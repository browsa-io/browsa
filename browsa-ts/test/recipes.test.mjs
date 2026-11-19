// Recipe (replay) methods with a mocked fetch.
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

const recipeBody = {
  id: "r1", name: "shop-search", status: "active", current_version: 1, repair_mode: "auto",
  price_credits: 8, created_at: "2026-11-18T00:00:00Z", recipe: { name: "shop-search", version: 1 },
};
const runBody = {
  id: "run1", job_id: "run1", recipe_id: "r1", version: 1, status: "ok", params: { query: "tv" },
  output: { items: [1] }, error_code: null, error_message: null, layers: [{ step: "s1", layer: 1 }],
  layer_used: { s1: 1 }, repaired: false, repaired_steps: [], new_version: null, duration_ms: 2100,
  price_credits: 8, credits: 8, finished_at: "2026-11-18T00:00:03Z",
};

test("createRecipe from a job and from an upload", async () => {
  const seen = [];
  const c = client({ "POST /v1/recipes": async () => json(recipeBody, 201) }, seen);
  const r = await c.createRecipe({ fromJobId: "job-1", name: "shop-search", repairMode: "review" });
  assert.equal(r.id, "r1");
  assert.equal(r.currentVersion, 1);
  assert.equal(r.priceCredits, 8);
  assert.deepEqual(seen[0].body, { from_job_id: "job-1", name: "shop-search", repair_mode: "review" });
  await c.createRecipe({ recipe: { name: "x", steps: [{ id: "s1", kind: "navigate", url: "u" }] } });
  assert.deepEqual(Object.keys(seen[1].body), ["recipe"]);
  assert.equal(seen[1].body.recipe.steps[0].id, "s1");
});

test("listRecipes, getRecipe, versions, promote, rollback, delete", async () => {
  const seen = [];
  const c = client({
    "GET /v1/recipes": async () => json({ recipes: [recipeBody] }),
    "GET /v1/recipes/r1": async () => json(recipeBody),
    "GET /v1/recipes/r1/versions": async () => json({ versions: [{ version: 2, status: "draft", verified_at: "t", promoted_at: null }] }),
    "POST /v1/recipes/r1/versions/2/promote": async () => json({ ...recipeBody, current_version: 2 }),
    "POST /v1/recipes/r1/rollback": async () => json(recipeBody),
    "DELETE /v1/recipes/r1": async () => json({ deleted: true, id: "r1" }),
  }, seen);
  assert.equal((await c.listRecipes({ limit: 5 }))[0].name, "shop-search");
  assert.equal(seen[0].url.searchParams.get("limit"), "5");
  assert.equal((await c.getRecipe("r1")).recipe.version, 1);
  const vs = await c.listRecipeVersions("r1", { includeRecipe: true });
  assert.equal(vs[0].version, 2);
  assert.equal(vs[0].verifiedAt, "t");
  assert.equal(seen[2].url.searchParams.get("include"), "recipe");
  assert.equal((await c.promoteRecipeVersion("r1", 2)).currentVersion, 2);
  await c.rollbackRecipe("r1", { version: 1 });
  assert.deepEqual(seen[4].body, { version: 1 });
  await c.deleteRecipe("r1");
  assert.equal(seen[5].key, "DELETE /v1/recipes/r1");
});

test("runRecipe sends params and wait, returns the run", async () => {
  const seen = [];
  const c = client({ "POST /v1/recipes/r1/run": async () => json(runBody) }, seen);
  const run = await c.runRecipe("r1", {
    params: { query: "tv" }, wait: 30, webhookUrl: "https://example.com/h",
    proxy: { network: "residential", country: "us" }, profileId: "agt_1",
  });
  assert.deepEqual(seen[0].body, {
    params: { query: "tv" }, wait: 30, webhook_url: "https://example.com/h",
    proxy: { network: "residential", country: "us" }, profile_id: "agt_1",
  });
  assert.equal(run.status, "ok");
  assert.deepEqual(run.output, { items: [1] });
  assert.equal(run.credits, 8);
  assert.equal(run.priceCredits, 8);
  assert.equal(run.layerUsed.s1, 1);
  assert.equal(run.durationMs, 2100);
});

test("runRecipe surfaces PARAMS_INVALID", async () => {
  const c = client({
    "POST /v1/recipes/r1/run": async () => json({ code: "PARAMS_INVALID", error: "params do not match" }, 400),
  });
  await assert.rejects(() => c.runRecipe("r1", { params: {} }), (e) => e instanceof APIError && /params/.test(e.message));
});

test("getRecipeRun with wait, cancelRecipeRun", async () => {
  const seen = [];
  const c = client({
    "GET /v1/recipe-runs/run1": async () => json({ ...runBody, status: "failed", error_code: "blocked", credits: 0 }),
    "POST /v1/recipe-runs/run1/cancel": async () => json({ ...runBody, status: "cancelled", error_code: "cancelled" }),
  }, seen);
  const run = await c.getRecipeRun("run1", { wait: 90 });
  assert.equal(seen[0].url.searchParams.get("wait"), "60");
  assert.equal(run.errorCode, "blocked");
  assert.equal(run.credits, 0);
  assert.equal((await c.cancelRecipeRun("run1")).status, "cancelled");
});

test("createTask sends recordRecipe as record_recipe; job reads recipe_draft_id", async () => {
  const seen = [];
  const c = client({
    "POST /v1/tasks": async () => json({ id: "j1", status: "queued", kind: "task" }, 202),
    "GET /v1/jobs/j1": async () => json({ id: "j1", status: "completed", kind: "task", record_recipe: true, recipe_draft_id: "r9" }),
    "GET /v1/jobs/j2": async () => json({ id: "j2", status: "running", kind: "task", record_recipe: true, recipe_draft_id: null }),
  }, seen);
  await c.createTask({ task: "find tvs", llm: "browsa", recordRecipe: true });
  assert.equal(seen[0].body.record_recipe, true);
  assert.equal("recordRecipe" in seen[0].body, false);
  const job = await c.getJob("j1");
  assert.equal(job.recipeDraftId, "r9");
  assert.equal(job.recordRecipe, true);
  assert.equal((await c.getJob("j2")).recipeDraftId, null);
});
