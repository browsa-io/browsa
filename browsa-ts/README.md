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
  llm: "browsa",
  onProgress: (j) => j.liveUrl && console.log("watch live:", j.liveUrl),
});
console.log(job.outcome, job.finalResult);
```

That runs Phantom, our own browser, in a temporary cloud browser, driven by Browsa's hosted model: no LLM key needed. To use your own model instead, pass `llm: "anthropic:claude-sonnet-5-5"` with `llmApiKey`, or save the key once (below).

`job.status` says the run ended; `job.outcome` says how. `outcome: "failed"` with `status: "completed"` means the agent finished but could not do the task, and `finalResult` says what stopped it.

`liveUrl` is a Phantom Live link to watch the browser. It exists only while the task runs (so read it in `onProgress` or from `createTask`), and each link opens once.

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

A task runs on one of Browsa's hosted tiers, or on any provider model with your own key. reCAPTCHA v2 image grids (3 x 3, 4 x 4 and reloading tiles), image-text captchas, GeeTest slide puzzles (v3 and v4) and AWS WAF captchas met during a task are solved in the browser's own session on workspaces that have bought a pack; other kinds are listed at https://browsa.io/captcha.

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

## Robots

A robot is a browser job you set up once: record a task, then run it on rows of input, on demand, on a schedule or from the API. Runs replay the recording on Phantom with no model.

```ts
const BOOK = "https://books.toscrape.com/catalogue";

// 1. Record a task once
const job = await c.runTask({
  task: "Open the product page and return title, price and in_stock",
  llm: "browsa",
  initialUrl: `${BOOK}/sharp-objects_997/index.html`,
  recordRecipe: true,
});

// 2. Save it as a robot
const robot = await c.robots.create({
  name: "Book prices",
  fromJobId: job.id,
  inputs: [{ url: `${BOOK}/sharp-objects_997/index.html` }, { url: `${BOOK}/soumission_998/index.html` }],
  schedule: { intervalSeconds: 86400, at: "09:00", tz: "UTC" },
  monitors: [{ field: "price", op: "changed" }],
  settings: { proxy: { network: "datacenter" } },
});

// 3. Run it and read the rows
const run = await c.robotRuns.wait((await c.robots.run(robot.id)).id);
for (const r of run.rows ?? []) console.log(r.row, r.status, r.output ?? r.errorCode);
const csv = await c.robotRuns.export(run.id);          // or { format: "json" }
```

| | |
|---|---|
| Price | `robot.health.priceCredits` per successful row, the same as the agent task. Failed rows are free. |
| Settings | `model` (records and repairs), `proxy` (Browsa's network: datacenter 5, residential 50 credits/GB; or a saved `proxyId`, free), `browser` (`os`, `screen`), `secrets` (names of workspace secrets every row may type). Unset is Auto. `update({ settings })` changes only the parts you pass. |
| More | `list`, `get`, `update`, `delete`, `pause`, `resume`, `runs`, `alerts`, `markAlertsRead`. Recipes alone: `createRecipe`, `runRecipe`, `getRecipeRun`. |

Guide: <https://browsa.io/guides/robots>.

## Secrets

One vault per workspace for what an agent types but must never read: logins (with an optional one-time-code seed), one-time-code seeds and plain values. Values are write-only, and a secret is typed only on its `origins`.

```ts
await client.secrets.create({
  name: "GITHUB_LOGIN", type: "login", origins: ["github.com"],
  username: "release-bot", password: process.env.GH_PASSWORD!,
  description: "Bot account for the release checks",
});

