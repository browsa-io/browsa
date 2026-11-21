// Robot methods (client.robots, client.robotRuns) with a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, APIError, TimeoutError } from "../dist/index.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(handlers, seen = []) {
  return new Client({
    apiKey: "agt_live_test",
    fetch: async (url, init) => {
      const u = new URL(url);
      const key = `${init.method} ${u.pathname}`;
      seen.push({ key, url: u, body: init.body ? JSON.parse(init.body) : null });
      const h = handlers[key];
      if (!h) return json({ error: `no mock for ${key}` }, 500);
      return h(u, init);
    },
  });
}

const runBody = {
  id: "rr1", robot_id: "rb1", trigger: "api", status: "queued", rows_total: 2, rows_ok: 0, rows_failed: 0,
  rows_pending: 2, credits: 0, site: "books.toscrape.com", stop_reason: null, not_before: null,
  created_at: "2026-11-19T00:00:00Z", started_at: null, finished_at: null,
  results_url: "/v1/robot-runs/rr1", export_url: "/v1/robot-runs/rr1/export?format=csv",
};
const robotBody = {
  id: "rb1", name: "Book prices", description: "", recipe_id: "r1", status: "active", paused_reason: null,
  profile_id: null, inputs: [{ url: "https://a" }, { url: "https://b" }], inputs_count: 2,
  destinations: [{ type: "webhook", url: "https://hook", secret_ref: "main" }],
  monitors: [{ field: "price", op: "lt", value: 20 }],
  schedule: { id: "s1", interval_seconds: 86400, enabled: true, next_run_at: "2026-11-20T09:00:00Z", at: "09:00", weekday: null, tz: "UTC" },
  settings: { model: { llm: "browsa-smart" }, proxy: { network: "residential", country: "us" }, browser: null },
  source_job_id: "job-1", previous_recipe_id: null, alerts_read_at: null,
  health: { pass_rate: 0.5, rows_counted: 4, last_failure: "blocked", last_failure_at: null, recipe_version: 1,
    versions: 1, repairs: 0, price_credits: 3, next_run_at: null, schedule_active: true, site: "books.toscrape.com" },
  alerts_unread: 1, last_run: runBody,
  created_at: "2026-11-19T00:00:00Z", updated_at: "2026-11-19T00:00:00Z",
};

test("robots.create sends snake_case, nested settings and schedule", async () => {
  const seen = [];
  const c = client({ "POST /v1/robots": async () => json(robotBody, 201) }, seen);
  const rb = await c.robots.create({
    name: "Book prices",
    fromJobId: "job-1",
    inputs: [{ url: "https://a" }, { url: "https://b" }],
    schedule: { intervalSeconds: 86400, at: "09:00", tz: "UTC" },
    destinations: [{ type: "webhook", url: "https://hook", secretRef: "main" }, { type: "email", to: "a@b.c" }],
    monitors: [{ field: "price", op: "lt", value: 20 }],
    settings: { model: { llm: "browsa", llmKeyId: "k1" }, proxy: { proxyId: "p1" }, browser: { os: "windows", screen: "1920x1080" } },
  });
  const b = seen[0].body;
  assert.equal(b.from_job_id, "job-1");
  assert.deepEqual(b.schedule, { interval_seconds: 86400, at: "09:00", tz: "UTC" });
  assert.deepEqual(b.destinations[0], { type: "webhook", url: "https://hook", secret_ref: "main" });
  assert.deepEqual(b.destinations[1], { type: "email", to: "a@b.c" });
  assert.deepEqual(b.settings, {
    model: { llm: "browsa", llm_key_id: "k1" }, proxy: { proxy_id: "p1" }, browser: { os: "windows", screen: "1920x1080" },
  });
  assert.ok(!("recipe_id" in b) && !("profile_id" in b));

  assert.equal(rb.id, "rb1");
  assert.equal(rb.recipeId, "r1");
  assert.equal(rb.inputs.length, 2);
  assert.equal(rb.schedule.intervalSeconds, 86400);
  assert.equal(rb.schedule.at, "09:00");
  assert.deepEqual(rb.settings, { model: { llm: "browsa-smart" }, proxy: { network: "residential", country: "us" }, browser: null, secrets: [] });
  assert.equal(rb.health.passRate, 0.5);
  assert.equal(rb.health.priceCredits, 3);
  assert.equal(rb.health.lastFailure, "blocked");
  assert.equal(rb.destinations[0].secretRef, "main");
  assert.equal(rb.lastRun.id, "rr1");
  assert.equal(rb.alertsUnread, 1);
});

test("robots.create from a recipe", async () => {
  const seen = [];
  const c = client({ "POST /v1/robots": async () => json({ ...robotBody, settings: { model: null, proxy: null, browser: null } }, 201) }, seen);
  const rb = await c.robots.create({ name: "x", recipeId: "r9" });
  assert.deepEqual(seen[0].body, { name: "x", recipe_id: "r9" });
  assert.deepEqual(rb.settings, { model: null, proxy: null, browser: null, secrets: [] });
});

