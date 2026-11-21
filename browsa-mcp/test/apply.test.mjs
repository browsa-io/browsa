// The apply block: the expressions are run against a DOM (linkedom) the way
// a caller's browser would evaluate them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { buildApply, recaptchaExpression, turnstileExpression } from "./dist/captcha/apply.js";
import { redactUrls } from "./dist/redact.js";

/** Evaluates an expression in a page made from `html`; `setup(window)` runs first. */
function inPage(html, expression, setup) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const events = [];
  document.addEventListener("input", (e) => events.push(`input:${e.target.getAttribute("name")}`));
  document.addEventListener("change", (e) => events.push(`change:${e.target.getAttribute("name")}`));
  setup?.(window);
  const result = vm.runInNewContext(expression, { window, document, Event: window.Event, Node: window.Node, Promise, Set, Object, Array, String });
  return { result, document, window, events };
}

const TOKEN = "0.tok-en_VALUE.with\"quote'and</script>";

describe("apply: Turnstile", () => {
  test("the token goes into the widget's hidden field and the widget's callback is called", () => {
    let got = null;
    const { result, document, events } = inPage(
      `<form><div class="cf-turnstile" data-sitekey="0x4AAAAAAA" data-callback="onOk"><input type="hidden" name="cf-turnstile-response"></div></form>`,
      turnstileExpression(TOKEN), (w) => { w.onOk = (t) => { got = t; }; });
    assert.equal(document.querySelector("[name='cf-turnstile-response']").value, TOKEN);
    assert.equal(got, TOKEN);
    assert.deepEqual([result.applied, result.fields, result.callback], [true, 1, "called onOk"]);
    assert.deepEqual(events, ["input:cf-turnstile-response", "change:cf-turnstile-response"]);
  });

  test("a widget that has not rendered its field yet gets one, inside the widget", () => {
    const { result, document } = inPage(`<form id="f"><div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div></form>`, turnstileExpression(TOKEN));
    const field = document.querySelector(".cf-turnstile input[name='cf-turnstile-response']");
    assert.equal(field.value, TOKEN);
    assert.equal(field.type, "hidden");
    assert.deepEqual([result.applied, result.created_field, result.callback], [true, true, "none"]);
  });

  test("a renamed answer field, a dotted callback name given by the caller, and turnstile.getResponse", () => {
    let got = null;
    const { result, document, window } = inPage(`<form><input type="hidden" name="cf_token"></form>`,
      turnstileExpression(TOKEN, { callback: "app.captcha.done", responseField: "cf_token" }),
      (w) => { w.app = { captcha: { done: (t) => { got = t; } } }; w.turnstile = { getResponse: () => "" }; });
    assert.equal(document.querySelector("[name='cf_token']").value, TOKEN);
    assert.equal(got, TOKEN);
    assert.equal(result.callback, "called app.captcha.done");
    assert.equal(window.turnstile.getResponse(), TOKEN);
  });

  test("nothing to put it in: applied is false, and a callback that throws or is missing says so", () => {
    assert.equal(inPage(`<p>no widget</p>`, turnstileExpression(TOKEN)).result.applied, false);
    const threw = inPage(`<div class="cf-turnstile" data-callback="boom"></div>`, turnstileExpression(TOKEN), (w) => { w.boom = () => { throw new Error("x"); }; });
    assert.match(threw.result.callback, /^threw in boom: x/);
    const none = inPage(`<div class="cf-turnstile" data-callback="gone"></div>`, turnstileExpression(TOKEN));
    assert.equal(none.result.callback, "not a function: gone");
  });
});

