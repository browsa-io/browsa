# n8n-nodes-browsa

[n8n](https://n8n.io/) community nodes for [Browsa](https://browsa.io), the cloud browser API for AI agents. Run a saved robot or recipe, describe a task in plain language and let an agent run it in a Phantom cloud browser, or scrape, extract, screenshot and crawl pages in one call. The **Browsa Trigger** node starts a workflow when a robot run ends, a robot alert fires, a recipe run ends or a task finishes. Phantom is Browsa's own browser.

- [Install](#install)
- [Credentials](#credentials)
- [Operations](#operations)
- [Browsa Trigger](#browsa-trigger)
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
| Robot | Run | `POST /v1/robots/{id}/run`, then `GET /v1/robot-runs/{id}` until it ends |
| Robot | Get Run | `GET /v1/robot-runs/{id}` |
| Recipe | Run | `POST /v1/recipes/{id}/run` with `wait`, then `GET /v1/recipe-runs/{id}` until it ends |
| Recipe | Get Run | `GET /v1/recipe-runs/{id}` |
| Task | Run | `POST /v1/tasks`, then `GET /v1/jobs/{id}` until it ends |
| Job | Get | `GET /v1/jobs/{id}` |
| Page | Scrape | `POST /v1/quick/scrape` |
| Page | Extract Data | `POST /v1/quick/extract` |
| Page | Take Screenshot | `POST /v1/quick/screenshot` |
| Page | Crawl | `POST /v1/quick/crawl`, then `GET /v1/jobs/{id}` until it ends |

### Robot > Run

Runs a [robot](https://browsa.io/guides/robots): a saved job made from a recipe, with a table of input rows. One run covers every row.

- **Robot**: pick it from the list or give its ID.
- **Inputs**: **Saved Inputs** (default) runs the rows saved on the robot. **Rows Given Here** runs the JSON array you give instead, for this run only, at most 500 rows, for example `[{"asin": "B0C1234567"}, {"asin": "B0D7654321"}]`.
- **Wait for Result** (on by default), **Timeout (Seconds)** and **Simplify**, as for Task > Run. A finished run has `status` `completed`, `partial` (some rows failed) or `failed`.
- **Output**: **One Run Item** (default) returns the run with every row in `rows`. **One Item per Row** returns one item per input row with its `input`, `status`, `output` and the run ID, ready for an IF node, Slack or Google Sheets.
- **Options**: On Timeout, and Stop on Unsuccessful Run (stops on `partial` or `failed`).

A robot run costs the recipe's credits per input row; failed rows are free.

### Robot > Get Run

Reads a robot run by ID, with the same Output, Wait and Simplify options.

### Recipe > Run

Replays a [recipe](https://browsa.io/guides/recipes) with new **Parameters** (a JSON object checked against the recipe's parameter schema, for example `{"query": "air fryer"}`). With **Wait for Result** on, the node asks Browsa to hold the answer up to 60 seconds and then polls until the run ends or the timeout passes. A run returns `status` (`ok`, `failed` or `cancelled`), `output`, `error_code` (`blocked`, `needs_login`, `site_changed`, `invalid_output`, `params_invalid`, `timeout`), `repaired`, `duration_ms` and `credits`. Failed runs are free.

### Recipe > Get Run

Reads a recipe run by ID, with optional waiting.

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

## Browsa Trigger

Starts the workflow on Browsa events. Choose one or more **Events**:

| Event | When |
|---|---|
| Robot Run Completed | A robot run ended, with one result per input row |
| Robot Alert | A robot monitor fired, for example a price dropped below your value |
| Robot Failed | A robot run failed as a whole |
| Recipe Run Completed | A recipe run returned its output |
| Task Completed | An agent task finished (Browsa sends it as `job.completed` with `job_kind: "task"`) |
| Task Needs User | An agent task asked a question and waits for `POST /v1/jobs/{id}/respond` |

How it works:

- When you activate the workflow (or click **Listen for test event**), the node registers a webhook with `POST /v1/webhooks` for the n8n webhook URL and the chosen events, and reads the workspace signing secret from `GET /v1/webhooks/signing-secret`. Deactivating the workflow deletes the webhook.
- Every delivery carries `X-Agents-Signature: t=<unix>, v1=<hex>`, an HMAC-SHA256 of `<unix>.<raw body>`. The node checks it (and refuses deliveries more than 5 minutes old) before it starts the workflow, and answers 401 otherwise. Turn **Check Signature** off under Options only to debug a proxy that changes the body.
- If Browsa does not know one of the event names yet, the node subscribes to every event and drops the ones you did not choose. Ignored deliveries get a 200 and start nothing.
- The output is the event: `event` (the trigger event it matched), `id`, `type`, `created_at`, `workspace_id`, `job_id`, `job_kind`, `data`, and `error_code` and `error_reason` for failures.
- Browsa refuses webhook URLs that do not resolve to a public address, so n8n must be reachable from the internet (n8n Cloud, or a self-hosted instance with `WEBHOOK_URL` set to its public HTTPS address). `localhost` test URLs do not work.

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

**Morning price check with a robot.** Schedule Trigger (every day at 8:00) > Browsa (Robot > Run, Output: One Item per Row) > IF (`{{ $json.output.price }}` is smaller than your target) > Slack (send a message) and Google Sheets (append `{{ $json.input.asin }}`, `{{ $json.output.price }}`). Or set a monitor on the robot ("price drops below 20") and start the workflow with the Browsa Trigger on **Robot Alert** instead of the schedule.

**Daily price check.** Schedule Trigger > Browsa (Task > Run, Model: Browsa, Task: "Open https://books.toscrape.com and return the title and price of the first 5 books", Output Schema: `{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}`) > Google Sheets (append `{{$json.result.books}}`).

**Docs to Markdown.** Manual Trigger > Browsa (Page > Crawl, Start URL `https://example.com/docs/`, Max Pages 20, Include Only URLs Matching `/docs/`) > one item per page with `markdown` > Write to your store.

**Screenshot to Slack.** Webhook > Browsa (Page > Take Screenshot, URL `{{$json.url}}`) > Slack (upload file from binary field `data`).

## Compatibility

Built with the official [n8n-node CLI](https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/) 0.56.4 and `n8n-workflow` 2.47, in strict mode with n8n Cloud support on (`n8n-node cloud-support`). No runtime dependencies. Node API version 1. Version 0.1.x was checked to load in n8n 2.47.7 (node, AI tool variant and credential); 0.2.0 (Robot, Recipe and the Browsa Trigger) is tested with mocked HTTP only so far.

## Development

```sh
npm ci
npm run lint     # n8n-node lint (n8n's community node rules)
npm test         # n8n-node build, then node --test test/*.test.js
npm run dev      # n8n with this node at http://localhost:5678 (in a container from n8n 3.0: Docker or Podman)
```

The unit tests mock n8n's request helper and the trigger's request and response objects; they do not call the Browsa API. The robots API (`/v1/robots`, `/v1/robot-runs`) and the `robot.*` and `task.needs_user` webhook events follow `docs/robots/ROBOTS.md`; check the field names against the live API before publishing 0.2.0.

Publishing goes through GitHub Actions with npm provenance (`.github/workflows/publish.yml`), as n8n requires for verified nodes. See [CONTRIBUTING_UPSTREAM.md](CONTRIBUTING_UPSTREAM.md).

## Resources

- [Browsa docs](https://browsa.io/docs) and [OpenAPI spec](https://browsa.io/openapi.yaml)
- [Browsa pricing](https://browsa.io/pricing)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/installation/)
- Support: support@browsa.io

## License

[MIT](LICENSE)
