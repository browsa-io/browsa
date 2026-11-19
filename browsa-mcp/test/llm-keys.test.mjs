// Offline tests for the saved-LLM-key paths, hosted tiers, reasoning and
// list_models: the MCP server runs over stdio against a local mock of the
// Browsa API (no network, no real keys).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

// Example GET /v1/models body. The model ids and credit numbers are server
// settings; the MCP server passes them through and hardcodes none.
const MODELS = {
  hosted: [
    { id: "browsa", model: "model-a", fallback_models: ["model-b"], reasoning: "low", credits_per_task: 5, default: true },
    { id: "browsa-fast", model: "model-c", fallback_models: ["model-b", "model-a"], reasoning: null, credits_per_task: 5 },
    { id: "browsa-smart", model: "model-a", fallback_models: ["model-b"], reasoning: "high", credits_per_task: 5 },
  ],
  own_key: { providers: ["anthropic", "openai", "google", "openai_compatible"], default_models: { anthropic: "a-model" } },
};

function startMockApi() {
  const calls = [];
  // Scripted { status, body } replies for the next POST /v1/tasks and /v1/schedules.
  const taskReplies = [];
  const scheduleReplies = [];
  // Extra keys for the result of GET /v1/jobs/j1 (usage, llm_tier, ...).
  let jobResultExtra = {};
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method, path: u.pathname, body, apiKey: req.headers["x-api-key"] });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && u.pathname === "/v1/tasks") {
        if (taskReplies.length) { const r = taskReplies.shift(); return send(r.status, r.body); }
        return send(202, { id: "j1", status: "queued", kind: "task" });
      }
      if (req.method === "GET" && u.pathname === "/v1/jobs/j1") {
        return send(200, {
          id: "j1", status: "completed", kind: "task", step_count: 2, progress_total: 25,
          llm_key_id: "k-1", llm_key_masked: "sk-ant-…a1b2", llm_key_source: "default",
          result: { final_result: "ok", ...jobResultExtra },
        });
      }
      if (req.method === "GET" && u.pathname === "/v1/models") return send(200, MODELS);
      if (req.method === "GET" && u.pathname === "/v1/jobs/j2") {
        return send(200, {
          id: "j2", status: "failed", kind: "task", step_count: 1, progress_total: 25,
          error_code: "CANCELLED", error_message: "cancelled by the caller",
        });
      }
      if (req.method === "POST" && u.pathname === "/v1/schedules") {
        if (scheduleReplies.length) { const r = scheduleReplies.shift(); return send(r.status, r.body); }
        return send(201, { id: "s1", interval_seconds: body.interval_seconds, enabled: true, llm_key_id: body.llm_key_id });
      }
      if (req.method === "GET" && u.pathname === "/v1/agents") {
        return send(200, { count: 3, agents: [
          { id: "agt_burner1", mode: "burner", status: "destroyed" },
          { id: "agt_persist1", mode: "persistent", status: "running", persona: "shopper" },
          { id: "agt_burner2", mode: "burner", status: "failed" },
        ] });
      }
      if (req.method === "GET" && u.pathname === "/v1/llm-keys") {
        return send(200, {
          llm_keys: [{
            id: "k-1", name: "Prod", provider: "anthropic", masked: "sk-ant-…a1b2", base_url: null,
            is_default: true, status: "valid", status_detail: "ok", status_message: "Key works.",
            last_validated_at: "2026-11-07T10:00:00Z", last_used_at: null,
            created_at: "2026-11-07T10:00:00Z", updated_at: "2026-11-07T10:00:00Z",
          }],
          limit: 20,
        });
      }
      send(404, { code: "NOT_FOUND", error: "no mock" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    calls,
    replyToTasks: (...r) => { taskReplies.push(...r); },
    replyToSchedules: (...r) => { scheduleReplies.push(...r); },
    setJobResultExtra: (extra) => { jobResultExtra = extra; },
    close: () => srv.close(),
  })));
}

