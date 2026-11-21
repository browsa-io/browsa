#!/usr/bin/env node
// Writes src/captcha/catalogue-snapshot.json from the public type catalogue
// (GET /types, no key). The snapshot is what the server knows before it has
// reached the network: names, status, parameters and price. Measured numbers
// are left out on purpose: they change, and the live catalogue is their home.
//
//   node scripts/update-catalogue.mjs [https://captcha.browsa.io]
import { writeFileSync } from "node:fs";

const base = (process.argv[2] || "https://captcha.browsa.io").replace(/\/+$/, "");
const r = await fetch(`${base}/types`, { headers: { Accept: "application/json" } });
const body = await r.json();
if (body.errorId || !Array.isArray(body.types)) throw new Error("unexpected catalogue answer");
const names = (ps) => (ps ?? []).map((p) => p.name);
const snapshot = {
  asOf: new Date().toISOString().slice(0, 10),
  service: body.service,
  types: body.types.map((t) => ({
    type: t.type, title: t.title, kind: t.kind, family: t.family, status: t.status,
    ...(t.offReason ? { offReason: t.offReason } : {}),
    required: names(t.required), oneOf: (t.requiredOneOf ?? []).map(names), optional: names(t.optional),
    proxy: t.proxy, credits: t.price?.creditsPerSolve ?? null,
  })),
};
const out = new URL("../src/captcha/catalogue-snapshot.json", import.meta.url);
writeFileSync(out, JSON.stringify(snapshot, null, 1) + "\n");
console.log(`${snapshot.types.length} types written (${snapshot.types.filter((t) => t.status === "live").length} live), as of ${snapshot.asOf}`);
