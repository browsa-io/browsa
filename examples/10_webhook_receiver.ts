// Receive Browsa webhooks (task and job events) and verify their signature. node:http only.
//
// Cost: 0 credits (webhooks are free).
//
// Run (behind a public https address that forwards to PORT):
//   npm i browsa
//   BROWSA_WEBHOOK_SECRET=<hex signing secret> PORT=8080 node 10_webhook_receiver.ts
//   (Node 22.18+; or: npx tsx 10_webhook_receiver.ts)
//
// The signing secret: GET https://browsa.io/v1/webhooks/signing-secret with your key
// in the X-API-Key header. Register the endpoint with client.createWebhook(...).
import http from "node:http";
import { verifySignature } from "browsa/webhooks";

const secret = process.env.BROWSA_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set BROWSA_WEBHOOK_SECRET to your webhook signing secret (hex).");
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks); // the raw bytes, before any parsing
    const signature = String(req.headers["x-agents-signature"] ?? "");
    if (req.method !== "POST" || !verifySignature(raw, signature, secret)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad signature" }));
      return;
    }
    const event = JSON.parse(raw.toString("utf-8"));
    // job_id, job_kind, agent_id and error_code sit at the top level of the event.
    console.log(`event=${event.type} job=${event.job_id} error=${event.error_code ?? "none"}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(Number(process.env.PORT ?? 8080), () => {
  const addr = server.address();
  console.log(`listening on :${typeof addr === "object" && addr ? addr.port : addr}`);
});
