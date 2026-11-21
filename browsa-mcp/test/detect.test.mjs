// The captcha detector on its own (no server, no network): pages with each
// captcha, and pages that must give nothing.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectCaptchas, scan } from "./dist/captcha/detect.js";
import { KEYS, withCaptcha, withoutCaptcha } from "./fixtures/pages.mjs";

const one = (page) => {
  const r = detectCaptchas(page);
  assert.equal(r.findings.length, 1, `expected one captcha, got ${JSON.stringify(r.findings.map((f) => f.kind))}`);
  return r.findings[0];
};

describe("detect: Turnstile", () => {
  test("a widget div gives the key; the check page of the live test is read as it is served", () => {
    const f = one(withCaptcha.turnstileImplicit);
    assert.equal(f.kind, "turnstile");
    assert.deepEqual(f.params, { websiteURL: "https://captcha-check.browsa.io/", websiteKey: "0x4AAAAAAGEprtbosKnaIPao" });
    assert.deepEqual(f.missing, []);
    assert.equal(f.confidence, "high");
  });

  test("action, cdata, the callback and a renamed answer field are read from the widget", () => {
    const f = one(withCaptcha.turnstileAttrs);
    assert.deepEqual(f.params.metadata, { action: "login", cdata: "sess-1" });
    assert.deepEqual(f.page, { callback: "onTurnstile", responseField: "cf_token" });
  });

  test("a widget rendered from script: the key, action and cData come from turnstile.render", () => {
    const f = one(withCaptcha.turnstileExplicit);
    assert.equal(f.params.websiteKey, KEYS.TS_KEY);
    assert.deepEqual(f.params.metadata, { action: "signup", cdata: "abc" });
    assert.equal(f.page.callback, "onDone");
  });

  test("a key that is only in the frame address is found through resources", () => {
    const f = one(withCaptcha.turnstileFrameOnly);
    assert.equal(f.params.websiteKey, KEYS.TS_KEY);
    assert.match(f.evidence[0], /frame/);
  });

  test("the script and the answer field without a key: reported, with the key missing and where to find it", () => {
    const f = one(withCaptcha.turnstileNoKey);
    assert.equal(f.params.websiteKey, undefined);
    assert.equal(f.missing.length, 1);
    assert.match(f.missing[0], /^websiteKey: .*resources/);
    assert.notEqual(f.confidence, "high");
  });

  test("no url: websiteURL is listed as missing", () => {
    const f = one({ html: withCaptcha.turnstileImplicit.html });
    assert.match(f.missing[0], /^websiteURL:/);
    assert.equal(f.params.websiteURL, undefined);
  });

  test("a provider's public test key is called out", () => {
    const f = one(withCaptcha.turnstileTestKey);
    assert.ok(f.notes.some((n) => /test key/.test(n)));
  });
});

describe("detect: reCAPTCHA", () => {
  test("v2 checkbox with its callback", () => {
    const f = one(withCaptcha.recaptchaV2);
    assert.equal(f.kind, "recaptcha_v2");
    assert.equal(f.params.websiteKey, KEYS.RC_KEY);
    assert.equal(f.params.isInvisible, undefined);
    assert.equal(f.page.callback, "captchaDone");
  });

  test("v2 invisible from the anchor frame (entities in the src decoded), and the recaptcha.net domain", () => {
    const f = one(withCaptcha.recaptchaV2InvisibleFrame);
    assert.equal(f.kind, "recaptcha_v2");
    assert.equal(f.params.websiteKey, KEYS.RC_KEY);
    assert.equal(f.params.isInvisible, true);
    assert.equal(f.params.apiDomain, "recaptcha.net");
  });

  test("v2 rendered from script", () => {
    const f = one(withCaptcha.recaptchaV2Explicit);
    assert.equal(f.kind, "recaptcha_v2");
    assert.equal(f.page.callback, "verifyCallback");
  });

  test("v3 from render=<key> and execute, with the action", () => {
    const f = one(withCaptcha.recaptchaV3);
    assert.equal(f.kind, "recaptcha_v3");
    assert.equal(f.params.pageAction, "checkout");
    assert.equal(f.params.isInvisible, undefined);
  });

  test("Enterprise, v3 and v2", () => {
    const v3 = one(withCaptcha.recaptchaV3Enterprise);
    assert.equal(v3.kind, "recaptcha_v3_enterprise");
    assert.equal(v3.params.pageAction, "LOGIN");
    assert.equal(v3.params.websiteKey, KEYS.RC_KEY2);
    assert.equal(one(withCaptcha.recaptchaV2Enterprise).kind, "recaptcha_v2_enterprise");
  });
});

