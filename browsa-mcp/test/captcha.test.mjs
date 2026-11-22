// Offline tests for solve_captcha_task: the MCP server runs over stdio against
// a local stand-in of the captcha API (no network, no real keys).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const KEY = "agt_test_x";

function startMockCaptchaApi() {
  const calls = [];
  const polls = new Map();
  const ok = (o) => ({ errorId: 0, errorCode: "", errorDescription: "", ...o });
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body });
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.method === "GET" && req.url === "/captcha-api/types") return send({ errorId: 0, types: TYPES });
      if (body.clientKey !== KEY) return send({ errorId: 1, errorCode: "ERROR_KEY_DENIED_ACCESS", errorDescription: "clientKey is missing or invalid" });
      if (req.url === "/captcha-api/createTask") {
        const t = body.task;
        if (t.type === "ImageToTextTask") {
          return send(ok({ taskId: "t-img", status: "ready", solution: { text: "x7Kp2" }, solveSeconds: 3.1,
            cost: { charged: true, amount: 0.004, unit: "credits", credits: 0.004, note: "Charged once, for this solve." } }));
        }
        if (t.type === "FunCaptchaTaskProxyLess") {
          return send({ errorId: 1, errorCode: "ERROR_TASK_NOT_SUPPORTED", errorDescription: "not supported", charged: false,
            fix: "Type names are case-sensitive; GET /types lists every type with its parameters." });
        }
        const id = t.websiteKey === "bad" ? "t-bad" : t.websiteKey === "slow" ? "t-slow" : `t-${t.type}`;
        polls.set(id, 0);
        return send(ok({ taskId: id }));
      }
      if (req.url === "/captcha-api/getTaskResult") {
        const id = body.taskId;
        polls.set(id, (polls.get(id) ?? 0) + 1);
        if (id === "t-slow" || polls.get(id) < 2) return send(ok({ taskId: id, status: "processing" }));
        if (id === "t-bad") return send({ errorId: 1, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", errorDescription: "no token", taskId: id });
        return send(ok({ taskId: id, status: "ready", solution: id.includes("Turnstile")
          ? { token: "0.cf-token", type: "turnstile", userAgent: "UA" } : { gRecaptchaResponse: "03AF-token", userAgent: "UA" } }));
      }
      if (req.url === "/captcha-api/reportIncorrect" || req.url === "/captcha-api/reportCorrect") {
        if (body.taskId === "t-twice") {
          return send({ errorId: 1, errorCode: "ERROR_ALREADY_REPORTED", errorDescription: "this solve was already reported.",
            fix: "Nothing to do: the first report stands, and a refund is made only once.", charged: false, refunded: true, taskId: body.taskId });
        }
        const wrong = req.url.endsWith("Incorrect");
        return send(ok({ taskId: body.taskId, status: "success", outcome: wrong ? "incorrect" : "correct", refunded: wrong,
          refund: { amount: wrong ? 0.004 : 0, unit: "credits" }, message: wrong ? "Recorded as incorrect. Refunded 0.004 credits." : "Recorded as correct." }));
      }
      send({ errorId: 1, errorCode: "ERROR_BAD_REQUEST", errorDescription: "unknown method" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close(),
  })));
}

const TYPES = [
  { type: "ImageToTextTask", title: "Image text", summary: "Read the characters in a picture captcha.", kind: "recognition", status: "live",
    required: [], requiredOneOf: [[{ name: "body", type: "string", description: "One picture." }, { name: "images", type: "array", description: "1 to 9 pictures." }]],
    optional: [{ name: "module", type: "string", description: "Ignored." }], proxy: "none", price: { usdPer1000: 0.4, creditsPerSolve: 0.004 },
    measured: [{ row: "image_text", name: "Image text type the characters", attempts: 30, passes: 28, passRate: 0.933, medianSeconds: 6.2, measuredOn: "2026-11-16", exit: "Data center" }] },
  { type: "VisionEngine", title: "Slider gap", summary: "The gap of a slider puzzle.", kind: "recognition", status: "off", offReason: "switched off until a measured run passes",
    required: [{ name: "module", type: "string", description: "slider_1" }, { name: "imageBackground", type: "string", description: "The background." }],
    optional: [], proxy: "none", price: { usdPer1000: 0.8, creditsPerSolve: 0.008 }, measured: [] },
];

