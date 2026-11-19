// Captcha client, task builders, type names and shims, against a local
// stand-in of the captcha API (node:http, no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  CaptchaClient, CaptchaError, CaptchaTimeoutError, BrowsaError, captchaTasks as tasks,
  normalizeCaptchaTask, TwoCaptchaSolver, useWithAntiCaptcha, CAPTCHA_TASK_TYPES,
} from "../dist/index.js";

const KEY = "agt_live_test";
const ok = (o) => ({ errorId: 0, errorCode: "", errorDescription: "", ...o });
const bad = (code, d = code, extra = {}) => ({ errorId: 1, errorCode: code, errorDescription: d, ...extra });

const api = { calls: [], polls: new Map(), readyAfter: 1 };
function handle(path, body) {
  api.calls.push({ path, body });
  if (body.clientKey !== KEY) return bad("ERROR_KEY_DENIED_ACCESS");
  if (path === "/getBalance") return ok({ balance: 4.2 });
  if (path === "/createTask") {
    const t = body.task;
    if (t.type === "ImageToTextTask") return ok({ taskId: "t-img", status: "ready", solution: { text: "x7Kp2" } });
    if (!CAPTCHA_TASK_TYPES.includes(t.type)) return bad("ERROR_TASK_NOT_SUPPORTED");
    const id = t.websiteKey === "bad" ? "t-bad" : `t-${t.type}`;
    api.polls.set(id, 0);
    return ok({ taskId: id });
  }
  if (path === "/getTaskResult") {
    const id = body.taskId;
    if (id === "t-img") return ok({ taskId: id, status: "ready", solution: { text: "x7Kp2" } });
    if (!api.polls.has(id)) return bad("ERROR_TASKID_INVALID");
    api.polls.set(id, api.polls.get(id) + 1);
    if (api.polls.get(id) <= api.readyAfter) return ok({ taskId: id, status: "processing" });
    if (id === "t-bad") return bad("ERROR_CAPTCHA_UNSOLVABLE", "no token", { taskId: id });
    const solution = id.includes("Turnstile") ? { token: "0.cf-token", type: "turnstile", userAgent: "UA" }
      : { gRecaptchaResponse: "03AF-token", userAgent: "UA", createTime: 1 };
    return ok({ taskId: id, status: "ready", solution });
  }
  return bad("ERROR_BAD_REQUEST", "unknown method");
}

let srv, url;
before(async () => {
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/html") { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html>"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handle(req.url, raw ? JSON.parse(raw) : {})));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const client = (o = {}) => new CaptchaClient({ apiKey: KEY, baseUrl: url, pollIntervalMs: 5, ...o });

test("builders pick the proxyless type without a proxy", () => {
  assert.deepEqual(tasks.recaptchaV2("https://a.example/x", "6Lk", { invisible: true }),
    { type: "ReCaptchaV2TaskProxyLess", websiteURL: "https://a.example/x", websiteKey: "6Lk", isInvisible: true });
  const v3 = tasks.recaptchaV3("https://a.example", "6Lk", { pageAction: "login", enterprise: true,
    proxy: { type: "http", host: "1.2.3.4", port: 8080, username: "u", password: "p:w" } });
  assert.equal(v3.type, "ReCaptchaV3EnterpriseTask");
  assert.equal(v3.proxy, "http://u:p%3Aw@1.2.3.4:8080");
  assert.deepEqual(tasks.turnstile("https://a.example", "0x4", { action: "signup", cdata: "c1" }),
    { type: "AntiTurnstileTaskProxyLess", websiteURL: "https://a.example", websiteKey: "0x4", metadata: { action: "signup", cdata: "c1" } });
  assert.deepEqual(tasks.turnstile("https://a.example", "0x4"), { type: "AntiTurnstileTaskProxyLess", websiteURL: "https://a.example", websiteKey: "0x4" });
  assert.throws(() => tasks.recaptchaV2("", "k"), /required/);
});

test("image builders encode bytes", () => {
  assert.equal(tasks.imageToText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x2e, 0x2e])).body, "iVBORy4u");
  assert.deepEqual(tasks.imageToText([Buffer.from("a"), "Yg=="]).images, ["YQ==", "Yg=="]);
  assert.deepEqual(tasks.recaptchaV2Classification(Buffer.from("img"), "/m/015qff", { size: 3 }),
    { type: "ReCaptchaV2Classification", image: "aW1n", question: "/m/015qff", size: 3 });
  assert.equal(tasks.awsWafClassification([Buffer.from("a")], "bed").question, "aws:grid:bed");
  assert.deepEqual(tasks.slider(Buffer.from("bg"), Buffer.from("pc")), { type: "VisionEngine", module: "slider_1", imageBackground: "Ymc=", image: "cGM=" });
  assert.throws(() => tasks.recaptchaV2Classification("x", "/m/0k4j", { size: 2 }), /size/);
});

