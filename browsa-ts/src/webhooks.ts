/**
 * Webhook signature verification for inbound deliveries.
 *
 * The agents service signs every outbound POST with HMAC-SHA256:
 *
 *     X-Agents-Signature: t=<unix>, v1=<hex>
 *     v1 = HMAC-SHA256(secret, "<unix>.<raw-request-body>")
 *
 * Use `verifySignature` in your receiver BEFORE trusting any payload
 * field. Constant-time comparison + timestamp skew check included.
 *
 * Example with Express:
 *
 *     import express from "express";
 *     import { verifySignature } from "browsa/webhooks";
 *
 *     const SECRET = process.env.BROWSA_WEBHOOK_SECRET!;
 *     app.post("/webhook",
 *       express.raw({ type: "application/json" }), // raw body!
 *       (req, res) => {
 *         const sig = req.header("X-Agents-Signature") || "";
 *         if (!verifySignature(req.body, sig, SECRET)) {
 *           return res.status(401).json({ error: "bad signature" });
 *         }
 *         const payload = JSON.parse(req.body.toString("utf-8"));
 *         // ... trust payload
 *         res.sendStatus(200);
 *       });
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_SKEW_SECONDS = 300;

export function parseSignatureHeader(header: string): { t: string; v1: string } {
  let t = "";
  let v1 = "";
  if (!header) return { t, v1 };
  for (const part of header.split(",")) {
    const kv = part.trim().split("=");
    if (kv.length < 2) continue;
    const k = kv[0]!.trim();
    const v = kv.slice(1).join("=").trim();
    if (k === "t") t = v;
    else if (k === "v1") v1 = v;
  }
  return { t, v1 };
}

export interface VerifyOptions {
  /** Reject deliveries older than this many seconds. Set to 0 to disable skew check. */
  skewSeconds?: number;
}

export function verifySignature(
  // A Node Buffer is a Uint8Array, so both are accepted. Naming Buffer here
  // would make the declaration file need @types/node in every consumer.
  body: Uint8Array | string,
  header: string,
  secret: Uint8Array | string,
  opts: VerifyOptions = {},
): boolean {
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || !v1) return false;
  const unix = Number(t);
  if (!Number.isFinite(unix) || unix <= 0) return false;

  const skew = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  if (skew > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - unix) > skew) return false;
  }

  const bodyBuf =
    typeof body === "string"
      ? Buffer.from(body, "utf-8")
      : Buffer.from(body as Uint8Array);

  let secretBuf: Buffer;
  if (typeof secret === "string") {
    // Accept hex string (the dashboard shows it as hex) or raw utf-8.
    secretBuf = /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0
      ? Buffer.from(secret, "hex")
      : Buffer.from(secret, "utf-8");
  } else {
    secretBuf = Buffer.from(secret as Uint8Array);
  }

  const signed = Buffer.concat([Buffer.from(`${t}.`, "utf-8"), bodyBuf]);
  const expectedHex = createHmac("sha256", secretBuf).update(signed).digest("hex");
  if (expectedHex.length !== v1.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, "utf-8"), Buffer.from(v1, "utf-8"));
  } catch {
    return false;
  }
}