const job = await client.runTask({
  task: "Log in to github.com with secrets.GITHUB_LOGIN and list my open pull requests",
  llm: "browsa",
  secretIds: ["GITHUB_LOGIN"], // attachment is explicit
});
```

In the task text: `secrets.NAME`, `secrets.NAME.username`, `secrets.NAME.password`, `secrets.NAME.totp`. A reference to a secret that is not in `secretIds` is 400 `SECRET_NOT_ATTACHED`. `secretIds` also works on `auto`, `createSchedule`, `runRecipe` and `sendMessage`; `act(id, { action: "type", id: 14, secret: "GITHUB_LOGIN:password" })` types one into a field.

When a run creates a login (a signup), it is saved as a secret: `job.savedSecrets` lists what was saved (`name`, `id`, `type`, `origins`, `usernameMasked`, `existing`) and `job.secretsNotSaved` says why not (`code`, `message`). Pass `saveSecrets: false` to opt out.

More: `list`, `get`, `update`, `delete(name, { force: true })`, `importEnv`, `usage`, `keypair` (to seal values with your own HPKE library; plain values over TLS are accepted). Changing secrets needs a key with the `secrets:write` scope.

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
| Typed `Job` + `Webhook` | Full TypeScript types for ESM and CommonJS projects, with `.raw` escape hatch |
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
const s = await c.createSession({ task: "Go to example.com and return the page title.", llm: "browsa" });
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

### Observe and act (no Playwright)

Read a running browser's page as compact text with element ids, then act on the ids. Each `act` returns what changed, not the whole page.

```ts
const b = await c.createAgent({ ttl: "10m" });
await c.act(b.id, { action: "navigate", url: "https://example.com/login" });
const view = await c.observe(b.id);
console.log(view.text);                    // [3] textbox "Email"  empty …
const r = await c.act(b.id, { action: "type", id: 3, text: "ada@example.com" });
console.log(r.status, r.text);             // ok  ~ [3] textbox "Email"  value "ada@example.com"
await c.act(b.id, { action: "click", role: "button", name: "Sign in" });
```

`status` is `ok`, `failed`, `blocked`, `challenge` or `stale`; none of them throws. `stale` means the ids came from a view the server no longer has (`ids_reset` is true): nothing was done and `text` carries a new view. Both calls are free. Format and actions: <https://browsa.io/docs#agents-observe>.

### Downloads and Phantom Live

Files a browser downloads are kept with the browser, not on your machine, so Playwright's `download.saveAs()` cannot reach them. List and fetch them through the API before you stop the browser:

```ts
const files = await c.listDownloads(b.id);          // [{ name, size, modified_at }]
const bytes = await c.downloadFile(b.id, files[0].name);
```

With Playwright the name is the last part of `await download.path()`.

`createLiveLink` gives a link that shows a running browser in any web browser, to watch or to take over:

```ts
const link = await c.createLiveLink(b.id, { scope: "control", ttlSeconds: 600 });
console.log(link.live_url);                         // opens once; make one per person
```

`scope` is `"view"` (default) or `"control"`. Both calls are free.

## Captcha solving

`CaptchaClient` is a client for Browsa's captcha API: `createTask`, `getTaskResult` and `getBalance` in the format CapSolver, Anti-Captcha, CapMonster and 2Captcha's v2 API share. Same key and credits as the browser API. Failed and unsolvable tasks are not charged. Measured pass rates per type: <https://browsa.io/captcha>.

```ts
import { CaptchaClient, CaptchaError, captchaTasks as tasks } from "browsa";

const cap = new CaptchaClient();          // BROWSA_API_KEY; https://captcha.browsa.io (or BROWSA_CAPTCHA_URL)
const sol = await cap.solve(tasks.recaptchaV3("https://example.com/login", "6Lc...", { pageAction: "login" }));
sol.gRecaptchaResponse;                    // typed by the builder; sol.taskId is the task id

const { text } = await cap.solve(tasks.imageToText(fs.readFileSync("captcha.png")));
await cap.getBalance();                    // credits
```

Builders: `imageToText`, `recaptchaV2`, `recaptchaV3`, `turnstile`, `recaptchaV2Classification` (and `awsWafClassification`, `slider`). Each takes `proxy` (a URL string or `{ type, host, port, username, password }`); without one the proxyless type is used.

A task copied from code for another service works as it is: `RecaptchaV2TaskProxyless`, `TurnstileTask`, `NoCaptchaTaskProxyless` and the like are sent under Browsa's names (`normalizeCaptchaTask`). Errors throw `CaptchaError` with the API's `code`.

`solve` does not poll on a timer: it asks the API to hold each call until the task ends, so a 7 s solve is answered at 7 s. The solution says what it cost and how long it took, and you can report whether the site took it:

```ts
const sol = await cap.solve(tasks.turnstile("https://example.com", "0x4AAAA..."));
sol.cost;            // { charged: true, amount: 0.008, unit: "credits", note: "Charged once, for this solve." }
sol.solveSeconds;    // 6.42
await cap.reportCorrect(sol.taskId);     // the site took it
// await cap.reportIncorrect(sol.taskId); // or: the site refused it (one report per task, within 15 minutes)

for (const t of await cap.listTypes()) { // every type: status, parameters, price, measured pass rate (no key sent)
  console.log(t.type, t.status, t.price.creditsPerSolve, t.required.map((p) => p.name));
}
```

More builders: `geetestSlideV3`, `geetestSlideV4`, `cloudflareChallenge`. A failed solve is free; `CaptchaError` carries `fix` (what to change) and `charged`. Reports are recorded and used to improve solving.

Coming from a library that cannot be pointed at another server:

```ts
import { TwoCaptchaSolver as Solver, useWithAntiCaptcha } from "browsa";
const solver = new Solver("agt_live_...");        // same calls as @2captcha/captcha-solver
const { data } = await solver.recaptcha({ pageurl: "https://example.com", googlekey: "6Le-..." });

useWithAntiCaptcha(require("@antiadmin/anticaptchaofficial"));   // its requests go to Browsa
```

CapSolver clients (`baseUrl`) and CapMonster's (`serviceUrl`) take a base URL as they are.

## Docs

- API reference: <https://browsa.io/docs>
- Docs: <https://browsa.io/docs>
- Support: <mailto:support@browsa.io>

## License

MIT.