function startMcp(env) {
  const e = { ...process.env, BROWSA_API_KEY: KEY, BROWSA_CAPTCHA_POLL_MS: "20", BROWSA_MCP_TOOLS: "all", ...env };
  delete e.BROWSA_CAPTCHA_URL;
  Object.assign(e, env);
  const child = spawn("node", ["dist/server.js"], { env: e, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); waiters.get(m.id)?.(m); waiters.delete(m.id); } catch { /* not a frame */ }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const t = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 15_000);
    waiters.set(myId, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    rpc,
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      return { isError: !!r.result.isError, body: JSON.parse(r.result.content[0].text) };
    },
    kill: () => child.kill("SIGTERM"),
  };
}

describe("MCP solve_captcha_task", () => {
  let api, mcp;
  before(async () => {
    api = await startMockCaptchaApi();
    // BROWSA_BASE_URL alone: the captcha API is at <base>/captcha-api
    mcp = startMcp({ BROWSA_BASE_URL: api.url });
    await mcp.init();
  });
  after(() => { mcp?.kill(); api?.close(); });

  test("listed, with a description that points to the measured types and claims no rate", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    const t = byName.solve_captcha_task;
    assert.ok(t);
    assert.deepEqual(t.inputSchema.required, ["task"]);
    assert.match(t.description, /browsa\.io\/captcha/);
    assert.ok(!/\d+ ?%/.test(t.description), "a rate is written into the description");
    assert.ok(!/hCaptcha|FunCaptcha|ALTCHA/.test(byName.run_task.description), "run_task lists unmeasured types");
    const init = await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.serverInfo.version, "0.8.1");
  });

  test("recognition: answered in createTask", async () => {
    const r = await mcp.call("solve_captcha_task", { task: { type: "ImageToTextTask", body: "iVBORw==" } });
    assert.equal(r.isError, false);
    assert.deepEqual(r.body.solution, { text: "x7Kp2" });
    assert.equal(r.body.task_id, "t-img");
    assert.equal(api.calls.at(-1).body.clientKey, KEY);
  });

  test("token: polled until ready; another service's type name is sent as Browsa's", async () => {
    const r = await mcp.call("solve_captcha_task", { task: { type: "TurnstileTaskProxyless", websiteURL: "https://a.example", websiteKey: "0x4" } });
    assert.equal(r.isError, false);
    assert.equal(r.body.solution.token, "0.cf-token");
    assert.equal(r.body.type, "AntiTurnstileTaskProxyLess");
    const created = api.calls.find((c) => c.path === "/captcha-api/createTask" && c.body.task.websiteKey === "0x4");
    assert.equal(created.body.task.type, "AntiTurnstileTaskProxyLess");
  });

  test("errors carry the API's code and say nothing was charged", async () => {
    let r = await mcp.call("solve_captcha_task", { task: { type: "ReCaptchaV2TaskProxyLess", websiteURL: "https://a.example", websiteKey: "bad" } });
    assert.equal(r.isError, true);
    assert.equal(r.body.code, "ERROR_CAPTCHA_UNSOLVABLE");
    assert.equal(r.body.charged, false);
    r = await mcp.call("solve_captcha_task", { task: { type: "FunCaptchaTaskProxyLess", websiteURL: "https://a.example", websiteKey: "k" } });
    assert.equal(r.body.code, "ERROR_TASK_NOT_SUPPORTED");
    assert.equal(r.body.measured_types, "https://browsa.io/captcha");
    r = await mcp.call("solve_captcha_task", { task: {} });
    assert.equal(r.isError, true);
  });

  test("local timeout returns the task id", async () => {
    const r = await mcp.call("solve_captcha_task", { task: { type: "ReCaptchaV3TaskProxyLess", websiteURL: "https://a.example", websiteKey: "slow" }, timeout_seconds: 5 });
    assert.equal(r.isError, true);
    assert.equal(r.body.code, "TIMEOUT");
    assert.equal(r.body.task_id, "t-slow");
  });
});

