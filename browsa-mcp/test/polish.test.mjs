// Annotations on every tool, --help / --version, the server's instructions,
// and the wording of the missing-key message. Offline: no key, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { startMcp } from "./helpers.mjs";

const run = promisify(execFile);
const SERVER = new URL("../dist/server.js", import.meta.url).pathname;
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
const noKeyEnv = () => {
  const env = { ...process.env };
  delete env.BROWSA_API_KEY;
  delete env.BROWSA_MCP_TOOLS;
  return env;
};

describe("command line flags", () => {
  test("--version prints the package version and exits without a key", async () => {
    for (const flag of ["--version", "-v"]) {
      const { stdout, stderr } = await run("node", [SERVER, flag], { env: noKeyEnv(), timeout: 10_000 });
      assert.equal(stdout.trim(), pkg.version);
      assert.equal(stderr, "");
    }
  });

  test("--help prints usage and exits; it does not start the server", async () => {
    for (const flag of ["--help", "-h"]) {
      const { stdout, stderr } = await run("node", [SERVER, flag], { env: noKeyEnv(), timeout: 10_000 });
      assert.match(stdout, new RegExp(`^browsa-mcp ${pkg.version.replaceAll(".", "\\.")}: MCP server for Browsa`));
      for (const word of ["--tools=", "BROWSA_API_KEY", "BROWSA_MCP_TOOLS", "captcha_page", "Create a key at https://app.browsa.io/dashboard/keys"]) {
        assert.ok(stdout.includes(word), `help mentions ${word}`);
      }
      assert.ok(!/chromium/i.test(stdout));
      assert.ok(!stdout.includes("—"));
      assert.equal(stderr, "");                       // no "ready" line: the server never started
    }
  });

  test("a flag wins over --tools, and the version is the same in every manifest", async () => {
    const { stdout } = await run("node", [SERVER, "--tools=all", "--version"], { env: noKeyEnv(), timeout: 10_000 });
    assert.equal(stdout.trim(), pkg.version);
    const server = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf-8"));
    const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf-8"));
    assert.deepEqual([server.version, ...server.packages.map((p) => p.version), manifest.version],
      [pkg.version, pkg.version, pkg.version]);
  });
});

describe("what the server says about itself", () => {
  test("initialize carries the version, a title and instructions", async () => {
    const mcp = startMcp(null, { BROWSA_MCP_TOOLS: "all" });
    try {
      const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      assert.equal(init.result.serverInfo.name, "browsa");
      assert.equal(init.result.serverInfo.version, pkg.version);
      const text = init.result.instructions;
      assert.equal(typeof text, "string");
      assert.ok(text.length > 200 && text.length < 1200, `instructions are short (${text.length} characters)`);
      for (const word of ["Phantom", "observe", "act", "close", "credits", "BROWSA_MCP_TOOLS"]) assert.ok(text.includes(word), word);
      assert.ok(!/chromium/i.test(text));
    } finally {
      mcp.kill();
    }
  });

  test("every tool of every group has annotations with both hints and a title", async () => {
    const mcp = await startMcp(null, { BROWSA_MCP_TOOLS: "all" }).init();
    try {
      const { result } = await mcp.rpc("tools/list", {});
      assert.equal(result.tools.length, 36);
      for (const t of result.tools) {
        const a = t.annotations;
        assert.ok(a, `${t.name} has annotations`);
        assert.equal(typeof a.title, "string", `${t.name} title`);
        assert.equal(typeof a.readOnlyHint, "boolean", `${t.name} readOnlyHint`);
        assert.equal(typeof a.destructiveHint, "boolean", `${t.name} destructiveHint`);
        assert.ok(!(a.readOnlyHint && a.destructiveHint), `${t.name} is not both read-only and destructive`);
      }
      const by = Object.fromEntries(result.tools.map((t) => [t.name, t.annotations]));
      const names = (f) => result.tools.filter((t) => f(t.annotations)).map((t) => t.name).sort();
      assert.deepEqual(names((a) => a.readOnlyHint), [
        "captcha_allowance", "credits", "detect_captcha", "get_job", "get_robot_run", "list_browsers", "list_captcha_types",
        "list_identities", "list_job_files", "list_llm_keys", "list_models", "list_robots", "list_schedules", "list_webhooks",
        "observe", "proxy_network", "read", "screenshot", "secrets",
      ]);
      assert.deepEqual(names((a) => a.destructiveHint), [
        "act", "cancel_job", "close", "delete_webhook", "flow", "run_robot", "run_task", "stop_browser",
      ]);
      assert.equal(by.detect_captcha.openWorldHint, false);   // runs in this process
      assert.equal(by.close.idempotentHint, true);
    } finally {
      mcp.kill();
    }
  });

  test("the default nine tools are annotated too, and a call without a key says where to create one", async () => {
    const mcp = await startMcp(null, { BROWSA_API_KEY: "" }).init();
    try {
      const { result } = await mcp.rpc("tools/list", {});
      assert.equal(result.tools.length, 9);
      assert.ok(result.tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean"));
      const r = await mcp.rpc("tools/call", { name: "observe", arguments: {} });
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /BROWSA_API_KEY is not set\. Create a key at https:\/\/app\.browsa\.io\/dashboard\/keys/);
    } finally {
      mcp.kill();
    }
  });
});
