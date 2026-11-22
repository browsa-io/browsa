// Captcha client: held calls (waitSeconds), cost on solutions, reports, the type
// catalogue, against a local stand-in of the captcha API (no network).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

import { CaptchaClient, CaptchaError, captchaTasks as tasks, TwoCaptchaSolver, CAPTCHA_TASK_TYPES, normalizeCaptchaTask } from "../dist/index.js";
import { verifySignature } from "../dist/webhooks.js";

const KEY = "agt_live_test";
const SECRET = "ab".repeat(32);
const COST = { charged: true, amount: 0.008, unit: "credits", credits: 0.008, note: "Charged once, for this solve." };
const ok = (o) => ({ errorId: 0, errorCode: "", errorDescription: "", ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = { calls: [], reported: new Map(), holdMs: 1100, holds: true };
async function handle(method, path, body) {
  api.calls.push({ method, path, body });
  if (path === "/types") {
    return { errorId: 0, types: [{ type: "ImageToTextTask", status: "live", required: [], optional: [], price: { usdPer1000: 0.4, creditsPerSolve: 0.004 }, measured: [] }] };
  }
  if (body.clientKey !== KEY) return { errorId: 1, errorCode: "ERROR_KEY_DENIED_ACCESS", errorDescription: "no", fix: "Send your key.", charged: false };
  if (path === "/createTask") return ok({ taskId: "t-1", ...(body.waitSeconds ? { status: "processing" } : {}) });
  if (path === "/getTaskResult") {
    const n = api.calls.filter((c) => c.path === path).length;
    if (body.waitSeconds && api.holds) await sleep(Math.min(api.holdMs, body.waitSeconds * 1000));
    else if (n < 3) return ok({ taskId: "t-1", status: "processing" });
    return ok({ taskId: "t-1", status: "ready", solution: { token: "0.cf" }, cost: COST, solveSeconds: 6.42 });
  }
  if (path === "/reportCorrect" || path === "/reportIncorrect") {
    const id = body.taskId;
    if (api.reported.has(id)) {
      return { errorId: 1, errorCode: "ERROR_ALREADY_REPORTED", taskId: id, charged: false,
        errorDescription: "this solve was already reported.", fix: "Nothing to do: the first report stands, and a refund is made only once." };
    }
    const wrong = path === "/reportIncorrect";
    api.reported.set(id, wrong);
    return ok({ taskId: id, status: "success", outcome: wrong ? "incorrect" : "correct", refunded: wrong,
      refund: { amount: wrong ? 0.008 : 0, unit: "credits" }, message: "Recorded." });
  }
  if (path === "/getCallbackSecret") return ok({ secret: SECRET });
  if (path === "/rotateCallbackSecret") return ok({ secret: "cd".repeat(32), rotated: true });
  return { errorId: 1, errorCode: "ERROR_BAD_REQUEST", errorDescription: "unknown method" };
}

let srv, url;
before(async () => {
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const out = await handle(req.method, req.url, raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());
beforeEach(() => { api.calls.length = 0; api.reported.clear(); api.holds = true; api.holdMs = 1100; });

const client = (o = {}) => new CaptchaClient({ apiKey: KEY, baseUrl: url, ...o });
const turnstile = () => tasks.turnstile("https://a.example", "0x4");

test("solve asks the API to hold and does not sleep between calls", async () => {
  const cap = client({ pollIntervalMs: 30_000 });          // a poll timer would make this take 30 s
  const t0 = Date.now();
  const sol = await cap.solve(turnstile());
  const took = Date.now() - t0;
  assert.equal(sol.token, "0.cf");
  assert.ok(took > 1000 && took < 5000, String(took));
  assert.deepEqual(api.calls.map((c) => [c.path, c.body.waitSeconds]), [["/createTask", 20], ["/getTaskResult", 20]]);
});

test("the wait never outlasts the HTTP timeout or the deadline", async () => {
  await client({ timeoutMs: 12_000 }).solve(turnstile());
  assert.equal(api.calls[0].body.waitSeconds, 7);          // 12 s request, 5 s of margin
  api.calls.length = 0;
  await client().solve(turnstile(), { timeoutMs: 4000 });
  assert.ok(api.calls[0].body.waitSeconds <= 4);
});

test("waitSeconds 0 polls as before", async () => {
  const sol = await client({ waitSeconds: 0, pollIntervalMs: 10 }).solve(turnstile());
  assert.equal(sol.token, "0.cf");
  assert.ok(api.calls.every((c) => !("waitSeconds" in c.body)));
});

test("a server that does not hold is polled, not hammered", async () => {
  api.holds = false;
  const t0 = Date.now();
  await client({ pollIntervalMs: 150 }).solve(turnstile());
  assert.ok(Date.now() - t0 >= 280, "two sleeps of 150 ms");
});

test("a solution carries its cost and time, and stays the plain solution", async () => {
  const sol = await client().solve(turnstile());
  assert.deepEqual(sol.cost, COST);
  assert.equal(sol.solveSeconds, 6.42);
  assert.equal(sol.taskId, "t-1");
  assert.deepEqual({ ...sol }, { token: "0.cf" });
  assert.equal(JSON.stringify(sol), '{"token":"0.cf"}');
});

test("createTask and getTaskResult take waitSeconds; nothing is sent when not asked", async () => {
  const cap = client();
  await cap.createTask(turnstile(), { waitSeconds: 10 });
  assert.equal(api.calls.at(-1).body.waitSeconds, 10);
  assert.equal("callbackUrl" in api.calls.at(-1).body, false);
  await cap.createTask(turnstile());
  assert.deepEqual(Object.keys(api.calls.at(-1).body).sort(), ["clientKey", "task"]);
  api.holdMs = 0;
  await cap.getTaskResult("t-1", { waitSeconds: 5 });
  assert.deepEqual(api.calls.at(-1).body, { clientKey: KEY, taskId: "t-1", waitSeconds: 5 });
  await cap.getTaskResult("t-1");
  assert.deepEqual(api.calls.at(-1).body, { clientKey: KEY, taskId: "t-1" });
});

test("reportIncorrect refunds; a second report throws with fix and charged", async () => {
  const cap = client();
  const r = await cap.reportIncorrect("t-1");
  assert.deepEqual([r.outcome, r.refunded, r.refund.amount], ["incorrect", true, 0.008]);
  assert.deepEqual([api.calls.at(-1).path, api.calls.at(-1).body], ["/reportIncorrect", { clientKey: KEY, taskId: "t-1" }]);
  await assert.rejects(() => cap.reportIncorrect("t-1"), (e) => {
    assert.ok(e instanceof CaptchaError);
    assert.deepEqual([e.code, e.taskId, e.charged], ["ERROR_ALREADY_REPORTED", "t-1", false]);
    assert.match(e.fix, /^Nothing to do/);
    return true;
  });
  assert.equal((await cap.reportCorrect("t-2")).outcome, "correct");
  assert.equal((await cap.report("t-3", false)).refunded, true);
});

test("errors carry fix and charged", async () => {
  await assert.rejects(() => new CaptchaClient({ apiKey: "agt_live_wrong", baseUrl: url }).getBalance(), (e) => {
    assert.deepEqual([e.code, e.fix, e.charged], ["ERROR_KEY_DENIED_ACCESS", "Send your key.", false]);
    return true;
  });
});

test("listTypes is a GET that sends no key", async () => {
  const types = await client().listTypes();
  assert.deepEqual([types[0].type, types[0].status], ["ImageToTextTask", "live"]);
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/types", body: {} });
});

// The service's signature (services/captcha-api README): key = the secret's bytes from hex, message = "<t>.<raw body>".
const sign = (raw, secretHex, t) => `t=${t}, v1=${createHmac("sha256", Buffer.from(secretHex, "hex")).update(`${t}.${raw}`).digest("hex")}`;

test("callbackUrl is sent on createTask and solve, and only when given", async () => {
  const cap = client();
  await cap.createTask(turnstile(), { callbackUrl: "https://hooks.example.com/c" });
  assert.equal(api.calls.at(-1).body.callbackUrl, "https://hooks.example.com/c");
  api.holdMs = 0;
  api.calls.length = 0;
  const sol = await cap.solve(turnstile(), { callbackUrl: "https://hooks.example.com/c" });
  assert.equal(sol.token, "0.cf");
  const created = api.calls.filter((c) => c.path === "/createTask");
  assert.equal(created.length, 1);
  assert.equal(created[0].body.callbackUrl, "https://hooks.example.com/c");
  assert.ok(api.calls.filter((c) => c.path === "/getTaskResult").every((c) => !("callbackUrl" in c.body)));
});

test("callbackSecret, rotateCallbackSecret, and the webhooks verifier takes the hex secret", async () => {
  const cap = client();
  const secret = await cap.callbackSecret();
  assert.equal(secret, SECRET);
  assert.deepEqual([api.calls.at(-1).path, api.calls.at(-1).body], ["/getCallbackSecret", { clientKey: KEY }]);
  const raw = '{"taskId":"t-1","status":"ready"}';
  const t = Math.floor(Date.now() / 1000);
  const header = sign(raw, secret, t);
  assert.equal(verifySignature(raw, header, secret), true);
  assert.equal(verifySignature(Buffer.from(raw), header, secret), true);
  assert.equal(verifySignature(raw + " ", header, secret), false);            // body changed
  assert.equal(verifySignature(raw, sign(raw, secret, t - 301), secret), false); // older than 5 minutes
  const rotated = await cap.rotateCallbackSecret();
  assert.equal(rotated, "cd".repeat(32));
  assert.equal(api.calls.at(-1).path, "/rotateCallbackSecret");
  assert.equal(verifySignature(raw, header, rotated), false);                 // signed with the old one
});

test("a receiver echoes the challenge once per host and drops a repeat", () => {
  const seen = new Set();
  const handle = (raw, header) => {
    if (!verifySignature(raw, header ?? "", SECRET)) return [401, "bad signature"];
    const msg = JSON.parse(raw);
    if (msg.type === "callback.verify") return [200, JSON.stringify({ challenge: msg.challenge })];
    if (seen.has(msg.taskId)) return [200, "duplicate"];
    seen.add(msg.taskId);
    return [200, "ok"];
  };
  const t = Math.floor(Date.now() / 1000);
  const verify = JSON.stringify({ type: "callback.verify", challenge: "c-123" });
  assert.deepEqual(handle(verify, sign(verify, SECRET, t)), [200, '{"challenge":"c-123"}']);
  const done = JSON.stringify({ errorId: 0, taskId: "t-1", status: "ready", solution: { token: "x" } });
  assert.deepEqual(handle(done, sign(done, SECRET, t)), [200, "ok"]);
  assert.deepEqual(handle(done, sign(done, SECRET, t)), [200, "duplicate"]);
  assert.equal(handle(done, sign(done, "ef".repeat(32), t))[0], 401);          // another account's secret
  assert.equal(handle(done, undefined)[0], 401);
});

test("question, drag and box builders", () => {
  assert.deepEqual(tasks.textQuestion("If tomorrow is Saturday, what day is today?", { websiteURL: "https://a.example/" }),
    { type: "TextCaptchaTask", comment: "If tomorrow is Saturday, what day is today?", websiteURL: "https://a.example/" });
  assert.deepEqual(tasks.dragDrop(new Uint8Array([98, 103]), ["cDE=", new Uint8Array([112, 50])]),
    { type: "DragDropTask", body: "Ymc=", pieces: ["cDE=", "cDI="] });
  assert.deepEqual(tasks.boundingBox("aW1n", "the red car", { many: true }),
    { type: "BoundingBoxTask", body: "aW1n", comment: "the red car", many: true });
  assert.equal("many" in tasks.boundingBox("aW1n", "the red car"), false);
  assert.throws(() => tasks.textQuestion(" "), TypeError);
  assert.throws(() => tasks.dragDrop("bg", []), TypeError);
  assert.throws(() => tasks.dragDrop("bg", Array(7).fill("p")), TypeError);
  assert.throws(() => tasks.boundingBox("aW1n", ""), TypeError);
});

test("a missing key says which variable to set and where to create a key", () => {
  const saved = process.env.BROWSA_API_KEY;
  delete process.env.BROWSA_API_KEY;
  try {
    assert.throws(() => new CaptchaClient(), /apiKey is required: pass apiKey or set BROWSA_API_KEY\. Create a key at https:\/\/app\.browsa\.io\/dashboard\/keys/);
  } finally {
    if (saved !== undefined) process.env.BROWSA_API_KEY = saved;
  }
});

test("drop-in shim: goodReport and badReport", async () => {
  const solver = new TwoCaptchaSolver(KEY, 5000, { baseUrl: url });
  assert.equal((await solver.badReport("t-9")).refunded, true);
  assert.equal(api.calls.at(-1).path, "/reportIncorrect");
  assert.equal((await solver.goodReport("t-10")).outcome, "correct");
});

test("new builders use the catalogue's names", () => {
  const v3 = tasks.geetestSlideV3("a", "b", { cssWidth: 260 });
  assert.deepEqual(v3, { type: "GeeTestSlide", version: 3, imageBackground: "a", imageFull: "b", cssWidth: 260 });
  assert.equal(tasks.geetestSlideV3("a", "b", { shuffled: false }).shuffled, false);
  assert.deepEqual(tasks.geetestSlideV4("a", "b", { top: 80, bgCssWidth: 300, sliceCssWidth: 60 }),
    { type: "GeeTestSlide", version: 4, imageBackground: "a", imageSlice: "b", top: 80, bgCssWidth: 300, sliceCssWidth: 60 });
  assert.deepEqual(tasks.cloudflareChallenge("https://a.example/", { host: "203.0.113.7", port: 8080 }, { userAgent: "UA" }),
    { type: "AntiCloudflareTask", websiteURL: "https://a.example/", proxy: "http://203.0.113.7:8080", userAgent: "UA" });
  assert.throws(() => tasks.cloudflareChallenge("https://a.example/", ""), TypeError);
  assert.ok(CAPTCHA_TASK_TYPES.includes("GeeTestSlide") && CAPTCHA_TASK_TYPES.includes("AntiCloudflareTask"));
  assert.equal(normalizeCaptchaTask({ type: "anticloudflaretask", proxy: "http://h:1" }).type, "AntiCloudflareTask");
});

test("CAPTCHA_TASK_TYPES knows every type GET /types listed as live on 2026-11-22", () => {
  const live = ["ImageToTextTask", "ReCaptchaV2Classification", "AwsWafClassification", "GeeTestSlide", "RotateTask",
    "ClickOrderTask", "GeeTestGridTask", "GeeTestIconTask", "GeeTestNineTask", "GeeTestShapeTask", "SliderGapTask",
    "TileSwapTask", "JigsawTask", "MtCaptchaTask", "CyberSiaraTask", "AudioTask", "HCaptchaTask", "TextCaptchaTask",
    "BoundingBoxTask", "DragDropTask", "AntiTurnstileTaskProxyLess", "AntiTurnstileTask", "ReCaptchaV3TaskProxyLess",
    "ReCaptchaV3Task", "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask", "ReCaptchaV2TaskProxyLess",
    "ReCaptchaV2Task", "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask", "AntiCloudflareTask"];
  assert.equal(new Set(live).size, 31);
  for (const t of live) assert.ok(CAPTCHA_TASK_TYPES.includes(t), t);
  assert.equal(new Set(CAPTCHA_TASK_TYPES).size, CAPTCHA_TASK_TYPES.length);
});
