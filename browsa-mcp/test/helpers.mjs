// Shared test helpers: a local mock of the Browsa API and an MCP client over stdio.
import { spawn } from "node:child_process";
import http from "node:http";

/**
 * A mock API. routes: {"POST /v1/agents/agt_1/observe": (body, url, state) => [status, obj] | obj}.
 * A route key may end in "*" to match a prefix.
 */
export function startMockApi(routes) {
  const calls = [];
  const state = {};
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const u = new URL(req.url, "http://x");
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: req.headers });
      const key = `${req.method} ${u.pathname}`;
      let fn = routes[key];
      if (!fn) {
        const pre = Object.keys(routes).find((k) => k.endsWith("*") && key.startsWith(k.slice(0, -1)));
        fn = pre && routes[pre];
      }
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (!fn) return send(404, { code: "NOT_FOUND", error: `no mock for ${key}` });
      try {
        const out = await fn(body, u, state);
        if (Array.isArray(out)) send(out[0], out[1]);
        else send(200, out);
      } catch (e) {
        send(500, { code: "MOCK", error: String(e) });
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls, state, close: () => srv.close(),
    last: (path) => [...calls].reverse().find((c) => c.path === path),
  })));
}

const CLEAN_ENV = ["BROWSA_LLM_API_KEY", "BROWSA_LLM_KEY_ID", "BROWSA_LLM", "BROWSA_COUNTRY", "BROWSA_MCP_TOOLS", "BROWSA_MCP_REDACT"];

/** Starts dist/server.js over stdio. */
export function startMcp(baseUrl, extraEnv = {}, opts = {}) {
  const env = { ...process.env, BROWSA_API_KEY: "agt_test_x", BROWSA_BASE_URL: baseUrl ?? "http://127.0.0.1:9" };
  for (const k of CLEAN_ENV) delete env[k];
  Object.assign(env, extraEnv);
  const child = spawn("node", [new URL("../dist/server.js", import.meta.url).pathname, ...(opts.args ?? [])],
    { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
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
    const t = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 20_000);
    waiters.set(myId, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return this;
    },
    rpc,
    async tools() { return (await rpc("tools/list", {})).result.tools; },
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      const content = r.result.content;
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { isError: !!r.result.isError, text, content };
    },
    stderr: () => stderr,
    kill: () => child.kill("SIGTERM"),
  };
}
