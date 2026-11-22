# Changelog

Covers npm `browsa`, PyPI `browsa` and npm `@browsa/mcp`. The two `browsa` SDKs share a version number; `@browsa/mcp` has its own. A heading that names packages covers only those. The integrations keep their own changelogs: [langchain-browsa](integrations/langchain-browsa/CHANGELOG.md), [crewai-browsa](integrations/crewai-browsa/CHANGELOG.md), [n8n-nodes-browsa](integrations/n8n-nodes-browsa/CHANGELOG.md).

## 0.8.1 (`@browsa/mcp` only, 2026-11-21)

No breaking change: tool names, arguments and answers are the same.

### Added

- **Annotations on every tool** (MCP `annotations`): a `title`, `readOnlyHint` and `destructiveHint` on all 36 tools, `idempotentHint` on `close`, `stop_browser`, `cancel_job`, `delete_webhook` and `detect_captcha`, and `openWorldHint: false` on the two tools that run inside the server process (`detect_captcha`, `captcha_allowance`). A client can tell a read from an action before it asks. The tools that act on a page (`act`, `flow`, `run_task`, `run_robot`) are marked destructive, because the page decides what a click does. The README lists every tool's hints.
- **`--help` and `--version`** (`-h`, `-v`): print and exit, without starting the server and without a key.
- **Server `instructions`** at `initialize`: how the browser tools fit together, what spends credits, and how optional groups are turned on.
- `serverInfo.title` is `Browsa`.

### Changed

- One wording for the key: "Create a key at https://app.browsa.io/dashboard/keys" in the missing-key message, the startup notice and the refused-key hint (some said "mint").
- The tool list is larger by the annotations: the default nine tools are about 1,450 tokens of definitions (1,244 in 0.8.0), `captcha_page,-core` about 600 (513). The README table has every group.

## 0.7.1 (npm `browsa` and PyPI `browsa`, 2026-11-21)

No breaking change. `@browsa/mcp` is not part of this release.

### Added

- **Captcha callbacks** (the API has them on since 2026-11-21): `callback_url` / `callbackUrl` on `create_task` / `createTask` and on `solve`; `callback_secret()` / `callbackSecret()` for the hex secret deliveries are signed with, and `rotate_callback_secret()` / `rotateCallbackSecret()` to replace it. Also on `AsyncCaptchaClient`. What the receiving endpoint has to do, with code, is in both READMEs:
  - the one-time host check: the API POSTs `{"type": "callback.verify", "challenge": "..."}` and the endpoint echoes `{"challenge": "..."}`; until it has, `createTask` answers `ERROR_INVALID_CALLBACK_URL` (no task, no charge);
  - the signature on every delivery: `X-Browsa-Signature: t=<unix seconds>, v1=<hex>`, HMAC-SHA256 keyed with the secret's bytes over `"<t>.<raw body>"`, checked by the existing `webhooks.verify_signature` / `verifySignature` with the hex secret as it is;
  - de-duplication on the body's `taskId`. One host receives at most 60 requests a minute.
- **Builders for the task types that went live on 2026-11-21:** `text_question` / `textQuestion` (`TextCaptchaTask`: a question asked in words), `drag_drop` / `dragDrop` (`DragDropTask`: where each piece goes in a picture) and `bounding_box` / `boundingBox` (`BoundingBoxTask`: a box around what an instruction names), with solution types. `TextCaptchaTask`, `DragDropTask` and `BoundingBoxTask` are in Python's `TASK_TYPES`.
- **`Client()` with no argument** (Python `Client`, `AsyncClient`; TypeScript `new Client()`): the key is read from `BROWSA_API_KEY`. `BROWSA_BASE_URL` is read too, as the CLI and the MCP server already did. An argument still wins.
- **`browsa --version`** (also `-v`, `browsa version`) prints the version and needs no key.
- TypeScript exports the types `CaptchaCost`, `CaptchaReport`, `CaptchaTypeInfo`, `GeeTestSlideSolution`, `CloudflareSolution`, `TextQuestionSolution`, `DragDropSolution`, `BoundingBoxSolution`.
- [`examples/`](examples): ten runnable scripts, each with its credit cost at the top, run by CI against a local stand-in of the API.

