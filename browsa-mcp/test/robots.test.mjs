// Offline tests for the robot tools: the MCP server runs over stdio against a
// local mock of the Browsa API (no network, no real keys).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const RUN = {
  id: "rr1", robot_id: "rb1", trigger: "api", status: "queued", rows_total: 2, rows_ok: 0, rows_failed: 0,
  rows_pending: 2, credits: 0, stop_reason: null, finished_at: null,
};
const DONE = {
  ...RUN, status: "partial", rows_ok: 1, rows_failed: 1, rows_pending: 0, credits: 3, finished_at: "2026-11-19T00:01:00Z",
  rows: [
    { row: 0, input: { url: "https://a" }, status: "ok", output: { price: 18 }, error_code: null, error_message: null,
      credits: 3, recipe_run_id: "x1", duration_ms: 2100, alerts: [], changed_fields: ["price"] },
    { row: 1, input: { url: "https://b" }, status: "failed", output: null, error_code: "blocked", error_message: "bot wall",
      credits: 0, recipe_run_id: "x2", duration_ms: null, alerts: [], changed_fields: [] },
  ],
};
const ROBOT = {
  id: "rb1", name: "Book prices", status: "active", paused_reason: null, recipe_id: "r1", inputs_count: 2,
  inputs: [{ url: "https://a" }, { url: "https://b" }],
  schedule: { id: "s1", interval_seconds: 86400, enabled: true, next_run_at: "2026-11-20T09:00:00Z", at: "09:00", tz: "UTC" },
  settings: { model: null, proxy: { network: "residential", country: "us" }, browser: null },
  health: { pass_rate: 0.5, price_credits: 3, last_failure: "blocked" },
  alerts_unread: 0, last_run: DONE,
};

function startMockApi() {
  const calls = [];
  let polls = 0;
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && u.pathname === "/v1/robots") return send(200, { robots: [ROBOT] });
      if (req.method === "POST" && u.pathname === "/v1/robots/rb1/run") return send(202, RUN);
      if (req.method === "POST" && u.pathname === "/v1/robots/off/run") {
        return send(503, { code: "ROBOTS_UNAVAILABLE", error: "robots are paused", request_id: "r-1" });
      }
      if (req.method === "GET" && u.pathname === "/v1/robot-runs/rr1") {
        polls += 1;
        return send(200, polls < 2 ? { ...RUN, status: "running" } : DONE);
      }
      send(404, { code: "NOT_FOUND", error: "no mock" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close(), resetPolls: () => { polls = 0; },
  })));
}

function startMcp(baseUrl) {
  const env = { ...process.env, BROWSA_API_KEY: "agt_test_x", BROWSA_BASE_URL: baseUrl, BROWSA_MCP_TOOLS: "all", BROWSA_ROBOT_POLL_MS: "20" };
  for (const k of ["BROWSA_LLM_API_KEY", "BROWSA_LLM_KEY_ID", "BROWSA_LLM", "BROWSA_COUNTRY"]) delete env[k];
  const child = spawn("node", ["dist/server.js"], { env, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const msg = JSON.parse(line); waiters.get(msg.id)?.(msg); waiters.delete(msg.id); } catch { /* not a frame */ }
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

describe("MCP robot tools", () => {
  let api, mcp;
  before(async () => { api = await startMockApi(); mcp = startMcp(api.url); await mcp.init(); });
  after(() => { mcp?.kill(); api?.close(); });

  test("tools/list has the three robot tools with plain descriptions", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    for (const n of ["list_robots", "run_robot", "get_robot_run"]) {
      assert.ok(byName[n], n);
      assert.ok(!/—/.test(byName[n].description), "em dash");
      assert.ok(!/chromium/i.test(byName[n].description));
    }
    assert.deepEqual(byName.run_robot.inputSchema.required, ["robot_id"]);
    assert.match(byName.run_robot.description, /price_credits per successful row/);
  });

  test("list_robots returns a compact view with price, health, schedule and settings", async () => {
    const r = await mcp.call("list_robots", { limit: 5 });
    assert.equal(r.isError, false);
    const rb = r.body.robots[0];
    assert.equal(rb.id, "rb1");
    assert.equal(rb.price_credits, 3);
    assert.equal(rb.pass_rate, 0.5);
    assert.equal(rb.inputs_count, 2);
    assert.equal(rb.schedule.interval_seconds, 86400);
    assert.deepEqual(rb.settings.proxy, { network: "residential", country: "us" });
    assert.equal(rb.last_run.credits, 3);
    assert.equal(api.calls.at(-1).query.limit, "5");
  });

  test("run_robot without wait returns the queued run and sends the rows", async () => {
    const r = await mcp.call("run_robot", { robot_id: "rb1", inputs: [{ url: "https://c" }] });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "queued");
    const post = api.calls.filter((c) => c.method === "POST").at(-1);
    assert.deepEqual(post.body, { inputs: [{ url: "https://c" }] });
  });

  test("run_robot with wait_seconds polls until the run ends and returns rows", async () => {
    api.resetPolls();
    const r = await mcp.call("run_robot", { robot_id: "rb1", wait_seconds: 10 });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "partial");
    assert.equal(r.body.credits, 3);
    assert.equal(r.body.rows.length, 2);
    assert.deepEqual(r.body.rows[0].changed_fields, ["price"]);
    assert.equal(r.body.rows[1].error_code, "blocked");
    assert.equal(r.body.rows[1].credits, 0);
  });

  test("get_robot_run returns rows", async () => {
    api.resetPolls();
    await mcp.call("get_robot_run", { run_id: "rr1" });
    const r = await mcp.call("get_robot_run", { run_id: "rr1" });
    assert.equal(r.body.rows[0].output.price, 18);
  });

  test("API errors come back with their code", async () => {
    const r = await mcp.call("run_robot", { robot_id: "off" });
    assert.equal(r.isError, true);
    assert.equal(r.body.code, "ROBOTS_UNAVAILABLE");
    assert.equal(r.body.status, 503);
  });
});
