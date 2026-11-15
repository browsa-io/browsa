// Client unit tests with a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, InvalidIDError, NotFoundError, AuthError, RateLimitError, APIError } from "../dist/index.js";

function mockFetch(handlers) {
  return async (url, init) => {
    const u = new URL(url);
    const handler = handlers[`${init.method} ${u.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ error: `no mock for ${init.method} ${u.pathname}` }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    }
    return handler(u, init);
  };
}

test("client requires agt_ prefix", () => {
  assert.throws(() => new Client({ apiKey: "sk-fake" }), /agt_/);
});

test("createTask sends snake_case body", async () => {
  let captured = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/tasks": async (_u, init) => {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({
          id: "abc-uuid", status: "queued", kind: "task",
          step_count: 0, progress_done: 0, progress_total: 25,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
  const job = await c.createTask({
    task: "x",
    llm: "claude-opus-4-7",
    llmApiKey: "sk-...",
    country: "US",
    maxSteps: 25,
    ja3Profile: "macos_chrome_137",
  });
  assert.equal(job.id, "abc-uuid");
  assert.equal(job.status, "queued");
  assert.equal(captured.llm_api_key, "sk-...");
  assert.equal(captured.ja3_profile, "macos_chrome_137");
  assert.equal(captured.max_steps, 25);
});

test("createTask sends maxCredits as max_credits", async () => {
  let captured = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/tasks": async (_u, init) => {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: "j1", status: "queued", kind: "task" }),
          { status: 202, headers: { "content-type": "application/json" } });
      },
    }),
  });
  await c.createTask({ task: "x", llm: "browsa", maxCredits: 40 });
  assert.equal(captured.max_credits, 40);
  assert.equal("maxCredits" in captured, false);
});

test("setKeyBudget PUTs the limit, null removes it", async () => {
  const seen = [];
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "PUT /v1/keys/k-1/budget": async (_u, init) => {
        const b = JSON.parse(init.body);
        seen.push(b);
        return new Response(JSON.stringify({ id: "k-1", monthly_budget_credits: b.monthly_budget_credits, spent_this_month: 12, resets_at: "2026-12-01T00:00:00Z" }),
          { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
  const r = await c.setKeyBudget("k-1", 100);
  assert.equal(r.monthly_budget_credits, 100);
  assert.equal(r.spent_this_month, 12);
  await c.setKeyBudget("k-1", null);
  assert.deepEqual(seen, [{ monthly_budget_credits: 100 }, { monthly_budget_credits: null }]);
});

const KEY_OBJ = {
  id: "k-1", name: "Prod Anthropic", provider: "anthropic", masked: "sk-ant-…a1b2",
  base_url: null, is_default: true, status: "valid", status_detail: "ok",
  status_message: "Key works. Checked with a free model-list call.",
  last_validated_at: "2026-11-07T10:00:00Z", last_used_at: null,
  created_at: "2026-11-07T10:00:00Z", updated_at: "2026-11-07T10:00:00Z",
};

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

test("saved LLM key endpoints: method, path, body", async () => {
  const { c, calls } = recordingClient(KEY_OBJ);
  const k = await c.createLlmKey({ provider: "anthropic", apiKey: "sk-ant-test-not-real", name: "Prod Anthropic", default: true });
  assert.equal(k.id, "k-1");
  assert.equal(k.masked, "sk-ant-…a1b2");
  assert.equal(k.isDefault, true);
  assert.equal(k.statusDetail, "ok");
  assert.equal(k.baseUrl, null);
  assert.equal(k.lastUsedAt, null);
  await c.createLlmKey({ provider: "openai_compatible", apiKey: "x-test", baseUrl: "https://llm.example/v1" });
  await c.getLlmKey("k-1");
  await c.validateLlmKey("k-1");
  await c.rotateLlmKey("k-1", { apiKey: "sk-ant-new-not-real" });
  await c.rotateLlmKey("k-1", { apiKey: "x-new", baseUrl: "https://llm2.example/v1" });
  await c.updateLlmKey("k-1", { name: "Renamed" });
  await c.updateLlmKey("k-1", { default: false });
  await c.deleteLlmKey("k-1");
  assert.deepEqual(calls, [
    { method: "POST", path: "/v1/llm-keys", body: { provider: "anthropic", api_key: "sk-ant-test-not-real", name: "Prod Anthropic", default: true } },
    { method: "POST", path: "/v1/llm-keys", body: { provider: "openai_compatible", api_key: "x-test", base_url: "https://llm.example/v1" } },
    { method: "GET", path: "/v1/llm-keys/k-1", body: undefined },
    { method: "POST", path: "/v1/llm-keys/k-1/validate", body: undefined },
    { method: "POST", path: "/v1/llm-keys/k-1/rotate", body: { api_key: "sk-ant-new-not-real" } },
    { method: "POST", path: "/v1/llm-keys/k-1/rotate", body: { api_key: "x-new", base_url: "https://llm2.example/v1" } },
    { method: "POST", path: "/v1/llm-keys/k-1", body: { name: "Renamed" } },
    { method: "POST", path: "/v1/llm-keys/k-1", body: { default: false } },
    { method: "DELETE", path: "/v1/llm-keys/k-1", body: undefined },
  ]);
  await assert.rejects(c.updateLlmKey("k-1", {}), /name or default/);
});

test("listLlmKeys parses the llm_keys envelope", async () => {
  const { c, calls } = recordingClient({ llm_keys: [KEY_OBJ, { ...KEY_OBJ, id: "k-2", is_default: false }], limit: 20 });
  const keys = await c.listLlmKeys();
  assert.deepEqual(calls.map(x => `${x.method} ${x.path}`), ["GET /v1/llm-keys"]);
  assert.deepEqual(keys.map(k => [k.id, k.isDefault]), [["k-1", true], ["k-2", false]]);
});

test("llmKeyId is sent as llm_key_id on tasks, schedules and auto", async () => {
  const { c, calls } = recordingClient((u) => u.pathname === "/v1/schedules"
    ? { id: "s1", interval_seconds: 3600, enabled: true, llm_key_id: "k-1" }
    : { id: "j1", status: "queued", kind: "task", llm_key_id: "k-1", llm_key_masked: "sk-ant-…a1b2", llm_key_source: "saved" });
  const job = await c.createTask({ task: "x", llmKeyId: "k-1" });
  assert.equal(job.llmKeyId, "k-1");
  assert.equal(job.llmKeyMasked, "sk-ant-…a1b2");
  assert.equal(job.llmKeySource, "saved");
  assert.equal(calls[0].body.llm_key_id, "k-1");
  assert.equal("llmKeyId" in calls[0].body, false);
  // llm omitted: not sent, so the server can pick the workspace default key.
  assert.equal("llm" in calls[0].body, false);
  assert.equal("llm_api_key" in calls[0].body, false);

  const s = await c.createSchedule({ task: "x", llm: "anthropic:claude-sonnet-5-5", llmKeyId: "k-1", intervalSeconds: 3600 });
  assert.equal(s.llmKeyId, "k-1");
  assert.equal(calls[1].path, "/v1/schedules");
  assert.equal(calls[1].body.llm_key_id, "k-1");
  assert.equal(calls[1].body.interval_seconds, 3600);

  await c.auto("go to example.com", { llmKeyId: "k-1" });
  assert.equal(calls[2].path, "/v1/auto");
  assert.equal(calls[2].body.llm_key_id, "k-1");

  // No key at all: nothing key-related is sent.
  await c.createTask({ task: "x" });
  assert.deepEqual(Object.keys(calls[3].body).sort(), ["framework", "task"]);
});

test("runTask forwards llmKeyId", async () => {
  const { c, calls } = recordingClient({ id: "j1", status: "completed", kind: "task" });
  const job = await c.runTask({ task: "x", llmKeyId: "k-9" });
  assert.equal(job.status, "completed");
  assert.equal(calls[0].path, "/v1/tasks");
  assert.equal(calls[0].body.llm_key_id, "k-9");
});

test("INVALID_ID 400 → InvalidIDError", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/not-a-uuid": async () => new Response(JSON.stringify({
        code: "INVALID_ID", error: "job id must be a UUID", request_id: "r-1",
      }), { status: 400, headers: { "content-type": "application/json" } }),
    }),
  });
  await assert.rejects(c.getJob("not-a-uuid"), (e) => {
    assert.ok(e instanceof InvalidIDError);
    assert.equal(e.code, "INVALID_ID");
    assert.equal(e.requestId, "r-1");
    return true;
  });
});

test("extract converts camelCase options to snake_case (regression: data was silently dropped)", async () => {
  let captured = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/quick/extract": async (_u, init) => {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ url: "https://x", data: { ok: true } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    }),
  });
  await c.extract("https://x", {
    prompt: "the heading",
    llm: "claude-haiku-4-5",
    llmApiKey: "jot_secret",
    llmBaseUrl: "https://llm.example/v1",
    schema: { type: "object", properties: { myHeading: { type: "string" } } },
  });
  // camelCase options must reach the server as snake_case (the bug: they
  // were sent verbatim and ignored, so extract returned no `data`).
  assert.equal(captured.llm_api_key, "jot_secret");
  assert.equal(captured.llm_base_url, "https://llm.example/v1");
  assert.equal(captured.prompt, "the heading");
  assert.equal(captured.llmApiKey, undefined, "camelCase key must not leak through");
  // ...but nested user-supplied schema property names must be preserved.
  assert.ok(captured.schema.properties.myHeading, "user schema keys must not be snake-cased");
});

test("404 NOT_FOUND → NotFoundError with request_id", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/00000000-0000-0000-0000-000000000000": async () => new Response(JSON.stringify({
        code: "NOT_FOUND", error: "no job with that id", request_id: "r-2",
      }), { status: 404, headers: { "content-type": "application/json" } }),
    }),
  });
  await assert.rejects(c.getJob("00000000-0000-0000-0000-000000000000"), (e) => {
    assert.ok(e instanceof NotFoundError);
    assert.equal(e.code, "NOT_FOUND");
    return true;
  });
});

test("401 → AuthError", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/credits": async () => new Response(JSON.stringify({
        code: "INVALID_API_KEY", error: "revoked", request_id: "r-3",
      }), { status: 401, headers: { "content-type": "application/json" } }),
    }),
  });
  await assert.rejects(c.credits(), (e) => e instanceof AuthError);
});

test("429 → RateLimitError with retryAfter", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/credits": async () => new Response(JSON.stringify({
        code: "RATE_LIMIT", error: "slow down",
      }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "5" } }),
    }),
  });
  await assert.rejects(c.credits(), (e) => {
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.retryAfter, 5);
    return true;
  });
});

test("snakeToJob maps result.final_result", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/abc": async () => new Response(JSON.stringify({
        id: "abc", status: "completed", kind: "task",
        step_count: 7, progress_done: 7, progress_total: 25,
        result: { final_result: "Hacker News top story: TestTitle" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    }),
  });
  const j = await c.getJob("abc");
  assert.equal(j.finalResult, "Hacker News top story: TestTitle");
});

test("streamJobEvents follows next_after until done", async () => {
  const pages = [
    { events: [{ type: "step", n: 3, action: "click" }, { type: "step", n: 4, action: "type" }], next_after: 4, done: false, status: "running" },
    { events: [], next_after: 4, done: false, status: "running" },
    { events: [{ type: "step", n: 5 }, { type: "status", status: "completed", error_code: null }], next_after: 5, done: true, status: "completed" },
  ];
  const seen = [];
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/job-1/events": async (u, init) => {
        seen.push({ after: u.searchParams.get("after"), wait: u.searchParams.get("wait"), key: init.headers["X-API-Key"] });
        return new Response(JSON.stringify(pages.shift()), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
  const evs = [];
  for await (const ev of c.streamJobEvents("job-1", { after: 2, wait: 99 })) evs.push(ev);
  assert.deepEqual(evs.map(e => e.type === "step" ? e.n : e.status), [3, 4, 5, "completed"]);
  assert.deepEqual(seen.map(s => [s.after, s.wait]), [["2", "30"], ["4", "30"], ["4", "30"]]);
  assert.equal(seen[0].key, "agt_live_test");
});

test("streamJobEvents throws NotFoundError on 404", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/nope/events": async () => new Response(JSON.stringify({ code: "NOT_FOUND", error: "no job with that id" }),
        { status: 404, headers: { "content-type": "application/json" } }),
    }),
  });
  await assert.rejects(async () => { for await (const _ of c.streamJobEvents("nope")) { /* drain */ } },
    (e) => e instanceof NotFoundError);
});

test("streamJobEvents stops when the loop breaks", async () => {
  let calls = 0;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/j/events": async () => {
        calls++;
        return new Response(JSON.stringify({ events: [{ type: "step", n: calls }], next_after: calls, done: false }),
          { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
  for await (const ev of c.streamJobEvents("j")) { if (ev.n === 2) break; }
  assert.equal(calls, 2);
});

// ── Sessions ────────────────────────────────────────────────────────────

const SESSION = {
  id: "s1", title: "Open example.com", status: "idle", accepts_messages: true, keep_browser: true,
  browser: { status: "live", mode: "burner", live_url: "https://browsa.io/stream-view/x",
    expires_at: "2026-11-07T12:15:00Z", expires_in_seconds: 600, credits: 5 },
  credits_charged: 12, turn_count: 2,
  turns: [
    { job_id: "s1", task: "Open example.com", status: "completed", final_result: "Example Domain",
      step_count: 3, duration_seconds: 21.5, credits_charged: 2, llm: "browsa", created_at: "2026-11-07T12:00:00Z" },
    { job_id: "j2", task: "Now open the Learn more link", status: "running", final_result: null,
      step_count: 1, duration_seconds: null, credits_charged: 0, created_at: "2026-11-07T12:01:00Z" },
  ],
  created_at: "2026-11-07T12:00:00Z",
};

const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });

test("createTask maps keepBrowser + browserTtlSeconds to snake_case", async () => {
  let captured = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/tasks": async (_u, init) => {
        captured = JSON.parse(init.body);
        return json({ job_id: "s1", status: "queued", kind: "task", session_id: "s1",
          session_url: "https://browsa.io/v1/sessions/s1" }, 202);
      },
    }),
  });
  const job = await c.createTask({ task: "x", llm: "browsa", keepBrowser: true, browserTtlSeconds: 600 });
  assert.equal(captured.keep_browser, true);
  assert.equal(captured.browser_ttl_seconds, 600);
  assert.equal("keepBrowser" in captured, false);
  assert.equal(job.sessionId, "s1");
  assert.equal(job.sessionUrl, "https://browsa.io/v1/sessions/s1");
});

test("createSession always sends keep_browser: true", async () => {
  let captured = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/tasks": async (_u, init) => {
        captured = JSON.parse(init.body);
        return json({ job_id: "s1", status: "queued", kind: "task", session_id: "s1" }, 202);
      },
    }),
  });
  const job = await c.createSession({ task: "Open example.com", llm: "browsa", agentId: "a1" });
  assert.equal(captured.keep_browser, true);
  assert.equal(captured.agent_id, "a1");
  assert.equal("browser_ttl_seconds" in captured, false);
  assert.equal(job.id, "s1");
  assert.equal(job.sessionId, "s1");
});

test("sendMessage posts snake_case body + Idempotency-Key", async () => {
  let captured = null, headers = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/sessions/s1/messages": async (_u, init) => {
        captured = JSON.parse(init.body);
        headers = init.headers;
        return json({ job_id: "j2", status: "queued", kind: "task", session_id: "s1", turn: 2 }, 202);
      },
    }),
  });
  const job = await c.sendMessage("s1", "Now open the Learn more link", {
    llmApiKey: "sk-ant-x", maxCredits: 20, idempotencyKey: "k-1",
    secrets: { "example.com": { x_password: "secret" } },
  });
  assert.deepEqual(captured, {
    task: "Now open the Learn more link", llm_api_key: "sk-ant-x", max_credits: 20,
    secrets: { "example.com": { x_password: "secret" } },
  });
  assert.equal(headers["Idempotency-Key"], "k-1");
  assert.equal(job.id, "j2");
  assert.equal(job.sessionId, "s1");
  assert.equal(job.turn, 2);
});

test("sendMessage 409 BROWSER_EXPIRED → APIError with code", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/sessions/s1/messages": async () => json({ code: "BROWSER_EXPIRED", error: "expired" }, 409),
    }),
  });
  await assert.rejects(c.sendMessage("s1", "x"), (e) => {
    assert.ok(e instanceof APIError);
    assert.equal(e.code, "BROWSER_EXPIRED");
    assert.equal(e.status, 409);
    return true;
  });
});

test("getSession + stopSession map the session", async () => {
  const seen = [];
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/sessions/s1": async () => { seen.push("get"); return json(SESSION); },
      "POST /v1/sessions/s1/stop": async () => {
        seen.push("stop");
        return json({ ...SESSION, status: "closed", accepts_messages: false, closed_reason: "stopped",
          browser: { status: "closed", mode: "burner", credits: 5 } });
      },
    }),
  });
  const s = await c.getSession("s1");
  assert.equal(s.status, "idle");
  assert.equal(s.acceptsMessages, true);
  assert.equal(s.browser.mode, "burner");
  assert.equal(s.browser.expiresInSeconds, 600);
  assert.equal(s.turnCount, 2);
  assert.deepEqual(s.turns.map(t => t.jobId), ["s1", "j2"]);
  assert.equal(s.turns[0].finalResult, "Example Domain");
  assert.equal(s.turns[0].durationSeconds, 21.5);
  assert.equal(s.turns[1].finalResult, null);
  assert.equal(s.turns[1].durationSeconds, null);
  const stopped = await c.stopSession("s1");
  assert.equal(stopped.status, "closed");
  assert.equal(stopped.closedReason, "stopped");
  assert.equal(stopped.browser.liveUrl, undefined);
  assert.deepEqual(seen, ["get", "stop"]);
});

test("batch sends no mode and rejects non-scrape modes", async () => {
  let captured = null, path = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: async (url, init) => {
      path = new URL(url).pathname + new URL(url).search;
      captured = JSON.parse(init.body);
      return json({ job_id: "b1", status: "queued", kind: "batch" }, 202);
    },
  });
  const r = await c.batch(["https://a.example", "https://b.example"], { maxChars: 500 });
  assert.equal(r.job_id, "b1");
  assert.equal(path, "/v1/quick/batch");
  assert.deepEqual(captured, { urls: ["https://a.example", "https://b.example"], max_chars: 500 });
  await c.batch(["https://a.example"], { mode: "scrape" });
  assert.equal("mode" in captured, false);
  await assert.rejects(c.batch(["https://a.example"], { mode: "extract" }), /only scrapes/);
});

test("listWebhookDeliveries", async () => {
  let search = null;
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/webhooks/whk_1/deliveries": async (u) => {
        search = u.search;
        return json({ deliveries: [{ id: "d1", event_type: "webhook.test", status_code: 405 }], count: 1 });
      },
    }),
  });
  const rows = await c.listWebhookDeliveries("whk_1", { limit: 5 });
  assert.equal(rows[0].status_code, 405);
  assert.equal(search, "?limit=5");
  await c.listWebhookDeliveries("whk_1");
  assert.equal(search, "");
});

test("runMessage keeps turn + sessionId from the 202 (GET has no turn)", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "POST /v1/sessions/s1/messages": async () => json({ job_id: "j2", status: "queued", kind: "task", session_id: "s1", turn: 2 }, 202),
      "GET /v1/jobs/j2": async () => json({ id: "j2", status: "completed", kind: "task", session_id: "s1", result: { final_result: "ok" } }),
    }),
  });
  const j = await c.runMessage("s1", "next", { llm: "browsa" });
  assert.equal(j.status, "completed");
  assert.equal(j.finalResult, "ok");
  assert.equal(j.turn, 2);
  assert.equal(j.sessionId, "s1");
});

test("downloadJobFile maps the JSON error envelope (code + request_id)", async () => {
  const c = new Client({
    apiKey: "agt_live_test",
    fetch: mockFetch({
      "GET /v1/jobs/j1/files/missing.txt": async () => json(
        { code: "NOT_FOUND", error: "no file with that name on this job", request_id: "rid-1" }, 404),
      "GET /v1/jobs/j1/files/out.json": async () => json({ a: 1 }),
    }),
  });
  await assert.rejects(c.downloadJobFile("j1", "missing.txt"), (e) => {
    assert.ok(e instanceof NotFoundError);
    assert.equal(e.code, "NOT_FOUND");
    assert.equal(e.requestId, "rid-1");
    assert.equal(e.message, "no file with that name on this job");
    return true;
  });
  const bytes = await c.downloadJobFile("j1", "out.json");
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes), '{"a":1}');
});

test("job outcome, signals and duration are typed; signals is never undefined", async () => {
  const { c } = recordingClient((u) => u.pathname === "/v1/jobs/j1"
    ? { id: "j1", status: "completed", kind: "task", outcome: "step_limit_reached",
        outcome_message: "The agent used all of its steps before it finished, so the result is partial; raise max_steps or narrow the task.",
        signals: ["bot_check_seen", "partial_result"], duration_ms: 61000 }
    : { id: "j2", status: "running", kind: "task", outcome: null, outcome_message: null, duration_ms: null });
  const done = await c.getJob("j1");
  assert.equal(done.status, "completed");
  assert.equal(done.outcome, "step_limit_reached");
  assert.match(done.outcomeMessage, /max_steps/);
  assert.deepEqual(done.signals, ["bot_check_seen", "partial_result"]);
  assert.equal(done.durationMs, 61000);
  // Still running, or an older server that sends none of the fields.
  const running = await c.getJob("j2");
  assert.equal(running.outcome, undefined);
  assert.equal(running.outcomeMessage, undefined);
  assert.equal(running.durationMs, undefined);
  assert.deepEqual(running.signals, []);
});

// ── Built-in proxy network ───────────────────────────────────────────────
const PROXY_NETWORK_ON = {
  enabled: true,
  tiers: [
    { network: "datacenter", credits_per_gb: 5, mb_per_credit: 200, countries: ["de", "us"] },
    { network: "residential", credits_per_gb: 50, mb_per_credit: 20, countries: ["us", "gb"] },
  ],
};

test("proxyNetwork reads the tiers, their countries and prices", async () => {
  const { c, calls } = recordingClient(PROXY_NETWORK_ON);
  const pn = await c.proxyNetwork();
  assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), ["GET /v1/proxy-network"]);
  assert.equal(pn.enabled, true);
  assert.deepEqual(pn.tiers, [
    { network: "datacenter", creditsPerGb: 5, mbPerCredit: 200, countries: ["de", "us"] },
    { network: "residential", creditsPerGb: 50, mbPerCredit: 20, countries: ["us", "gb"] },
  ]);
});

test("proxyNetwork is off when the API says so, and on an older API (404); other errors throw", async () => {
  const off = await recordingClient({ enabled: false, tiers: [] }).c.proxyNetwork();
  assert.equal(off.enabled, false);
  assert.deepEqual(off.tiers, []);
  const status = (code, body) => new Client({
    apiKey: "agt_live_test",
    fetch: async () => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } }),
  });
  const old = await status(404, { code: "NOT_FOUND", error: "no such route" }).proxyNetwork();
  assert.equal(old.enabled, false);
  assert.deepEqual(old.tiers, []);
  await assert.rejects(status(401, { code: "INVALID_API_KEY", error: "bad key" }).proxyNetwork(), AuthError);
});

test("a network proxy is sent as { network, country } on tasks, schedules and browsers", async () => {
  const { c, calls } = recordingClient({ id: "j1", status: "queued", kind: "task" });
  await c.createTask({ task: "x", llm: "browsa", proxy: { network: "residential", country: "gb" } });
  assert.deepEqual(calls[0].body.proxy, { network: "residential", country: "gb" });
  assert.equal("proxy_id" in calls[0].body, false);
  await c.createTask({ task: "x", llm: "browsa", proxy: { network: "datacenter" } });
  assert.deepEqual(calls[1].body.proxy, { network: "datacenter" });
  await c.createTask({ task: "x", llm: "browsa", proxyId: "px_1" });
  assert.equal(calls[2].body.proxy_id, "px_1");
  assert.equal("proxy" in calls[2].body, false);
  assert.equal("proxyId" in calls[2].body, false);
  await c.createSchedule({ task: "x", llm: "browsa", intervalSeconds: 3600, proxy: { network: "datacenter", country: "de" } });
  assert.equal(calls[3].path, "/v1/schedules");
  assert.deepEqual(calls[3].body.proxy, { network: "datacenter", country: "de" });
  await c.createAgent({ ttl: "5m", proxy: { network: "datacenter", country: "us" } });
  assert.equal(calls[4].path, "/v1/agents");
  assert.deepEqual(calls[4].body, { ttl: "5m", proxy: { network: "datacenter", country: "us" } });
  // Your own proxy still goes as it did.
  await c.createAgent({ proxy: { type: "socks5", host: "gw.example.net", port: 1080 }, proxyId: undefined });
  assert.deepEqual(calls[5].body, { proxy: { type: "socks5", host: "gw.example.net", port: 1080 } });
});

test("a job carries its proxy network usage; without one the fields are null and 0", async () => {
  const { c } = recordingClient((u) => u.pathname === "/v1/jobs/j1"
    ? { id: "j1", status: "completed", kind: "task", proxy_network: "datacenter", proxy_bytes: 12300000, proxy_credits: 1 }
    : u.pathname === "/v1/jobs/j2"
      ? { id: "j2", status: "completed", kind: "task", proxy_network: null, proxy_bytes: 0, proxy_credits: 0 }
      : { id: "j3", status: "completed", kind: "task" });
  const used = await c.getJob("j1");
  assert.deepEqual([used.proxyNetwork, used.proxyBytes, used.proxyCredits], ["datacenter", 12300000, 1]);
  for (const id of ["j2", "j3"]) {
    const j = await c.getJob(id);
    assert.deepEqual([j.proxyNetwork, j.proxyBytes, j.proxyCredits], [null, 0, 0]);
  }
});

// ── Page view: observe and act ─────────────────────────────────────────

test("observe and act send the engine's shape and return the answer as is", async () => {
  const { c, calls } = recordingClient({ text: "page …", state: "ok", status: "ok", tab: "T1", session: "pv_a", ids_reset: true });
  const v = await c.observe("agt_1");
  assert.equal(v.text, "page …");
  assert.equal(v.ids_reset, true);
  assert.deepEqual(calls[0], { method: "POST", path: "/v1/agents/agt_1/observe", body: {} });
  await c.observe("agt_1", { scope: "page", budget: 4000, expand: 12, json: true });
  assert.deepEqual(calls[1].body, { scope: "page", budget: 4000, expand: 12, json: true, session: "pv_a" });
  const r = await c.act("agt_1", { action: "type", id: 14, text: "10115", clear: true });
  assert.equal(r.status, "ok");
  assert.deepEqual(calls[2], { method: "POST", path: "/v1/agents/agt_1/act",
    body: { action: "type", id: 14, text: "10115", clear: true, session: "pv_a" } });
  await c.act("agt_1", { action: "wait", for: "text", text: "Thank you", timeout: 8000 });
  assert.deepEqual(calls[3].body, { action: "wait", for: "text", text: "Thank you", timeout: 8000, session: "pv_a" });
});

test("the view session is remembered per browser and tab", async () => {
  let reply = { text: "", tab: "T1", session: "pv_a" };
  const { c, calls } = recordingClient(() => reply);
  await c.observe("agt_1");
  reply = { text: "", tab: "T2", session: "pv_b" };
  await c.observe("agt_1", { tab: "T2" });
  assert.equal("session" in calls[1].body, false);                  // nothing seen for T2 yet
  await c.act("agt_1", { action: "click", id: 3 });                 // no tab: the one used last
  assert.equal(calls[2].body.session, "pv_b");
  reply = { text: "", tab: "T1", session: "pv_a" };
  await c.act("agt_1", { action: "click", id: 3, tab: "T1" });
  assert.deepEqual(calls[3].body, { action: "click", id: 3, tab: "T1", session: "pv_a" });
  await c.act("agt_2", { action: "press", keys: "Enter" });         // another browser: none
  assert.equal("session" in calls[4].body, false);
  await c.act("agt_1", { action: "click", id: 3, session: "" });    // opt out
  assert.equal("session" in calls[5].body, false);
  await c.act("agt_1", { action: "click", id: 3, session: "pv_mine" });
  assert.equal(calls[6].body.session, "pv_mine");
});
