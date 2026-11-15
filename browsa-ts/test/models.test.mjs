// Hosted tiers, reasoning, models(), usage and cost: mocked fetch, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "../dist/index.js";

// Example GET /v1/models body. The model ids and credit numbers are server
// settings; the SDK must not depend on these values.
const MODELS = {
  hosted: [
    { id: "browsa", model: "claude-opus-4-8", fallback_models: ["claude-sonnet-4-6"], reasoning: "low", credits_per_task: 5, default: true },
    { id: "browsa-fast", model: "gemini-3.1-flash-lite", fallback_models: ["claude-sonnet-4-6", "claude-opus-4-8"], reasoning: null, credits_per_task: 5 },
    { id: "browsa-smart", model: "claude-opus-4-8", fallback_models: ["claude-sonnet-4-6"], reasoning: "high", credits_per_task: 5 },
  ],
  own_key: {
    providers: ["anthropic", "openai", "google", "openai_compatible"],
    default_models: { anthropic: "a-model", openai: "o-model", google: "g-model" },
  },
};

// Every request is recorded; `reply` is the JSON body (or a function of the URL).
function recordingClient(reply) {
  const calls = [];
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(typeof reply === "function" ? reply(u, init) : reply),
        { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { c, calls };
}

test("createTask sends the hosted tier and reasoning", async () => {
  const { c, calls } = recordingClient({ id: "j1", status: "queued", kind: "task" });
  await c.createTask({ task: "x", llm: "browsa-smart", reasoning: "high" });
  assert.deepEqual(calls[0], {
    method: "POST", path: "/v1/tasks",
    body: { task: "x", llm: "browsa-smart", framework: "browser-use", reasoning: "high" },
  });
  await c.createTask({ task: "x", llm: "browsa-fast" });
  assert.equal(calls[1].body.llm, "browsa-fast");
  assert.equal("reasoning" in calls[1].body, false);
});

test("reasoning is sent by runTask, createSession, sendMessage, runMessage, createSchedule and auto", async () => {
  const { c, calls } = recordingClient((u) =>
    u.pathname.startsWith("/v1/jobs/")
      ? { id: "j1", status: "completed", kind: "task" }
      : { id: "j1", status: "queued", kind: "task", session_id: "j1", turn: 2 });
  await c.runTask({ task: "x", llm: "browsa", reasoning: "medium" });
  await c.createSession({ task: "x", llm: "browsa-fast", reasoning: "low" });
  await c.sendMessage("s1", "next", { reasoning: "high" });
  await c.runMessage("s1", "again", { llm: "browsa-smart", reasoning: "medium" });
  await c.createSchedule({ task: "x", llm: "browsa-smart", reasoning: "high", intervalSeconds: 3600 });
  await c.auto("go to example.com", { llm: "browsa", reasoning: "low" });
  const posts = calls.filter((x) => x.method === "POST");
  assert.deepEqual(posts.map((x) => x.path), [
    "/v1/tasks", "/v1/tasks", "/v1/sessions/s1/messages", "/v1/sessions/s1/messages", "/v1/schedules", "/v1/auto",
  ]);
  assert.deepEqual(posts.map((x) => [x.body.llm, x.body.reasoning]), [
    ["browsa", "medium"], ["browsa-fast", "low"], [undefined, "high"],
    ["browsa-smart", "medium"], ["browsa-smart", "high"], ["browsa", "low"],
  ]);
  assert.equal(posts[1].body.keep_browser, true);
  assert.deepEqual(posts[2].body, { task: "next", reasoning: "high" });
  assert.equal(posts[4].body.interval_seconds, 3600);
  // Left out: not sent, so the tier's or provider's default applies.
  await c.sendMessage("s1", "plain");
  assert.deepEqual(calls.at(-1).body, { task: "plain" });
});

test("models() parses GET /v1/models into camelCase", async () => {
  const { c, calls } = recordingClient(MODELS);
  const m = await c.models();
  assert.deepEqual(calls, [{ method: "GET", path: "/v1/models", body: undefined }]);
  assert.deepEqual(m.hosted.map((h) => h.id), ["browsa", "browsa-fast", "browsa-smart"]);
  assert.deepEqual(m.hosted.map((h) => h.default), [true, false, false]);
  assert.deepEqual(m.hosted[1], {
    id: "browsa-fast", model: "gemini-3.1-flash-lite",
    fallbackModels: ["claude-sonnet-4-6", "claude-opus-4-8"],
    reasoning: null, creditsPerTask: 5, default: false,
  });
  assert.equal(m.hosted[2].reasoning, "high");
  assert.deepEqual(m.ownKey.providers, ["anthropic", "openai", "google", "openai_compatible"]);
  assert.equal(m.ownKey.defaultModels.openai, "o-model");
  assert.deepEqual(m.raw, MODELS);
});

test("models() tolerates missing keys", async () => {
  for (const body of [{}, { hosted: null, own_key: null }]) {
    const m = await recordingClient(body).c.models();
    assert.deepEqual(m.hosted, []);
    assert.deepEqual(m.ownKey, { providers: [], defaultModels: {} });
  }
  const m = await recordingClient({ hosted: [{ id: "browsa" }] }).c.models();
  assert.deepEqual(m.hosted[0], {
    id: "browsa", model: "", fallbackModels: [], reasoning: null, creditsPerTask: undefined, default: false,
  });
});

test("job result carries usage, llmCostUsd, llmTier and reasoning", async () => {
  // Own key: usage and an estimated cost, no tier.
  const own = await recordingClient({
    id: "j1", status: "completed", kind: "task",
    result: {
      final_result: "ok",
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 800, cache_write_tokens: 100, requests: 4 },
      llm_cost_usd: 0.0123, reasoning: "medium",
    },
  }).c.getJob("j1");
  assert.deepEqual(own.usage, {
    inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 100, requests: 4,
  });
  assert.equal(own.llmCostUsd, 0.0123);
  assert.equal(own.llmTier, undefined);
  assert.equal(own.reasoning, "medium");
  assert.equal(own.finalResult, "ok");

  // Hosted: a tier, and the cost is null (paid in credits).
  const hosted = await recordingClient({
    id: "j2", status: "completed", kind: "task",
    result: { usage: { input_tokens: 10, output_tokens: 2 }, llm_cost_usd: null, llm_tier: "browsa-smart", reasoning: "high" },
  }).c.getJob("j2");
  assert.equal(hosted.llmCostUsd, null);
  assert.equal(hosted.llmTier, "browsa-smart");
  assert.equal(hosted.reasoning, "high");
  assert.deepEqual(hosted.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 });
});