### Changed

- **Reports:** an incorrect report refunds that solve once, within the workspace's report limits (refunds are on at the API since 2026-11-21). `refunded` in the answer says whether a refund was made; not every report is refunded. Docstrings, both READMEs and `examples/captcha/_run.py` say so. The calls and their answers are unchanged.
- **A missing key says what to do, the same way everywhere.** Python `Client()` without a key raised a bare `TypeError` (a missing argument); it now raises `ValueError("api_key is required: pass api_key or set BROWSA_API_KEY. Create a key at https://app.browsa.io/dashboard/keys")`. TypeScript, the CLI and both captcha clients use the same sentence, and "Create a key at" replaces "Mint one at" in every message.
- PyPI: the Changelog link points at this file; Python 3.13 and 3.14 are listed (CI runs the tests on 3.9 to 3.14).

### Repository

- CI on every push and pull request: the TypeScript SDK and the MCP server on Node 20, 22 and 24, the Python SDK on 3.9 to 3.14, the examples, and the release scripts. No job needs a key.
- The npm publish workflows stop within seconds, with the form values, when npm trusted publishing is not set up for the package, and a package tag now creates its GitHub Release from this file.
- `SECURITY.md`, `CONTRIBUTING.md`, a code of conduct, issue forms and a pull request template.

## 0.8.0 (`@browsa/mcp` only, 2026-11-21)

No breaking change: the default tool list is the same nine tools, and every existing tool keeps its name, arguments and answers. Everything new is off until its group or variable is set, except retries.

### Added

- **Captcha solving for a browser of your own: the `captcha_page` group** (`BROWSA_MCP_TOOLS=captcha_page`).
  - `detect_captcha`: the page's HTML in (with its address and, optionally, its frame and script URLs), the captchas found out: the catalogue's task type name, site key and parameters, `status` from the type catalogue, which tool takes it, and what is missing. Runs in the server process: no request, no key, free. It reports a captcha only when its provider is in the page; text that mentions captchas, class names and code samples give nothing.
  - `solve_captcha_on_page`: one token task through the captcha API with the held wait, answered with the solution, `cost`, and an `apply` block for the caller's browser: a JavaScript expression that sets the token where the widget keeps it and calls the page's callback, or, for a cookie answer, the cookies and user agent to set before re-requesting the URL. Picture puzzles, types that are off and types the catalogue does not list are refused before anything is sent.
  - `captcha_allowance`: what is left under the local limits.
- **Local limits for captcha solves**, off unless set: `BROWSA_CAPTCHA_MAX_CREDITS` (session spend), `BROWSA_CAPTCHA_RATE_PER_MINUTE`, `BROWSA_CAPTCHA_CONCURRENCY`. They cover `solve_captcha_on_page` and `solve_captcha_task`. A refused call names the limit and says when to retry (`code: LOCAL_LIMIT`, `limit`, `retry_after_seconds`).
- **`-name` in `BROWSA_MCP_TOOLS`** takes a group or a tool off; `-core` takes the nine browser tools off. `captcha_page,-core` lists three tools, about 510 tokens of definitions (the default nine are about 1,240; `npm run tokens` measures every group, as characters / 4).
- **Prompts** (`prompts/list`, `prompts/get`): `solve_captcha_on_my_page`, `what_captcha_is_this`, `pass_check_in_browsa_browser`, each listed only when its tools are on.
- **Retries:** a `429`, or the captcha key's per-minute limit, is retried with the server's `Retry-After` (up to 30 s) or exponential backoff with jitter; a gateway `5xx` or a dropped connection only for calls that change nothing. A call that may have been carried out is never sent twice. `BROWSA_MCP_RETRIES` (default 2, `0` for none). This applies to the server's own calls (core tools, robots, the captcha tools), not to the tools that go through the `browsa` SDK client.
- **Starts offline:** the captcha type list starts from a snapshot bundled with the package (`scripts/update-catalogue.mjs` refreshes it before a release) and is replaced by the live list when a fetch succeeds.
- `detect_captcha`, `captcha_allowance` and `list_captcha_types` answer without `BROWSA_API_KEY`.
- Packaging: `manifest.json` (MCP Bundle) with `npm run bundle`; `SECURITY.md` and a "What leaves your machine" section; install snippets for more clients; `server.json` lists the new variables.

