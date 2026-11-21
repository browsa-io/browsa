// The captcha_page group over stdio, against a local stand-in of the captcha
// API (no network, no real key): groups, detect with no key and no request,
// solve with cost and the apply block, local limits, retries, offline start,
// prompts.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { startMcp } from "./helpers.mjs";
import { KEYS, withCaptcha, withoutCaptcha } from "./fixtures/pages.mjs";

const KEY = "agt_test_x";
const COST = { charged: true, amount: 0.008, unit: "credits", credits: 0.008, note: "Charged once, for this solve." };
const tok = (name, kind, status = "live", extra = {}) => ({
  type: name, title: name, kind, family: "f", status, required: kind === "token" ? [{ name: "websiteURL" }, { name: "websiteKey" }] : [],
  optional: [], proxy: "none", price: { creditsPerSolve: 0.008 }, ...extra,
});
const TYPES = [
  tok("AntiTurnstileTaskProxyLess", "token"),
  tok("AntiTurnstileTask", "token", "live", { proxy: "required", required: [{ name: "websiteURL" }, { name: "websiteKey" }, { name: "proxy" }] }),
  tok("ReCaptchaV2TaskProxyLess", "token"),
  tok("ReCaptchaV3TaskProxyLess", "token", "off", { offReason: "switched off for this test" }),
  tok("AntiCloudflareTask", "token", "live", { proxy: "required", required: [{ name: "websiteURL" }, { name: "proxy" }] }),
  tok("ImageToTextTask", "recognition", "live", { requiredOneOf: [[{ name: "body" }, { name: "images" }]] }),
];

/** plan: per websiteKey behaviour of createTask. */
function startCaptchaApi() {
  const calls = [];
  const state = { typesDown: false, seen: {} };
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url.replace("/captcha-api", "");
      calls.push({ path, body, method: req.method });
      const send = (o, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
      const ok = (o) => send({ errorId: 0, ...o });
      if (path === "/types") return state.typesDown ? send("<html>bad gateway</html>", 502) : ok({ types: TYPES });
      if (path === "/createTask") {
        const t = body.task;
        const n = (state.seen[t.websiteKey] = (state.seen[t.websiteKey] ?? 0) + 1);
        if (t.websiteKey === "k-429" && n === 1) return send({ error: "slow down" }, 429, { "retry-after": "0" });
        if (t.websiteKey === "k-ratebody" && n === 1) return send({ errorId: 1, errorCode: "ERROR_RATE_LIMIT", errorDescription: "too many", charged: false });
        if (t.websiteKey === "k-502") return send("<html>bad gateway</html>", 502);
        if (t.websiteKey === "k-fail") return send({ errorId: 1, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", errorDescription: "no token", fix: "Send a new task.", charged: false, taskId: "t-fail" });
        if (t.websiteKey === "k-slow") return ok({ taskId: "t-slow" });
        if (t.websiteKey === "k-poll") return ok({ taskId: "t-poll" });
        if (t.type === "AntiCloudflareTask") {
          return ok({ taskId: "t-cf", status: "ready", solveSeconds: 9.9, cost: { ...COST, amount: 0.012, credits: 0.012 },
            solution: { cookies: { cf_clearance: "clr.1" }, token: "clr.1", type: "challenge", userAgent: "UA/157" } });
        }
        if (/ReCaptcha/.test(t.type)) return ok({ taskId: "t-rc", status: "ready", solveSeconds: 40, cost: COST, solution: { gRecaptchaResponse: "03AF-token", userAgent: "UA" } });
        return ok({ taskId: `t-${n}`, status: "ready", solveSeconds: 6.4, cost: COST, solution: { token: "0.cf-token", type: "turnstile", userAgent: "UA" } });
      }
      if (path === "/getTaskResult") {
        const n = (state.seen[body.taskId] = (state.seen[body.taskId] ?? 0) + 1);
        if (body.taskId === "t-slow") return setTimeout(() => ok({ taskId: body.taskId, status: "ready", cost: COST, solution: { token: "0.slow" } }), 700);
        // a poll is safe to repeat: the first answer is a gateway error
        if (body.taskId === "t-poll" && n === 1) return send("<html>bad gateway</html>", 502);
        return ok({ taskId: body.taskId, status: "ready", solveSeconds: 3, cost: COST, solution: { token: "0.after-retry" } });
      }
      send({ errorId: 1, errorCode: "ERROR_BAD_REQUEST", errorDescription: "unknown method" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, state, close: () => srv.close(),
    count: (path) => calls.filter((c) => c.path === path).length,
  })));
}

const ENV = { BROWSA_CAPTCHA_POLL_MS: "20", BROWSA_MCP_RETRY_BASE_MS: "5" };
const json = (r) => JSON.parse(r.text);
const TS = { type: "AntiTurnstileTaskProxyLess", params: { websiteURL: "https://a.example/", websiteKey: KEYS.TS_KEY } };
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); };

