// client.secrets, secretIds / saveSecrets passthrough and savedSecrets parsing,
// with a mocked fetch. Every value here is an obvious dummy.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, APIError } from "../dist/index.js";

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

const secretBody = {
  id: "7b0c0000-0000-0000-0000-000000000001", name: "DUMMY_LOGIN", type: "login", description: "Test account",
  origins: ["https://*.example.com"], username_masked: "du…", has_value: true, has_totp: true,
  totp: { digits: 6, algorithm: "SHA1", period: 30 },
  placeholders: ["DUMMY_LOGIN:username", "DUMMY_LOGIN:password", "TOTP:DUMMY_LOGIN"],
  keypair_id: null, created_by: { type: "key", id: "k1" }, last_used_at: null,
  created_at: "2026-11-19T10:00:00Z", updated_at: "2026-11-19T10:00:00Z",
  used_by: [{ kind: "robot", id: "rb1", name: "Invoices" }],
};

test("secrets.list, listPage and get parse the secret", async () => {
  const c = client({
    "GET /v1/secrets": async () => json({ secrets: [secretBody], limit: 500 }),
    "GET /v1/secrets/DUMMY_LOGIN": async () => json(secretBody),
  });
  const list = await c.secrets.list();
  assert.equal(list[0].name, "DUMMY_LOGIN");
  assert.equal(list[0].usernameMasked, "du…");
  assert.deepEqual(list[0].totp, { digits: 6, algorithm: "SHA1", period: 30 });
  assert.deepEqual(list[0].usedBy, [{ kind: "robot", id: "rb1", name: "Invoices" }]);
  assert.equal(list[0].keypairId, null);
  assert.equal((await c.secrets.listPage()).limit, 500);
  const s = await c.secrets.get("DUMMY_LOGIN");
  assert.equal(s.type, "login");
  assert.equal(s.placeholders[1], "DUMMY_LOGIN:password");
  assert.equal(s.hasTotp, true);
});

test("secrets.create and update send snake_case and only given fields", async () => {
  const seen = [];
  const c = client({
    "POST /v1/secrets": async () => json(secretBody, 201),
    "PATCH /v1/secrets/DUMMY_LOGIN": async () => json(secretBody),
  }, seen);
  await c.secrets.create({
    name: "DUMMY_LOGIN", type: "login", origins: ["example.com"], description: "Test account",
    username: "dummy-user", password: "dummy-pass", totpSecret: "JBSWY3DPEHPK3PXP", totpCode: "000000",
  });
  assert.deepEqual(seen[0].body, {
    name: "DUMMY_LOGIN", type: "login", origins: ["example.com"], description: "Test account",
    username: "dummy-user", password: "dummy-pass", totp_secret: "JBSWY3DPEHPK3PXP", totp_code: "000000",
  });
  await c.secrets.create({ name: "DUMMY_TOKEN", type: "value", origins: ["*"], value: "dummy-value", allowAnyOrigin: true });
  assert.deepEqual(seen[1].body, { name: "DUMMY_TOKEN", type: "value", origins: ["*"], value: "dummy-value", allow_any_origin: true });
  await c.secrets.create({ name: "DUMMY_SEALED", type: "value", origins: ["example.com"], sealedValue: "ZHVtbXk=", keypairId: "kp_1" });
  assert.deepEqual(seen[2].body, { name: "DUMMY_SEALED", type: "value", origins: ["example.com"], sealed_value: "ZHVtbXk=", keypair_id: "kp_1" });

  await c.secrets.update("DUMMY_LOGIN", { origins: ["github.com"], totpSecret: "" });
  assert.deepEqual(seen[3].body, { origins: ["github.com"], totp_secret: "" });
  await c.secrets.update("DUMMY_LOGIN", { description: "New text", digits: 8, algorithm: "SHA256", period: 60 });
  assert.deepEqual(seen[4].body, { description: "New text", digits: 8, algorithm: "SHA256", period: 60 });
});

