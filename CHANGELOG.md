# Changelog

Covers the three packages: npm `browsa`, npm `@browsa/mcp` and PyPI `browsa`. They share a version number.

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