describe("captcha_page: groups and the tool list", () => {
  test("off by default; on as a group; -core leaves only the captcha tools; all has them", async () => {
    let mcp = await startMcp(undefined).init();
    let names = (await mcp.tools()).map((t) => t.name);
    assert.equal(names.length, 9);
    assert.ok(!names.includes("detect_captcha"));
    const off = await mcp.call("detect_captcha", { html: "<p>" });
    assert.match(off.text, /optional group "captcha_page"/);
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "captcha_page" }).init();
    names = (await mcp.tools()).map((t) => t.name);
    assert.equal(names.length, 12);
    assert.deepEqual(names.slice(9), ["detect_captcha", "solve_captcha_on_page", "captcha_allowance"]);
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "captcha_page,-core" }).init();
    const tools = await mcp.tools();
    assert.deepEqual(tools.map((t) => t.name), ["detect_captcha", "solve_captcha_on_page", "captcha_allowance"]);
    const chars = JSON.stringify(tools).length;
    assert.ok(chars / 4 < 650, `captcha_page is ${Math.ceil(chars / 4)} tokens (chars / 4), budget 650`);
    const text = JSON.stringify(tools);
    assert.ok(!/\d+ ?%|refund|callback ?url|—/i.test(text), "tool text has a rate, a refund, a callback URL or an em dash");
    assert.ok(!/playwright|puppeteer|capsolver|anti-captcha|capmonster|2captcha|cloudflare|google|chromium|browserbase/i.test(text));
    const core = await mcp.call("open", { url: "https://a.example" });
    assert.match(core.text, /core tools are switched off/);
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "captcha,captcha_page,-core,-captcha_allowance,-report_captcha_result" }).init();
    assert.deepEqual((await mcp.tools()).map((t) => t.name).sort(), ["detect_captcha", "list_captcha_types", "solve_captcha_on_page", "solve_captcha_task"]);
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "all" }).init();
    names = (await mcp.tools()).map((t) => t.name);
    assert.equal(names.length, 36);
    assert.equal(new Set(names).size, 36);
    mcp.kill();
  });

  test("an empty BROWSA_MCP_TOOLS (an install form left blank) is the default", async () => {
    const mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "", BROWSA_CAPTCHA_MAX_CREDITS: "", BROWSA_CAPTCHA_RATE_PER_MINUTE: " " }).init();
    try { assert.equal((await mcp.tools()).length, 9); } finally { mcp.kill(); }
  });
});

