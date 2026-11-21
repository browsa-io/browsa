// Retries for calls that are safe to repeat: exponential backoff with full
// jitter, and the server's Retry-After when it sends one.
//
//   429                      any call: the server refused it before doing work
//   502, 503, 504, 5xx       only calls that change nothing (GET, DELETE, a
//                            result poll), and only when the answer is not the
//                            API's own error (a JSON body with a code) or it
//                            carries Retry-After
//   no answer (network)      only calls that change nothing
//
// A POST that may have been carried out is never sent twice.

import { numEnv } from "./config.js";

export const RETRIES = numEnv("BROWSA_MCP_RETRIES", 2, 0, 5) as number;
const BASE_MS = numEnv("BROWSA_MCP_RETRY_BASE_MS", 500, 1, 10_000) as number;
const CAP_MS = 8_000;
/** A Retry-After longer than this is not waited out: the caller gets the answer. */
export const MAX_RETRY_AFTER_MS = 30_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full jitter: a random wait up to base * 2^attempt, at most 8 s. */
export function backoffMs(attempt: number, base = BASE_MS, random: () => number = Math.random): number {
  return Math.round(random() * Math.min(CAP_MS, base * 2 ** attempt));
}

/** Retry-After in ms: seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface RetryOpts {
  /** The call changes nothing when repeated (GET, DELETE, a poll). */
  idempotent: boolean;
  retries?: number;
  /** Tells whether a 5xx body is the API's own answer (then it is not retried). */
  isApiAnswer?: (body: any) => boolean;
}

const defaultIsApiAnswer = (b: any) => !!b && typeof b === "object" && typeof b.code === "string";

/**
 * fetch with the rules above. `init` is called for every attempt, so each one
 * gets its own timeout signal. Returns the last response; throws the last
 * network error.
 */
export async function fetchRetry(url: string, init: () => RequestInit, opts: RetryOpts): Promise<Response> {
  const max = opts.retries ?? RETRIES;
  const isApi = opts.isApiAnswer ?? defaultIsApiAnswer;
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, init());
    } catch (e) {
      // a timeout already took the caller's whole budget: do not wait it out again
      if (!opts.idempotent || attempt >= max || (e as Error)?.name === "TimeoutError") throw e;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (attempt >= max) return resp;
    const after = retryAfterMs(resp.headers.get("retry-after"));
    let again = resp.status === 429;
    if (!again && resp.status >= 500 && opts.idempotent) {
      again = after !== null || !isApi(await resp.clone().json().catch(() => null));
    }
    if (!again) return resp;
    if (after !== null && after > MAX_RETRY_AFTER_MS) return resp;
    await resp.body?.cancel().catch(() => {});
    await sleep(after ?? backoffMs(attempt));
  }
}
