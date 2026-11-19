// Smoke test: spawn the MCP server over stdio, send list-tools + a cheap
// credits call, assert the responses look right. Doesn't need a real API key
// for list-tools, but credits needs one.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const KEY = process.env.BROWSA_API_KEY;

function rpc(child, request) {
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
            return resolve(msg);
          }
        } catch { /* keep looking */ }
      }
    };
    child.stdout.on("data", onData);
    setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("rpc timeout"));
    }, 10_000);
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

const TOOL_NAMES = [
  "act", "cancel_job", "create_schedule", "create_webhook", "credits", "delete_webhook",
  "get_job", "get_robot_run", "list_browsers", "list_identities", "list_job_files", "list_llm_keys",
  "list_models", "list_robots", "list_schedules", "list_webhooks", "observe", "proxy_network", "respond_to_job",
  "run_robot", "run_task", "solve_captcha_task", "start_browser", "stop_browser",
];

function boot(apiKey) {
  const env = { ...process.env, BROWSA_API_KEY: apiKey };
  return spawn("node", ["dist/server.js"], { env, stdio: ["pipe", "pipe", "inherit"] });
}

async function initialize(child) {
  // MCP requires the initialize handshake first.
  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

// Offline: listing tools makes no API call, so a placeholder key is enough.
describe("MCP server stdio: tool catalog", () => {
  test("list_tools returns the documented tools", async () => {
    const child = boot("agt_test_offline");
    try {
      await initialize(child);
      const list = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      assert.ok(Array.isArray(list.result.tools));
      assert.deepEqual(list.result.tools.map((t) => t.name).sort(), TOOL_NAMES);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("MCP server stdio", { skip: !KEY }, () => {
  let child;

  test("server starts", async () => {
    child = boot(KEY);
    await initialize(child);
  });

  test("credits tool returns balance via real API", async () => {
    const r = await rpc(child, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "credits", arguments: {} },
    });
    assert.ok(r.result.content);
    const text = r.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed.balance, "number");
  });

  test("get_job with bad uuid returns clean error envelope", async () => {
    const r = await rpc(child, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "get_job", arguments: { job_id: "not-a-uuid" } },
    });
    assert.equal(r.result.isError, true);
    const body = JSON.parse(r.result.content[0].text);
    assert.equal(body.code, "INVALID_ID");
    assert.ok(body.request_id);
  });

  test("cleanup", () => {
    if (child) child.kill("SIGTERM");
  });
});