describe("detect_captcha: no key, no request", () => {
  let api, mcp;
  before(async () => {
    api = await startCaptchaApi();
    mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core", BROWSA_API_KEY: "" }).init();
    await until(() => api.count("/types") === 1);
  });
  after(() => { mcp?.kill(); api?.close(); });

  test("works with no API key, and the live catalogue gives the status", async () => {
    const r = await mcp.call("detect_captcha", withCaptcha.turnstileImplicit);
    assert.equal(r.isError, false);
    const b = json(r);
    assert.equal(b.found, 1);
    const c = b.captchas[0];
    assert.deepEqual([c.kind, c.type, c.status, c.solve_with, c.ready], ["turnstile", "AntiTurnstileTaskProxyLess", "live", "solve_captcha_on_page", true]);
    assert.deepEqual(c.params, { websiteURL: "https://captcha-check.browsa.io/", websiteKey: "0x4AAAAAAGEprtbosKnaIPao" });
    assert.equal(c.credits_per_solve, 0.008);
    assert.equal(b.catalogue.source, "live");
  });

  test("status follows the catalogue: off, not in it, picture types, and a missing key", async () => {
    const v3 = json(await mcp.call("detect_captcha", withCaptcha.recaptchaV3)).captchas[0];
    assert.deepEqual([v3.type, v3.status, v3.ready], ["ReCaptchaV3TaskProxyLess", "off", false]);
    assert.match(v3.notes.join(" "), /switched off for this test/);
    const hc = json(await mcp.call("detect_captcha", withCaptcha.hcaptcha)).captchas[0];
    assert.deepEqual([hc.type, hc.status, hc.solve_with, hc.ready], [null, "not_in_catalogue", null, false]);
    const img = json(await mcp.call("detect_captcha", withCaptcha.imageText)).captchas[0];
    assert.deepEqual([img.type, img.solve_with, img.ready], ["ImageToTextTask", "solve_captcha_task", false]);
    const nokey = json(await mcp.call("detect_captcha", withCaptcha.turnstileNoKey)).captchas[0];
    assert.equal(nokey.ready, false);
    assert.match(nokey.missing[0], /^websiteKey:/);
    const cf = json(await mcp.call("detect_captcha", withCaptcha.cloudflareCheck)).captchas[0];
    assert.deepEqual([cf.type, cf.ready], ["AntiCloudflareTask", true]);
    assert.match(cf.missing[0], /^proxy:/);
  });

  test("pages without a captcha: found 0", async () => {
    for (const html of [withoutCaptcha.loginForm, withoutCaptcha.article, withoutCaptcha.docsWithSamples]) {
      const b = json(await mcp.call("detect_captcha", { html, url: "https://plain.example/" }));
      assert.deepEqual([b.found, b.captchas], [0, []]);
      assert.match(b.note, /No captcha/);
    }
    assert.equal((await mcp.call("detect_captcha", {})).isError, true);
  });

  test("none of those calls reached the network: one catalogue GET at startup, nothing else, and it carried no key", async () => {
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["GET /types"]);
    assert.deepEqual(api.calls[0].body, {});
  });

  test("solving and the allowance without a key: solve says to set one, allowance answers", async () => {
    const s = await mcp.call("solve_captcha_on_page", { captcha: TS });
    assert.equal(s.isError, true);
    assert.match(s.text, /BROWSA_API_KEY is not set/);
    const a = await mcp.call("captcha_allowance");
    assert.equal(a.isError, false);
    assert.match(json(a).note, /No local limit is set/);
  });
});

