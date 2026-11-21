// The captcha API's type catalogue (GET /types: public, no key, no
// parameters). The server starts from the snapshot bundled with the package,
// so it knows the types with no network; the live list replaces it when a
// fetch succeeds and is kept for an hour. A failed fetch changes nothing.
//
// BROWSA_CAPTCHA_CATALOGUE=bundled never fetches.

import snapshot from "./catalogue-snapshot.json";
import { captchaCall } from "./client.js";

export interface CatType {
  type: string;
  title: string;
  kind: string;          // "token" or "recognition"
  family: string;
  status: string;        // "live" or "off"
  offReason?: string;
  required: string[];
  oneOf: string[][];
  optional: string[];
  proxy: string;         // "none" or "required"
  credits: number | null;
}

export interface Catalogue {
  source: "bundled" | "live";
  asOf: string;
  types: CatType[];
}

const TTL_MS = 60 * 60 * 1000;
const PINNED = /^bundled$/i.test((process.env.BROWSA_CAPTCHA_CATALOGUE ?? "").trim());

let current: Catalogue = { source: "bundled", asOf: snapshot.asOf, types: snapshot.types as CatType[] };
const RETRY_AFTER_FAIL_MS = 60 * 1000;
let fetchedAt = 0;
let failedAt = 0;
let pending: Promise<void> | null = null;

/** What is known now. Never touches the network. */
export function catalogue(): Catalogue {
  return current;
}

export function typeInfo(name: string, cat: Catalogue = current): CatType | undefined {
  return cat.types.find((t) => t.type === name);
}

export function fromApi(body: any, asOf: string): Catalogue | null {
  if (!body || body.errorId || !Array.isArray(body.types) || !body.types.length) return null;
  const names = (ps: any[]) => (ps ?? []).map((p) => String(p.name));
  return {
    source: "live", asOf,
    types: body.types.map((t: any) => ({
      type: String(t.type), title: String(t.title ?? t.type), kind: String(t.kind ?? ""), family: String(t.family ?? ""),
      status: String(t.status ?? ""), ...(t.offReason ? { offReason: String(t.offReason) } : {}),
      required: names(t.required), oneOf: (t.requiredOneOf ?? []).map(names), optional: names(t.optional),
      proxy: String(t.proxy ?? "none"), credits: typeof t.price?.creditsPerSolve === "number" ? t.price.creditsPerSolve : null,
    })),
  };
}

/** Fetches the live list when the one in memory is older than an hour. Never throws. */
export function refreshCatalogue(): Promise<void> {
  if (PINNED || Date.now() - fetchedAt < TTL_MS || Date.now() - failedAt < RETRY_AFTER_FAIL_MS) return Promise.resolve();
  pending ??= (async () => {
    try {
      // one short try: a solve must not wait on a catalogue the network cannot give
      const live = fromApi(await captchaCall("types", null, { timeoutMs: 5000, retries: 0 }), new Date().toISOString());
      if (live) { current = live; fetchedAt = Date.now(); } else failedAt = Date.now();
    } catch { failedAt = Date.now(); /* offline: keep what we have */ } finally {
      pending = null;
    }
  })();
  return pending;
}