function startMcp(baseUrl, extraEnv = {}) {
  const env = { ...process.env, BROWSA_API_KEY: "agt_test_x", BROWSA_BASE_URL: baseUrl, BROWSA_MCP_TOOLS: "all", ...extraEnv };
  for (const k of ["BROWSA_LLM_API_KEY", "BROWSA_LLM_KEY_ID", "BROWSA_LLM", "BROWSA_COUNTRY"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const child = spawn("node", ["dist/server.js"], { env, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        waiters.get(msg.id)?.(msg);
        waiters.delete(msg.id);
      } catch { /* not a frame */ }
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

const taskPosts = (api) => api.calls.filter((c) => c.method === "POST" && c.path === "/v1/tasks");
const schedulePosts = (api) => api.calls.filter((c) => c.method === "POST" && c.path === "/v1/schedules");
const lastTaskBody = (api) => taskPosts(api).at(-1).body;
const KEY_REQUIRED = { status: 400, body: { code: "LLM_KEY_REQUIRED", error: "no LLM key for this task", request_id: "r-1" } };
const KEYS_UNAVAILABLE = { status: 503, body: { code: "LLM_KEYS_UNAVAILABLE", error: "saved LLM keys are not enabled" } };

describe("MCP saved LLM keys (no env LLM key)", () => {
  let api, mcp;
  before(async () => {
    api = await startMockApi();
    mcp = startMcp(api.url);
    await mcp.init();
  });
  after(() => { mcp?.kill(); api?.close(); });

  test("tools/list has llm_key_id on run_task and create_schedule, plus list_llm_keys", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    assert.ok(byName.run_task.inputSchema.properties.llm_key_id);
    assert.ok(byName.create_schedule.inputSchema.properties.llm_key_id);
    assert.ok(byName.list_llm_keys);
    // No em dashes in the descriptions this change wrote.
    for (const name of ["create_schedule", "list_llm_keys"]) {
      assert.ok(!/—/.test(byName[name].description), `em dash in ${name}`);
    }
    for (const t of [byName.run_task, byName.create_schedule]) {
      for (const p of ["llm", "llm_key_id", "llm_api_key"]) {
        assert.ok(!/—/.test(t.inputSchema.properties[p].description), `em dash in ${t.name}.${p}`);
      }
    }
  });

  test("list_identities returns persistent identities only (not burners)", async () => {
    const r = await mcp.call("list_identities");
    assert.equal(r.isError, false);
    assert.deepEqual(r.body.map((a) => a.id), ["agt_persist1"]);
    const list = await mcp.rpc("tools/list", {});
    const runTask = list.result.tools.find((t) => t.name === "run_task");
    assert.match(runTask.inputSchema.properties.profile_id.description, /agt_/);
  });

  test("get_job returns error_code (a cancelled job is failed + CANCELLED)", async () => {
    const r = await mcp.call("get_job", { job_id: "j2" });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "failed");
    assert.equal(r.body.error_code, "CANCELLED");
    const list = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
    assert.match(byName.cancel_job.description, /JOB_NOT_CANCELLABLE/);
    assert.ok(!/\bIdempotent\b/.test(byName.cancel_job.description));
    assert.ok(!/\|cancelled\|/.test(byName.get_job.description));
  });

  test("run_task with no key sends no llm_api_key, no llm, no llm_key_id", async () => {
    const r = await mcp.call("run_task", { task: "x" });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "completed");
    assert.equal(r.body.llm_key_source, "default");
    assert.equal(r.body.llm_key_masked, "sk-ant-…a1b2");
    const body = lastTaskBody(api);
    assert.equal("llm_api_key" in body, false);
    assert.equal("llm_key_id" in body, false);
    assert.equal("llm" in body, false);
    assert.equal(api.calls.at(-1).apiKey, "agt_test_x");
  });

  test("run_task forwards llm_key_id and llm", async () => {
    await mcp.call("run_task", { task: "x", llm_key_id: "k-1", llm: "anthropic:claude-sonnet-5-5" });
    const body = lastTaskBody(api);
    assert.equal(body.llm_key_id, "k-1");
    assert.equal(body.llm, "anthropic:claude-sonnet-5-5");
    assert.equal("llm_api_key" in body, false);
  });

  test("explicit llm:\"browsa\" still runs hosted with no key", async () => {
    await mcp.call("run_task", { task: "x", llm: "browsa", llm_key_id: "k-1" });
    const body = lastTaskBody(api);
    assert.equal(body.llm, "browsa");
    assert.equal("llm_api_key" in body, false);
    assert.equal("llm_key_id" in body, false);
  });

  test("per-call llm_api_key wins over llm_key_id and gets a default model", async () => {
    await mcp.call("run_task", { task: "x", llm_api_key: "sk-test-not-real", llm_key_id: "k-1" });
    const body = lastTaskBody(api);
    assert.equal(body.llm_api_key, "sk-test-not-real");
    assert.equal("llm_key_id" in body, false);
    assert.equal(body.llm, "claude-opus-5-5");
  });

  test("zero-config: 400 LLM_KEY_REQUIRED retries once on the hosted model and says so", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks(KEY_REQUIRED); // then the default 202
    const r = await mcp.call("run_task", { task: "x" });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, "completed");
    assert.equal(r.body.llm, "browsa");
    assert.equal(r.body.note,
      "No saved LLM key found, so this ran on Browsa's hosted model (adds credits per task; see list_models). " +
      "Save a key at https://app.browsa.io/dashboard/llm-keys to use your own.");
    const posts = taskPosts(api).slice(before);
    assert.equal(posts.length, 2);
    assert.equal("llm" in posts[0].body, false);
    assert.equal(posts[1].body.llm, "browsa");
    assert.equal("llm_api_key" in posts[1].body, false);
    assert.equal("llm_key_id" in posts[1].body, false);
  });

  test("zero-config: 503 LLM_KEYS_UNAVAILABLE also falls back to the hosted model", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks(KEYS_UNAVAILABLE);
    const r = await mcp.call("run_task", { task: "x" });
    assert.equal(r.isError, false);
    assert.match(r.body.note, /hosted model/);
    const posts = taskPosts(api).slice(before);
    assert.deepEqual(posts.map((p) => p.body.llm), [undefined, "browsa"]);
  });

  test("a successful run with a saved default has no hosted note", async () => {
    const r = await mcp.call("run_task", { task: "x" });
    assert.equal(r.isError, false);
    assert.equal("note" in r.body, false);
  });

  test("explicit llm + LLM_KEY_REQUIRED: no fallback, actionable error", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks(KEY_REQUIRED);
    const r = await mcp.call("run_task", { task: "x", llm: "openai:gpt-4o" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /app\.browsa\.io\/dashboard\/llm-keys/);
    assert.match(r.body.error, /BROWSA_LLM_API_KEY/);
    assert.match(r.body.error, /llm:"browsa"/);
    assert.equal(r.body.code, "LLM_KEY_REQUIRED");
    assert.equal(r.body.status, 400);
    assert.equal(r.body.request_id, "r-1");
    assert.equal(taskPosts(api).length - before, 1, "must not retry");
  });

  test("explicit llm + 503 LLM_KEYS_UNAVAILABLE: no fallback, actionable error", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks(KEYS_UNAVAILABLE);
    const r = await mcp.call("run_task", { task: "x", llm: "anthropic:claude-sonnet-5-5" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /BROWSA_LLM_API_KEY/);
    assert.equal(r.body.code, "LLM_KEYS_UNAVAILABLE");
    assert.equal(taskPosts(api).length - before, 1);
  });

  test("LLM_MODEL_REQUIRED asks for the model name", async () => {
    api.replyToTasks({ status: 400, body: { code: "LLM_MODEL_REQUIRED", error: "llm is required for openai_compatible keys" } });
    const r = await mcp.call("run_task", { task: "x", llm_key_id: "k-compat" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /pass llm/);
  });

  test("LLM_KEY_NOT_FOUND points to list_llm_keys", async () => {
    api.replyToTasks({ status: 400, body: { code: "LLM_KEY_NOT_FOUND", error: "unknown llm_key_id" } });
    const r = await mcp.call("run_task", { task: "x", llm_key_id: "nope" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /list_llm_keys/);
    assert.equal(r.body.code, "LLM_KEY_NOT_FOUND");
  });

  test("unrelated 400 passes through unchanged, with no retry", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks({ status: 400, body: { code: "BAD_REQUEST", error: "country must be 2 letters" } });
    const r = await mcp.call("run_task", { task: "x", country: "USA" });
    assert.equal(r.isError, true);
    assert.equal(r.body.error, "country must be 2 letters");
    assert.equal(taskPosts(api).length - before, 1);
  });

  test("create_schedule: zero-config falls back to hosted with a note; explicit llm does not", async () => {
    let before = schedulePosts(api).length;
    api.replyToSchedules(KEY_REQUIRED);
    let r = await mcp.call("create_schedule", { task: "x", interval_seconds: 3600 });
    assert.equal(r.isError, false);
    assert.equal(r.body.llm, "browsa");
    assert.match(r.body.note, /^No saved LLM key found, so this schedule runs on Browsa's hosted model/);
    assert.match(r.body.note, /dashboard\/llm-keys/);
    let posts = schedulePosts(api).slice(before);
    assert.deepEqual(posts.map((p) => p.body.llm), [undefined, "browsa"]);

    before = schedulePosts(api).length;
    api.replyToSchedules(KEY_REQUIRED);
    r = await mcp.call("create_schedule", { task: "x", interval_seconds: 3600, llm: "openai:gpt-4o" });
    assert.equal(r.isError, true);
    assert.equal(r.body.code, "LLM_KEY_REQUIRED");
    assert.equal(schedulePosts(api).length - before, 1);
  });

  test("create_schedule: no key sends none; llm_key_id is forwarded", async () => {
    await mcp.call("create_schedule", { task: "x", interval_seconds: 3600 });
    let s = api.calls.filter((c) => c.path === "/v1/schedules").at(-1).body;
    assert.equal("llm_api_key" in s, false);
    assert.equal("llm_key_id" in s, false);
    assert.equal(s.interval_seconds, 3600);
    const r = await mcp.call("create_schedule", { task: "x", interval_seconds: 3600, llm_key_id: "k-1" });
    s = api.calls.filter((c) => c.path === "/v1/schedules").at(-1).body;
    assert.equal(s.llm_key_id, "k-1");
    assert.equal(r.body.llm_key_id, "k-1");
  });

  test("tools/list: reasoning on run_task and create_schedule, tiers named, list_models listed", async () => {
    const r = await mcp.rpc("tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    for (const t of [byName.run_task, byName.create_schedule]) {
      assert.deepEqual(t.inputSchema.properties.reasoning.enum, ["low", "medium", "high"]);
      for (const tier of ['"browsa"', '"browsa-fast"', '"browsa-smart"']) {
        assert.ok(t.inputSchema.properties.llm.description.includes(tier), `${t.name}.llm names ${tier}`);
      }
      assert.ok(!/—/.test(t.inputSchema.properties.reasoning.description));
    }
    assert.ok(byName.list_models);
    assert.ok(!/—/.test(byName.list_models.description));
    // Credit prices are server settings: no tool text states one.
    for (const t of r.result.tools) {
      assert.ok(!/\d+[- ]credit/.test(JSON.stringify(t)), `fixed credit price in ${t.name}`);
    }
  });

  test("run_task forwards reasoning and a hosted tier, with no key", async () => {
    await mcp.call("run_task", { task: "x", llm: "browsa-smart", reasoning: "high", llm_key_id: "k-1" });
    let body = lastTaskBody(api);
    assert.equal(body.llm, "browsa-smart");
    assert.equal(body.reasoning, "high");
    assert.equal("llm_api_key" in body, false);
    assert.equal("llm_key_id" in body, false);
    await mcp.call("run_task", { task: "x", llm: "browsa-fast" });
    body = lastTaskBody(api);
    assert.equal(body.llm, "browsa-fast");
    assert.equal("reasoning" in body, false);
    // With your own key, reasoning goes along with the model.
    await mcp.call("run_task", { task: "x", llm: "anthropic:claude-sonnet-5-5", reasoning: "medium" });
    body = lastTaskBody(api);
    assert.deepEqual([body.llm, body.reasoning], ["anthropic:claude-sonnet-5-5", "medium"]);
  });

  test("a hosted tier never falls back or rewrites key errors", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks(KEY_REQUIRED);
    const r = await mcp.call("run_task", { task: "x", llm: "browsa-smart" });
    assert.equal(r.isError, true);
    assert.equal(r.body.error, "no LLM key for this task");
    assert.equal(taskPosts(api).length - before, 1);
  });

  test("the zero-config hosted retry keeps reasoning", async () => {
    const before = taskPosts(api).length;
    api.replyToTasks(KEY_REQUIRED);
    const r = await mcp.call("run_task", { task: "x", reasoning: "low" });
    assert.equal(r.isError, false);
    const posts = taskPosts(api).slice(before);
    assert.deepEqual(posts.map((p) => [p.body.llm, p.body.reasoning]), [[undefined, "low"], ["browsa", "low"]]);
  });

  test("an invalid reasoning value is the server's 400, passed through", async () => {
    api.replyToTasks({ status: 400, body: { code: "BAD_REQUEST", error: "reasoning must be low, medium or high" } });
    const r = await mcp.call("run_task", { task: "x", reasoning: "extreme" });
    assert.equal(r.isError, true);
    assert.equal(r.body.error, "reasoning must be low, medium or high");
    assert.equal(lastTaskBody(api).reasoning, "extreme");
  });

  test("run_task and get_job return usage, cost, tier and reasoning when the job has them", async () => {
    const usage = { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 800, cache_write_tokens: 100, requests: 4 };
    api.setJobResultExtra({ usage, llm_cost_usd: null, llm_tier: "browsa-smart", reasoning: "high" });
    try {
      for (const r of [
        await mcp.call("run_task", { task: "x", llm: "browsa-smart", reasoning: "high" }),
        await mcp.call("get_job", { job_id: "j1" }),
      ]) {
        assert.equal(r.isError, false);
        assert.deepEqual(r.body.usage, usage);
        assert.equal(r.body.llm_cost_usd, null);
        assert.equal(r.body.llm_tier, "browsa-smart");
        assert.equal(r.body.reasoning, "high");
        assert.equal(r.body.final_result, "ok");
      }
    } finally { api.setJobResultExtra({}); }
  });

  test("jobs without the new result keys return none of them", async () => {
    for (const r of [await mcp.call("run_task", { task: "x" }), await mcp.call("get_job", { job_id: "j1" }), await mcp.call("get_job", { job_id: "j2" })]) {
      assert.equal(r.isError, false);
      for (const k of ["usage", "llm_cost_usd", "llm_tier", "reasoning"]) assert.equal(k in r.body, false, k);
    }
  });

  test("create_schedule forwards reasoning and a hosted tier", async () => {
    await mcp.call("create_schedule", { task: "x", interval_seconds: 3600, llm: "browsa-fast", reasoning: "medium" });
    let s = schedulePosts(api).at(-1).body;
    assert.deepEqual([s.llm, s.reasoning], ["browsa-fast", "medium"]);
    assert.equal("llm_api_key" in s, false);
    await mcp.call("create_schedule", { task: "x", interval_seconds: 3600 });
    s = schedulePosts(api).at(-1).body;
    assert.equal("reasoning" in s, false);
  });

  test("list_models returns the hosted tiers and own-key providers as the API sends them", async () => {
    const r = await mcp.call("list_models");
    assert.equal(r.isError, false);
    assert.deepEqual(r.body, MODELS);
    assert.equal(api.calls.at(-1).path, "/v1/models");
    assert.equal(api.calls.at(-1).apiKey, "agt_test_x");
  });

  test("list_llm_keys returns masked keys only", async () => {
    const r = await mcp.call("list_llm_keys");
    assert.equal(r.isError, false);
    assert.equal(r.body.llm_keys[0].masked, "sk-ant-…a1b2");
    assert.equal(r.body.llm_keys[0].is_default, true);
    assert.equal("api_key" in r.body.llm_keys[0], false);
    assert.match(r.body.manage_at, /dashboard\/llm-keys/);
  });
});