test("secrets.delete: SECRET_IN_USE carries used_by; force sends ?force=1", async () => {
  const seen = [];
  let inUse = true;
  const c = client({
    "DELETE /v1/secrets/DUMMY_LOGIN": async () => (inUse
      ? json({ error: "DUMMY_LOGIN is in use", code: "SECRET_IN_USE", id: "s1", name: "DUMMY_LOGIN",
          used_by: [{ kind: "schedule", id: "sc1", name: "Nightly" }] }, 409)
      : json({ deleted: true, id: "s1", name: "DUMMY_LOGIN" })),
  }, seen);
  await assert.rejects(c.secrets.delete("DUMMY_LOGIN"), (e) => {
    assert.ok(e instanceof APIError);
    assert.equal(e.code, "SECRET_IN_USE");
    assert.equal(e.status, 409);
    assert.equal(e.body.used_by[0].kind, "schedule");
    return true;
  });
  assert.equal(seen[0].url.search, "");
  inUse = false;
  const r = await c.secrets.delete("DUMMY_LOGIN", { force: true });
  assert.equal(r.deleted, true);
  assert.equal(seen[1].url.searchParams.get("force"), "1");
});

test("secrets.importEnv, usage and keypair", async () => {
  const seen = [];
  const c = client({
    "POST /v1/secrets/import": async () => json({
      secrets: [{ ...secretBody, name: "DUMMY_A", type: "value" }], created: 1, updated: 0, skipped: ["DUMMY_B"],
    }, 201),
    "GET /v1/secrets/DUMMY_LOGIN/usage": async () => json({
      secret_id: "s1", name: "DUMMY_LOGIN", limit: 10, next_cursor: "MTc5",
      usage: [{ job_id: "j1", origin: "https://example.com", action: "typed", source: "replay",
        at: "2026-11-19T10:05:00Z", robot_id: "rb1", robot_name: "Invoices" }],
    }),
    "GET /v1/secrets/keypair": async () => json({
      id: "kp_1", public_key: "AAAA", suite: { kem_id: 32, kdf_id: 1, aead_id: 2, mode: "base" },
      info_prefix: "browsa-secrets/v1:ws:", format: "base64(enc || ciphertext)", use_until: "2026-11-26T00:00:00Z",
    }),
  }, seen);
  const imp = await c.secrets.importEnv("DUMMY_A=dummy-a\nDUMMY_B=dummy-b\n", ["example.com"], {
    description: "dummies", onConflict: "skip",
  });
  assert.deepEqual(seen[0].body, {
    env: "DUMMY_A=dummy-a\nDUMMY_B=dummy-b\n", origins: ["example.com"], description: "dummies", on_conflict: "skip",
  });
  assert.equal(imp.secrets[0].name, "DUMMY_A");
  assert.equal(imp.created, 1);
  assert.deepEqual(imp.skipped, ["DUMMY_B"]);

  const u = await c.secrets.usage("DUMMY_LOGIN", { limit: 10, cursor: "abc" });
  assert.equal(seen[1].url.searchParams.get("limit"), "10");
  assert.equal(seen[1].url.searchParams.get("cursor"), "abc");
  assert.deepEqual(u.usage[0], {
    jobId: "j1", origin: "https://example.com", action: "typed", source: "replay",
    at: "2026-11-19T10:05:00Z", robotId: "rb1", robotName: "Invoices",
  });
  assert.equal(u.nextCursor, "MTc5");
  await c.secrets.usage("DUMMY_LOGIN");
  assert.equal(seen[2].url.search, "");

  const kp = await c.secrets.keypair();
  assert.equal(kp.id, "kp_1");
  assert.equal(kp.publicKey, "AAAA");
  assert.equal(kp.infoPrefix, "browsa-secrets/v1:ws:");
  assert.equal(kp.suite.kem_id, 32);
});

