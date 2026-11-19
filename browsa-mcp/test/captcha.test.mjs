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
      if (body.clientKey !== KEY) return send({ errorId: 1, errorCode: "ERROR_KEY_DENIED_ACCESS", errorDescription: "clientKey is missing or invalid" });
      if (req.url === "/captcha-api/createTask") {
        const t = body.task;
        if (t.type === "ImageToTextTask") return send(ok({ taskId: "t-img", status: "ready", solution: { text: "x7Kp2" } }));
        if (t.type === "FunCaptchaTaskProxyLess") return send({ errorId: 1, errorCode: "ERROR_TASK_NOT_SUPPORTED", errorDescription: "not supported" });
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
      send({ errorId: 1, errorCode: "ERROR_BAD_REQUEST", errorDescription: "unknown method" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close(),
  })));
}

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
    assert.equal(init.result.serverInfo.version, "0.6.0");
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
