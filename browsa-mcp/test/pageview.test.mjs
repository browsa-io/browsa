// Offline tests for the observe and act tools: the MCP server runs over
// stdio against a local mock of the Browsa API (no network, no real keys).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const VIEW = 'page "Sign up" https://example.com/  scroll 0 of 713, viewport 1280x713\n[3] textbox "Name"  empty\n[5] button "Greet"\ndialog: none  frames: none';

function startMockApi() {
  const calls = [];
  const state = { session: "pv_a", tabs: 1 };
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method, path: u.pathname, body });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== "POST") return send(404, { code: "NOT_FOUND", error: "no mock" });
      if (u.pathname === "/v1/agents/agt_gone/observe") {
        return send(409, { code: "AGENT_NOT_RUNNING", error: "agent is destroyed", request_id: "r-1" });
      }
      const tabs = [{ id: "T1", url: "https://example.com/", title: "Sign up", active: true }];
      if (state.tabs > 1) tabs.push({ id: "T2", url: "https://example.org/", title: "Other", active: false });
      if (u.pathname === "/v1/agents/agt_1/observe") {
        return send(200, { text: VIEW, state: "ok", url: "https://example.com/", title: "Sign up", tab: "T1", tabs, session: state.session, ids_reset: false });
      }
      if (u.pathname === "/v1/agents/agt_1/act") {
        if (body.id && body.session !== state.session) {
          return send(200, { text: "stale: element ids were reset (the view session was restarted); nothing was done; a new view follows\n" + VIEW,
            status: "stale", action: body.action, tab: "T1", session: state.session, ids_reset: true });
        }
        return send(200, { text: `after: ${body.action} [${body.id}]\n~ [3] textbox "Name"  value "Ada"\nsettled after 0 ms, no requests`,
          status: "ok", action: body.action, tab: "T1", session: state.session, ids_reset: false });
      }
      send(404, { code: "NOT_FOUND", error: "no mock" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, state, close: () => srv.close(),
  })));
}

function startMcp(baseUrl) {
  const env = { ...process.env, BROWSA_API_KEY: "agt_test_x", BROWSA_BASE_URL: baseUrl };
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
    // the tools answer with the view or the diff as plain text
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      return { isError: !!r.result.isError, text: r.result.content[0].text };
    },
    kill: () => child.kill("SIGTERM"),
  };
}

describe("MCP observe and act", () => {
  let api, mcp;
  before(async () => { api = await startMockApi(); mcp = startMcp(api.url); await mcp.init(); });
  after(() => { mcp?.kill(); api?.close(); });

  test("tools/list has observe and act with the engine's action list", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(byName.observe.inputSchema.required, ["browser_id"]);
    assert.deepEqual(byName.act.inputSchema.required, ["browser_id", "action"]);
    assert.deepEqual(byName.act.inputSchema.properties.action.enum, [
      "click", "type", "press", "select", "check", "uncheck", "hover", "scroll",
      "navigate", "back", "forward", "reload", "wait", "upload", "dialog",
    ]);
    for (const t of [byName.observe, byName.act]) assert.ok(!/—/.test(t.description), "em dash");
  });

  test("observe returns the view as text and sends only what was given", async () => {
    const r = await mcp.call("observe", { browser_id: "agt_1", scope: "page", budget: 4000 });
    assert.equal(r.isError, false);
    assert.equal(r.text, VIEW);
    assert.deepEqual(api.calls.at(-1), { method: "POST", path: "/v1/agents/agt_1/observe", body: { scope: "page", budget: 4000 } });
  });

  test("act sends the action with the session of the last view", async () => {
    const r = await mcp.call("act", { browser_id: "agt_1", action: "type", id: 3, text: "Ada", clear: true });
    assert.equal(r.isError, false);
    assert.match(r.text, /^after: type \[3\]\n~ \[3\] textbox "Name"  value "Ada"/);
    assert.deepEqual(api.calls.at(-1).body, { action: "type", id: 3, text: "Ada", clear: true, session: "pv_a" });
  });

  test("ids from a lost view: the answer says stale and the next act carries the new session", async () => {
    api.state.session = "pv_b"; // the API restarted its view session
    const stale = await mcp.call("act", { browser_id: "agt_1", action: "click", id: 5 });
    assert.equal(stale.isError, false);
    assert.match(stale.text, /^stale: element ids were reset/);
    assert.ok(stale.text.includes('[5] button "Greet"'));
    const again = await mcp.call("act", { browser_id: "agt_1", action: "click", id: 5 });
    assert.equal(api.calls.at(-1).body.session, "pv_b");
    assert.match(again.text, /^after: click \[5\]/);
  });

  test("with more than one tab, observe lists the tab ids", async () => {
    api.state.tabs = 2;
    const r = await mcp.call("observe", { browser_id: "agt_1" });
    assert.ok(r.text.endsWith('\ntabs: T1 "Sign up" (this one) | T2 "Other"'), r.text);
  });

  test("an API error comes back as a tool error with its code", async () => {
    const r = await mcp.call("observe", { browser_id: "agt_gone" });
    assert.equal(r.isError, true);
    const body = JSON.parse(r.text);
    assert.equal(body.code, "AGENT_NOT_RUNNING");
    assert.equal(body.status, 409);
  });
});