test("jobs without the new result keys still parse", async () => {
  for (const body of [
    { id: "j1", status: "completed", kind: "task", result: { final_result: "hello" } },
    { id: "j2", status: "running", kind: "task" },
    { id: "j3", status: "failed", kind: "task", result: null },
    { id: "j4", status: "completed", kind: "task", result: { usage: null } },
  ]) {
    const j = await recordingClient(body).c.getJob(body.id);
    assert.equal(j.usage, undefined);
    assert.equal(j.llmCostUsd, undefined);
    assert.equal(j.llmTier, undefined);
    assert.equal(j.reasoning, undefined);
    assert.equal(j.status, body.status);
  }
  const j = await recordingClient({ id: "j1", status: "completed", kind: "task", result: { final_result: "hello" } }).c.getJob("j1");
  assert.equal(j.finalResult, "hello");
});

test("schedule carries reasoning when the server sends it", async () => {
  const s = await recordingClient({ id: "s1", interval_seconds: 3600, enabled: true, llm: "browsa-smart", reasoning: "high" })
    .c.getSchedule("s1");
  assert.equal(s.reasoning, "high");
  const old = await recordingClient({ id: "s2", interval_seconds: 3600, enabled: true }).c.getSchedule("s2");
  assert.equal(old.reasoning, undefined);
});