describe("solve_captcha_on_page", () => {
  let api, mcp;
  before(async () => {
    api = await startCaptchaApi();
    mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,captcha,-core" }).init();
    await until(() => api.count("/types") === 1);
  });
  after(() => { mcp?.kill(); api?.close(); });

  test("from a detect_captcha entry: the task, the held wait, cost, and an expression that works in the page", async () => {
    const entry = json(await mcp.call("detect_captcha", withCaptcha.turnstileAttrs)).captchas[0];
    const r = await mcp.call("solve_captcha_on_page", { captcha: entry });
    assert.equal(r.isError, false);
    const b = json(r);
    const sent = api.calls.findLast((c) => c.path === "/createTask").body;
    assert.equal(sent.clientKey, KEY);
    assert.equal(sent.waitSeconds, 20);
    assert.deepEqual(sent.task, { websiteURL: "https://shop.example/login", websiteKey: KEYS.TS_KEY, metadata: { action: "login", cdata: "sess-1" }, type: "AntiTurnstileTaskProxyLess" });
    assert.deepEqual([b.type, b.solution.token, b.seconds], ["AntiTurnstileTaskProxyLess", "0.cf-token", 6.4]);
    assert.deepEqual(b.cost, COST);
    assert.deepEqual([b.apply.how, b.apply.valid_seconds], ["evaluate", 300]);
    assert.equal(b.allowance.spent_credits, 0.008);
    assert.match(b.next, /report_captcha_result/);
    // the expression, evaluated in that page: the renamed field and the page's callback
    const { window, document } = parseHTML(`<html><body>${withCaptcha.turnstileAttrs.html}</body></html>`);
    let got = null;
    window.onTurnstile = (t) => { got = t; };
    const out = vm.runInNewContext(b.apply.expression, { window, document, Event: window.Event, Node: window.Node });
    assert.deepEqual([out.applied, out.callback, got], [true, "called onTurnstile", "0.cf-token"]);
    assert.equal(document.querySelector("[name='cf_token']").value, "0.cf-token");
  });

  test("from html and url alone: detection runs first", async () => {
    const b = json(await mcp.call("solve_captcha_on_page", withCaptcha.recaptchaV2));
    assert.deepEqual([b.type, b.solution.gRecaptchaResponse, b.apply.valid_seconds], ["ReCaptchaV2TaskProxyLess", "03AF-token", 120]);
    assert.match(b.apply.expression, /captchaDone/);
  });

  test("a cookie answer: cookies, user agent, re-request, and the proxy goes into the task", async () => {
    const entry = json(await mcp.call("detect_captcha", withCaptcha.cloudflareCheck)).captchas[0];
    const need = await mcp.call("solve_captcha_on_page", { captcha: entry });
    assert.equal(need.isError, true);
    assert.deepEqual([json(need).code, json(need).missing, json(need).charged], ["MISSING_PARAMETER", ["proxy"], false]);
    const b = json(await mcp.call("solve_captcha_on_page", { captcha: entry, proxy: "http://u:p@proxy.example:8000" }));
    assert.equal(api.calls.findLast((c) => c.path === "/createTask").body.task.proxy, "http://u:p@proxy.example:8000");
    assert.equal(b.apply.how, "cookies");
    assert.deepEqual(b.apply.cookies, [{ name: "cf_clearance", value: "clr.1", domain: "protected.example", path: "/", secure: true }]);
    assert.equal(b.apply.user_agent, "UA/157");
    assert.match(b.apply.steps.join(" "), /Re-request the URL.*Do not reload the challenge page/);
    assert.equal(b.cost.credits, 0.012);
  });

  test("with a proxy a ProxyLess type becomes its proxy form", async () => {
    const b = json(await mcp.call("solve_captcha_on_page", { captcha: TS, proxy: "http://proxy.example:8000" }));
    assert.equal(b.type, "AntiTurnstileTask");
  });

  test("what it cannot do is said before anything is sent or charged", async () => {
    const before = api.count("/createTask");
    const cases = [
      [{ captcha: { type: "ImageToTextTask", params: {} } }, "NOT_A_TOKEN_TYPE", /solve_captcha_task/],
      [{ captcha: { type: "ReCaptchaV3TaskProxyLess", params: TS.params } }, "TYPE_OFF", /switched off/],
      [{ captcha: { type: "HCaptchaTask", params: TS.params } }, "NOT_IN_CATALOGUE", /case-sensitive/],
      [{ captcha: { kind: "hcaptcha", type: null, params: {} } }, "NOT_IN_CATALOGUE", /no task type/],
      [{ captcha: { type: "AntiTurnstileTaskProxyLess", params: { websiteURL: "https://a.example/" } } }, "MISSING_PARAMETER", /websiteKey/],
      [{ html: withoutCaptcha.loginForm, url: "https://plain.example/" }, "NO_CAPTCHA", /no captcha was found/],
      [withCaptcha.twoWidgets, "SEVERAL_CAPTCHAS", /more than one/],
      [withCaptcha.imageText, "NOT_SOLVABLE_HERE", /can be solved by this tool/],
    ];
    for (const [args, code, re] of cases) {
      const r = await mcp.call("solve_captcha_on_page", args);
      assert.equal(r.isError, true, code);
      assert.equal(json(r).code, code);
      assert.equal(json(r).charged, false);
      assert.match(json(r).error, re);
    }
    assert.equal((await mcp.call("solve_captcha_on_page", {})).isError, true);
    assert.equal(api.count("/createTask"), before);
  });

  test("the API's own error is passed on with its fix, and nothing is counted as spent", async () => {
    const spent = json(await mcp.call("captcha_allowance")).spent_credits;
    const r = await mcp.call("solve_captcha_on_page", { captcha: { ...TS, params: { ...TS.params, websiteKey: "k-fail" } } });
    assert.equal(r.isError, true);
    const b = json(r);
    assert.deepEqual([b.code, b.charged, b.fix, b.task_id], ["ERROR_CAPTCHA_UNSOLVABLE", false, "Send a new task.", "t-fail"]);
    assert.equal(b.allowance.spent_credits, spent);
  });
});