test("secretIds and saveSecrets reach every task-starting call; saveSecrets only when set", async () => {
  const seen = [];
  const job = { id: "j1", status: "queued", kind: "task" };
  const c = client({
    "POST /v1/tasks": async () => json(job, 202),
    "POST /v1/auto": async () => json({ job_id: "j2", routed_via: "task" }, 202),
    "POST /v1/schedules": async () => json({ id: "sc1", interval_seconds: 3600 }, 201),
    "POST /v1/recipes/r1/run": async () => json({ id: "rr1", recipe_id: "r1", status: "queued" }, 202),
    "POST /v1/sessions/j1/messages": async () => json({ ...job, session_id: "j1", turn: 2 }, 202),
  }, seen);
  const task = "Log in with secrets.DUMMY_LOGIN and read the balance";
  const last = () => seen[seen.length - 1].body;

  await c.createTask({ task, llm: "browsa", secretIds: ["DUMMY_LOGIN"], saveSecrets: false });
  assert.deepEqual(last().secret_ids, ["DUMMY_LOGIN"]);
  assert.equal(last().save_secrets, false);

  await c.createTask({ task, llm: "browsa", secretIds: ["DUMMY_LOGIN"] });
  assert.ok(!("save_secrets" in last()));
  await c.createTask({ task: "plain", llm: "browsa" });
  assert.ok(!("secret_ids" in last()) && !("save_secrets" in last()));
  assert.ok(!("secretIds" in last()) && !("saveSecrets" in last()));

  await c.auto(task, { secretIds: ["DUMMY_LOGIN"], saveSecrets: true });
  assert.deepEqual(last().secret_ids, ["DUMMY_LOGIN"]);
  assert.equal(last().save_secrets, true);

  await c.createSchedule({ intervalSeconds: 3600, task, llm: "browsa", secretIds: ["DUMMY_LOGIN"], saveSecrets: false });
  assert.deepEqual(last().secret_ids, ["DUMMY_LOGIN"]);
  assert.equal(last().save_secrets, false);
  assert.equal(last().interval_seconds, 3600);

  await c.runRecipe("r1", { params: { q: "x" }, secretIds: ["DUMMY_LOGIN"] });
  assert.deepEqual(last(), { params: { q: "x" }, secret_ids: ["DUMMY_LOGIN"] });

  await c.sendMessage("j1", task, { secretIds: ["DUMMY_LOGIN"], saveSecrets: false });
  assert.deepEqual(last(), { task, secret_ids: ["DUMMY_LOGIN"], save_secrets: false });

  await c.createSession({ task, llm: "browsa", secretIds: ["DUMMY_LOGIN"] });
  assert.deepEqual(last().secret_ids, ["DUMMY_LOGIN"]);
  assert.equal(last().keep_browser, true);
});

test("act sends secret instead of text for type", async () => {
  const seen = [];
  const c = client({
    "POST /v1/agents/agt1/act": async () => json({
      text: "type [14] secret DUMMY_LOGIN:password (hidden)", status: "ok", secret: "DUMMY_LOGIN:password",
      url: "https://example.com/login", session: "v1", ids_reset: false,
    }),
  }, seen);
  const r = await c.act("agt1", { action: "type", id: 14, secret: "DUMMY_LOGIN:password" });
  assert.deepEqual(seen[0].body, { action: "type", id: 14, secret: "DUMMY_LOGIN:password" });
  assert.equal(r.status, "ok");
});

test("job.savedSecrets and secretsNotSaved come from the job's result", async () => {
  const c = client({
    "GET /v1/jobs/j1": async () => json({
      id: "j1", status: "completed", kind: "task",
      secrets_used: [{ id: "s1", name: "DUMMY_LOGIN", type: "login" }],
      result: {
        final_result: "Signed up",
        saved_secrets: [
          { name: "EXAMPLE_COM_LOGIN", id: "s9", type: "login", origins: ["https://*.example.com"], username_masked: "du…", existing: false },
          { name: "EXAMPLE_API_KEY", id: "s10", type: "value", origins: ["https://api.example.com"], existing: true },
        ],
        secrets_not_saved: { code: "SECRET_LIMIT", message: "The workspace has 500 secrets." },
      },
    }),
    "GET /v1/jobs/j2": async () => json({ id: "j2", status: "completed", kind: "task", result: { final_result: "x" } }),
    "GET /v1/jobs/j3": async () => json({ id: "j3", status: "running", kind: "task", result: null }),
  });
  const j = await c.getJob("j1");
  assert.deepEqual(j.savedSecrets, [
    { name: "EXAMPLE_COM_LOGIN", id: "s9", type: "login", origins: ["https://*.example.com"], usernameMasked: "du…", existing: false },
    { name: "EXAMPLE_API_KEY", id: "s10", type: "value", origins: ["https://api.example.com"], existing: true },
  ]);
  assert.deepEqual(j.secretsNotSaved, { code: "SECRET_LIMIT", message: "The workspace has 500 secrets." });
  assert.equal(j.secretsUsed[0].name, "DUMMY_LOGIN");

  const j2 = await c.getJob("j2");
  assert.deepEqual(j2.savedSecrets, []);
  assert.equal(j2.secretsNotSaved, undefined);
  assert.equal(j2.secretsUsed, undefined);
  assert.deepEqual((await c.getJob("j3")).savedSecrets, []);
});
