# n8n-nodes-browsa

An [n8n](https://n8n.io/) community node for [Browsa](https://browsa.io), the cloud browser API for AI agents. Describe a task in plain language and an agent runs it in a Phantom cloud browser, or scrape, extract, screenshot and crawl pages in one call. Phantom is Browsa's own browser.

- [Install](#install)
- [Credentials](#credentials)
- [Operations](#operations)
- [Costs](#costs)
- [Use it as an AI Agent tool](#use-it-as-an-ai-agent-tool)
- [Example workflows](#example-workflows)
- [Compatibility](#compatibility)
- [Development](#development)
- [Resources](#resources)

## Install

### Self-hosted n8n, from the n8n editor

You need the Owner or Admin role.

1. Go to **Settings** > **Community Nodes**.
2. Select **Install**.
3. In **Enter npm package name**, enter `n8n-nodes-browsa`.
4. Check "I understand the risks of installing unverified code from a public source."
5. Select **Install**.

Source: [n8n docs, GUI installation](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation/).

### Self-hosted n8n, from the command line

Use this for queue mode, or when the editor install is not available. For n8n in Docker:

```sh
docker exec -it n8n sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm i n8n-nodes-browsa
```

Then restart n8n. Source: [n8n docs, manual installation](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation/).

### n8n Cloud

n8n Cloud only offers community nodes that n8n has verified. Once this node is verified, an instance owner or admin can install it from the canvas:

1. Open the nodes panel (**+** or the **N** key).
2. Search for **Browsa**. It shows under **More from the community**.
3. Select it, then **Install**.

Source: [n8n docs, install verified community nodes](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes/). Until then, use a self-hosted n8n.

## Credentials

The node uses one credential, **Browsa API**:

1. Sign up at [app.browsa.io](https://app.browsa.io). New accounts get 100 free credits after email verification, with no card.
2. Create an API key on [API keys](https://app.browsa.io/dashboard/keys). It starts with `agt_live_`. The secret is shown once.
3. In n8n, create a **Browsa API** credential and paste the key.

n8n sends the key in the `X-API-Key` header. Saving the credential tests it with `GET https://browsa.io/v1/credits`, which is free.

## Operations

| Resource | Operation | Browsa endpoint |
|---|---|---|
| Task | Run | `POST /v1/tasks`, then `GET /v1/jobs/{id}` until it ends |
| Job | Get | `GET /v1/jobs/{id}` |
| Page | Scrape | `POST /v1/quick/scrape` |
| Page | Extract Data | `POST /v1/quick/extract` |
| Page | Take Screenshot | `POST /v1/quick/screenshot` |
| Page | Crawl | `POST /v1/quick/crawl`, then `GET /v1/jobs/{id}` until it ends |

### Task > Run

Runs a plain-language task in a Phantom browser and returns the result.

- **Task**: what the agent should do, at most 20,000 characters.
- **Model**:
  - **Browsa**, **Browsa Fast**, **Browsa Smart**: hosted tiers. No model key needed; each adds the hosted credits per task (see [Costs](#costs)).
  - **My Saved Model Key**: an Anthropic, OpenAI or Google key saved on [LLM keys](https://app.browsa.io/dashboard/llm-keys) in the Browsa dashboard. Give its ID, or leave the ID empty to use the workspace's default saved key.
  - **My Model API Key**: a key typed into the node, with an optional model name and base URL (for an Anthropic- or OpenAI-compatible server). The key is stored in the workflow, so a saved key is the safer choice.
- **Wait for Result** (on by default): the node waits until the job ends, polling with the API's long poll (up to 30 seconds a call). Polling is free. Off: the node returns at once with the job ID; read it later with **Job > Get**.
- **Timeout (Seconds)** (default 600) and, under Options, **On Timeout**: stop the workflow with a message that names the job ID (default), or return the job with `"wait_timed_out": true`. The job keeps running on Browsa either way.
- **Simplify** (on by default): returns `id`, `kind`, `status`, `outcome`, `outcome_message`, `result`, `error_code`, `error_message`, `credits_charged`, `duration_ms`. `result` is the JSON that matches your output schema when you gave one, else the agent's final answer. Off: the full job.
- **Options**: Output Schema (JSON Schema, object at the top level; the answer then comes back as matching JSON), Start URL, Max Steps (default 20, at most 100), Max Credits, Allowed Domains, Reasoning (low, medium, high), Operating System, Saved Proxy ID, Allow Purchases (off by default: the agent stops at order and payment buttons), Stop on Unsuccessful Outcome.

**Outcome.** A job can have `status: completed` and still not have done the task: `outcome` says how it ended (`completed`, `failed`, `step_limit_reached`, `budget_reached`, `timed_out`, `blocked_by_bot_check`, `never_started`, `stalled`, `cancelled_by_user`) and `outcome_message` says what to try next. The node always returns both. Turn on **Stop on Unsuccessful Outcome** to stop the workflow when `outcome` is not `completed`.

A task that asks a question (`status: input_required`) also ends the wait; the job has `input_question`. Answer it with `POST /v1/jobs/{id}/respond` (for example with an HTTP Request node).

### Job > Get

Reads a task or crawl job by ID: status, outcome, result and cost. Turn on **Wait for Completion** to wait until it ends, with the same timeout and Simplify options as Task > Run.

### Page > Scrape

Opens a URL in a Phantom browser and returns it in the chosen **Formats**: Markdown (default), HTML, text, links and screenshot. A screenshot (the visible part of the page, PNG) goes to a binary field (`data` by default). Options: Wait After Load, Max Characters, Block Resources (images, fonts, media).

### Page > Extract Data

Returns the fields you describe from a page, as **Instructions** in plain language or as a **JSON Schema**. Who turns the page into data:

- **None (Return Page Text)** (default): Browsa returns the page's clean text and the schema, ready for your own model, for example an AI node after this one.
- **My Saved Anthropic Key** or **My Anthropic API Key**: Browsa runs the extraction and returns the result in `data`. The key is used for this call only. Your provider bills the tokens.

### Page > Take Screenshot

Returns a PNG of the page as binary data (field `data` by default). **Full Page** (on by default) captures the full scrollable height, up to 16,000 px.

### Page > Crawl

Follows links breadth first from a **Start URL** and scrapes each page. **Max Pages** (default 25, at most 200), **Crawl Formats**, and Options: Max Depth (default 2, at most 5), Same Domain Only (on by default), Include Only URLs Matching and Exclude URLs Matching (regular expressions), Wait After Load, Max Characters. With **Wait for Result** on, **Output** gives one item per page (default) or one item with the whole job.

### Errors

When Browsa answers with an error, the node shows its code (for example `INSUFFICIENT_CREDIT`, `TOO_MANY_REQUESTS`, `LLM_KEY_REQUIRED`), what to do, and the request ID to quote to support@browsa.io. With **Continue On Fail**, the item gets an `error` field instead. A workspace has 6 browser slots; when all are in use the API answers `429 TOO_MANY_REQUESTS` and charges nothing, so the node's **Retry On Fail** setting is a good fit.

## Costs

Browsa bills in prepaid credits that never expire. From [llms-full.txt](https://browsa.io/llms-full.txt) and [pricing](https://browsa.io/pricing), as of 2026-11-15:

| What you run | Credits |
|---|---|
| Cloud browser | 1 per started 12 minutes it runs, 5 for a full hour |
| Quick scrape, extract or screenshot | 1 per page |
| Crawl | 1 per page |
| Agent task, your own LLM key | browser + 1 + 1 per 5 steps |
| Agent task on a hosted tier (`browsa`, `browsa-fast` or `browsa-smart`) | browser + 1 + 1 per 5 steps + 5 |
| Webhooks, job status, polling, downloads | Free |

- A 10-step agent task that finishes inside 12 minutes costs 4 credits with your own key, 9 on a hosted tier. A 20-step task costs 6 or 11.
- A task that fails gets its whole browser charge back and is not charged for steps or the hosted surcharge.
- With your own model key, Browsa adds no LLM markup; your provider bills you for tokens.
- The hosted credits per task are a server setting and can change; `GET /v1/models` returns the live values.
- Price of a credit: $0.10 (Starter, $20 for 200), $0.083 (Growth, $100 for 1,200), $0.067 (Pro, $500 for 7,500).

## Use it as an AI Agent tool

The node declares `usableAsTool: true`, so you can attach it to n8n's **AI Agent** node as a tool and let the model fill in parameters such as the task text or the URL. Task > Run with Wait for Result on, or Page > Scrape with Markdown, are the most useful tool shapes. n8n's node template notes that tools do not support binary data, so use Take Screenshot in a regular workflow step instead.

Older self-hosted n8n versions also needed `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` before a community node could be a tool (see for example the [n8n-nodes-mcp README](https://github.com/nerding-io/n8n-nodes-mcp/blob/main/README.md)). The current n8n source has no such setting in its [community packages config](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/modules/community-packages/community-packages.config.ts); set it only if your version asks for it.

## Example workflows

**Daily price check.** Schedule Trigger > Browsa (Task > Run, Model: Browsa, Task: "Open https://books.toscrape.com and return the title and price of the first 5 books", Output Schema: `{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}`) > Google Sheets (append `{{$json.result.books}}`).

**Docs to Markdown.** Manual Trigger > Browsa (Page > Crawl, Start URL `https://example.com/docs/`, Max Pages 20, Include Only URLs Matching `/docs/`) > one item per page with `markdown` > Write to your store.

**Screenshot to Slack.** Webhook > Browsa (Page > Take Screenshot, URL `{{$json.url}}`) > Slack (upload file from binary field `data`).

## Compatibility

Built with the official [n8n-node CLI](https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/) 0.56.4 and `n8n-workflow` 2.47, in strict mode with n8n Cloud support on (`n8n-node cloud-support`). No runtime dependencies. Node API version 1. Checked to load in n8n 2.47.7 (node, AI tool variant and credential).

## Development

```sh
npm ci
npm run lint     # n8n-node lint (n8n's community node rules)
npm test         # n8n-node build, then node --test test/*.test.js
npm run dev      # n8n with this node at http://localhost:5678 (in a container from n8n 3.0: Docker or Podman)
```

The unit tests mock n8n's request helper; they do not call the Browsa API.

Publishing goes through GitHub Actions with npm provenance (`.github/workflows/publish.yml`), as n8n requires for verified nodes. See [CONTRIBUTING_UPSTREAM.md](CONTRIBUTING_UPSTREAM.md).

## Resources

- [Browsa docs](https://browsa.io/docs) and [OpenAPI spec](https://browsa.io/openapi.yaml)
- [Browsa pricing](https://browsa.io/pricing)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/installation/)
- Support: support@browsa.io

## License

[MIT](LICENSE)
