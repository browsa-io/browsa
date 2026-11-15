// MCP server e2e against prod: calls every tool through the real stdio
// protocol. Skipped without BROWSA_API_KEY.
//
// Free by default: run_task is called with an empty task, which the API
// rejects before anything is created or charged. Set BROWSA_LIVE_SPEND=1 to
// also run one real task on the hosted model (about 7 to 12 credits) and
// read its files.
//
//   BROWSA_API_KEY=agt_live_... node --test test/full-e2e.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const KEY = process.env.BROWSA_API_KEY;
const SPEND = process.env.BROWSA_LIVE_SPEND === "1";
const BASE = (process.env.BROWSA_BASE_URL || "https://browsa.io").replace(/\/+$/, "");

const TOOL_NAMES = [
  "cancel_job", "create_schedule", "create_webhook", "credits", "delete_webhook",
  "get_job", "list_browsers", "list_identities", "list_job_files", "list_llm_keys",
  "list_models", "list_schedules", "list_webhooks", "proxy_network", "respond_to_job", "run_task", "start_browser",
  "stop_browser",
];

function rpc(child, request, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === request.id) {
            child.stdout.off("data", onData);
            clearTimeout(timer);
            return resolve(msg);
          }
        } catch { /* keep looking */ }
      }
    };
    child.stdout.on("data", onData);
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("rpc timeout"));
    }, timeoutMs);
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

let nextId = 100;
async function callTool(child, name, args = {}, timeoutMs) {
  const r = await rpc(child, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, timeoutMs);
  return { isError: r.result?.isError === true, body: JSON.parse(r.result.content[0].text) };
}

// Direct REST call, for cleanup the MCP tools cannot do (no delete_schedule tool).
async function rest(method, path) {
  const r = await fetch(BASE + path, { method, headers: { "X-API-Key": KEY } });
  return r.status;
}

