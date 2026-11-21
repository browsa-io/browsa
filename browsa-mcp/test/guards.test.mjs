// The local captcha limits and the retry helpers, with a clock the test moves.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Guard } from "./dist/captcha/guards.js";
import { backoffMs, retryAfterMs } from "./dist/retry.js";

const NONE = { maxCredits: null, ratePerMinute: null, concurrency: null };

describe("guard: spend cap", () => {
  test("no limits: everything passes and spend is still counted", () => {
    const g = new Guard(NONE);
    assert.equal(g.configured, false);
    for (let i = 0; i < 50; i++) { const b = g.begin(0.008); assert.equal(b.ok, true); b.ticket.done(0.008); }
    const a = g.allowance();
    assert.deepEqual([a.spent_credits, a.solved, a.spend_cap, a.rate, a.concurrency], [0.4, 50, "not set", "not set", "not set"]);
  });

  test("a solve that would pass the cap is refused before anything is sent; a failed solve costs nothing", () => {
    const g = new Guard({ ...NONE, maxCredits: 0.02 });
    const a = g.begin(0.008); a.ticket.done(0.008);
    const b = g.begin(0.008); b.ticket.done(0);                 // failed: free
    const c = g.begin(0.008); c.ticket.done(0.008);
    assert.equal(g.allowance().spend_cap.remaining_credits, 0.004);
    const d = g.begin(0.008);
    assert.equal(d.ok, false);
    assert.equal(d.refusal.limit, "spend_cap");
    assert.equal(d.refusal.retry_after_seconds, null);
    assert.match(d.refusal.retry, /not in this session/);
    assert.match(d.refusal.message, /BROWSA_CAPTCHA_MAX_CREDITS is 0\.02/);
    assert.equal(g.begin(0.004).ok, true, "a cheaper solve still fits");
  });

  test("running solves hold their price: two cannot both take the last credits", () => {
    const g = new Guard({ ...NONE, maxCredits: 0.01 });
    const a = g.begin(0.008);
    const b = g.begin(0.008);
    assert.equal(b.ok, false);
    assert.equal(b.refusal.retry_after_seconds, 5);
    assert.match(b.refusal.retry, /running solves end/);
    a.ticket.done(0);
    assert.equal(g.begin(0.008).ok, true, "the failed solve gave its hold back");
  });

  test("done twice counts once", () => {
    const g = new Guard({ ...NONE, maxCredits: 1 });
    const a = g.begin(0.01); a.ticket.done(0.01); a.ticket.done(0.01);
    assert.equal(g.allowance().spent_credits, 0.01);
  });
});

describe("guard: rate and concurrency", () => {
  test("rate: refused with the seconds until the oldest start leaves the minute", () => {
    let now = 1_000_000;
    const g = new Guard({ ...NONE, ratePerMinute: 2 }, () => now);
    g.begin(0.008).ticket.done(0.008);
    now += 10_000;
    g.begin(0.008).ticket.done(0.008);
    now += 5_000;
    const r = g.begin(0.008);
    assert.equal(r.ok, false);
    assert.deepEqual([r.refusal.limit, r.refusal.retry_after_seconds], ["rate", 45]);
    assert.equal(g.allowance().rate.remaining, 0);
    now += 45_000;
    assert.equal(g.begin(0.008).ok, true);
  });

  test("concurrency: refused while the slots are taken, free again when one ends", () => {
    const g = new Guard({ ...NONE, concurrency: 1 });
    const a = g.begin(0.008);
    const b = g.begin(0.008);
    assert.deepEqual([b.ok, b.refusal.limit], [false, "concurrency"]);
    assert.deepEqual(g.allowance().concurrency, { max: 1, running: 1, free: 0 });
    a.ticket.done(0.008);
    assert.equal(g.begin(0.008).ok, true);
  });

  test("a refused call does not use up the rate", () => {
    const g = new Guard({ ...NONE, ratePerMinute: 5, concurrency: 1 });
    const a = g.begin(0.008);
    for (let i = 0; i < 10; i++) assert.equal(g.begin(0.008).ok, false);
    assert.equal(g.allowance().rate.remaining, 4);
    a.ticket.done(0);
  });
});

describe("retry helpers", () => {
  test("Retry-After: seconds, an HTTP date, and rubbish", () => {
    assert.equal(retryAfterMs("3"), 3000);
    assert.equal(retryAfterMs("0.5"), 500);
    const now = Date.parse("2026-11-21T10:00:00Z");
    assert.equal(retryAfterMs("Sat, 21 Nov 2026 10:00:07 GMT", now), 7000);
    assert.equal(retryAfterMs("Sat, 21 Nov 2026 09:00:00 GMT", now), 0);
    assert.equal(retryAfterMs("soon"), null);
    assert.equal(retryAfterMs(null), null);
  });

  test("backoff: full jitter under an exponential ceiling, at most 8 s", () => {
    assert.equal(backoffMs(0, 500, () => 1), 500);
    assert.equal(backoffMs(1, 500, () => 1), 1000);
    assert.equal(backoffMs(2, 500, () => 0.5), 1000);
    assert.equal(backoffMs(10, 500, () => 1), 8000);
    assert.equal(backoffMs(3, 500, () => 0), 0);
    const seen = new Set(Array.from({ length: 20 }, () => backoffMs(4, 500)));
    assert.ok(seen.size > 1, "no jitter");
  });
});
