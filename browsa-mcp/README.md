<!-- mcp-name: io.browsa/browsa -->
<p align="center">
  <a href="https://browsa.io"><img src="https://browsa.io/browsa-logo-lockup.png" alt="Browsa" width="340"></a>
</p>

# @browsa/mcp

**Drive real browsers from Claude Desktop, Cursor, Cline, and any MCP-compatible client.**

MCP (Model Context Protocol) server for [Browsa](https://browsa.io): turn any LLM into a real-browser agent with one config line. The agent gets a fresh cloud Chromium on Browsa's own build, and a live view link so you can watch it work.

[![npm version](https://img.shields.io/npm/v/@browsa/mcp.svg)](https://www.npmjs.com/package/@browsa/mcp)

## What this is

Most "AI agent" setups stop at the LLM. We give the LLM a real browser. Through MCP, Claude can now:
- Navigate, fill forms, click, scroll, scrape
- Return results as structured JSON
- Use your own HTTP or SOCKS5 proxy per browser, or a tier of Browsa's built-in network where it is on (see `proxy_network`)
- Stay logged in across calls via persistent identities

No code from you: just configure Claude Desktop (or Cursor / Cline / Zed) once, and ask in natural language.

## Install

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "browsa": {
      "command": "npx",
      "args": ["-y", "@browsa/mcp"],
      "env": {
        "BROWSA_API_KEY": "agt_live_..."
      }
    }
  }
}
```

No LLM secret goes in the config: save your Anthropic, OpenAI or Google key once at [app.browsa.io/dashboard/llm-keys](https://app.browsa.io/dashboard/llm-keys) and tasks use the workspace's default saved key. (Prefer to keep it local? Add `"BROWSA_LLM_API_KEY": "sk-ant-..."` instead.)

Restart Claude Desktop. Ask: *"Go to news.ycombinator.com and tell me the top story title."*

### Cursor

`~/.cursor/mcp.json`:

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

### Cline / Continue / Zed

Any MCP-spec-compliant client. Point at `npx -y @browsa/mcp` and set `BROWSA_API_KEY`.

## Env

| Var | Required | What |
|---|---|---|
| `BROWSA_API_KEY` | yes | Your `agt_live_*` key from [browsa.io → Keys](https://app.browsa.io/dashboard/keys) |
| `BROWSA_LLM_KEY_ID` | no | Id of a saved LLM key to use by default (see `list_llm_keys`). Without it, the workspace's default saved key for the model's provider is used |
| `BROWSA_LLM_API_KEY` | no | A per-task LLM provider key sent with every task. Not needed once a key is saved at [dashboard/llm-keys](https://app.browsa.io/dashboard/llm-keys). Wins over `BROWSA_LLM_KEY_ID` |
| `BROWSA_LLM` | no | Default LLM, e.g. `anthropic:claude-sonnet-5-5`, or a hosted tier such as `browsa-fast`. Unset: the saved key's provider default model (`claude-opus-5-5` with `BROWSA_LLM_API_KEY`) |
| `BROWSA_COUNTRY` | no | Default egress country (e.g. `US`) |
| `BROWSA_BASE_URL` | no | Override prod URL (staging / self-hosted) |

### Which LLM key a task uses

Per call, first match wins: a hosted tier (`llm: "browsa"`, `"browsa-fast"` or `"browsa-smart"`: no key, see [Models](#models)), then `llm_api_key`, then `llm_key_id`, then `BROWSA_LLM_API_KEY`, then `BROWSA_LLM_KEY_ID`. With none of these, no key is sent and the server uses the workspace's default saved key for the provider of `llm` (with `llm` unset: the first default in the order anthropic, openai, google).

If no key is saved at all:

- **No model named** (no `llm` argument, no `BROWSA_LLM`): `run_task` and `create_schedule` still work with zero config. They retry once on Browsa's hosted model (which adds credits per task) and the result has a `note` saying so: *"No saved LLM key found, so this ran on Browsa's hosted model (adds credits per task; see list_models). Save a key at https://app.browsa.io/dashboard/llm-keys to use your own."* The same happens if the server has saved keys turned off (`LLM_KEYS_UNAVAILABLE`). A schedule created this way stays on the hosted model; create it again after saving a key.
- **A model named**: there is no fallback. The tool returns an error (code `LLM_KEY_REQUIRED`) that says to save a key at [app.browsa.io/dashboard/llm-keys](https://app.browsa.io/dashboard/llm-keys), set `BROWSA_LLM_API_KEY`, or pass `llm: "browsa"`.

## Models

`run_task` and `create_schedule` take `llm` and `reasoning`:

| `llm` | What it is |
|---|---|
| `"browsa"` | The default hosted model |
| `"browsa-fast"` | Fastest and lightest |
| `"browsa-smart"` | For harder tasks |
| anything else, e.g. `"anthropic:claude-sonnet-5-5"` | A provider model, run with your own key (saved, or `llm_api_key`) |

Hosted tiers need no LLM key and add a flat number of credits per task. Which model each tier runs on, and what it costs, are server settings that can change: the `list_models` tool returns them (free, read-only), along with the providers you can bring a key for.

`reasoning` is `"low"`, `"medium"` or `"high"`; leave it out for the tier's or the provider's default. Ask in plain language, for example: *"Use browsa-smart with high reasoning to compare the pricing pages of these three sites."*

`run_task` and `get_job` results carry `status` and `outcome`. `status: completed` only means the run ended; `outcome: failed` with it means the agent finished but could not do the task, and `outcome_message` and `final_result` say why. `signals` lists what was seen on the way (a bot check, a proxy failure) when there is any.

When the job has them, `run_task` and `get_job` results include `usage` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `requests`), `llm_tier`, `reasoning` (the level that was applied) and `llm_cost_usd`. `llm_cost_usd` is an estimate from public list prices for runs with your own key; it is `null` when unknown and always `null` for hosted runs, which are paid in credits.

## Tools exposed

| Tool | What |
|---|---|
| `run_task` | Run a browser-driven task. Returns the final result, `outcome` and steps. Optional `llm`, `reasoning`, `llm_key_id`. |
| `get_job` | Poll a long-running task. Optional server-side `wait_seconds`. |
| `cancel_job` | Cancel a running task. |
| `respond_to_job` | Answer an `input_required` prompt (a decision, or a CAPTCHA the task could not solve itself: see https://browsa.io/captcha). |
| `start_browser` | Start a real cloud browser and get its CDP URL, to drive yourself with Playwright or Puppeteer. |
| `stop_browser` | Stop a browser from `start_browser` and release it. |
| `proxy_network` | Whether Browsa's built-in proxy network is on, its tiers, countries and price. Read-only and free. |
| `observe` | Read the page of a browser from `start_browser` as compact text with element ids. No Playwright needed. |
| `act` | One action in that browser (click, type, press, select, scroll, navigate, wait and more); returns what changed. |
| `list_browsers` | List this workspace's browsers and their status. |
| `credits` | Show credit balance + top-up packs. |
| `list_webhooks` / `create_webhook` / `delete_webhook` | Webhook CRUD. |
| `list_identities` | List persistent browser identities (use one via `profile_id` to reuse warmed cookies). |
| `create_schedule` / `list_schedules` | Recurring tasks. `create_schedule` takes `llm`, `reasoning` and `llm_key_id`; the schedule stores only the key's id. |
| `list_job_files` | Output files a task wrote. |
| `list_llm_keys` | Saved LLM keys: id, provider, masked key, default flag, status. Read-only; never returns a secret. |
| `list_models` | Hosted tiers (model, default reasoning, credits per task) and own-key providers. Read-only and free. |

## Why MCP-first matters

Most agent platforms gate distribution behind "write code → deploy → call our API." We gate it behind "paste config → ask Claude." For an AI agent platform, **the prospect's first 30 seconds is the make-or-break moment.** With this MCP server, the first 30 seconds is a working browser doing what they asked.

## Source + Issues

- Docs: <https://browsa.io/docs>
- Support: <mailto:support@browsa.io>
- API reference: <https://browsa.io/docs>

## License

MIT.