test("other services' type names map to Browsa's", () => {
  const cases = [
    ["RecaptchaV2TaskProxyless", false, "ReCaptchaV2TaskProxyLess"],
    ["NoCaptchaTaskProxyless", false, "ReCaptchaV2TaskProxyLess"],
    ["RecaptchaV2Task", false, "ReCaptchaV2TaskProxyLess"],
    ["RecaptchaV2Task", true, "ReCaptchaV2Task"],
    ["RecaptchaV3TaskProxyless", false, "ReCaptchaV3TaskProxyLess"],
    ["RecaptchaV3EnterpriseTask", false, "ReCaptchaV3EnterpriseTaskProxyLess"],
    ["TurnstileTaskProxyless", false, "AntiTurnstileTaskProxyLess"],
    ["TurnstileTask", false, "AntiTurnstileTaskProxyLess"],
    ["TurnstileTask", true, "AntiTurnstileTask"],
    ["ReCaptchaV2TaskProxyLess", false, "ReCaptchaV2TaskProxyLess"],
    ["imagetotexttask", false, "ImageToTextTask"],
    ["FunCaptchaTaskProxyless", false, "FunCaptchaTaskProxyless"],
  ];
  for (const [given, proxy, want] of cases) {
    const t = { type: given, websiteURL: "https://a.example", websiteKey: "k", ...(proxy ? { proxyType: "http", proxyAddress: "1.2.3.4", proxyPort: 8080 } : {}) };
    assert.equal(normalizeCaptchaTask(t).type, want, given);
  }
  const t = normalizeCaptchaTask({ type: "TurnstileTask", websiteURL: "u", websiteKey: "k", pageAction: "a", data: "c" });
  assert.deepEqual(t.metadata, { action: "a", cdata: "c" });
  assert.equal(t.pageAction, undefined);
  const cf = { type: "TurnstileTask", cloudflareTaskType: "cf_clearance", websiteURL: "u", websiteKey: "k" };
  assert.deepEqual(normalizeCaptchaTask(cf), cf);
});

test("recognition is answered in createTask", async () => {
  api.calls = [];
  const s = await client().solve(tasks.imageToText(Buffer.from("png")));
  assert.deepEqual({ ...s }, { text: "x7Kp2" });
  assert.equal(s.taskId, "t-img");
  assert.deepEqual(api.calls.map((c) => c.path), ["/createTask"]);
  assert.equal(api.calls[0].body.clientKey, KEY);
});

test("token tasks are polled until ready", async () => {
  api.calls = []; api.readyAfter = 2;
  const s = await client().solve(tasks.recaptchaV3("https://a.example", "6Lk"));
  assert.equal(s.gRecaptchaResponse, "03AF-token");
  assert.equal(s.taskId, "t-ReCaptchaV3TaskProxyLess");
  assert.equal(JSON.stringify(s).includes("taskId"), false);
  assert.deepEqual(api.calls.map((c) => c.path), ["/createTask", "/getTaskResult", "/getTaskResult", "/getTaskResult"]);
  api.readyAfter = 1;
});

test("pasted competitor tasks are sent with Browsa's names; normalize:false sends them raw", async () => {
  api.calls = [];
  const s = await client().solve({ type: "TurnstileTaskProxyless", websiteURL: "https://a.example", websiteKey: "0x4" });
  assert.equal(s.token, "0.cf-token");
  assert.equal(api.calls[0].body.task.type, "AntiTurnstileTaskProxyLess");
  await assert.rejects(client({ normalize: false }).createTask({ type: "TurnstileTaskProxyless", websiteURL: "https://a.example", websiteKey: "0x4" }),
    (e) => e instanceof CaptchaError && e.code === "ERROR_TASK_NOT_SUPPORTED");
});

test("a failed task throws with its code and task id", async () => {
  await assert.rejects(client().solve(tasks.recaptchaV2("https://a.example", "bad")),
    (e) => e instanceof CaptchaError && e instanceof BrowsaError && e.code === "ERROR_CAPTCHA_UNSOLVABLE" && e.taskId === "t-bad");
});