### Changed

- Optional variables given as empty strings (as install forms pass them) are read as unset.
- `report_captcha_result`: the description and the README now say that an incorrect report refunds that solve once, within the workspace's report limits (refunds are on at the API since 2026-11-21). The tool and its answer are unchanged: `refunded` says whether a refund was made.
- The bundled captcha type list is the catalogue of 2026-11-21 (23 types, 18 live).
- A server with a `captcha_page` tool listed fetches the public type list once at startup (`GET /types`, no key, no parameters, not waited for). The default server makes no request at startup, as before.

## 0.7.0 (2026-11-21)

All three packages. 0.6.0 of npm `browsa` and PyPI `browsa` and 0.6.1 of `@browsa/mcp` were prepared on 2026-11-19 and never published; everything they had ships here. `@browsa/mcp` still depends on `browsa` ^0.3.1: it calls the API itself and reads the new job fields from the raw job.

### Added

- **Secrets** (Python `client.secrets`, also on `AsyncClient`; TypeScript `client.secrets`): `list`, `list_page` / `listPage` (with the workspace limit), `get` (by id or name), `create` (`login`, `totp` or `value`, with `origins`), `update`, `delete` (`force`; a secret in use raises `APIError` code `SECRET_IN_USE` with `used_by` in the error body), `import_env` / `importEnv` (.env text, `on_conflict`), `usage` (`limit`, `cursor`) and `keypair`. Values are sent plain over TLS; sealed fields (`sealed_value`, `sealed_password`, ... with `keypair_id`) pass through for callers who seal with their own HPKE library. No crypto dependency is added.
- **`secret_ids` / `secretIds`** on create and run task, sessions (first task and `send_message` / `sendMessage`), `auto`, schedules and `run_recipe` / `runRecipe`. The task text refers to attached secrets as `secrets.NAME`, `secrets.NAME.username`, `secrets.NAME.password` or `secrets.NAME.totp`; a reference to a secret that is not attached is `400 SECRET_NOT_ATTACHED`. `{{secret:NAME}}` and `%NAME%` still work.
- **`save_secrets` / `saveSecrets`** on the same task-starting calls (not recipe runs): when a run creates a login, the runner saves it as a workspace secret. On by default on the server; the SDKs send it only when you set it, `false` opts out.
- **Saved secrets on jobs:** `job.saved_secrets` / `job.savedSecrets` (`name`, `id`, `type`, `origins`, `username_masked` on logins, `existing`) and `job.secrets_not_saved` / `job.secretsNotSaved` (`code`, `message`), from the job's result. Also `job.secrets_used` / `job.secretsUsed`.
- TypeScript `act`: `secret` (a placeholder such as `"NAME:password"`) instead of `text` for `type`; `ActResult.status` includes `secret_origin`. Python `act` already passed `secret=` through; it is now documented.
- **Captcha client: no poll timer.** `solve` (Python `CaptchaClient` / `AsyncCaptchaClient`, TypeScript `CaptchaClient`) asks the API to hold each call until the task ends (`waitSeconds`, 20 s a call), so the answer arrives when it exists. `create_task` / `createTask` and `get_task_result` / `getTaskResult` take `wait_seconds` / `waitSeconds`. `wait_seconds=0` / `waitSeconds: 0` on the client polls as before, and a server that does not hold calls is polled every `poll_interval`.
- **Cost and time on a solution:** `sol.cost` (`charged`, `amount`, `unit`, `note`) and `sol.solve_seconds` / `sol.solveSeconds`. The solution object itself is unchanged.
- **Reports:** `report_correct`, `report_incorrect`, `report(task_id, correct)` / `reportCorrect`, `reportIncorrect`, `report`: tell the API whether the site took a solution. A task can be reported once, within 15 minutes of the solve. Reports are recorded and used to improve solving. The drop-in shims `TwoCaptcha` and `TwoCaptchaSolver` gain `report(id, correct)` (Python) and `goodReport` / `badReport` (TypeScript).
- **Type catalogue:** `list_types()` / `listTypes()`: every task type with its status, parameters, price and measured pass rate. No key is sent.
- `CaptchaError.fix` and `.charged`. Builders `geetest_slide_v3`, `geetest_slide_v4`, `cloudflare_challenge` / `geetestSlideV3`, `geetestSlideV4`, `cloudflareChallenge`; `GeeTestSlide` and `AntiCloudflareTask` are in the type lists.
- Python: `examples/captcha/`, one runnable file per task type (standard library only).
- **MCP:** `run_task` takes `secret_ids` and `save_secrets`; `run_task` and `get_job` answers list `saved_secrets` and `secrets_not_saved` when the job has them.
- **MCP:** `list_captcha_types` and `report_captcha_result` in the `captcha` group; `solve_captcha_task` waits on the API instead of a timer and returns `cost`.

