# langchain-browsa

LangChain tools and a document loader for [Browsa](https://browsa.io), cloud browsers for AI agents. Every call runs in Phantom, Browsa's own browser, in the cloud: your agent gets a real browser without running one.

| Class | What it does | Browsa endpoint |
|---|---|---|
| `BrowsaTaskTool` | Runs a plain-language task: an agent clicks, types and reads pages until it has the answer | `POST /v1/tasks` |
| `BrowsaScrapeTool` | Returns one page as Markdown, HTML, text or links | `POST /v1/quick/scrape` |
| `BrowsaExtractTool` | Returns structured data from one page | `POST /v1/quick/extract` |
| `BrowsaScreenshotTool` | Returns a PNG of one page | `POST /v1/quick/screenshot` |
| `BrowsaLoader` | Loads pages as LangChain `Document`s (scrape, batch or crawl) | `/v1/quick/scrape`, `/batch`, `/crawl` |
| `BrowsaToolkit` | All four tools, sharing one client | |

Built on the official Python SDK, [`browsa`](https://pypi.org/project/browsa/). Full API docs: <https://browsa.io/docs>.

## Install

```bash
pip install -U langchain-browsa
```

Python 3.10 or newer. Get an API key (it starts with `agt_live_`) at <https://app.browsa.io/dashboard/keys>; new accounts get 100 free credits after email verification, with no card.

```bash
export BROWSA_API_KEY="agt_live_..."
```

Every class reads `BROWSA_API_KEY`, or takes `api_key="agt_live_..."`.

## Quickstart: an agent with a browser

`create_agent` from `langchain` builds a LangGraph agent. Give it the Browsa tools:

```python
# pip install -U langchain-browsa "langchain[anthropic]"
from langchain.agents import create_agent
from langchain_browsa import BrowsaToolkit

agent = create_agent(
    model="claude-sonnet-4-6",
    tools=BrowsaToolkit().get_tools(),
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "What is the top story on news.ycombinator.com right now?"}]}
)
print(result["messages"][-1].content)
```

The browser task itself runs on Browsa's hosted model tier `browsa` by default, so you need no second LLM key for it. Your agent's own model (here Claude) only decides which tool to call.

## Tools

### BrowsaTaskTool

```python
from langchain_browsa import BrowsaTaskTool

tool = BrowsaTaskTool()
out = tool.invoke({"task": "Open example.com and return the text of the H1 heading."})

print(out["outcome"], out["final_result"])
```

Arguments the model fills: `task` (required) and `initial_url` (optional).

The result is a dict:

| Key | Meaning |
|---|---|
| `status` | The run ended: `completed`, `failed` or `cancelled` |
| `outcome` | How it ended: `completed`, `failed`, `step_limit_reached`, `budget_reached`, `timed_out`, `blocked_by_bot_check`, `never_started`, `stalled`, `cancelled_by_user` |
| `succeeded` | `True` only when `status` and `outcome` are both `completed` and the result is not partial |
| `final_result` | The agent's answer |
| `structured_output` | The answer as an object, when you set `output_schema` |
| `outcome_message`, `error_code`, `error_message`, `signals` | Why it ended the way it did, when there is something to say |
| `job_id`, `step_count`, `credits_charged`, `duration_ms` | Bookkeeping |
| `live_url` | The Phantom Live link of the run (see below) |

Read `outcome`, not only `status`. A job can be `completed` with outcome `failed`: the agent finished but could not do the task, and `final_result` says what stopped it. A task that a limit stopped can be `completed` with a partial result and outcome `step_limit_reached`.

`live_url` is a Phantom Live link to watch the browser. It works only while the task runs and opens once, so to watch a run, pass a callback:

```python
tool = BrowsaTaskTool(on_live_url=lambda url: print("watch live:", url))
```

Options (all optional):

| Option | Default | Meaning |
|---|---|---|
| `llm` | `"browsa"` | A hosted tier (`"browsa"`, `"browsa-fast"`, `"browsa-smart"`, no key needed) or a provider model such as `"anthropic:claude-sonnet-5-5"` |
| `llm_api_key` | | Your own Anthropic, OpenAI or Google key for this task. Browsa deletes it when the task ends |
| `llm_key_id` | | A key saved in your Browsa workspace instead |
| `llm_base_url` | | An Anthropic- or OpenAI-compatible endpoint for your own key |
| `reasoning` | | `"low"`, `"medium"` or `"high"` |
| `output_schema` | | JSON Schema (an object at the top level) for the answer; the answer comes back in `structured_output` |
| `max_steps` | API default 20 | Most agent steps (max 100) |
| `max_credits` | | Most credits the task may charge; it stops before going over |
| `allowed_domains` | | The only sites the agent may open, e.g. `["example.com", "*.example.com"]` |
| `task_options` | `{}` | Any other `browsa.Client.create_task` option, e.g. `country`, `proxy`, `proxy_id`, `secrets` |
| `wait_timeout` | `600` | Seconds to wait for the task; after that the tool raises a `ToolException` with the job id (the task keeps running) |

Structured output:

```python
tool = BrowsaTaskTool(
    llm="browsa-smart",
    output_schema={
        "type": "object",
        "properties": {"title": {"type": "string"}, "points": {"type": "integer"}},
        "required": ["title", "points"],
    },
    max_credits=20,
)
out = tool.invoke({"task": "Return the title and points of the top story on news.ycombinator.com"})
print(out["structured_output"])
```

The schema is stored on the tool as `task_output_schema`, because `output_schema` is already a LangChain `Runnable` property.

With your own model key:

```python
import os

tool = BrowsaTaskTool(llm="anthropic:claude-sonnet-5-5", llm_api_key=os.environ["ANTHROPIC_API_KEY"])
```

### BrowsaScrapeTool

```python
from langchain_browsa import BrowsaScrapeTool

page = BrowsaScrapeTool().invoke({"url": "https://example.com"})
print(page["http_status"], page["markdown"][:200])
```

Arguments: `url`, and `formats` (any of `markdown`, `html`, `text`, `links`; default `markdown`). Options: `formats`, `wait_ms`, `max_chars`, `country`, `block`, `scrape_options`. No LLM is involved. Check `http_status`: a site that answers 404 or 500 still returns a page.

### BrowsaExtractTool

```python
from langchain_browsa import BrowsaExtractTool

tool = BrowsaExtractTool(llm_api_key="sk-ant-...")
out = tool.invoke({"url": "https://example.com", "prompt": "Return the page heading and the first link."})
print(out["data"])
```

Arguments: `url`, and `prompt` or `json_schema`. The extraction model is Anthropic: give an Anthropic(-compatible) key with `llm_api_key`, or a saved key with `llm_key_id`, and the result has `data`. Without a key, the result has the page's clean `text` and the `schema`, so your own model can do the extraction. Options: `json_schema` (default schema), `llm`, `llm_base_url`, `wait_ms`, `country`, `block`, `extract_options`.

### BrowsaScreenshotTool

```python
from langchain_browsa import BrowsaScreenshotTool

tool = BrowsaScreenshotTool()
msg = tool.invoke({"name": tool.name, "type": "tool_call", "id": "1", "args": {"url": "https://example.com"}})
png_b64 = msg.artifact["screenshot_png_b64"]
```

Arguments: `url` and `full_page` (default `True`). The tool returns content and an artifact: the model gets a short text, and the PNG (base64) is in `ToolMessage.artifact`. Set `include_image=True` to also put the image in the content, for models that accept images in tool results.

### BrowsaLoader

```python
from langchain_browsa import BrowsaLoader

docs = BrowsaLoader("https://example.com").load()

docs = BrowsaLoader(["https://example.com", "https://example.org"], mode="batch").load()

docs = BrowsaLoader(
    "https://docs.example.com",
    mode="crawl",
    max_pages=20,
    max_depth=2,
    include_regex=r"/guides/",
).load()
```

`mode` is `"scrape"` (one call per URL), `"batch"` (up to 100 URLs as one job) or `"crawl"` (follow links from one start URL, up to `max_pages`). `page_content` is Markdown by default (`content_format="text"` or `"html"` to change it). Metadata: `source` (the URL the browser landed on), `requested_url`, `http_status`, `title` when known, `links` when you ask for the `links` format, `job_id` for batch and crawl, and `mode`. Pages that failed are skipped and logged. `lazy_load`, `load`, `alazy_load` and `aload` all work.

### BrowsaToolkit

```python
from langchain_browsa import BrowsaToolkit

tools = BrowsaToolkit(
    task_kwargs={"llm": "browsa-smart", "max_credits": 30},
    include_screenshot=False,
).get_tools()
```

### Async

Every tool supports `ainvoke` and the loader supports `alazy_load` / `aload`, through `browsa.AsyncClient`.

### Errors

API errors (bad key, no credits, rate limit) raise `langchain_core.tools.ToolException` with Browsa's error code and request id. To hand them to the model as the tool's answer instead, set `handle_tool_error=True` on the tool. A task that ran but did not succeed is not an error: it comes back with its `outcome`.

## Costs

Browsa bills in prepaid credits that never expire. From <https://browsa.io/pricing>:

| What you run | Credits |
|---|---|
| Cloud browser | 1 per started 12 minutes it runs, 5 for a full hour |
| Quick scrape, extract or screenshot | 1 per page |
| Batch of URLs | 1 per URL |
| Agent task, your own LLM key | browser + 1 + 1 per 5 steps |
| Agent task on a hosted tier (`"llm": "browsa"`, `"browsa-fast"` or `"browsa-smart"`) | browser + 1 + 1 per 5 steps + 5 |

Worked examples from the pricing page: a 10-step agent task that finishes inside 12 minutes costs 4 credits with your own key, 9 on a hosted tier. A 20-step task costs 6 or 11. A task that fails gets its whole browser charge back and is not charged for steps or the hosted surcharge. With your own model key, Browsa adds no LLM markup; your provider bills you for tokens.

The tier credits are a server setting and can change; `browsa.Client(...).models()` returns the live values. Use `max_credits` on `BrowsaTaskTool` to cap what one task may spend.

Credit packs: Starter $20 for 200 credits, Growth $100 for 1,200 credits, Pro $500 for 7,500 credits. New accounts get 100 free credits after email verification.

## Development

```bash
pip install -e ".[test]"
pytest tests/unit_tests          # offline: the HTTP layer is faked and sockets are disabled
BROWSA_API_KEY=agt_live_... pytest tests/integration_tests   # live API, spends credits
```

The unit tests include LangChain's standard tool tests (`langchain-tests`), run offline.

## Links

- Browsa docs: <https://browsa.io/docs>
- Python SDK: <https://pypi.org/project/browsa/>
- Source: <https://github.com/browsa-io/browsa>
- Support: <mailto:support@browsa.io>

## License

MIT