test("balance, bad key, non-JSON answer", async () => {
  assert.equal(await client().getBalance(), 4.2);
  await assert.rejects(new CaptchaClient({ apiKey: "agt_live_wrong", baseUrl: url }).getBalance(), (e) => e.code === "ERROR_KEY_DENIED_ACCESS");
  await assert.rejects(client().call("html"), (e) => e instanceof CaptchaError && e.code === "HTTP_404");
});

test("local timeout", async () => {
  api.readyAfter = 1e9;
  await assert.rejects(client().solve(tasks.turnstile("https://a.example", "0x4"), { timeoutMs: 40 }),
    (e) => e instanceof CaptchaTimeoutError && e.taskId === "t-AntiTurnstileTaskProxyLess");
  api.readyAfter = 1;
});

test("key and URL from the environment", () => {
  const saved = { k: process.env.BROWSA_API_KEY, u: process.env.BROWSA_CAPTCHA_URL };
  process.env.BROWSA_API_KEY = "agt_live_env"; process.env.BROWSA_CAPTCHA_URL = "http://x.example/cap/";
  assert.equal(new CaptchaClient().baseUrl, "http://x.example/cap");
  delete process.env.BROWSA_API_KEY;
  assert.throws(() => new CaptchaClient(), /apiKey/);
  if (saved.k) process.env.BROWSA_API_KEY = saved.k;
  if (saved.u) process.env.BROWSA_CAPTCHA_URL = saved.u; else delete process.env.BROWSA_CAPTCHA_URL;
});

test("TwoCaptchaSolver answers like @2captcha/captcha-solver", async () => {
  const solver = new TwoCaptchaSolver(KEY, 5, { baseUrl: url });
  assert.deepEqual(await solver.recaptcha({ pageurl: "https://a.example/login", googlekey: "6Lk" }), { data: "03AF-token", id: "t-ReCaptchaV2TaskProxyLess" });
  api.calls = [];
  const r = await solver.recaptcha({ pageurl: "https://a.example", googlekey: "6Lk", version: "v3", action: "login", proxy: "u:p@1.2.3.4:3128", proxytype: "HTTPS" });
  assert.equal(r.data, "03AF-token");
  assert.deepEqual(api.calls[0].body.task, { type: "ReCaptchaV3Task", websiteURL: "https://a.example", websiteKey: "6Lk", proxy: "https://u:p@1.2.3.4:3128", pageAction: "login" });
  assert.equal((await solver.cloudflareTurnstile({ pageurl: "https://a.example", sitekey: "0x4", action: "a", data: "c" })).data, "0.cf-token");
  assert.deepEqual(await solver.imageCaptcha({ body: "iVBORw==" }), { data: "x7Kp2", id: "t-img" });
  assert.equal(await solver.balance(), 4.2);
  await assert.rejects(solver.cloudflareTurnstile({ pageurl: "https://a.example", sitekey: "" }), /required/);
});

test("useWithAntiCaptcha sends the library's requests to Browsa", async () => {
  // The parts of @antiadmin/anticaptchaofficial the bridge touches.
  const ac = {
    settings: { clientKey: "" },
    setAPIKey(k) { this.settings.clientKey = k; },
    async JSONRequest() { throw new Error("the real host would be called"); },
    checkForErrors(r) { if (r.errorId > 0) throw r.errorCode; return r; },
    async solveTurnstileProxyless(websiteURL, websiteKey, action = "", cData = "") {
      const created = await this.JSONRequest("createTask", { clientKey: this.settings.clientKey,
        task: { type: "TurnstileTaskProxyless", websiteURL, websiteKey, action, cData, chlPageData: null }, softId: 0 });
      for (;;) {
        const r = await this.JSONRequest("getTaskResult", { clientKey: this.settings.clientKey, taskId: created.taskId });
        if (r.status === "ready") return r.solution.token;
      }
    },
  };
  const undo = useWithAntiCaptcha(ac, { baseUrl: url });
  ac.setAPIKey(KEY);
  api.calls = [];
  assert.equal(await ac.solveTurnstileProxyless("https://a.example", "0x4", "login"), "0.cf-token");
  assert.deepEqual(api.calls[0].body.task, { type: "AntiTurnstileTaskProxyLess", websiteURL: "https://a.example", websiteKey: "0x4", metadata: { action: "login" } });
  ac.setAPIKey("agt_live_wrong");
  await assert.rejects(ac.JSONRequest("getBalance", { clientKey: "agt_live_wrong" }), (e) => e === "ERROR_KEY_DENIED_ACCESS");
  undo();
  await assert.rejects(ac.JSONRequest("getBalance", {}), /real host/);
});
