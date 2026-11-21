// Local limits on captcha solving, kept by this process for its lifetime
// (one MCP session). They sit in front of the API: a refused call sends
// nothing and costs nothing. All three are off unless their variable is set.
//
//   BROWSA_CAPTCHA_MAX_CREDITS       credits this session may spend on solves
//   BROWSA_CAPTCHA_RATE_PER_MINUTE   solves started in any 60 s
//   BROWSA_CAPTCHA_CONCURRENCY       solves running at once
//
// The workspace's own limits (balance, monthly budget, the key's rate) are the
// API's and still apply.

import { numEnv } from "../config.js";

export interface Limits { maxCredits: number | null; ratePerMinute: number | null; concurrency: number | null }

export function limitsFromEnv(): Limits {
  const whole = (n: number | null) => (n === null ? null : Math.max(1, Math.floor(n)));
  return {
    maxCredits: numEnv("BROWSA_CAPTCHA_MAX_CREDITS", null),
    ratePerMinute: whole(numEnv("BROWSA_CAPTCHA_RATE_PER_MINUTE", null, 1)),
    concurrency: whole(numEnv("BROWSA_CAPTCHA_CONCURRENCY", null, 1)),
  };
}

export interface Refusal {
  limit: "spend_cap" | "rate" | "concurrency";
  message: string;
  /** Seconds until a retry can pass; null when waiting does not help. */
  retry_after_seconds: number | null;
  retry: string;
}

export interface Ticket {
  /** Ends the solve: `credits` is what the API charged (0 for a failed solve). */
  done(credits: number): void;
}

const WINDOW_MS = 60_000;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export class Guard {
  private spent = 0;
  private reserved = 0;
  private running = 0;
  private solves = 0;
  private starts: number[] = [];

  constructor(readonly limits: Limits, private now: () => number = Date.now) {}

  get configured(): boolean {
    const l = this.limits;
    return l.maxCredits !== null || l.ratePerMinute !== null || l.concurrency !== null;
  }

  private recent(): number[] {
    const from = this.now() - WINDOW_MS;
    this.starts = this.starts.filter((t) => t > from);
    return this.starts;
  }

  /** Asks to start one solve that costs `price` credits when it succeeds. */
  begin(price: number): { ok: true; ticket: Ticket } | { ok: false; refusal: Refusal } {
    const l = this.limits;
    if (l.concurrency !== null && this.running >= l.concurrency) {
      return { ok: false, refusal: {
        limit: "concurrency", retry_after_seconds: 5, retry: "when a running solve ends (a token solve takes seconds to about 2 minutes)",
        message: `${this.running} captcha solves are running and BROWSA_CAPTCHA_CONCURRENCY is ${l.concurrency}`,
      } };
    }
    if (l.ratePerMinute !== null && this.recent().length >= l.ratePerMinute) {
      const wait = Math.max(1, Math.ceil((this.starts[0] + WINDOW_MS - this.now()) / 1000));
      return { ok: false, refusal: {
        limit: "rate", retry_after_seconds: wait, retry: `in ${wait} s`,
        message: `${this.starts.length} solves started in the last minute and BROWSA_CAPTCHA_RATE_PER_MINUTE is ${l.ratePerMinute}`,
      } };
    }
    if (l.maxCredits !== null && this.spent + this.reserved + price > l.maxCredits + 1e-9) {
      const waiting = this.reserved > 0;
      return { ok: false, refusal: {
        limit: "spend_cap", retry_after_seconds: waiting ? 5 : null,
        retry: waiting
          ? "when the running solves end: a failed solve gives its reserved credits back"
          : "not in this session: raise BROWSA_CAPTCHA_MAX_CREDITS in this server's env and restart it",
        message: `this solve costs ${price} credits; the session has spent ${round(this.spent)}`
          + `${this.reserved ? ` and holds ${round(this.reserved)} for running solves` : ""}, and BROWSA_CAPTCHA_MAX_CREDITS is ${l.maxCredits}`,
      } };
    }
    this.running += 1;
    this.reserved += price;
    this.starts.push(this.now());
    let open = true;
    return { ok: true, ticket: { done: (credits: number) => {
      if (!open) return;
      open = false;
      this.running -= 1;
      this.reserved = Math.max(0, this.reserved - price);
      if (credits > 0) { this.spent += credits; this.solves += 1; }
    } } };
  }

  /** What is left, for the agent. Limits that are not set say so. */
  allowance(): Record<string, unknown> {
    const l = this.limits;
    const used = this.recent().length;
    return {
      spent_credits: round(this.spent),
      solved: this.solves,
      spend_cap: l.maxCredits === null ? "not set"
        : { max_credits: l.maxCredits, remaining_credits: round(Math.max(0, l.maxCredits - this.spent - this.reserved)), reserved_credits: round(this.reserved) },
      rate: l.ratePerMinute === null ? "not set"
        : { per_minute: l.ratePerMinute, remaining: Math.max(0, l.ratePerMinute - used),
          ...(used ? { oldest_frees_in_seconds: Math.max(1, Math.ceil((this.starts[0] + WINDOW_MS - this.now()) / 1000)) } : {}) },
      concurrency: l.concurrency === null ? "not set" : { max: l.concurrency, running: this.running, free: Math.max(0, l.concurrency - this.running) },
    };
  }
}

/** The one guard of this server process. */
export const guard = new Guard(limitsFromEnv());