### Fixed

- **Robots: updating settings no longer drops `settings.secrets`.** `PATCH /v1/robots/{id}` replaces the whole `settings` object. Python `robots.update(settings=...)` sent only the parts given, and TypeScript `robots.update({ settings })` rebuilt settings from `model`, `proxy` and `browser` alone, so a proxy-only update removed the robot's secrets (and, in TypeScript, reset its model and browser to Auto). Both SDKs now read the robot and send its current settings with the given parts over them, one key at a time (one extra GET). A part given as `None` / `null` goes back to Auto; `settings=None` / `null` still resets everything, without the read.
- `Robot.settings` keeps `secrets` (names or ids, `[]` when none); `settings_warnings` / `settingsWarnings` are parsed.

### Changed

- **Browser connections have their own host, `cdp.browsa.io`.** The API returns `cdp_http` / `cdp_url` on that host, and the SDKs use the addresses the API returns as they are, on whichever host they name. The fallback addresses `connect()` builds when an agent carries a profile id but no `cdp_http` / `cdp_url` (Python `Client.connect`, TypeScript `client.connect`) are now `https://cdp.browsa.io/api/v1/cdp/<profile>` and `wss://cdp.browsa.io/api/v1/cdp/<profile>/ws/page/...`. Addresses on `browsa.io/api/v1/cdp/...` keep working.
- TypeScript `connect()`: an empty `cdp_http` / `cdp_url` now falls back the same way a missing one does (Python already did).
- `@browsa/mcp` builds no CDP address itself; no change.

### Docs

- Python and TypeScript READMEs: a Secrets section; the robots table lists `settings.secrets`; the captcha section covers held waits, cost, reports and the type catalogue.

## 0.6.0 (`@browsa/mcp` only, published 2026-11-19)

### Changed

- **Nine core tools on by default** (about 1.2k tokens of schemas, was 25 tools): `open`, `observe`, `act`, `read`, `screenshot`, `secrets`, `handoff`, `flow`, `close`. `browser_id` is optional everywhere and defaults to the last browser used.
- **The other 0.5 tools are optional groups**, turned on with `BROWSA_MCP_TOOLS` or `--tools=`: `tasks`, `robots`, `schedules`, `webhooks`, `cdp` (`start_browser`, `stop_browser`), `captcha`, `admin`, or `all` for every 0.5 tool. Names, arguments and answers of those tools are unchanged. A call to a tool whose group is off says which setting turns it on.
- `observe` and `act` answer in plain text. The first line of `act` is the status (`ok`, `failed`, `blocked`, `challenge`, `stale`, `dialog`, `secret_origin`) with the next step when something stopped; errors end with a `next:` line. `observe`'s default budget is 1500 tokens (was 2000), at most 6000; an `act` diff over 400 tokens comes back as a fresh view instead.
- Tool texts and the README name no other product.

### Added