describe("resilience: retries and an offline start", () => {
  test("429 with Retry-After and the key's rate limit are retried; a poll is retried on a gateway error; createTask is not", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core" }).init();
    try {
      const solve = (websiteKey) => mcp.call("solve_captcha_on_page", { captcha: { ...TS, params: { ...TS.params, websiteKey } } });
      const made = (k) => api.calls.filter((c) => c.path === "/createTask" && c.body.task.websiteKey === k).length;
      let r = await solve("k-429");
      assert.equal(r.isError, false, r.text);
      assert.equal(made("k-429"), 2);
      r = await solve("k-ratebody");
      assert.equal(r.isError, false, r.text);
      assert.equal(made("k-ratebody"), 2);
      r = await solve("k-poll");
      assert.equal(r.isError, false, r.text);
      assert.equal(json(r).solution.token, "0.after-retry");
      assert.equal(api.calls.filter((c) => c.path === "/getTaskResult" && c.body.taskId === "t-poll").length, 2);
      // a createTask that met a gateway error may have been taken: it is sent once
      r = await solve("k-502");
      assert.equal(r.isError, true);
      assert.equal(json(r).code, "HTTP_502");
      assert.equal(made("k-502"), 1);
    } finally { mcp.kill(); api.close(); }
  });

  test("BROWSA_MCP_RETRIES=0 switches retries off", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core", BROWSA_MCP_RETRIES: "0" }).init();
    try {
      const r = await mcp.call("solve_captcha_on_page", { captcha: { ...TS, params: { ...TS.params, websiteKey: "k-429" } } });
      assert.equal(r.isError, true);
      assert.equal(api.count("/createTask"), 1);
    } finally { mcp.kill(); api.close(); }
  });

  test("the network is down at startup: the server lists its tools at once and detects from the bundled catalogue", async () => {
    const t0 = Date.now();
    const mcp = await startMcp("http://127.0.0.1:9", { ...ENV, BROWSA_MCP_TOOLS: "all" }).init();
    try {
      assert.equal((await mcp.tools()).length, 36);
      assert.ok(Date.now() - t0 < 3000, "startup waited on the network");
      const b = json(await mcp.call("detect_captcha", withCaptcha.turnstileImplicit));
      assert.equal(b.catalogue.source, "bundled");
      assert.match(b.catalogue.as_of, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual([b.captchas[0].type, b.captchas[0].status, b.captchas[0].ready], ["AntiTurnstileTaskProxyLess", "live", true]);
      const s = await mcp.call("solve_captcha_on_page", { captcha: TS });
      assert.equal(s.isError, true);
      assert.equal(json(s).code, "NETWORK");
      assert.equal((await mcp.rpc("prompts/list", {})).result.prompts.length, 3);
    } finally { mcp.kill(); }
  });

  test("a catalogue that answers rubbish leaves the bundled one in place; BROWSA_CAPTCHA_CATALOGUE=bundled never asks", async () => {
    const api = await startCaptchaApi();
    api.state.typesDown = true;
    let mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core" }).init();
    await until(() => api.count("/types") >= 1);
    assert.equal(json(await mcp.call("detect_captcha", withCaptcha.turnstileImplicit)).catalogue.source, "bundled");
    mcp.kill();
    const before = api.calls.length;
    mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core", BROWSA_CAPTCHA_CATALOGUE: "bundled" }).init();
    await mcp.call("detect_captcha", withCaptcha.turnstileImplicit);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(api.calls.length, before);
    mcp.kill(); api.close();
  });

  test("the default server (no captcha tool listed) makes no request at startup", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, ENV).init();
    await mcp.tools();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(api.calls.length, 0);
    mcp.kill(); api.close();
  });
});

