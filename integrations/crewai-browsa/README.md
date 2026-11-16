# crewai-browsa

[CrewAI](https://www.crewai.com/) tools for [Browsa](https://browsa.io), cloud browsers for AI agents. Your crew gets Phantom, Browsa's cloud browser, to run browser tasks in plain language and to scrape, extract and screenshot pages.

| Tool | What the agent gets | Credits |
|---|---|---|
| `BrowsaTaskTool` | A browser agent that opens sites, clicks, types and returns the answer (text, or JSON from an `output_schema`) | browser + 1 + 1 per 5 steps, + 5 on a hosted tier |
| `BrowsaScrapeTool` | One rendered page as Markdown and links | 1 per page |
| `BrowsaExtractTool` | Fields you describe from one page, as JSON | 1 per page |
| `BrowsaScreenshotTool` | A PNG of a page, saved to a file | 1 per page |

## Install

```bash
pip install crewai-browsa
```

Python 3.10 to 3.13. It installs the official [`browsa`](https://pypi.org/project/browsa/) SDK (0.3.1 or later) and `crewai`.

## Set your key

Create an API key at <https://app.browsa.io/dashboard/keys> and set it:

```bash
export BROWSA_API_KEY=agt_live_...
```

or pass it to any tool: `BrowsaScrapeTool(api_key="agt_live_...")`. New accounts get 100 free credits after email verification, with no card.

## Quick start

```python
from crewai import Agent, Crew, Task
from crewai_browsa import BrowsaScrapeTool, BrowsaTaskTool

researcher = Agent(
    role="Web researcher",
    goal="Find facts on live websites",
    backstory="You read pages in a cloud browser and cite URLs.",
    tools=[BrowsaScrapeTool(), BrowsaTaskTool()],
)

task = Task(
    description="Return the titles of the top 3 stories on news.ycombinator.com.",
    expected_output="Three titles with their links.",
    agent=researcher,
)

print(Crew(agents=[researcher], tasks=[task]).kickoff())
```

Your crew's own model is configured as usual in CrewAI. `BrowsaTaskTool` runs a separate browser agent on Browsa, by default on the hosted tier `browsa`, so no model key is needed for it.

## Example: a research crew

A researcher reads live pages and a writer turns the notes into a brief. The researcher reads known URLs with the scrape tool (1 credit) and uses a browser task only when it must click or search. Full file: [`examples/research_crew.py`](examples/research_crew.py).

```python
from crewai import Agent, Crew, Process, Task
from crewai_browsa import BrowsaExtractTool, BrowsaScrapeTool, BrowsaTaskTool

researcher = Agent(
    role="Web researcher",
    goal="Collect accurate, current facts from the live web, with their source URLs",
    backstory=(
        "You read pages in a cloud browser. Read a known URL with the scrape tool; "
        "use the browser task tool only when you must click, search or page through a site."
    ),
    tools=[BrowsaScrapeTool(), BrowsaExtractTool(), BrowsaTaskTool(max_steps=25)],
)
writer = Agent(
    role="Analyst",
    goal="Turn the researcher's notes into a short, sourced brief",
    backstory="You write plainly and cite every fact with its URL.",
)

research = Task(
    description=(
        "Find the top 5 stories on the front page of Hacker News (title, points, link). "
        "Then open the top story's link and summarise it in three sentences."
    ),
    expected_output="5 stories and a 3-sentence summary of the first.",
    agent=researcher,
)
brief = Task(
    description="Write a brief from the research: one line per story, then the summary.",
    expected_output="A Markdown brief with sources.",
    agent=writer,
    context=[research],
)

Crew(agents=[researcher, writer], tasks=[research, brief], process=Process.sequential).kickoff()
```

## Example: a shopping assistant that compares stores

The shopper runs one browser task per store. Each task returns the same JSON shape through an `output_schema`, and an advisor compares the offers. Full file: [`examples/shopping_crew.py`](examples/shopping_crew.py).

```python
from crewai import Agent, Crew, Process, Task
from crewai_browsa import BrowsaTaskTool

OFFER_SCHEMA = {
    "type": "object",
    "properties": {
        "store": {"type": "string"},
        "product_title": {"type": "string"},
        "price": {"type": "number"},
        "currency": {"type": "string"},
        "in_stock": {"type": "boolean"},
        "url": {"type": "string"},
    },
    "required": ["store", "product_title", "price", "currency", "in_stock", "url"],
}

shopper = Agent(
    role="Shopping assistant",
    goal="Find the current price and stock of one exact product at each store",
    backstory="You check one store per browser task and skip accessories and bundles.",
    tools=[BrowsaTaskTool(output_schema=OFFER_SCHEMA, max_steps=30, max_credits=20)],
)
advisor = Agent(
    role="Buying advisor",
    goal="Recommend where to buy, based only on the offers that were found",
    backstory="You compare like for like and never invent a price.",
)

find_offers = Task(
    description=(
        "Product: Sony WH-1000XM5 headphones, black. For each of bestbuy.com, target.com "
        "and walmart.com, run one browser task: search the store, open the exact listing "
        "and return the offer. Note any store that failed and why."
    ),
    expected_output="One JSON offer per store, plus a note for stores with no offer.",
    agent=shopper,
)
recommend = Task(
    description="Compare the offers: cheapest in-stock offer first, then the rest.",
    expected_output="A table (store, price, in stock, link) and a one-line recommendation.",
    agent=advisor,
    context=[find_offers],
)

Crew(agents=[shopper, advisor], tasks=[find_offers, recommend], process=Process.sequential).kickoff()
```

Browsa's task agent does not press order, payment or subscription buttons unless the task sets `allow_purchase` (it is off by default), so this crew only reads. One task per store keeps each answer separate: when a task about several named stores has no answer for one of them, the whole task's outcome is `failed`.

## What `BrowsaTaskTool` returns

On success the agent gets JSON:

```json
{
  "result": {"store": "...", "price": 279.99, "...": "..."},
  "status": "completed",
  "outcome": "completed",
  "partial": false,
  "job_id": "252e8eac-...",
  "live_url": "https://...",
  "credits_charged": 11
}
```

- `result` is `structured_output` when an `output_schema` was given, otherwise the agent's text answer.
- The tool reads `outcome`, not only `status`. `status: "completed"` with `outcome: "failed"` means the agent finished but could not do the task; the tool reports that as a failure, with `outcome_message` saying what stopped it.
- A task a limit stopped (`step_limit_reached`, `budget_reached`, `timed_out`) that still returned a partial result comes back with `"partial": true`.
- `live_url` is a Phantom Live link to watch the browser. It exists only while the task runs, and each link opens once.

Failures (a failed outcome, an HTTP error such as `402 INSUFFICIENT_CREDIT`, no free browser slot) are returned as CrewAI `ToolFailure` objects, so CrewAI records the call as failed and your crew's tool failure policy applies. The agent still reads the message, the error code and the details. On crewai versions without `ToolFailure` the tool returns the same text.

If a task is still running at `timeout` (600 seconds by default), or stops to ask a question the tool cannot answer, the tool cancels it so it does not keep its browser. Pass `cancel_unfinished=False` to leave it running.

## Options

All tools take `api_key` (default `BROWSA_API_KEY`), `base_url` (default `BROWSA_BASE_URL` or `https://browsa.io`) and `client` (an existing `browsa.Client`).

`BrowsaTaskTool`

| Option | Default | Meaning |
|---|---|---|
| `llm` | `"browsa"` | A hosted tier (`"browsa"`, `"browsa-fast"`, `"browsa-smart"`) or your own model, e.g. `"anthropic:claude-sonnet-5-5"` |
| `llm_api_key` | none | Your Anthropic, OpenAI or Google key, for this task only |
| `llm_key_id` | none | A model key saved in your Browsa workspace |
| `reasoning` | none | `"low"`, `"medium"` or `"high"` |
| `max_steps` | Browsa's 20 | Most agent steps, up to 100 |
| `max_credits` | none | Most credits one task may charge |
| `output_schema` | none | Default JSON Schema for the answer; the agent can pass its own |
| `timeout` | 600 | Seconds to wait |
| `cancel_unfinished` | `True` | Cancel on timeout or on a question |
| `task_options` | `{}` | Any other `POST /v1/tasks` field, e.g. `{"allowed_domains": ["example.com"]}` |

The agent passes `task`, and optionally `start_url` and `output_schema`.

To use your own model key instead of a hosted tier:

```python
import os
BrowsaTaskTool(llm="anthropic:claude-sonnet-5-5", llm_api_key=os.environ["ANTHROPIC_API_KEY"])
```

`BrowsaScrapeTool`: `formats` (any of `markdown`, `html`, `text`, `links`; default `["markdown", "links"]`), `max_chars` (30000 here; Browsa's default is 100000), `wait_ms`, `country`, `block`, `max_links`.

`BrowsaExtractTool`: the agent passes `url` and a `prompt` or an `extraction_schema`. With `llm_api_key` (an Anthropic or Anthropic-compatible key) or a saved `llm_key_id`, Browsa runs the extraction and the tool returns `data` as JSON. Without a key, Browsa returns the page's clean text and the schema, and your crew's model reads the fields from it.

`BrowsaScreenshotTool`: the agent passes `url` and `full_page`; the PNG is written to `output_dir` (default `browsa_screenshots`) and the tool returns its path.

All tools also have `_arun`, so they work in async crews.

## Costs

From <https://browsa.io/pricing>:

| What you run | Credits |
|---|---|
| Cloud browser | 1 per started 12 minutes it runs, 5 for a full hour |
| Quick scrape, extract or screenshot | 1 per page |
| Agent task, your own LLM key | browser + 1 + 1 per 5 steps |
| Agent task on a hosted tier (`"llm": "browsa"`, `"browsa-fast"` or `"browsa-smart"`) | browser + 1 + 1 per 5 steps + 5 |

- A 10-step agent task that finishes inside 12 minutes costs 4 credits with your own key, 9 on a hosted tier. A 20-step task costs 6 or 11.
- A task that fails gets its whole browser charge back and is not charged for steps or the hosted surcharge. With your own model key, Browsa adds no LLM markup; your provider bills you for tokens.
- Credit packs: Starter $20 for 200 credits, Growth $100 for 1,200, Pro $500 for 7,500. Credits never expire. No subscription.
- A workspace has 6 browser slots; a request with every slot in use gets `429 TOO_MANY_REQUESTS` and is not charged. The tool reports it as a retryable failure.

Set `max_credits` on `BrowsaTaskTool` to cap what one task may charge.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The tests fake the HTTP layer under the `browsa` SDK and block real sockets, so they need no key and no network.

## Links

- Browsa: <https://browsa.io>
- API docs: <https://browsa.io/docs>
- Python SDK: <https://pypi.org/project/browsa/>
- Source: <https://github.com/browsa-io/browsa>
- Support: support@browsa.io

MIT licensed.