test("robots.list, get, pause, resume, delete", async () => {
  const seen = [];
  const c = client({
    "GET /v1/robots": async () => json({ robots: [robotBody] }),
    "GET /v1/robots/rb1": async () => json(robotBody),
    "POST /v1/robots/rb1/pause": async () => json({ ...robotBody, status: "paused" }),
    "POST /v1/robots/rb1/resume": async () => json(robotBody),
    "DELETE /v1/robots/rb1": async () => json({ deleted: true, id: "rb1" }),
  }, seen);
  const list = await c.robots.list({ limit: 10 });
  assert.equal(list[0].name, "Book prices");
  assert.equal(seen[0].url.searchParams.get("limit"), "10");
  assert.equal((await c.robots.get("rb1")).health.repairs, 0);
  assert.equal((await c.robots.pause("rb1")).status, "paused");
  assert.equal((await c.robots.resume("rb1")).status, "active");
  assert.equal(await c.robots.delete("rb1"), undefined);
});

test("robots.update sends only given fields; null clears schedule and settings", async () => {
  const seen = [];
  const c = client({ "PATCH /v1/robots/rb1": async () => json(robotBody) }, seen);
  await c.robots.update("rb1", { name: "New", schedule: null, settings: null });
  // settings: null resets everything: no read first.
  assert.deepEqual(seen.map((s) => s.key), ["PATCH /v1/robots/rb1"]);
  assert.deepEqual(seen[0].body, { name: "New", schedule: null, settings: null });
  await c.robots.update("rb1", { name: "Only name", profileId: null });
  assert.deepEqual(seen[1].body, { name: "Only name", profile_id: null });
});

// The API's PATCH replaces settings whole, so a settings update reads the
// robot and sends its settings with the new parts over them.
const secretRobot = {
  ...robotBody,
  settings: {
    model: { llm: "browsa-smart" }, proxy: { network: "residential", country: "us" },
    browser: { os: "mac", screen: "1440x900" }, secrets: ["DUMMY_LOGIN", "DUMMY_TOKEN"],
  },
};

test("robots.update with only a proxy keeps settings.secrets and the other parts", async () => {
  const seen = [];
  const c = client({
    "GET /v1/robots/rb1": async () => json(secretRobot),
    "PATCH /v1/robots/rb1": async () => json(secretRobot),
  }, seen);
  const rb = await c.robots.update("rb1", { settings: { proxy: { network: "datacenter" } }, profileId: null });
  assert.deepEqual(seen.map((s) => s.key), ["GET /v1/robots/rb1", "PATCH /v1/robots/rb1"]);
  assert.deepEqual(seen[1].body, {
    settings: {
      model: { llm: "browsa-smart" }, proxy: { network: "datacenter" },
      browser: { os: "mac", screen: "1440x900" }, secrets: ["DUMMY_LOGIN", "DUMMY_TOKEN"],
    },
    profile_id: null,
  });
  assert.deepEqual(rb.settings.secrets, ["DUMMY_LOGIN", "DUMMY_TOKEN"]);
});

test("robots.update: a null part goes Auto, secrets can be replaced, a robot without settings works", async () => {
  const seen = [];
  let current = secretRobot;
  const c = client({
    "GET /v1/robots/rb1": async () => json(current),
    "PATCH /v1/robots/rb1": async () => json(robotBody),
  }, seen);
  await c.robots.update("rb1", { settings: { model: null, secrets: ["DUMMY_TOKEN"] } });
  assert.deepEqual(seen[1].body.settings, {
    model: null, proxy: { network: "residential", country: "us" },
    browser: { os: "mac", screen: "1440x900" }, secrets: ["DUMMY_TOKEN"],
  });
  current = { ...robotBody, settings: null };
  await c.robots.update("rb1", { settings: { secrets: ["DUMMY_LOGIN"] } });
  assert.deepEqual(seen[3].body, { settings: { secrets: ["DUMMY_LOGIN"] } });
});

test("robots.create sends settings.secrets; get parses secrets and settingsWarnings", async () => {
  const seen = [];
  const c = client({
    "POST /v1/robots": async () => json(secretRobot, 201),
    "GET /v1/robots/rb1": async () => json({
      ...secretRobot,
      settings_warnings: [{ code: "SECRET_NOT_FOUND", secret: "LATER_KEY", message: "LATER_KEY is not in this workspace's Secrets." }],
    }),
  }, seen);
  await c.robots.create({ name: "x", recipeId: "r9", settings: { secrets: ["DUMMY_LOGIN"] } });
  assert.deepEqual(seen[0].body.settings, { secrets: ["DUMMY_LOGIN"] });
  const rb = await c.robots.get("rb1");
  assert.deepEqual(rb.settings.secrets, ["DUMMY_LOGIN", "DUMMY_TOKEN"]);
  assert.equal(rb.settingsWarnings[0].code, "SECRET_NOT_FOUND");
  assert.equal(rb.settingsWarnings[0].secret, "LATER_KEY");
});