describe("MCP captcha: waits, cost, the type list and reports", () => {
  let api, mcp;
  before(async () => {
    api = await startMockCaptchaApi();
    mcp = startMcp({ BROWSA_BASE_URL: api.url });
    await mcp.init();
  });
  after(() => { mcp?.kill(); api?.close(); });

  test("both tools are listed in the captcha group, and name no other company", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    assert.ok(byName.list_captcha_types && byName.report_captcha_result);
    assert.deepEqual(byName.report_captcha_result.inputSchema.required, ["task_id", "correct"]);
    const text = JSON.stringify([byName.list_captcha_types, byName.report_captcha_result]);
    assert.ok(!/capsolver|anti-captcha|capmonster|2captcha|chromium|\d+ ?%/i.test(text));
  });

  test("solve asks the API to hold the call and passes cost and time on", async () => {
    const r = await mcp.call("solve_captcha_task", { task: { type: "ImageToTextTask", body: "iVBORw==" } });
    assert.equal(r.isError, false);
    assert.equal(r.body.seconds, 3.1);
    assert.deepEqual([r.body.cost.charged, r.body.cost.credits], [true, 0.004]);
    assert.match(r.body.next, /report_captcha_result/);
    const created = api.calls.findLast((c) => c.path === "/captcha-api/createTask");
    assert.equal(created.body.waitSeconds, 20);
    const t = await mcp.call("solve_captcha_task", { task: { type: "ReCaptchaV3TaskProxyLess", websiteURL: "https://a.example", websiteKey: "k" } });
    assert.equal(t.isError, false);
    const poll = api.calls.findLast((c) => c.path === "/captcha-api/getTaskResult");
    assert.ok(poll.body.waitSeconds >= 1 && poll.body.waitSeconds <= 20);
  });

  test("an unknown type points at list_captcha_types and passes the API's fix on", async () => {
    const r = await mcp.call("solve_captcha_task", { task: { type: "FunCaptchaTaskProxyLess", websiteURL: "https://a.example", websiteKey: "k" } });
    assert.equal(r.isError, true);
    assert.match(r.body.next, /list_captcha_types/);
    assert.match(r.body.fix, /case-sensitive/);
    assert.equal(r.body.charged, false);
  });

  test("list_captcha_types: compact list, live_only, and one type in full; no key is sent", async () => {
    const all = await mcp.call("list_captcha_types");
    assert.equal(all.isError, false);
    assert.deepEqual(all.body.types.map((t) => [t.type, t.status]), [["ImageToTextTask", "live"], ["VisionEngine", "off"]]);
    const img = all.body.types[0];
    assert.deepEqual(img.required, ["body or images"]);
    assert.deepEqual(img.optional, ["module"]);
    assert.equal(img.credits_per_solve, 0.004);
    assert.deepEqual(img.measured, [{ what: "Image text type the characters", passes: "28 of 30", median_seconds: 6.2, measured_on: "2026-11-16", exit: "Data center" }]);
    assert.match(all.body.types[1].off_reason, /measured run/);
    const call = api.calls.findLast((c) => c.path === "/captcha-api/types");
    assert.deepEqual(call.body, {});
    const live = await mcp.call("list_captcha_types", { live_only: true });
    assert.deepEqual(live.body.types.map((t) => t.type), ["ImageToTextTask"]);
    const one = await mcp.call("list_captcha_types", { type: "visionengine" });
    assert.equal(one.body.type, "VisionEngine");
    assert.equal(one.body.required[0].description, "slider_1");
    const none = await mcp.call("list_captcha_types", { type: "Nope" });
    assert.equal(none.isError, true);
    assert.deepEqual(none.body.types, ["ImageToTextTask", "VisionEngine"]);
  });

  test("report_captcha_result: refund on incorrect, record on correct, one report per task", async () => {
    const bad = await mcp.call("report_captcha_result", { task_id: "t-img", correct: false });
    assert.equal(bad.isError, false);
    assert.deepEqual([bad.body.outcome, bad.body.refunded, bad.body.refund.amount], ["incorrect", true, 0.004]);
    assert.deepEqual(api.calls.at(-1).body, { clientKey: KEY, taskId: "t-img" });
    assert.equal(api.calls.at(-1).path, "/captcha-api/reportIncorrect");
    const good = await mcp.call("report_captcha_result", { task_id: "t-2", correct: true });
    assert.deepEqual([good.body.outcome, good.body.refunded], ["correct", false]);
    assert.equal(api.calls.at(-1).path, "/captcha-api/reportCorrect");
    const twice = await mcp.call("report_captcha_result", { task_id: "t-twice", correct: false });
    assert.equal(twice.isError, true);
    assert.deepEqual([twice.body.code, twice.body.refunded], ["ERROR_ALREADY_REPORTED", true]);
    assert.match(twice.body.fix, /first report stands/);
    assert.equal((await mcp.call("report_captcha_result", { task_id: "t-3" })).isError, true);
    assert.equal((await mcp.call("report_captcha_result", { correct: true })).isError, true);
  });
});

describe("MCP solve_captcha_task: BROWSA_CAPTCHA_URL", () => {
  test("wins over BROWSA_BASE_URL", async () => {
    const api = await startMockCaptchaApi();
    const mcp = startMcp({ BROWSA_BASE_URL: "http://127.0.0.1:9", BROWSA_CAPTCHA_URL: `${api.url}/captcha-api/` });
    await mcp.init();
    try {
      const r = await mcp.call("solve_captcha_task", { task: { type: "ImageToTextTask", body: "iVBORw==" } });
      assert.equal(r.isError, false);
    } finally { mcp.kill(); api.close(); }
  });
});