- `open` (browser, navigation and first view in one call), `observe find` (only the matching lines, with their container), `act solve_captcha` and `press_and_hold`, `act secret` (a saved secret typed by Browsa by reference: the value never reaches the MCP server or the model), `read` (a container as text, a table as TSV, or links, with no model), `screenshot` (JPEG), `secrets` (names, kinds, sites, one-time-code flag, never values), `handoff` (a single-use live link; the next `observe` or `act` says when the page moved on), `flow` (`start` records `act` and `read` steps, `save` stores a recipe with parameters and secret references, `run` replays it with no model calls and answers `site_changed` with the failing step, `list`).
- Tokens in URLs (`token`, `key`, `session`, `code`, `signature` and similar parameters) are masked in every answer (`BROWSA_MCP_REDACT=off` to debug). The server writes no files.
- README: install one-liners and links for Claude Code, Claude Desktop, Cursor, VS Code and Windsurf, and an upgrade section.

### Needs the agents service release of 2026-11-19

`act secret`, `screenshot`, the CSS locators a flow records (`act record`, `observe selector`) and `flow run version` use API fields added to the agents service in the same change. Until it is deployed, `screenshot` says the server cannot take screenshots yet, `act secret` answers `failed` (nothing typed), flows record role-and-name locators without `read` steps, and `flow run version` runs the current version with a note.

## 0.5.0 (2026-11-19)

All three packages. 0.4.0 was prepared on 2026-11-17 and never published; everything it had ships here.

### Added