describe("apply: reCAPTCHA", () => {
  test("v2: every answer textarea is filled and data-callback is called", () => {
    let got = null;
    const { result, document } = inPage(
      `<form><div class="g-recaptcha" data-sitekey="k" data-callback="done"></div>
       <textarea id="g-recaptcha-response" name="g-recaptcha-response"></textarea><textarea id="g-recaptcha-response-1"></textarea></form>`,
      recaptchaExpression(TOKEN), (w) => { w.done = (t) => { got = t; }; });
    assert.equal(document.getElementById("g-recaptcha-response").value, TOKEN);
    assert.equal(document.getElementById("g-recaptcha-response-1").value, TOKEN);
    assert.equal(got, TOKEN);
    assert.deepEqual([result.applied, result.fields, result.callback], [true, 2, "called done"]);
  });

  test("v2 rendered from script: the callback is found in the widget's own client table", () => {
    let got = null;
    const { result, window } = inPage(`<form><textarea name="g-recaptcha-response"></textarea></form>`, recaptchaExpression(TOKEN), (w) => {
      const loop = { deep: {} };
      loop.deep.back = loop;                                   // the real table has cycles
      w.___grecaptcha_cfg = { clients: { 0: { id: 0, T: loop, aa: { K: { sitekey: "k", callback: (t) => { got = t; } } } } } };
      w.grecaptcha = { getResponse: () => "" };
    });
    assert.equal(got, TOKEN);
    assert.equal(result.callback, "called the widget's callback");
    assert.equal(window.grecaptcha.getResponse(), TOKEN);
  });

  test("v2 with no field: one is added to the form", () => {
    const { result, document } = inPage(`<form><div class="g-recaptcha" data-sitekey="k"></div></form>`, recaptchaExpression(TOKEN));
    assert.equal(document.querySelector(".g-recaptcha textarea[name='g-recaptcha-response']").value, TOKEN);
    assert.equal(result.created_field, true);
  });

  test("v3: the page's next grecaptcha.execute (plain and enterprise) answers the token; no field is invented", async () => {
    const { result, document, window } = inPage(`<form><button>Pay</button></form>`, recaptchaExpression(TOKEN, {}, true), (w) => {
      w.grecaptcha = { execute: () => Promise.resolve("theirs"), enterprise: { execute: () => Promise.resolve("theirs") } };
    });
    assert.equal(await window.grecaptcha.execute("k", { action: "a" }), TOKEN);
    assert.equal(await window.grecaptcha.enterprise.execute("k"), TOKEN);
    assert.equal(document.querySelector("textarea"), null);
    assert.deepEqual([result.applied, result.execute], [true, "answers this token"]);
  });
});

describe("apply: the block", () => {
  test("Turnstile and reCAPTCHA solutions give an expression, steps and a lifetime", () => {
    const t = buildApply("AntiTurnstileTaskProxyLess", { token: "0.abc", type: "turnstile" }, "https://a.example/", {});
    assert.deepEqual([t.how, t.valid_seconds], ["evaluate", 300]);
    assert.match(t.expression, /cf-turnstile-response/);
    assert.equal(t.steps.length, 3);
    const v2 = buildApply("ReCaptchaV2TaskProxyLess", { gRecaptchaResponse: "03A" }, "https://a.example/", {});
    assert.deepEqual([v2.how, v2.valid_seconds], ["evaluate", 120]);
    const v3 = buildApply("ReCaptchaV3EnterpriseTaskProxyLess", { gRecaptchaResponse: "03A" }, "https://a.example/", {});
    assert.match(v3.expression, /const v3 = true/);
    assert.match(v3.steps[0], /execute/);
  });

  test("a cookie answer gives the cookies for the site's host, the user agent, and says not to reload", () => {
    const a = buildApply("AntiCloudflareTask", { cookies: { cf_clearance: "abc.def-1" }, token: "abc.def-1", type: "challenge", userAgent: "UA/1" }, "https://shop.example/p?x=1", {});
    assert.equal(a.how, "cookies");
    assert.deepEqual(a.cookies, [{ name: "cf_clearance", value: "abc.def-1", domain: "shop.example", path: "/", secure: true }]);
    assert.equal(a.user_agent, "UA/1");
    assert.equal(a.expression, undefined);
    assert.match(a.steps.join(" "), /Re-request the URL/);
    assert.match(a.steps.join(" "), /Do not reload the challenge page/);
  });

  test("an unknown solution shape is not guessed at", () => {
    assert.equal(buildApply("ImageToTextTask", { text: "x7Kp2" }, undefined, {}).how, "manual");
  });

  test("the token is embedded safely, and the server's URL masking leaves the expressions alone", () => {
    for (const expr of [turnstileExpression(TOKEN, { callback: "a.b" }), recaptchaExpression(TOKEN), recaptchaExpression(TOKEN, {}, true)]) {
      assert.ok(!expr.includes("</script>"), "a token could close a script tag");
      assert.equal(redactUrls(expr), expr, "masking changed the expression");
      assert.doesNotThrow(() => new vm.Script(expr));
    }
  });
});
