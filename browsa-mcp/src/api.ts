// The Browsa API over fetch. Tools call it directly, so they do not depend
// on the installed browsa SDK having a method for each route.

import { BrowsaError } from "browsa";
import { API_KEY, BASE_URL, USER_AGENT } from "./config.js";
import { fetchRetry } from "./retry.js";

export { BrowsaError };

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { "X-API-Key": API_KEY ?? "", Accept: "application/json", "User-Agent": USER_AGENT };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function parse(resp: Response): Promise<any> {
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new BrowsaError(body?.error || body?.message || `HTTP ${resp.status}`, {
      code: body?.code ?? `HTTP_${resp.status}`, requestId: body?.request_id, status: resp.status,
    });
  }
  return body;
}

// GET and DELETE are repeated on 429, a gateway 5xx or no answer; a POST only
// on 429, where the API did nothing (see retry.ts).

export async function apiGet(path: string, timeoutMs = 90_000): Promise<any> {
  return parse(await fetchRetry(`${BASE_URL}${path}`,
    () => ({ headers: headers(false), signal: AbortSignal.timeout(timeoutMs) }), { idempotent: true }));
}

export async function apiPost(path: string, payload: unknown, timeoutMs = 90_000): Promise<any> {
  return parse(await fetchRetry(`${BASE_URL}${path}`, () => ({
    method: "POST", headers: headers(true), body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(timeoutMs),
  }), { idempotent: false }));
}

export async function apiDelete(path: string, timeoutMs = 30_000): Promise<any> {
  return parse(await fetchRetry(`${BASE_URL}${path}`,
    () => ({ method: "DELETE", headers: headers(false), signal: AbortSignal.timeout(timeoutMs) }), { idempotent: true }));
}
