// Live integration tests — hit the real browsa.io API.
// Skipped when BROWSA_API_KEY isn't set.
//
// Run: BROWSA_API_KEY=agt_live_... node --test test/live.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Client, InvalidIDError, NotFoundError } from "../dist/index.js";

const KEY = process.env.BROWSA_API_KEY;

describe("live integration", { skip: !KEY }, () => {
  const c = new Client({ apiKey: KEY });

  test("credits", async () => {
    const r = await c.credits();
    assert.ok(typeof r.balance === "number");
  });

  test("list keys", async () => {
    const keys = await c.listKeys();
    assert.ok(Array.isArray(keys));
  });

  test("list webhooks", async () => {
    const hooks = await c.listWebhooks();
    assert.ok(Array.isArray(hooks));
  });

  test("signing secret", async () => {
    const s = await c.getSigningSecret();
    assert.ok(typeof s === "string");
    assert.ok(s.length >= 32);
  });

  test("invalid uuid → InvalidIDError + request_id populated", async () => {
    await assert.rejects(c.getJob("not-a-uuid"), (e) => {
      assert.ok(e instanceof InvalidIDError, `expected InvalidIDError, got ${e.constructor.name}`);
      assert.equal(e.code, "INVALID_ID");
      assert.ok(e.requestId, "request_id should be populated by middleware");
      return true;
    });
  });

  test("unknown uuid → NotFoundError", async () => {
    await assert.rejects(c.getJob("00000000-0000-0000-0000-000000000000"), (e) => {
      assert.ok(e instanceof NotFoundError);
      return true;
    });
  });
});
