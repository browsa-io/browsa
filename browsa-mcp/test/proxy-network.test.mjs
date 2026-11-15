// Offline tests for the built-in proxy network: the MCP server runs over
// stdio against a local mock of the Browsa API (no network, no real keys).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const ON = {
  enabled: true,
  tiers: [
    { network: "datacenter", credits_per_gb: 5, mb_per_credit: 200, countries: ["de", "us"] },
    { network: "residential", credits_per_gb: 50, mb_per_credit: 20, countries: ["us", "gb"] },
  ],
};

// mode: "on" | "off" | "missing" (an older API without the endpoint) | "down"
function startMockApi(mode) {
  const calls = [];
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
      if (req.method === "GET" && u.pathname === "/v1/proxy-network") {
        if (mode === "on") return send(200, ON);
        if (mode === "off") return send(200, { enabled: false, tiers: [] });
        if (mode === "down") return send(500, { code: "INTERNAL_ERROR", error: "boom", request_id: "r-9" });
        return send(404, { code: "NOT_FOUND", error: "no such route" });
      }
      if (req.method === "POST" && u.pathname === "/v1/agents") {
        if (body?.proxy?.network && mode !== "on") {
          return send(503, { code: "PROXY_NETWORK_UNAVAILABLE", error: "the proxy network is not enabled", request_id: "r-1" });
        }
        if (body?.proxy?.network && body.proxy.country === "fr") {
          return send(400, { code: "PROXY_NETWORK_COUNTRY_UNAVAILABLE", error: "country fr is not offered", request_id: "r-2" });
        }
        return send(201, {
          id: "agt_1", status: "running", cdp_http: "https://cdp.example/agt_1", cost_credits: 1,
          ...(body?.proxy?.network ? { proxy: body.proxy, proxy_network: body.proxy.network, proxy_bytes: 0, proxy_credits: 0 } : { proxy_network: null }),
        });
      }
      if (req.method === "GET" && u.pathname === "/v1/jobs/j1") {
        return send(200, { id: "j1", status: "completed", kind: "task", step_count: 2, progress_total: 25,
          proxy_network: "residential", proxy_bytes: 2500000000, proxy_credits: 125, result: { final_result: "ok" } });
      }
      if (req.method === "GET" && u.pathname === "/v1/jobs/j2") {
        return send(200, { id: "j2", status: "completed", kind: "task", step_count: 2, progress_total: 25,
          proxy_network: null, proxy_bytes: 0, proxy_credits: 0, result: { final_result: "ok" } });
      }
      send(404, { code: "NOT_FOUND", error: "no mock" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close(),
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
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      return { isError: !!r.result.isError, body: JSON.parse(r.result.content[0].text) };
    },
    kill: () => child.kill("SIGTERM"),
  };
}

describe("MCP built-in proxy network: enabled", () => {
  let api, mcp;
  before(async () => { api = await startMockApi("on"); mcp = startMcp(api.url); await mcp.init(); });
  after(() => { mcp?.kill(); api?.close(); });

  test("tools/list: proxy_network exists and start_browser.proxy describes both forms, with no price", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    assert.ok(byName.proxy_network);
    const proxy = byName.start_browser.inputSchema.properties.proxy;
    assert.deepEqual(proxy.properties.network.enum, ["datacenter", "residential"]);
    assert.ok(proxy.properties.host && proxy.properties.country);
    assert.match(proxy.description, /proxy_network tool reports enabled/);
    for (const text of [byName.proxy_network.description, proxy.description, byName.start_browser.description]) {
      assert.ok(!/—/.test(text), "em dash");
      assert.ok(!/\d+ credits? per GB/.test(text), "a price is written into a description");
      assert.ok(!/supplies no proxies/.test(text));
    }
  });

  test("proxy_network returns the tiers, countries and prices the API lists", async () => {
    const r = await mcp.call("proxy_network");
    assert.equal(r.isError, false);
    assert.deepEqual(r.body, ON);
  });

  test("start_browser sends proxy {network, country} as given and reports the egress", async () => {
    const r = await mcp.call("start_browser", { proxy: { network: "datacenter", country: "de" } });
    assert.equal(r.isError, false);
    const post = api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents").at(-1);
    assert.deepEqual(post.body.proxy, { network: "datacenter", country: "de" });
    assert.equal(r.body.proxy_network, "datacenter");
    assert.equal(r.body.proxy_bytes, 0);
    assert.equal(r.body.proxy_credits, 0);
    assert.equal(r.body.egress, "Browsa datacenter proxy network");
  });

  test("start_browser with your own proxy is unchanged and shows no network usage", async () => {
    const r = await mcp.call("start_browser", { proxy: { host: "gw.example.net", port: 1080, type: "socks5" } });
    assert.equal(r.isError, false);
    assert.equal(r.body.egress, "your proxy");
    assert.equal("proxy_network" in r.body, false);
    const none = await mcp.call("start_browser", {});
    assert.equal(none.body.egress, "Browsa's data-center IP");
    assert.equal("proxy_network" in none.body, false);
  });

  test("a country the tier does not offer comes back with its code", async () => {
    const r = await mcp.call("start_browser", { proxy: { network: "residential", country: "fr" } });
    assert.equal(r.isError, true);
    assert.equal(r.body.code, "PROXY_NETWORK_COUNTRY_UNAVAILABLE");
    assert.equal(r.body.status, 400);
  });

  test("get_job shows proxy usage only for a job that used the network", async () => {
    const used = await mcp.call("get_job", { job_id: "j1" });
    assert.deepEqual([used.body.proxy_network, used.body.proxy_bytes, used.body.proxy_credits], ["residential", 2500000000, 125]);
    const own = await mcp.call("get_job", { job_id: "j2" });
    for (const k of ["proxy_network", "proxy_bytes", "proxy_credits"]) assert.equal(k in own.body, false);
  });
});

for (const mode of ["off", "missing"]) {
  describe(`MCP built-in proxy network: ${mode === "off" ? "switched off" : "older API without the endpoint"}`, () => {
    let api, mcp;
    before(async () => { api = await startMockApi(mode); mcp = startMcp(api.url); await mcp.init(); });
    after(() => { mcp?.kill(); api?.close(); });

    test("proxy_network says not enabled, with no tiers", async () => {
      const r = await mcp.call("proxy_network");
      assert.equal(r.isError, false);
      assert.deepEqual(r.body, { enabled: false, tiers: [] });
    });

    test("a network proxy is refused by the API with PROXY_NETWORK_UNAVAILABLE", async () => {
      const r = await mcp.call("start_browser", { proxy: { network: "datacenter" } });
      assert.equal(r.isError, true);
      assert.equal(r.body.code, "PROXY_NETWORK_UNAVAILABLE");
      assert.equal(r.body.status, 503);
    });
  });
}

describe("MCP built-in proxy network: the API fails", () => {
  let api, mcp;
  before(async () => { api = await startMockApi("down"); mcp = startMcp(api.url); await mcp.init(); });
  after(() => { mcp?.kill(); api?.close(); });

  test("proxy_network reports the error instead of guessing", async () => {
    const r = await mcp.call("proxy_network");
    assert.equal(r.isError, true);
    assert.equal(r.body.status, 500);
    assert.equal(r.body.request_id, "r-9");
  });
});