test("robots.run, runs, alerts, markAlertsRead", async () => {
  const seen = [];
  const c = client({
    "POST /v1/robots/rb1/run": async () => json(runBody, 202),
    "GET /v1/robots/rb1/runs": async () => json({ robot_id: "rb1", runs: [runBody] }),
    "GET /v1/robots/rb1/alerts": async () => json({ robot_id: "rb1", alerts: [
      { id: "a1", robot_id: "rb1", robot_run_id: "rr1", row: 0, field: "price", rule: "lt 20", old: 25, new: 18, created_at: "t" },
    ] }),
    "POST /v1/robots/rb1/alerts/read": async () => json({ robot_id: "rb1", alerts_read_at: "t", alerts_unread: 0 }),
  }, seen);
  const run = await c.robots.run("rb1", { inputs: [{ url: "https://c" }] });
  assert.deepEqual(seen[0].body, { inputs: [{ url: "https://c" }] });
  assert.equal(run.status, "queued");
  assert.equal(run.rowsPending, 2);
  await c.robots.run("rb1");
  assert.deepEqual(seen[1].body, {});
  assert.equal((await c.robots.runs("rb1"))[0].id, "rr1");
  const alerts = await c.robots.alerts("rb1", { limit: 5 });
  assert.equal(alerts[0].rule, "lt 20");
  assert.equal(alerts[0].new, 18);
  await c.robots.markAlertsRead("rb1");
});

test("robotRuns.get maps rows; wait polls to a final status", async () => {
  let calls = 0;
  const done = {
    ...runBody, status: "partial", rows_ok: 1, rows_failed: 1, rows_pending: 0, credits: 3,
    rows: [
      { row: 0, input: { url: "https://a" }, status: "ok", output: { price: 18 }, error_code: null, error_message: null,
        credits: 3, recipe_run_id: "x1", duration_ms: 2100, alerts: [], changed_fields: ["price"] },
      { row: 1, input: { url: "https://b" }, status: "failed", output: null, error_code: "blocked", error_message: "bot wall",
        credits: 0, recipe_run_id: "x2", duration_ms: null, alerts: [], changed_fields: [] },
    ],
  };
  const c = client({
    "GET /v1/robot-runs/rr1": async () => json(++calls < 2 ? { ...runBody, status: "running" } : done),
  });
  const run = await c.robotRuns.wait("rr1", { pollMs: 1 });
  assert.equal(calls, 2);
  assert.equal(run.status, "partial");
  assert.equal(run.credits, 3);
  assert.equal(run.rows[0].output.price, 18);
  assert.deepEqual(run.rows[0].changedFields, ["price"]);
  assert.equal(run.rows[1].errorCode, "blocked");
  assert.equal(run.rows[1].credits, 0);
});

test("robotRuns.wait times out", async () => {
  const c = client({ "GET /v1/robot-runs/rr1": async () => json({ ...runBody, status: "running" }) });
  await assert.rejects(c.robotRuns.wait("rr1", { timeoutMs: 5, pollMs: 10 }), TimeoutError);
});

test("robotRuns.export csv text and json object", async () => {
  const seen = [];
  const c = client({
    "GET /v1/robot-runs/rr1/export": async (u) =>
      u.searchParams.get("format") === "json"
        ? json({ robot_run_id: "rr1", rows: [{ row: 0 }] })
        : new Response("row,url,price\n0,https://a,18\n", { headers: { "content-type": "text/csv; charset=utf-8" } }),
  }, seen);
  const csv = await c.robotRuns.export("rr1");
  assert.ok(csv.startsWith("row,url,price"));
  assert.equal(seen[0].url.searchParams.get("format"), "csv");
  const j = await c.robotRuns.export("rr1", { format: "json", items: 10 });
  assert.equal(j.rows.length, 1);
  assert.equal(seen[1].url.searchParams.get("items"), "10");
});

test("robot errors surface as APIError with the code", async () => {
  const c = client({
    "POST /v1/robots/rb1/run": async () => json({ error: "robots are off", code: "ROBOTS_UNAVAILABLE" }, 503),
    "POST /v1/robots": async () => json({ error: "a robot takes at most 500 input rows", code: "TOO_MANY_INPUTS" }, 400),
  });
  await assert.rejects(c.robots.run("rb1"), (e) => e instanceof APIError && e.code === "ROBOTS_UNAVAILABLE");
  await assert.rejects(c.robots.create({ name: "x", recipeId: "r" }), (e) => e instanceof APIError && e.code === "TOO_MANY_INPUTS");
});