- **Robots** (TypeScript `client.robots` and `client.robotRuns`, Python `client.robots` and `client.robot_runs`, and the same on `AsyncClient`): `create` (from a task run recorded with `recordRecipe` / `record_recipe`, or from a recipe), `list`, `get`, `update`, `delete`, `run` (on the saved rows, or on rows for this run only), `pause`, `resume`, `runs`, `alerts`, `markAlertsRead` / `mark_alerts_read`; `robotRuns.get` (a row per input with its output, typed error, credits and changed fields), `wait` (polls until `completed`, `partial` or `failed`) and `export` (CSV text or JSON). Types `Robot`, `RobotRun`, `RobotRunRow`, `RobotAlert`, `RobotHealth`, `RobotSettings`, `RobotSchedule`, `RobotMonitor`, `RobotDestination`.
- **Robot settings:** `settings.model` (a hosted tier, or a model of a saved key; it records the robot and repairs it), `settings.proxy` (Browsa's proxy network, datacenter or residential with an optional country, or a saved proxy) and `settings.browser` (`os`, `screen`). Each part is optional; unset is Auto. `update` with `settings: null` / `settings=None` goes back to Auto.
- **Robot price:** a row costs the recipe's `price_credits` (`robot.health.priceCredits` / `price_credits`), the same credits as the agent task. Failed rows are free. `RobotRun.credits` is what a run charged.
- **MCP:** `list_robots`, `run_robot` (optional `wait_seconds`, up to 300) and `get_robot_run`.
- **Recipes (replays that pass bot walls):** `createRecipe` / `create_recipe` (from a task run with `fromJobId` / `from_job_id`, or an uploaded recipe JSON), `listRecipes`, `getRecipe`, `updateRecipe`, `listRecipeVersions`, `promoteRecipeVersion`, `rollbackRecipe`, `deleteRecipe`, `runRecipe` / `run_recipe` (with `wait` up to 60 seconds, `webhookUrl`, `proxy`, `profileId`, `allowMutations`), `getRecipeRun` / `get_recipe_run` (with `wait`) and `cancelRecipeRun`. Types `Recipe`, `RecipeVersion`, `RecipeRun`.
- **Recipe price:** `Recipe.priceCredits` / `price_credits` is what one successful run costs, the same credits as the job run as an agent task (the recorded task's charge, or for an uploaded recipe the hosted `browsa` task price). `RecipeRun.priceCredits` and `credits` (the price when it succeeded, 0 when it failed or was cancelled).
- **Tasks:** `recordRecipe` / `record_recipe` records the run as a recipe draft; the finished job has `recipeDraftId` / `recipe_draft_id`.
- **Captcha solving client** (Python `browsa.captcha`, TypeScript `CaptchaClient`): `createTask`, `getTaskResult`, `getBalance` and `solve` (create and wait) for Browsa's captcha API at `https://captcha.browsa.io`, typed task builders (image text, reCAPTCHA v2 and v3, Turnstile, reCAPTCHA grid), and the task type names of CapSolver, Anti-Captcha, CapMonster and 2Captcha mapped to Browsa's. Same key and credits as the browser API; charged only when solved.
- **Shims for libraries that cannot change their server:** a 2Captcha-shaped `TwoCaptcha` (Python) / `TwoCaptchaSolver` (TypeScript), and `use_with_anticaptcha` / `useWithAntiCaptcha` for Anti-Captcha's official clients.
- **MCP:** `solve_captcha_task`.

### Changed

- The captcha clients and the MCP server default to `https://captcha.browsa.io`, where the captcha API is live (the unpublished 0.4.0 pointed at `browsa.io/captcha-api`, which does not serve it). `BROWSA_CAPTCHA_URL` still overrides it. With a Browsa key, `getBalance` / `get_balance` is in credits.
- TypeScript: the error classes live in `errors.ts`; imports from `browsa` are unchanged.
- MCP: `run_task`'s description no longer lists captcha types; it points to the measured list at browsa.io/captcha.
- Release workflows for npm `browsa` and `@browsa/mcp` in the public repo: GitHub Actions with npm trusted publishing and provenance, on tags `browsa-ts-v<version>` and `browsa-mcp-v<version>`.

### Docs

- READMEs: a Robots section with a real example, captcha sections no longer say "not live yet", MCP tool table lists the robot tools.

## 0.3.3 (`@browsa/mcp` only, 2026-11-17)

### Changed

- Tool descriptions and the README name the browser Phantom, Browsa's own browser.

## 0.3.2 (`@browsa/mcp` only)

### Fixed

- **MCP, no key set:** the server starts and lists its tools when `BROWSA_API_KEY` is missing, and each tool call answers that the key is not set. 0.3.1 exited at once, so MCP directories such as Glama could not read its tools. With a key, nothing changes.

## 0.3.1 (2026-11-16)

Found by installing the published 0.3.0 packages in clean containers and running them against production.

### Fixed

- **TypeScript, CommonJS projects:** types now resolve under `moduleResolution: node16` or `nodenext`. 0.3.0 pointed `require` at the ESM declaration file, and `tsc` refused the import (TS1479). `require("browsa")` itself always worked.
- **TypeScript, `browsa/webhooks`:** types now resolve under the classic `node10` resolution, and the declarations no longer need `@types/node` (`verifySignature` takes `Uint8Array | string`; a `Buffer` is a `Uint8Array`).
- **Python, timeouts:** a request that times out raises `browsa.TimeoutError`. 0.3.0 let the built-in `TimeoutError` (or `socket.timeout` on Python 3.9) through, so `except BrowsaError` missed it. A connection dropped mid-response now raises `BrowsaError` too.
- **Python, typing:** the package ships `py.typed`. 0.3.0 did not, and `mypy --strict` rejected `import browsa` as untyped.
- **MCP, job results:** `run_task` and `get_job` return `outcome`, `outcome_message` and `signals`. 0.3.0 returned only `status`, so a run that ended `completed` without doing the task looked like a success.
- **MCP, `run_task` description:** tells the model to read `outcome`; no longer promises a noVNC link.
- **CLI:** `browsa run` shows the live link while the task runs and no longer prints `live: undefined` at the end; it prints the outcome when it differs from the status, and labels a hosted tier as such.

### Added

- `listDownloads` / `downloadFile` (Python: `list_downloads` / `download_file`): the files a running browser downloaded.
- `createLiveLink` (Python: `create_live_link`): a Phantom Live link to watch or take over a running browser.

### Docs

- The first sample in each README runs on the hosted model, so it works with only a Browsa key, and reads `outcome`.
- READMEs say when `liveUrl` exists (while the task runs) and that a link opens once.
- MCP README lists the `proxy_network` tool and no longer says Browsa supplies no proxies.

## 0.3.0 (2026-11-16)

Hosted tiers and `reasoning`, the models listing, token usage and cost on jobs, the built-in proxy network, the `bot_check_passed` signal, `observe` and `act`.