describe("local limits", () => {
  test("spend cap: refused with the limit's name before anything is sent; the allowance shows what is left", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,captcha,-core", BROWSA_CAPTCHA_MAX_CREDITS: "0.02" }).init();
    try {
      await until(() => api.count("/types") === 1);
      assert.equal(json(await mcp.call("captcha_allowance")).spend_cap.remaining_credits, 0.02);
      for (let i = 0; i < 2; i++) assert.equal((await mcp.call("solve_captcha_on_page", { captcha: TS })).isError, false);
      const r = await mcp.call("solve_captcha_on_page", { captcha: TS });
      assert.equal(r.isError, true);
      const b = json(r);
      assert.deepEqual([b.code, b.limit, b.retry_after_seconds, b.charged], ["LOCAL_LIMIT", "spend_cap", null, false]);
      assert.match(b.error, /BROWSA_CAPTCHA_MAX_CREDITS is 0\.02/);
      assert.match(b.retry, /not in this session/);
      assert.deepEqual([b.allowance.spent_credits, b.allowance.spend_cap.remaining_credits, b.allowance.solved], [0.016, 0.004, 2]);
      assert.equal(api.count("/createTask"), 2);
      // the same cap covers solve_captcha_task
      const legacy = await mcp.call("solve_captcha_task", { task: { type: "AntiTurnstileTaskProxyLess", ...TS.params } });
      assert.equal(legacy.isError, true);
      assert.equal(json(legacy).limit, "spend_cap");
      assert.equal(api.count("/createTask"), 2);
    } finally { mcp.kill(); api.close(); }
  });

  test("rate: the third solve in a minute is refused with the seconds to wait", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core", BROWSA_CAPTCHA_RATE_PER_MINUTE: "2" }).init();
    try {
      for (let i = 0; i < 2; i++) assert.equal((await mcp.call("solve_captcha_on_page", { captcha: TS })).isError, false);
      const b = json(await mcp.call("solve_captcha_on_page", { captcha: TS }));
      assert.deepEqual([b.code, b.limit], ["LOCAL_LIMIT", "rate"]);
      assert.ok(b.retry_after_seconds >= 55 && b.retry_after_seconds <= 60);
      assert.equal(b.retry, `in ${b.retry_after_seconds} s`);
      assert.equal(api.count("/createTask"), 2);
    } finally { mcp.kill(); api.close(); }
  });

  test("concurrency: a second solve while one runs is refused, then passes", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha_page,-core", BROWSA_CAPTCHA_CONCURRENCY: "1" }).init();
    try {
      const slow = mcp.call("solve_captcha_on_page", { captcha: { ...TS, params: { ...TS.params, websiteKey: "k-slow" } } });
      await until(() => api.count("/getTaskResult") === 1);
      const b = json(await mcp.call("solve_captcha_on_page", { captcha: TS }));
      assert.deepEqual([b.code, b.limit, b.retry_after_seconds], ["LOCAL_LIMIT", "concurrency", 5]);
      assert.deepEqual(b.allowance.concurrency, { max: 1, running: 1, free: 0 });
      assert.equal((await slow).isError, false);
      assert.equal((await mcp.call("solve_captcha_on_page", { captcha: TS })).isError, false);
    } finally { mcp.kill(); api.close(); }
  });

  test("no limit set: solve_captcha_task answers exactly as before (no allowance field)", async () => {
    const api = await startCaptchaApi();
    const mcp = await startMcp(api.url, { ...ENV, BROWSA_MCP_TOOLS: "captcha" }).init();
    try {
      const b = json(await mcp.call("solve_captcha_task", { task: { type: "AntiTurnstileTaskProxyLess", ...TS.params } }));
      assert.deepEqual(Object.keys(b), ["task_id", "type", "solution", "seconds", "cost", "next"]);
      assert.equal(api.count("/types"), 0);
    } finally { mcp.kill(); api.close(); }
  });
});

describe("prompts", () => {
  test("listed for the tools that are on; the captcha recipe walks detect, solve, apply, verify", async () => {
    let mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "captcha_page" }).init();
    let list = (await mcp.rpc("prompts/list", {})).result.prompts;
    assert.deepEqual(list.map((p) => p.name), ["solve_captcha_on_my_page", "what_captcha_is_this", "pass_check_in_browsa_browser"]);
    const p = (await mcp.rpc("prompts/get", { name: "solve_captcha_on_my_page", arguments: { url: "https://a.example/login" } })).result;
    const text = p.messages[0].content.text;
    assert.equal(p.messages[0].role, "user");
    assert.match(text, /https:\/\/a\.example\/login/);
    const order = ["detect_captcha", "solve_captcha_on_page", "apply.steps", "Verify"].map((w) => text.indexOf(w));
    assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "steps out of order");
    assert.ok(!/\d+ ?%|refund|playwright|chromium/i.test(JSON.stringify(list) + text));
    assert.ok((await mcp.rpc("prompts/get", { name: "nope" })).error);
    mcp.kill();

    mcp = await startMcp(undefined).init();
    list = (await mcp.rpc("prompts/list", {})).result.prompts;
    assert.deepEqual(list.map((p) => p.name), ["pass_check_in_browsa_browser"]);
    assert.ok((await mcp.rpc("prompts/get", { name: "solve_captcha_on_my_page" })).error, "a prompt for tools that are off was served");
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "captcha_page,-core" }).init();
    list = (await mcp.rpc("prompts/list", {})).result.prompts;
    assert.deepEqual(list.map((p) => p.name), ["solve_captcha_on_my_page", "what_captcha_is_this"]);
    mcp.kill();
  });
});
