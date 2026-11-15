// Node.js built-in test runner — no jest, no vitest.
// Run: node --test test/webhooks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifySignature, parseSignatureHeader } from "../dist/webhooks.js";

function mkSig(body, secretHex, t) {
  const secret = Buffer.from(secretHex, "hex");
  const signed = Buffer.concat([Buffer.from(`${t}.`, "utf-8"), Buffer.from(body)]);
  const v1 = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${t}, v1=${v1}`;
}

// Produced by the server's own signer (services/agents webhook dispatcher:
// SigningSecretHex + signPayload). Pins the SDK to the server's scheme:
// the hex secret is decoded to bytes before the HMAC.
const SERVER_VECTOR = {
  secret: "d91fa6dc5ad9593624374801db6a037f3991e3e336448511948d7f97a8cfd426",
  body: '{"id":"evt_1","type":"job.completed","job_id":"j1"}',
  header: "t=1700000000, v1=9c4aa64a67d46e2cc817ec2f689b9f1e9f542d4eb2975a43326bf5e48c41cecc",
};

test("verifies a signature made by the server's signer", () => {
  const { secret, body, header } = SERVER_VECTOR;
  assert.equal(verifySignature(body, header, secret, { skewSeconds: 0 }), true);
  assert.equal(verifySignature(Buffer.from(body), header, Buffer.from(secret, "hex"), { skewSeconds: 0 }), true);
  assert.equal(verifySignature(body + " ", header, secret, { skewSeconds: 0 }), false);
  // Old timestamp: rejected once the default 300s skew check is on.
  assert.equal(verifySignature(body, header, secret), false);
});

test("verify good signature", () => {
  const secret = "deadbeefcafebabe".repeat(4); // 64 hex = 32 bytes
  const body = Buffer.from('{"type":"job.completed"}', "utf-8");
  const t = Math.floor(Date.now() / 1000);
  const sig = mkSig(body, secret, t);
  assert.equal(verifySignature(body, sig, secret), true);
});

test("rejects bad signature", () => {
  const secret = "deadbeef".repeat(8);
  const body = Buffer.from("{}", "utf-8");
  const t = Math.floor(Date.now() / 1000);
  const sig = mkSig(body, secret, t).replace("v1=", "v1=ffffff").slice(0, -6) + "00";
  assert.equal(verifySignature(body, sig, secret), false);
});

test("rejects old timestamp", () => {
  const secret = "11111111".repeat(8);
  const body = Buffer.from("{}", "utf-8");
  const t = Math.floor(Date.now() / 1000) - 3600; // 1h ago
  const sig = mkSig(body, secret, t);
  assert.equal(verifySignature(body, sig, secret), false);
});

test("accepts string body", () => {
  const secret = "22222222".repeat(8);
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const sig = mkSig(Buffer.from(body, "utf-8"), secret, t);
  assert.equal(verifySignature(body, sig, secret), true);
});

test("empty header returns false", () => {
  assert.equal(verifySignature("{}", "", "00".repeat(32)), false);
});

test("parseSignatureHeader extracts t and v1", () => {
  const r = parseSignatureHeader("t=1700000000, v1=deadbeef");
  assert.equal(r.t, "1700000000");
  assert.equal(r.v1, "deadbeef");
});

test("parseSignatureHeader handles whitespace + extra fields", () => {
  const r = parseSignatureHeader("  t=42 ,  v1=cafe,  z=ignored");
  assert.equal(r.t, "42");
  assert.equal(r.v1, "cafe");
});
