// 0.3.1: run_task and get_job say how the run ended. 0.3.0 returned only
// `status`, so a run that ended "completed" without doing the task looked
// like a success to the model reading the tool result.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const NOT_DONE = {
  id: "11111111-1111-4111-8111-111111111111", status: "completed", kind: "task", step_count: 4, progress_total: 20,
  outcome: "failed", outcome_message: "The agent finished but reported that it could not do the task; the result says what it found and what stopped it.",
  signals: ["bot_check_seen"], credits_charged: 7,
  result: { final_result: "No order number: the site has no Buy now button." },
};
const DONE = { id: "22222222-2222-4222-8222-222222222222", status: "completed", kind: "task", step_count: 2, progress_total: 20,
  outcome: "completed", outcome_message: "The task finished.", signals: [], result: { final_result: "Example Domain" } };

function startMockApi() {
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "POST" && u.pathname === "/v1/tasks") return send(202, { ...NOT_DONE, status: "queued", outcome: undefined, outcome_message: undefined, signals: [] });
      if (req.method === "GET" && u.pathname === `/v1/jobs/${NOT_DONE.id}`) return send(200, NOT_DONE);
      if (req.method === "GET" && u.pathname === `/v1/jobs/${DONE.id}`) return send(200, DONE);
      send(404, { code: "NOT_FOUND", error: "no mock" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

function startMcp(baseUrl) {
  const env = { ...process.env, BROWSA_API_KEY: "agt_test_x", BROWSA_BASE_URL: baseUrl, BROWSA_MCP_TOOLS: "all" };
  for (const k of ["BROWSA_LLM_API_KEY", "BROWSA_LLM_KEY_ID", "BROWSA_LLM", "BROWSA_COUNTRY"]) delete env[k];
  const child = spawn("node", ["dist/server.js"], { env, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8"); const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) { if (!line.trim()) continue; try { const msg = JSON.parse(line); waiters.get(msg.id)?.(msg); waiters.delete(msg.id); } catch { /* not a frame */ } }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id; const t = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 15_000);
    waiters.set(myId, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  return {
    async init() { await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); },
    rpc,
    async call(name, args = {}) { const r = await rpc("tools/call", { name, arguments: args }); return { isError: !!r.result.isError, body: JSON.parse(r.result.content[0].text) }; },
    kill: () => child.kill("SIGTERM"),
  };
}

describe("MCP job results carry the outcome", () => {
  let api, mcp;
  before(async () => { api = await startMockApi(); mcp = startMcp(api.url); await mcp.init(); });
  after(() => { mcp?.kill(); api?.close(); });

  test("get_job on a run that ended without doing the task", async () => {
    const r = await mcp.call("get_job", { job_id: NOT_DONE.id });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "completed");
    assert.equal(r.body.outcome, "failed");
    assert.match(r.body.outcome_message, /could not do the task/);
    assert.deepEqual(r.body.signals, ["bot_check_seen"]);
    assert.match(r.body.final_result, /no Buy now button/);
  });

  test("run_task returns the same fields", async () => {
    const r = await mcp.call("run_task", { task: "Buy it", llm: "browsa" });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "completed");
    assert.equal(r.body.outcome, "failed");
    assert.match(r.body.outcome_message, /could not do the task/);
    assert.equal(r.body.credits_charged, 7);
  });

  test("a finished task has outcome completed and no empty signals list", async () => {
    const r = await mcp.call("get_job", { job_id: DONE.id });
    assert.equal(r.body.outcome, "completed");
    assert.ok(!("signals" in r.body));
  });

  test("the run_task description tells the model to read outcome, and names no noVNC", async () => {
    const r = await mcp.rpc("tools/list", {});
    const t = r.result.tools.find((x) => x.name === "run_task");
    assert.match(t.description, /outcome/);
    assert.ok(!/noVNC/i.test(t.description));
  });
});
