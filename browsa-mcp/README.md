<!-- mcp-name: io.browsa/browsa -->
<p align="center">
  <a href="https://browsa.io"><img src="https://browsa.io/browsa-logo-lockup.png" alt="Browsa" width="340"></a>
</p>

# @browsa/mcp

**Real cloud browsers for any MCP client.** Your model opens a Phantom browser (Browsa's own), reads the page as compact text, acts with real input, types saved secrets it never sees, hands over to a person when a check needs one, and replays what it did with no model calls.

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

### Any other MCP client

Command `npx -y @browsa/mcp`, environment `BROWSA_API_KEY`. Transport: stdio. Registry name: `io.browsa/browsa`.

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
- The server writes no files. Screenshots and page text come back inline; state (open browsers, a flow being recorded) is kept in memory.
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
| `captcha` | `solve_captcha_task` (Browsa's captcha API, for pages outside a Browsa browser; the answer says what the solve cost), `list_captcha_types` (every type with its parameters, price and measured pass rate), `report_captcha_result` (tell Browsa whether the site took a solution; reports are recorded and used to improve solving) |
| `admin` | `credits`, `list_browsers`, `list_identities`, `proxy_network`, `list_llm_keys`, `list_models` |
| `all` | every group |

```json
"env": { "BROWSA_API_KEY": "agt_live_...", "BROWSA_MCP_TOOLS": "tasks,robots" }
```

A tool name works too (`BROWSA_MCP_TOOLS=run_task,credits`). Calling a tool whose group is off answers with the setting that turns it on.

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
| `BROWSA_API_KEY` | yes | Your `agt_live_*` key from [app.browsa.io/dashboard/keys](https://app.browsa.io/dashboard/keys) |
| `BROWSA_MCP_TOOLS` | no | Optional groups to turn on, e.g. `tasks,robots`, or `all` |
| `BROWSA_COUNTRY` | no | Default exit country for `open` (needs a proxy) |
| `BROWSA_MCP_REDACT` | no | `off` shows URL tokens (debugging only) |
| `BROWSA_LLM`, `BROWSA_LLM_KEY_ID`, `BROWSA_LLM_API_KEY` | no | Model and key for the `tasks` and `schedules` groups. Unset: the workspace's saved key, or Browsa's hosted model |
| `BROWSA_CAPTCHA_URL` | no | Captcha API for `solve_captcha_task` (default `https://captcha.browsa.io`) |
| `BROWSA_BASE_URL` | no | Another Browsa API (staging) |

## Links

- Docs: <https://browsa.io/docs>
- MCP guide: <https://browsa.io/guides/mcp-server>
- Support: <mailto:support@browsa.io>

## License

MIT.
