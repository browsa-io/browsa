// run_task takes secret_ids and save_secrets and returns saved_secrets.
// Every value here is an obvious dummy.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { startMockApi, startMcp } from "./helpers.mjs";

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const DONE = {
  id: JOB_ID, status: "completed", kind: "task", step_count: 6, progress_total: 25,
  outcome: "completed", outcome_message: "The task finished.", signals: [],
  result: {
    final_result: "Signed up",
    saved_secrets: [{ name: "EXAMPLE_COM_LOGIN", id: "s9", type: "login", origins: ["https://*.example.com"],
      username_masked: "du…", existing: false }],
    secrets_not_saved: { code: "NO_USERNAME", message: "The second form had no username." },
  },
};

describe("run_task and workspace secrets", () => {
  let api, mcp;
  before(async () => {
    api = await startMockApi({
      "POST /v1/tasks": () => [202, { ...DONE, status: "queued", result: null }],
      [`GET /v1/jobs/${JOB_ID}`]: () => DONE,
    });
    mcp = await startMcp(api.url, { BROWSA_MCP_TOOLS: "all" }).init();
  });
  after(() => { mcp?.kill(); api?.close(); });

  test("the schema has secret_ids and save_secrets and the description mentions saved_secrets", async () => {
    const t = (await mcp.tools()).find((x) => x.name === "run_task");
    assert.equal(t.inputSchema.properties.secret_ids.type, "array");
    assert.equal(t.inputSchema.properties.save_secrets.type, "boolean");
    assert.match(t.inputSchema.properties.secret_ids.description, /secrets\.NAME/);
    assert.match(t.description, /saved_secrets/);
    for (const text of [t.description, t.inputSchema.properties.secret_ids.description, t.inputSchema.properties.save_secrets.description]) {
      assert.ok(!/chromium/i.test(text));
    }
  });

  test("secret_ids and save_secrets reach POST /v1/tasks; the result lists saved_secrets", async () => {
    const r = await mcp.call("run_task", {
      task: "Sign up on example.com and log in with secrets.DUMMY_LOGIN", llm: "browsa",
      secret_ids: ["DUMMY_LOGIN"], save_secrets: false,
    });
    assert.equal(r.isError, false);
    const sent = api.last("/v1/tasks").body;
    assert.deepEqual(sent.secret_ids, ["DUMMY_LOGIN"]);
    assert.equal(sent.save_secrets, false);
    const body = JSON.parse(r.text);
    assert.deepEqual(body.saved_secrets, [{ name: "EXAMPLE_COM_LOGIN", id: "s9", type: "login",
      origins: ["https://*.example.com"], username_masked: "du…", existing: false }]);
    assert.equal(body.secrets_not_saved.code, "NO_USERNAME");
  });

  test("without them nothing extra is sent", async () => {
    await mcp.call("run_task", { task: "Read the title", llm: "browsa" });
    const sent = api.last("/v1/tasks").body;
    assert.ok(!("secret_ids" in sent));
    assert.ok(!("save_secrets" in sent));
  });

  test("get_job shows saved_secrets too", async () => {
    const r = await mcp.call("get_job", { job_id: JOB_ID });
    assert.equal(JSON.parse(r.text).saved_secrets[0].name, "EXAMPLE_COM_LOGIN");
  });
});