describe("MCP env defaults", () => {
  test("BROWSA_LLM_KEY_ID is sent as llm_key_id", async () => {
    const api = await startMockApi();
    const mcp = startMcp(api.url, { BROWSA_LLM_KEY_ID: "k-env" });
    try {
      await mcp.init();
      await mcp.call("run_task", { task: "x" });
      const body = lastTaskBody(api);
      assert.equal(body.llm_key_id, "k-env");
      assert.equal("llm_api_key" in body, false);
      // A per-call key id overrides the env one.
      await mcp.call("run_task", { task: "x", llm_key_id: "k-call" });
      assert.equal(lastTaskBody(api).llm_key_id, "k-call");
    } finally { mcp.kill(); api.close(); }
  });

  test("BROWSA_LLM set: LLM_KEY_REQUIRED is an error, not a hosted fallback", async () => {
    const api = await startMockApi();
    const mcp = startMcp(api.url, { BROWSA_LLM: "google:gemini-2.5-flash" });
    try {
      await mcp.init();
      api.replyToTasks(KEY_REQUIRED);
      const r = await mcp.call("run_task", { task: "x" });
      assert.equal(r.isError, true);
      assert.match(r.body.error, /dashboard\/llm-keys/);
      assert.equal(taskPosts(api).length, 1);
      assert.equal(taskPosts(api)[0].body.llm, "google:gemini-2.5-flash");
    } finally { mcp.kill(); api.close(); }
  });

  test("BROWSA_LLM_API_KEY still works as a per-task key", async () => {
    const api = await startMockApi();
    const mcp = startMcp(api.url, { BROWSA_LLM_API_KEY: "sk-env-not-real" });
    try {
      await mcp.init();
      await mcp.call("run_task", { task: "x" });
      const body = lastTaskBody(api);
      assert.equal(body.llm_api_key, "sk-env-not-real");
      assert.equal(body.llm, "claude-opus-5-5");
    } finally { mcp.kill(); api.close(); }
  });
});
