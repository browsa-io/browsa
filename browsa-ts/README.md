<p align="center">
  <a href="https://browsa.io"><img src="https://browsa.io/browsa-logo-lockup.png" alt="Browsa" width="340"></a>
</p>

# browsa (TypeScript)

Real browsers for AI agents: the official TypeScript/JavaScript SDK for [browsa.io](https://browsa.io).

[![npm version](https://img.shields.io/npm/v/browsa.svg)](https://www.npmjs.com/package/browsa)
[![Node](https://img.shields.io/node/v/browsa.svg)](https://www.npmjs.com/package/browsa)

## Install

```bash
npm install browsa
# or pnpm add browsa / yarn add browsa / bun add browsa
```

Zero deps. Pure Node 18+ fetch. Single ESM+CJS bundle. Audit-friendly.

## Five-line hello world

```ts
import { Client } from "browsa";

const c = new Client({ apiKey: "agt_live_..." });
const job = await c.runTask({
  task: "Go to news.ycombinator.com and return the top story title.",
  llm: "claude-opus-5-5",
  llmApiKey: "sk-ant-...",
});
console.log(job.finalResult);
console.log("watch live:", job.liveUrl);
```

That runs a real Chromium fork (Phantom, our real browser) inside an isolated burner session, driven by [browser-use](https://browser-use.com) + Claude Opus. The agent navigates, extracts, and returns. A live noVNC stream URL is available the moment the burner spawns.

## Saved LLM keys

Save your LLM provider key once in the workspace (dashboard: <https://app.browsa.io/dashboard/llm-keys>, or the API) and tasks use it without the secret in your code:

```ts
const key = await c.createLlmKey({ provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY!, name: "Prod Anthropic" });
console.log(key.id, key.masked, key.status);   // 3f6c...  sk-ant-…a1b2  valid

// The first key of a provider becomes its default, so this needs no key at all:
await c.runTask({ task: "Return the title of example.com" });

// Or pick a saved key by id (also on createTask, createSchedule and auto):
await c.runTask({ task: "...", llm: "anthropic:claude-sonnet-5-5", llmKeyId: key.id });
```

Which key a task uses, first match wins: `llmApiKey` (per task), then `llmKeyId`, then the workspace's default saved key for the provider of `llm` (with `llm` omitted: the first default in the order anthropic, openai, google), then a hosted tier such as `llm: "browsa"` (see [Models](#models)).

| Method | Endpoint |
|---|---|
| `createLlmKey({ provider, apiKey, name?, baseUrl?, default? })` | `POST /v1/llm-keys` |
| `listLlmKeys()` | `GET /v1/llm-keys` |
| `getLlmKey(id)` | `GET /v1/llm-keys/{id}` |
| `validateLlmKey(id)` | `POST /v1/llm-keys/{id}/validate` |
| `rotateLlmKey(id, { apiKey, baseUrl? })` | `POST /v1/llm-keys/{id}/rotate` |
| `updateLlmKey(id, { name?, default? })` | `POST /v1/llm-keys/{id}` |
| `deleteLlmKey(id)` | `DELETE /v1/llm-keys/{id}` |

Providers: `anthropic`, `openai`, `google`, `openai_compatible` (needs `baseUrl`). Each returns an `LLMKey` (or nothing, for delete). The API never returns the secret, only `masked` (prefix + last 4). Keys are checked with a free model-list call when saved or rotated; an invalid key throws `APIError` with code `LLM_KEY_INVALID` and nothing changes. Rotating keeps the id, so schedules and queued runs pick up the new secret. Jobs carry `llmKeyId`, `llmKeyMasked` and `llmKeySource` (`"saved"` or `"default"`).

CLI: `browsa llm-keys` lists saved keys; `browsa run "<task>" --llm-key-id <id>` (or `$BROWSA_LLM_KEY_ID`) runs with one. With no `--llm-key`, `--llm-key-id` or env key, `browsa run` uses the workspace's default saved key.

## Models

A task runs on one of Browsa's hosted tiers, or on any provider model with your own key.

| `llm` | What it is |
|---|---|
| `"browsa"` | The default hosted model |
| `"browsa-fast"` | Fastest and lightest |
| `"browsa-smart"` | For harder tasks |
| anything else, e.g. `"anthropic:claude-sonnet-5-5"` | A provider model, run with your own key (`llmApiKey`, `llmKeyId` or the workspace default) |

Hosted tiers need no LLM key and add a flat number of credits per task. Which model each tier runs on, and what it costs, are server settings that can change, so read them from `models()` (free, read-only) instead of hardcoding them:

```ts
const m = await c.models();
for (const tier of m.hosted) {
  console.log(tier.id, tier.model, tier.reasoning, tier.creditsPerTask, tier.default);
}
console.log(m.ownKey.providers, m.ownKey.defaultModels);
```

`reasoning` sets how much the model reasons: `"low"`, `"medium"` or `"high"`. Leave it out for the tier's or the provider's default. It is accepted by `createTask`, `runTask`, `createSession`, `sendMessage`, `runMessage`, `createSchedule` and `auto`; the API answers 400 for any other value.

```ts
const job = await c.runTask({
  task: "Go to news.ycombinator.com and return the top story title.",
  llm: "browsa-smart",
  reasoning: "high",
});
console.log(job.finalResult);
console.log(job.llmTier, job.reasoning);    // browsa-smart high
if (job.usage) console.log(job.usage.inputTokens, job.usage.outputTokens, job.usage.requests);
console.log(job.llmCostUsd);                // null for hosted runs
```

A finished job has `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `requests`), `llmCostUsd`, `llmTier` and `reasoning` (the level that was applied). `llmCostUsd` is an estimate from public list prices for runs with your own key; it is `null` when unknown and always `null` for hosted runs, which are paid in credits. All four are `undefined` on jobs that do not have them, such as jobs run before these fields existed.

CLI: `browsa models` lists the hosted tiers and own-key providers; `browsa run "<task>" --llm browsa-smart --reasoning high` picks a tier and a reasoning level. After a run, the CLI prints the tier, reasoning, token counts and estimated cost when the job has them.

## Webhooks

```ts
import { verifySignature } from "browsa/webhooks";
import express from "express";

const app = express();
app.post("/webhook",
  express.raw({ type: "application/json" }),  // raw body!
  (req, res) => {
    const sig = req.header("X-Agents-Signature") || "";
    if (!verifySignature(req.body, sig, process.env.BROWSA_WEBHOOK_SECRET!)) {
      return res.status(401).json({ error: "bad signature" });
    }
    const payload = JSON.parse(req.body.toString("utf-8"));
    // trust payload from here
    res.sendStatus(200);
  });
```

## What you get

| Capability | Notes |
|---|---|
| Typed `Job` + `Webhook` | Full TypeScript types, with `.raw` escape hatch |
| Hosted tiers + reasoning | `llm: "browsa" / "browsa-fast" / "browsa-smart"`, `reasoning`, `models()`, `job.usage` |
| Long-poll waits | `waitForJob({ timeoutMs })` uses server-side `?wait=30` |
| Live step events | `for await (const ev of client.streamJobEvents(jobId, { after }))`; resume with `after: lastN` |
| Webhook signature verify | HMAC-SHA256, constant-time compare, skew check |
| Canonical error envelope | `AuthError`, `InvalidIDError`, `RateLimitError`, etc. |
| `X-Request-Id` propagation | Every error carries `requestId` |
| Zero deps | Audit-friendly, no transitive surface |
| ESM + CJS | Works in any Node 18+ runtime, edge runtimes welcome |

## Advanced

### Progress callbacks for long-running tasks

```ts
const job = await c.runTask({
  task: "...",
  llm: "claude-opus-5-5",
  llmApiKey: "sk-ant-...",
  maxSteps: 80,
  onProgress: (j) => console.log(`step ${j.stepCount}/${j.progressTotal}`),
});
```

### Interactive (input_required) tasks

```ts
let job = await c.createTask({ task: "...", llm: "...", llmApiKey: "..." });
while (!["completed", "failed", "cancelled"].includes(job.status)) {
  job = await c.getJob(job.id, { wait: 30 });
  if (job.status === "input_required") {
    const answer = await prompt(`Agent asks: ${job.inputQuestion}\n> `);
    job = await c.respondToJob(job.id, answer);
  }
}
```

### Sessions: follow-up messages on the same browser

Start a task with `createSession` and the browser stays up after it ends (15 minutes by default, `browserTtlSeconds` up to 3600), so you can send follow-ups that continue on the same page. A follow-up pays no new browser, only the task's base and step credits.

```ts
const s = await c.createSession({ task: "Go to example.com and return the H1.", llm: "browsa" });
const first = await c.waitForJob(s.id);
console.log(first.finalResult);

const turn = await c.runMessage(s.sessionId!, "Now open the Learn more link and tell me its URL and H1");
console.log(turn.finalResult);

const session = await c.getSession(s.sessionId!);
console.log(session.status, session.browser.expiresInSeconds, session.turns.map((t) => t.finalResult));
await c.stopSession(s.sessionId!);
```

`sendMessage` returns the new turn's job right away (use `runMessage` to wait). Model fields you leave out reuse the previous turn's model, but a BYOK `llmApiKey` must be sent again on every message. A closed browser throws an `APIError` with `code === "BROWSER_EXPIRED"`; a turn still running throws `code === "SESSION_BUSY"`.

### JA3-spoofed sessions (TLS fingerprint)

```ts
await c.runTask({
  task: "Hit a TLS-fingerprinted site",
  llm: "claude-opus-5-5", llmApiKey: "sk-...",
  ja3Profile: "macos_chrome_137",
});
```

## Docs

- API reference: <https://browsa.io/docs>
- Docs: <https://browsa.io/docs>
- Support: <mailto:support@browsa.io>

## License

MIT.