describe("detect: the other kinds", () => {
  test("a full-page check asks for a proxy and says the answer is a cookie", () => {
    const f = one(withCaptcha.cloudflareCheck);
    assert.equal(f.kind, "cloudflare");
    assert.ok(f.missing.some((m) => m.startsWith("proxy:")));
    assert.ok(f.notes.some((n) => /cookie/.test(n)));
  });

  test("picture puzzles say which pictures are missing", () => {
    const gt = one(withCaptcha.geetestV4);
    assert.deepEqual([gt.kind, gt.params.version], ["geetest_slide", 4]);
    assert.match(gt.missing[0], /imageBackground, imageSlice/);
    assert.equal(one(withCaptcha.awsWaf).kind, "aws_waf");
    assert.equal(one(withCaptcha.dataDome).kind, "slider");
  });

  test("image text: a picture that says captcha with an answer field; an inline picture next to a captcha field", () => {
    const a = one(withCaptcha.imageText);
    assert.equal(a.kind, "image_text");
    assert.match(a.missing[0], /^body:/);
    const b = one(withCaptcha.imageTextInline);
    assert.match(b.missing[0], /data: URL/);
  });

  test("providers the API has no type for are still named", () => {
    assert.equal(one(withCaptcha.hcaptcha).kind, "hcaptcha");
    const kinds = detectCaptchas(withCaptcha.arkoseAndPx).findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ["altcha", "arkose", "press_and_hold"]);
  });

  test("two widgets on one page are two findings", () => {
    assert.deepEqual(detectCaptchas(withCaptcha.twoWidgets).findings.map((f) => f.kind), ["turnstile", "recaptcha_v2"]);
  });
});

describe("detect: pages without a captcha give nothing", () => {
  for (const [name, html] of Object.entries(withoutCaptcha)) {
    test(name, () => {
      const r = detectCaptchas({ html, url: "https://plain.example/page" });
      assert.deepEqual(r.findings, [], `fired on ${name}`);
    });
  }

  test("resources from other hosts change nothing", () => {
    const r = detectCaptchas({ html: withoutCaptcha.loginForm, url: "https://plain.example/",
      resources: ["https://cdn.example/captcha.js", "https://www.google.com/maps/embed", "https://www.gstatic.com/fonts.css", "not a url", "data:text/plain,hi"] });
    assert.deepEqual(r.findings, []);
  });

  test("odd input does not throw", () => {
    for (const html of [undefined, null, 42, "<<<>>>", "<div class='cf-turnstile' data-sitekey=", "<script>turnstile.render("]) {
      assert.deepEqual(detectCaptchas({ html }).findings.filter((f) => f.confidence === "high"), []);
    }
  });
});

describe("detect: the scanner", () => {
  test("reads tags and attributes, drops comments, samples and non-script data, keeps script bodies", () => {
    const s = scan(`<title> A &amp; B </title><!-- <i id="c"> --><div id=a class='x y' data-k="1&amp;2"><pre><b id="p"></b></pre>
<script type="text/javascript">var a = 1;</script><script type="application/json">{"id":"j"}</script><form><input name=q></form><input name=out>`);
    assert.equal(s.title, "A & B");
    assert.deepEqual(s.tags.map((t) => t.name), ["title", "div", "script", "script", "form", "input", "input"]);
    assert.deepEqual(s.tags[1].attrs, { id: "a", class: "x y", "data-k": "1&2" });
    assert.deepEqual(s.scripts, ["var a = 1;"]);
    assert.deepEqual([s.tags[5].form, s.tags[6].form], [0, -1]);
  });

  test("very large input is cut, and says so", () => {
    const r = detectCaptchas({ html: "<p>x</p>".repeat(400_000) });
    assert.equal(r.truncated, true);
  });
});
