// Browsa's captcha API (createTask / getTaskResult), called with fetch.
// Default: https://captcha.browsa.io, or <BROWSA_BASE_URL>/captcha-api when
// BROWSA_BASE_URL points at another copy (staging).

import { BrowsaError } from "browsa";
import { API_KEY, BASE_URL, BASE_URL_SET, numEnv, USER_AGENT } from "../config.js";
import { backoffMs, fetchRetry, RETRIES, sleep } from "../retry.js";

const CAPTCHA_UA = `${USER_AGENT} (captcha)`;

export const CAPTCHA_URL = (process.env.BROWSA_CAPTCHA_URL ||
  (BASE_URL_SET ? `${BASE_URL}/captcha-api` : "https://captcha.browsa.io"))
  .replace(/\/+$/, "");

const POLL_MS = numEnv("BROWSA_CAPTCHA_POLL_MS", 3000, 1) as number;
/** Seconds the API is asked to hold a call (it allows 25). */
const WAIT_S = 20;

// Calls that change nothing when sent twice. createTask and the reports are
// not among them: they are repeated only when the API refused them outright.
const IDEMPOTENT = new Set(["types", "errors", "health", "getTaskResult", "getBalance"]);

/**
 * One call. payload null: a GET with no key (the catalogue is public).
 * Every API answer, an error too, is HTTP 200 with errorId; anything else
 * (a gateway page) throws.
 */
export async function captchaCall(method: string, payload: Record<string, unknown> | null,
  opts: { timeoutMs?: number; retries?: number } = {}): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? RETRIES;
  const init = (): RequestInit => payload === null
    ? { method: "GET", headers: { Accept: "application/json", "User-Agent": CAPTCHA_UA }, signal: AbortSignal.timeout(timeoutMs) }
    : {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": CAPTCHA_UA },
      body: JSON.stringify({ clientKey: API_KEY, ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  const isApiAnswer = (b: any) => !!b && typeof b === "object" && "errorId" in b;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchRetry(`${CAPTCHA_URL}/${method}`, init, { idempotent: IDEMPOTENT.has(method), isApiAnswer, retries });
    const body: any = await resp.json().catch(() => null);
    if (!isApiAnswer(body)) {
      throw new BrowsaError(`captcha API: unexpected answer (HTTP ${resp.status})`, { code: `HTTP_${resp.status}`, status: resp.status });
    }
    // The key's per-minute limit: the API did nothing, so any call may go again.
    if (body.errorCode === "ERROR_RATE_LIMIT" && attempt < retries) {
      await sleep(backoffMs(attempt, 1000));
      continue;
    }
    return body;
  }
}

export type TaskOutcome =
  | { state: "solved"; taskId: string; body: any; seconds: number }
  | { state: "error"; body: any }
  | { state: "timeout"; taskId: string; timeoutMs: number };

/**
 * Creates a task and waits for its end. The API holds each call until the
 * task ends (waitSeconds), so there is no poll timer to wait out; a server
 * that does not hold calls is polled.
 */
export async function runCaptchaTask(task: Record<string, unknown>, timeoutMs: number): Promise<TaskOutcome> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const hold = () => Math.max(0, Math.min(WAIT_S, Math.floor((deadline - Date.now()) / 1000)));
  const solved = (taskId: string, b: any): TaskOutcome => ({
    state: "solved", taskId, body: b,
    seconds: typeof b.solveSeconds === "number" ? b.solveSeconds : Math.round((Date.now() - started) / 100) / 10,
  });
  const created = await captchaCall("createTask", { task, ...(hold() ? { waitSeconds: hold() } : {}) });
  if (created.errorId) return { state: "error", body: created };
  if (created.status === "ready" && created.solution) return solved(created.taskId, created);
  while (Date.now() < deadline) {
    const wait = hold();
    if (!wait) await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    const asked = Date.now();
    const r = await captchaCall("getTaskResult", { taskId: created.taskId, ...(wait ? { waitSeconds: wait } : {}) });
    if (r.errorId) return { state: "error", body: { taskId: created.taskId, ...r } };
    if (r.status === "ready") return solved(created.taskId, r);
    if (wait && Date.now() - asked < 1000) {
      // answered at once though asked to hold (an older server): poll, do not spin
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  return { state: "timeout", taskId: created.taskId, timeoutMs };
}