describe("MCP full e2e: every tool", { skip: !KEY }, () => {
  let child;
  let scheduleId;
  let webhookId;

  after(async () => {
    if (scheduleId) await rest("DELETE", `/v1/schedules/${scheduleId}`);
    if (webhookId) await rest("DELETE", `/v1/webhooks/${webhookId}`);
    if (child) child.kill("SIGTERM");
  });

  test("boot + initialize", async () => {
    const env = { ...process.env, BROWSA_API_KEY: KEY };
    for (const k of ["BROWSA_LLM_API_KEY", "BROWSA_LLM_KEY_ID", "BROWSA_LLM"]) delete env[k];
    child = spawn("node", ["dist/server.js"], { env, stdio: ["pipe", "pipe", "inherit"] });
    const r = await rpc(child, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    });
    assert.equal(r.result.serverInfo.name, "browsa");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  test("tools/list returns the 13 tools", async () => {
    const r = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(r.result.tools.map((t) => t.name).sort(), TOOL_NAMES);
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.ok(t.description.length > 20, t.name);
    }
  });

  test("credits", async () => {
    const { isError, body } = await callTool(child, "credits");
    assert.equal(isError, false);
    assert.equal(typeof body.balance, "number");
  });

  test("list_webhooks", async () => {
    const { body } = await callTool(child, "list_webhooks");
    assert.ok(Array.isArray(body));
  });

  test("list_identities", async () => {
    const { body } = await callTool(child, "list_identities");
    assert.ok(Array.isArray(body));
  });

  test("list_models: hosted tiers and own-key providers", async () => {
    const { isError, body } = await callTool(child, "list_models");
    assert.equal(isError, false);
    assert.ok(Array.isArray(body.hosted));
    assert.ok(body.hosted.some((h) => h.id === "browsa"));
    assert.ok(Array.isArray(body.own_key.providers));
  });

  test("list_llm_keys: masked keys only", async () => {
    const { isError, body } = await callTool(child, "list_llm_keys");
    assert.equal(isError, false);
    assert.ok(Array.isArray(body.llm_keys));
    for (const k of body.llm_keys) assert.ok(!("api_key" in k) && !("secret" in k));
  });

  test("create_webhook + list_webhooks + delete_webhook", async () => {
    const { isError, body: wh } = await callTool(child, "create_webhook", {
      url: "https://browsa.io/wh-mcp-e2e-probe", events: ["job.completed"],
    });
    assert.equal(isError, false, JSON.stringify(wh));
    assert.ok(wh.id);
    webhookId = wh.id;
    const { body: list } = await callTool(child, "list_webhooks");
    assert.ok(list.some((w) => w.id === webhookId));
    const { body: del } = await callTool(child, "delete_webhook", { webhook_id: webhookId });
    assert.equal(del.deleted, webhookId);
    webhookId = undefined;
  });

  test("create_schedule (hosted model, 30 days) + list_schedules", async () => {
    const { isError, body: s } = await callTool(child, "create_schedule", {
      name: "mcp-e2e", task: "Return the title of https://example.com", llm: "browsa",
      interval_seconds: 2592000, max_steps: 2,
    });
    assert.equal(isError, false, JSON.stringify(s));
    assert.ok(s.id);
    scheduleId = s.id;
    assert.equal(s.interval_seconds, 2592000);
    const { body: list } = await callTool(child, "list_schedules");
    assert.ok(list.some((x) => x.id === scheduleId && x.llm === "browsa"));
    const status = await rest("DELETE", `/v1/schedules/${scheduleId}`);
    assert.ok(status >= 200 && status < 300, `delete schedule: ${status}`);
    scheduleId = undefined;
  });

  test("create_schedule: interval under 1h is a clean error", async () => {
    const { isError, body } = await callTool(child, "create_schedule", { task: "x", llm: "browsa", interval_seconds: 60 });
    assert.equal(isError, true);
    assert.equal(body.code, "INVALID_INTERVAL");
  });

  test("get_job: bad UUID -> INVALID_ID with request_id", async () => {
    const { isError, body } = await callTool(child, "get_job", { job_id: "not-a-uuid" });
    assert.equal(isError, true);
    assert.equal(body.code, "INVALID_ID");
    assert.ok(body.request_id);
  });

  test("get_job: unknown UUID -> NOT_FOUND", async () => {
    const { isError, body } = await callTool(child, "get_job", { job_id: "00000000-0000-0000-0000-000000000000" });
    assert.equal(isError, true);
    assert.equal(body.code, "NOT_FOUND");
  });

  test("cancel_job / respond_to_job / list_job_files: bad UUID -> INVALID_ID", async () => {
    for (const [name, args] of [
      ["cancel_job", { job_id: "not-a-uuid" }],
      ["respond_to_job", { job_id: "not-a-uuid", response: "x" }],
      ["list_job_files", { job_id: "not-a-uuid" }],
    ]) {
      const { isError, body } = await callTool(child, name, args);
      assert.equal(isError, true, name);
      assert.equal(body.code, "INVALID_ID", name);
    }
  });

  test("run_task: empty task is rejected before anything runs", async () => {
    const { isError, body } = await callTool(child, "run_task", { task: "" });
    assert.equal(isError, true);
    assert.equal(body.status, 400);
    assert.ok(body.request_id);
  });

  test("run_task for real on the hosted model + get_job + list_job_files", { skip: !SPEND }, async () => {
    const { isError, body } = await callTool(child, "run_task", {
      task: "Return the exact page title only.", llm: "browsa",
      initial_url: "https://example.com", max_steps: 2, timeout_minutes: 5,
    }, 330_000);
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.status, "completed", JSON.stringify(body));
    assert.match(body.final_result, /Example Domain/);
    const { body: job } = await callTool(child, "get_job", { job_id: body.job_id });
    assert.equal(job.status, "completed");
    const { body: files } = await callTool(child, "list_job_files", { job_id: body.job_id });
    assert.ok(Array.isArray(files));
    const { isError: cErr, body: c } = await callTool(child, "cancel_job", { job_id: body.job_id });
    assert.equal(cErr, true);
    assert.equal(c.code, "JOB_NOT_CANCELLABLE");
    const { isError: rErr, body: rr } = await callTool(child, "respond_to_job", { job_id: body.job_id, response: "x" });
    assert.equal(rErr, true);
    assert.equal(rr.code, "NOT_AWAITING_INPUT");
  });
});
