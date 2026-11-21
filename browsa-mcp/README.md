<!-- mcp-name: io.browsa/browsa -->
<p align="center">
  <a href="https://browsa.io"><img src="https://browsa.io/browsa-logo-lockup.png" alt="Browsa" width="340"></a>
</p>

# @browsa/mcp

**Real cloud browsers for any MCP client.** Your model opens a Phantom browser (Browsa's own), reads the page as compact text, acts with real input, types saved secrets it never sees, hands over to a person when a check needs one, and replays what it did with no model calls.

**Captcha solving for a browser of your own.** An agent that already drives its own browser keeps it: `detect_captcha` finds the captcha in the page's HTML on your machine, `solve_captcha_on_page` returns the solution with the step to apply it in that browser. See [Captchas in your own browser](#captchas-in-your-own-browser).

[![npm version](https://img.shields.io/npm/v/@browsa/mcp.svg)](https://www.npmjs.com/package/@browsa/mcp)

You need a Browsa API key: [app.browsa.io/dashboard/keys](https://app.browsa.io/dashboard/keys). Replace `agt_live_...` below with it.

## Install

[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_Browsa-111111?style=for-the-badge)](https://cursor.com/en/install-mcp?name=browsa&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBicm93c2EvbWNwIl0sImVudiI6eyJCUk9XU0FfQVBJX0tFWSI6ImFndF9saXZlXy4uLiJ9fQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Browsa-0098FF?style=for-the-badge)](https://insiders.vscode.dev/redirect/mcp/install?name=browsa&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40browsa%2Fmcp%22%5D%2C%22env%22%3A%7B%22BROWSA_API_KEY%22%3A%22agt_live_...%22%7D%7D)

After a one-click install, put your key in place of `agt_live_...` in the client's MCP settings.

### Claude Code

```bash
claude mcp add browsa -e BROWSA_API_KEY=agt_live_... -- npx -y @browsa/mcp
```

### Claude Desktop

Settings, Developer, Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "browsa": {
      "command": "npx",
      "args": ["-y", "@browsa/mcp"],
      "env": { "BROWSA_API_KEY": "agt_live_..." }
    }
  }
}
```

Restart Claude Desktop.

### Cursor

The button above, the link `cursor://anysphere.cursor-deeplink/mcp/install?name=browsa&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBicm93c2EvbWNwIl0sImVudiI6eyJCUk9XU0FfQVBJX0tFWSI6ImFndF9saXZlXy4uLiJ9fQ==`, or the same `mcpServers` block as Claude Desktop in `~/.cursor/mcp.json`.

### VS Code

The button above, or:

```bash
code --add-mcp '{"name":"browsa","command":"npx","args":["-y","@browsa/mcp"],"env":{"BROWSA_API_KEY":"agt_live_..."}}'
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, the same `mcpServers` block as Claude Desktop.

### Cline, JetBrains AI Assistant, LM Studio, Gemini CLI

Each takes the same `mcpServers` block as Claude Desktop: Cline in `cline_mcp_settings.json` (MCP Servers, Configure), JetBrains under Settings, Tools, AI Assistant, Model Context Protocol, LM Studio in `mcp.json` (Program, Install, Edit mcp.json), Gemini CLI in `~/.gemini/settings.json`.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.browsa]
command = "npx"
args = ["-y", "@browsa/mcp"]
env = { BROWSA_API_KEY = "agt_live_..." }
```

### Zed

`settings.json`:

```json
{
  "context_servers": {
    "browsa": { "command": "npx", "args": ["-y", "@browsa/mcp"], "env": { "BROWSA_API_KEY": "agt_live_..." } }
  }
}
```

### Any other MCP client

Command `npx -y @browsa/mcp`, environment `BROWSA_API_KEY`. Transport: stdio. Registry name: `io.browsa/browsa`. The generic form most clients read:

```json
{
  "mcpServers": {
    "browsa": {
      "command": "npx",
      "args": ["-y", "@browsa/mcp"],
      "env": { "BROWSA_API_KEY": "agt_live_..." }
    }
  }
}
```

### Only the captcha tools, next to a browser of your own

Three tools instead of nine, about 510 tokens of tool definitions, and a spend cap for the session:

```json
{
  "mcpServers": {
    "browsa-captcha": {
      "command": "npx",
      "args": ["-y", "@browsa/mcp", "--tools=captcha_page,-core"],
      "env": { "BROWSA_API_KEY": "agt_live_...", "BROWSA_CAPTCHA_MAX_CREDITS": "5" }
    }
  }
}
```

```bash
claude mcp add browsa-captcha -e BROWSA_API_KEY=agt_live_... -e BROWSA_MCP_TOOLS=captcha_page,-core -e BROWSA_CAPTCHA_MAX_CREDITS=5 -- npx -y @browsa/mcp
```

### One-file bundle (MCPB)

`manifest.json` in this package is an [MCP Bundle](https://github.com/modelcontextprotocol/mcpb) manifest. `npm run bundle` stages a self-contained copy in `build/mcpb`, and `npx @anthropic-ai/mcpb pack build/mcpb build/browsa.mcpb` makes the file a desktop client installs with a double click; the key and the tool groups are asked for in its install form.

Then ask: *"Open books.toscrape.com and list the first five titles with their prices."*

## Tools

Nine tools are on by default. Their schemas are about 1.2k tokens in total.

| Tool | What it does |
|---|---|
| `open` | Opens a cloud browser and goes to `url`. Returns the browser id, a live view link and the first view. Options: `country`, `profile` (a saved identity), `proxy`, `ttl` (default 10m). |
| `observe` | The page as text, one line per element: `[id] role "name" state`. Default budget 1500 tokens, up to 6000. `scope: page` for the whole page, `expand` for one container in full, `find` (text or `/regex/`) for only the matching lines. |
| `act` | One action with real input: click, type, press, select, check, uncheck, hover, scroll, navigate, back, forward, reload, wait, upload, dialog, press_and_hold, solve_captcha. Answers with what changed (at most 400 tokens) or a fresh view. |
| `read` | The full content of one container, with no model: `as: text`, `table` (TSV) or `links`. |
| `screenshot` | A JPEG of the viewport, the full page (`full`) or one element (`id`). |
| `secrets` | Your saved secrets: names, kinds, the sites each may be typed on, and whether it has a one-time code. Never values. |
| `handoff` | A single-use live link for a person to take over: a captcha the solver gave up on, a login, a decision. The next `observe` or `act` says when the page moved on. |
| `flow` | `start` records your `act` and `read` steps, `save` stores them as a Browsa recipe, `run` replays it with no model calls, `list` shows them. |
| `close` | Closes the browser. |

`browser_id` is optional everywhere: it defaults to the last browser used.

### What an answer looks like

The first line of every `act` answer is one of `ok`, `failed`, `blocked`, `challenge`, `stale`, `dialog` or `secret_origin`, and when something stopped it says what to do next:

```
ok
after: type [3] "poetry", then Enter
~ [3] searchbox "Search"  value "poetry"
settled after 180 ms, 1 request (GET /search → 200)
```

```
stale: the page changed and those ids are gone; nothing was done. Fresh view:
page "Results" https://books.toscrape.com/...
```

```
challenge: turnstile check appeared; next: act solve_captcha, and if it stays, handoff
```

Errors work the same way: `error: AGENT_NOT_RUNNING: agent is destroyed` is followed by `next: this browser is gone (it expired or was closed); call open for a new one`.

### Secrets by reference

Save logins, one-time-code seeds and keys once in the dashboard (Secrets). The model sees only names:

```
secrets: 1 (values are never shown; type one with act {action: "type", id, secret: REF})
GITHUB  login  on github.com and subdomains  refs GITHUB:username, GITHUB:password, TOTP:GITHUB  one-time code
```

`act {"action": "type", "id": 14, "secret": "GITHUB:password"}` sends only the reference. Browsa types the value inside the browser, only when the page and the field are on the secret's sites (otherwise the answer is `secret_origin` and nothing is typed), writes an audit row, and shows `<secret>GITHUB:password</secret>` wherever the value would appear. The value never passes through this MCP server or the model.

### Flows: record once, replay with no model

```
flow {op: "start"}
act ... / read ...                                   (do the task once)
flow {op: "save", name: "book-search", params: {query: "poetry"}}
flow {op: "run", name: "book-search", params: {query: "travel"}}
```

`params` on save names the values you typed that should change between runs: each example value becomes `{{query}}`. Secrets you typed are saved as references. A run costs the flow's `price_credits` when it succeeds; failed runs are free. When the site changed, `run` answers `site_changed` with the step that broke: redo it with `act` and save the flow again.

### Privacy

- Tokens in URLs (query and fragment parameters such as `token`, `key`, `session`, `code`, `signature`) are shown as `***` in every answer. `BROWSA_MCP_REDACT=off` turns this off for debugging.
- The server writes no files. Screenshots and page text come back inline; state (open browsers, a flow being recorded, captcha spend) is kept in memory.
- Live links are single use and expire.

## More tools (optional groups)

Everything else from 0.5 is in groups you turn on with `BROWSA_MCP_TOOLS` (comma separated) or the argument `--tools=...`:

| Group | Tools |
|---|---|
| `tasks` | `run_task`, `get_job`, `cancel_job`, `respond_to_job`, `list_job_files` |
| `robots` | `list_robots`, `run_robot`, `get_robot_run` |
| `schedules` | `create_schedule`, `list_schedules` |
| `webhooks` | `list_webhooks`, `create_webhook`, `delete_webhook` |
| `cdp` | `start_browser`, `stop_browser` (a CDP address, to drive the browser from your own code) |
| `captcha_page` | `detect_captcha`, `solve_captcha_on_page`, `captcha_allowance`: captcha solving for a browser of your own, [below](#captchas-in-your-own-browser) |
| `captcha` | `solve_captcha_task` (Browsa's captcha API, for pages outside a Browsa browser; the answer says what the solve cost), `list_captcha_types` (every type with its parameters, price and measured pass rate), `report_captcha_result` (tell Browsa whether the site took a solution; an incorrect report refunds that solve once, within limits: within 15 minutes of the solve, and a capped share of the workspace's solves of the last 24 hours. The answer's `refunded` says whether it did) |
| `admin` | `credits`, `list_browsers`, `list_identities`, `proxy_network`, `list_llm_keys`, `list_models` |
| `all` | every group |

```json
"env": { "BROWSA_API_KEY": "agt_live_...", "BROWSA_MCP_TOOLS": "tasks,robots" }
```

A tool name works too (`BROWSA_MCP_TOOLS=run_task,credits`). A leading `-` takes a group or a tool off again, and `-core` takes the nine browser tools off: `captcha_page,-core` lists three tools, `captcha,captcha_page,-core,-report_captcha_result` five. Calling a tool whose group is off answers with the setting that turns it on.

### What the tool list costs

The tool definitions a client loads before the first message, per setting. Tokens are an estimate, characters of the JSON definitions divided by 4 (no tokenizer; real counts differ by model). `npm run tokens` prints this table from the built server.

| Tools listed | `BROWSA_MCP_TOOLS` | Tools | Tokens (chars / 4) |
|---|---|---|---|
| default | (unset) | 9 | 1,244 |
| the captcha tools for your own browser | `captcha_page,-core` | 3 | 513 |
| the captcha API tools | `captcha,-core` | 3 | 696 |
| `tasks` | `tasks,-core` | 5 | 1,296 |
| `robots` | `robots,-core` | 3 | 433 |
| `schedules` | `schedules,-core` | 2 | 461 |
| `webhooks` | `webhooks,-core` | 3 | 210 |
| `cdp` | `cdp,-core` | 2 | 640 |
| `admin` | `admin,-core` | 6 | 447 |
| everything | `all` | 36 | 5,936 |

A group adds its row to the default's 1,244. Prompts are fetched only when picked and add nothing.

## Captchas in your own browser

For an agent that drives a browser Browsa does not host. Turn the group on with `BROWSA_MCP_TOOLS=captcha_page` (add `,-core` to list nothing else). The server never touches your browser: it reads HTML you paste and returns what to run.

```
detect_captcha {html, url, resources}        local, free, no key, nothing sent
  -> {found: 1, captchas: [{kind: "turnstile", type: "AntiTurnstileTaskProxyLess", status: "live",
      solve_with: "solve_captcha_on_page", ready: true,
      params: {websiteURL, websiteKey}, missing: [], credits_per_solve: 0.008, confidence: "high", evidence: [...]}]}

solve_captcha_on_page {captcha: <that entry>}
  -> {task_id, type, solution: {token}, seconds: 6.5,
      cost: {charged: true, amount: 0.008, unit: "credits"},
      apply: {how: "evaluate", expression: "(() => { ... })()", steps: [...], valid_seconds: 300},
      allowance: {spent_credits, ...}}

(your browser) evaluate apply.expression in the page, submit, read the page's answer
```

**`detect_captcha`** takes the page's HTML (`document.documentElement.outerHTML`), its address, and optionally the URLs of its frames and scripts (`resources`): a rendered widget often keeps its site key only in its frame's address. For each captcha it gives the catalogue's task type name, the parameters found (site key, action, cdata, invisible, the page's callback), `status` from the type catalogue (`live`, `off`, or `not_in_catalogue`), `solve_with` (which tool takes it), `ready`, and `missing`: what could not be read from the HTML and where to find it. It reports a captcha only when its provider is really in the page (a widget with a site key, the provider's frame or script, or its start call); the word "captcha" in text, class names and code samples give nothing.

**`solve_captcha_on_page`** takes one entry from `detect_captcha` (or `{type, params}` you wrote, or `html` + `url` to detect first), runs the task through Browsa's captcha API and waits for it. What it can do:

- **Token types** (`kind: token` in the catalogue): the answer is a token, and `apply.expression` is JavaScript for the page's main frame that puts it in the field the widget keeps, calls the page's callback when the widget names one, and returns `{applied, fields, callback}`. For a v3 token there is no field: the expression makes the page's next `grecaptcha.execute()` answer it, then you do the page's own action.
- **Cookie types**: `apply.cookies` and `apply.user_agent`, with the instruction to set them and re-request the URL through the same proxy, and not to reload the challenge page. These need `proxy`.

What it cannot do: click, drag or type in your browser; solve picture puzzles (send the image to `solve_captcha_task` in the `captcha` group: the answer is text, tiles or a distance, and the input is yours to make); solve a type the catalogue lists as `off` or does not list. Each of these is refused before anything is sent, with `charged: false`. A solve is charged only when it succeeds; `cost` is in every answer. How often each type passes is measured and published per type: see the `measured` fields of `list_captcha_types` or <https://browsa.io/captcha>.

### Limits you set

Off unless set. They are checked in this process before a request is made, and cover `solve_captcha_on_page` and `solve_captcha_task`.

| Var | Limit |
|---|---|
| `BROWSA_CAPTCHA_MAX_CREDITS` | Credits one session (one run of this server) may spend on solves. Running solves hold their price until they end. |
| `BROWSA_CAPTCHA_RATE_PER_MINUTE` | Solves started in any 60 seconds. |
| `BROWSA_CAPTCHA_CONCURRENCY` | Solves running at once. |

A refused call names the limit and says when to retry:

```json
{"error": "refused by this server's local limit (rate): 2 solves started in the last minute and BROWSA_CAPTCHA_RATE_PER_MINUTE is 2",
 "code": "LOCAL_LIMIT", "limit": "rate", "retry_after_seconds": 45, "retry": "in 45 s", "charged": false, "allowance": {...}}
```

`retry_after_seconds` is `null` for a spent cap: waiting does not help. `captcha_allowance` reports what is left at any time, and every solve answer carries the same `allowance` block. The workspace's own limits still apply on Browsa's side.

### Prompts

Built-in prompts, listed only when their tools are on: **solve_captcha_on_my_page** (detect, solve, apply, verify, in your own browser), **what_captcha_is_this** (detect only, free) and **pass_check_in_browsa_browser** (open, `act solve_captcha`, hand off if it stays).

## Retries and starting offline

- A call answered `429`, or refused by the key's per-minute limit, is sent again after a wait: the server's `Retry-After` when it gives one (up to 30 s), otherwise exponential backoff with jitter. A gateway `5xx` or a dropped connection is retried only for calls that change nothing (reads, deletes, a result poll). A call that may have been carried out (create a browser, start a task, create a captcha task) is never sent twice. `BROWSA_MCP_RETRIES` sets the number of retries (default 2, `0` for none).
- Starting waits on no request. The tool list is built in, and the captcha type list starts from a copy bundled with the package, so a client lists the tools and `detect_captcha` works with the network down. `detect_captcha` says which list it used (`catalogue.source`: `live` or `bundled`, with its date).

## What leaves your machine

- `detect_captcha` and `captcha_allowance`: nothing. No request is made.
- `solve_captcha_on_page`: your key and the task's parameters (type, page address, site key, the optional fields) go to `captcha.browsa.io`. The page's HTML is never sent.
- The browser tools: your key and each call's arguments go to `browsa.io`.
- No telemetry: no analytics, usage pings or update checks. The one request no tool asked for is a `GET` of the public captcha type list at startup, with no key and no parameters, and only when a `captcha_page` tool is listed (`BROWSA_CAPTCHA_CATALOGUE=bundled` stops it).

The full table is in [SECURITY.md](./SECURITY.md).

## Upgrading from 0.7

Nothing to change. The default tool list is the same nine tools, and every existing tool keeps its name, arguments and answers. New in 0.8: the `captcha_page` group, the three captcha limits, `-name` in `BROWSA_MCP_TOOLS`, prompts, retries on `429` and gateway errors, and `list_captcha_types` and `detect_captcha` working without a key.

## Upgrading from 0.5

0.6 lists nine tools instead of 25, so a model spends far fewer tokens on tool definitions before it starts.

- **To keep every 0.5 tool**, set `BROWSA_MCP_TOOLS=all`. Nothing else changes for them: same names, same arguments, same JSON answers.
- `start_browser` and `stop_browser` move to the `cdp` group. Use `open` and `close` instead: `open` also navigates and returns the first view.
- `observe` and `act` keep their names and arguments; `browser_id` is now optional. Their answers are plain text and the first line of `act` is the status, as above. `observe`'s default budget is 1500 tokens (it was 2000); pass `budget` for more.
- `run_task` and the other task tools are in the `tasks` group; robots in `robots`; credits, models, keys and identities in `admin`.
- The task tools still read `BROWSA_LLM`, `BROWSA_LLM_KEY_ID` and `BROWSA_LLM_API_KEY`.

## Env

| Var | Required | What |
|---|---|---|
| `BROWSA_API_KEY` | yes | Your `agt_live_*` key from [app.browsa.io/dashboard/keys](https://app.browsa.io/dashboard/keys). `detect_captcha` and `list_captcha_types` run without it |
| `BROWSA_MCP_TOOLS` | no | Optional groups to turn on, e.g. `tasks,robots`, or `all`; `-name` turns one off, `-core` the nine browser tools |
| `BROWSA_COUNTRY` | no | Default exit country for `open` (needs a proxy) |
| `BROWSA_MCP_REDACT` | no | `off` shows URL tokens (debugging only) |
| `BROWSA_LLM`, `BROWSA_LLM_KEY_ID`, `BROWSA_LLM_API_KEY` | no | Model and key for the `tasks` and `schedules` groups. Unset: the workspace's saved key, or Browsa's hosted model |
| `BROWSA_CAPTCHA_MAX_CREDITS`, `BROWSA_CAPTCHA_RATE_PER_MINUTE`, `BROWSA_CAPTCHA_CONCURRENCY` | no | Local limits for captcha solves: session spend, starts per minute, running at once. Unset: no local limit |
| `BROWSA_CAPTCHA_CATALOGUE` | no | `bundled` uses the captcha type list shipped with the package and never fetches it |
| `BROWSA_MCP_RETRIES` | no | Retries on `429` and gateway errors (default 2, `0` for none) |
| `BROWSA_CAPTCHA_URL` | no | Captcha API for the captcha tools (default `https://captcha.browsa.io`) |
| `BROWSA_BASE_URL` | no | Another Browsa API (staging) |

## Links

- Docs: <https://browsa.io/docs>
- MCP guide: <https://browsa.io/guides/mcp-server>
- Support: <mailto:support@browsa.io>

## License

MIT.
