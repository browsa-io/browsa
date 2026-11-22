// CLI tests: run dist/cli.js against a local mock of the API (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function withMock(routes, fn) {
  const srv = http.createServer((req, res) => {
    const body = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { code: "NOT_FOUND", error: "no mock" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    srv.close();
  }
}

const cli = (base, ...args) =>
  run("node", ["dist/cli.js", ...args, "--base", base], { env: { ...process.env, BROWSA_API_KEY: "agt_test_cli" } });

test("identities lists persistent identities only, with full ids", async () => {
  await withMock({
    "GET /v1/agents": { agents: [
      { id: "agt_burner_0001", mode: "burner", status: "failed", options: { os_type: "OS_TYPE_MACOS" } },
      { id: "agt_persist_0001", mode: "persistent", status: "running", persona: "shopper", trust_score: 870 },
    ] },
  }, async (base) => {
    const { stdout } = await cli(base, "identities");
    assert.equal(stdout.trim(), "agt_persist_0001  shopper  running  trust=870");
  });
});

test("empty lists say so instead of printing nothing", async () => {
  await withMock({
    "GET /v1/agents": { agents: [{ id: "agt_b", mode: "burner", status: "destroyed" }] },
    "GET /v1/webhooks": { webhooks: [] },
    "GET /v1/llm-keys": { llm_keys: [] },
  }, async (base) => {
    assert.equal((await cli(base, "identities")).stdout.trim(), "no persistent identities");
    assert.equal((await cli(base, "webhooks")).stdout.trim(), "no webhooks");
    assert.match((await cli(base, "llm-keys")).stdout, /^no saved LLM keys/);
  });
});

// Like withMock, but records each request and answers from a function.
async function withRecordingMock(answer, fn) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      calls.push({ method: req.method, path, body: raw ? JSON.parse(raw) : undefined });
      const body = answer(req.method, path);
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { code: "NOT_FOUND", error: "no mock" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`, calls);
  } finally {
    srv.close();
  }
}

// No LLM env defaults from the machine running the tests.
const cleanEnv = () => {
  const env = { ...process.env, BROWSA_API_KEY: "agt_test_cli" };
  for (const k of ["BROWSA_LLM", "BROWSA_LLM_API_KEY", "BROWSA_LLM_KEY_ID"]) delete env[k];
  return env;
};

test("run --llm <tier> --reasoning sends both and prints the llm line", async () => {
  await withRecordingMock((method, path) => {
    if (method === "POST" && path === "/v1/tasks") return { id: "j1", status: "queued", kind: "task" };
    if (method === "GET" && path === "/v1/jobs/j1") {
      return {
        id: "j1", status: "completed", kind: "task", step_count: 2, progress_total: 25,
        result: {
          final_result: "done", llm_tier: "browsa-smart", reasoning: "high", llm_cost_usd: null,
          usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, requests: 4 },
        },
      };
    }
  }, async (base, calls) => {
    const { stdout } = await run("node",
      ["dist/cli.js", "run", "do it", "--llm", "browsa-smart", "--reasoning", "high", "--base", base], { env: cleanEnv() });
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post.body.llm, "browsa-smart");
    assert.equal(post.body.reasoning, "high");
    assert.equal("llm_api_key" in post.body, false);
    assert.match(stdout, /^llm: tier=browsa-smart · reasoning=high · tokens in=1200 out=300 · requests=4$/m);
    assert.match(stdout, /--- result ---\ndone/);

    // Without the flag nothing is sent.
    await run("node", ["dist/cli.js", "run", "do it", "--llm", "browsa", "--base", base], { env: cleanEnv() });
    const second = calls.filter((c) => c.method === "POST").at(-1);
    assert.equal(second.body.llm, "browsa");
    assert.equal("reasoning" in second.body, false);
  });
});

test("run prints no llm line for a job without usage, tier or reasoning", async () => {
  await withRecordingMock((method, path) => {
    if (method === "POST" && path === "/v1/tasks") return { id: "j1", status: "queued", kind: "task" };
    if (method === "GET" && path === "/v1/jobs/j1") {
      return { id: "j1", status: "completed", kind: "task", result: { final_result: "done" } };
    }
  }, async (base) => {
    const { stdout } = await run("node", ["dist/cli.js", "run", "do it", "--base", base], { env: cleanEnv() });
    assert.ok(!/^llm:/m.test(stdout));
    assert.match(stdout, /--- result ---\ndone/);
  });
});

test("models lists the hosted tiers and own-key providers", async () => {
  const models = {
    hosted: [
      { id: "browsa", model: "model-a", fallback_models: ["model-b"], reasoning: "low", credits_per_task: 5, default: true },
      { id: "browsa-fast", model: "model-c", fallback_models: [], reasoning: null, credits_per_task: 5 },
    ],
    own_key: { providers: ["anthropic", "openai_compatible"], default_models: { anthropic: "a-model" } },
  };
  await withMock({ "GET /v1/models": models }, async (base) => {
    const { stdout } = await cli(base, "models");
    assert.equal(stdout.trim(), [
      "browsa  model-a  reasoning=low  +5 credits/task  [default]",
      "browsa-fast  model-c  reasoning=default  +5 credits/task",
      "",
      "own key:",
      "  anthropic  a-model",
      "  openai_compatible  (name the model with --llm)",
    ].join("\n"));
    assert.deepEqual(JSON.parse((await cli(base, "models", "--json")).stdout), models);
  });
});

test("--version prints the package version and needs no key", async () => {
  const env = { ...process.env };
  delete env.BROWSA_API_KEY;
  const { version } = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf-8"));
  for (const flag of ["--version", "-v", "version"]) {
    const { stdout } = await run("node", ["dist/cli.js", flag], { env });
    assert.equal(stdout.trim(), version);
  }
});

test("a missing key names the variable and where to create a key", async () => {
  const env = { ...process.env };
  delete env.BROWSA_API_KEY;
  await assert.rejects(run("node", ["dist/cli.js", "credits"], { env }), (e) => {
    assert.equal(e.code, 2);
    assert.match(e.stderr, /BROWSA_API_KEY is not set\. Create a key at https:\/\/app\.browsa\.io\/dashboard\/keys/);
    return true;
  });
});

test("help has no em dashes", async () => {
  const { stdout } = await run("node", ["dist/cli.js", "--help"]);
  assert.match(stdout, /^browsa: real browsers for AI agents/);
  assert.ok(!stdout.includes("—"));
});
