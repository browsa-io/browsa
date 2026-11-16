<p align="center">
  <a href="https://browsa.io"><img src="https://browsa.io/browsa-logo-lockup.png" alt="Browsa" width="340"></a>
</p>

# browsa (Python)

Real browsers for AI agents: the official Python SDK for [browsa.io](https://browsa.io).

[![PyPI version](https://img.shields.io/pypi/v/browsa.svg)](https://pypi.org/project/browsa/)
[![Python](https://img.shields.io/pypi/pyversions/browsa.svg)](https://pypi.org/project/browsa/)

## Install

```bash
pip install browsa
```

Zero dependencies. Pure stdlib. Single-file wheel.

## Five-line hello world

```python
from browsa import Client

c = Client(api_key="agt_live_...")
job = c.run_task(
    task="Go to news.ycombinator.com and return the top story title.",
    llm="browsa",
    on_progress=lambda j: j.live_url and print("watch live:", j.live_url),
)
print(job.outcome, job.final_result)
```

That runs Phantom, our Chromium build, in a temporary cloud browser, driven by Browsa's hosted model: no LLM key needed. To use your own model instead, pass `llm="anthropic:claude-sonnet-5-5"` with `llm_api_key`, or save the key once (below).

`job.status` says the run ended; `job.outcome` says how. `outcome == "failed"` with `status == "completed"` means the agent finished but could not do the task, and `final_result` says what stopped it.

`live_url` is a Phantom Live link to watch the browser. It exists only while the task runs (so read it in `on_progress` or from `create_task`), and each link opens once.

## Saved LLM keys

Save your LLM provider key once in the workspace (dashboard: <https://app.browsa.io/dashboard/llm-keys>, or the API) and tasks use it without the secret in your code:

```python
import os

key = c.create_llm_key("anthropic", os.environ["ANTHROPIC_API_KEY"], name="Prod Anthropic")
print(key.id, key.masked, key.status)        # 3f6c...  sk-ant-…a1b2  valid

# The first key of a provider becomes its default, so this needs no key at all:
job = c.run_task(task="Return the title of example.com")

# Or pick a saved key by id (also on create_task, create_schedule and auto):
job = c.run_task(task="...", llm="anthropic:claude-sonnet-5-5", llm_key_id=key.id)
```

Which key a task uses, first match wins: `llm_api_key` (per task), then `llm_key_id`, then the workspace's default saved key for the provider of `llm` (with `llm` omitted: the first default in the order anthropic, openai, google), then a hosted tier such as `llm="browsa"` (see [Models](#models)).

| Method | Endpoint |
|---|---|
| `create_llm_key(provider, api_key, *, name=None, base_url=None, default=None)` | `POST /v1/llm-keys` |
| `list_llm_keys()` | `GET /v1/llm-keys` |
| `get_llm_key(llm_key_id)` | `GET /v1/llm-keys/{id}` |
| `validate_llm_key(llm_key_id)` | `POST /v1/llm-keys/{id}/validate` |
| `rotate_llm_key(llm_key_id, api_key, *, base_url=None)` | `POST /v1/llm-keys/{id}/rotate` |
| `update_llm_key(llm_key_id, *, name=None, default=None)` | `POST /v1/llm-keys/{id}` |
| `delete_llm_key(llm_key_id)` | `DELETE /v1/llm-keys/{id}` |

Providers: `anthropic`, `openai`, `google`, `openai_compatible` (needs `base_url`). Each returns an `LLMKey` (or nothing, for delete). The API never returns the secret, only `masked` (prefix + last 4). Keys are checked with a free model-list call when saved or rotated; an invalid key raises `APIError` with code `LLM_KEY_INVALID` and nothing changes. Rotating keeps the id, so schedules and queued runs pick up the new secret. Jobs show `llm_key_id`, `llm_key_masked` and `llm_key_source` (`"saved"` or `"default"`).

## Models

A task runs on one of Browsa's hosted tiers, or on any provider model with your own key.

| `llm` | What it is |
|---|---|
| `"browsa"` | The default hosted model |
| `"browsa-fast"` | Fastest and lightest |
| `"browsa-smart"` | For harder tasks |
| anything else, e.g. `"anthropic:claude-sonnet-5-5"` | A provider model, run with your own key (`llm_api_key`, `llm_key_id` or the workspace default) |

Hosted tiers need no LLM key and add a flat number of credits per task. Which model each tier runs on, and what it costs, are server settings that can change, so read them from `models()` (free, read-only) instead of hardcoding them:

```python
m = c.models()
for tier in m.hosted:
    print(tier.id, tier.model, tier.reasoning, tier.credits_per_task, tier.default)
print(m.own_key.providers, m.own_key.default_models)
```

`reasoning` sets how much the model reasons: `"low"`, `"medium"` or `"high"`. Leave it out for the tier's or the provider's default. It is accepted by `create_task`, `run_task`, `create_session`, `send_message`, `run_message` and `create_schedule`; the API answers 400 for any other value.

```python
job = c.run_task(
    task="Go to news.ycombinator.com and return the top story title.",
    llm="browsa-smart",
    reasoning="high",
)
print(job.final_result)
print(job.llm_tier, job.reasoning)          # browsa-smart high
if job.usage:
    print(job.usage.input_tokens, job.usage.output_tokens, job.usage.requests)
print(job.llm_cost_usd)                     # None for hosted runs
```

A finished job has `usage` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `requests`), `llm_cost_usd`, `llm_tier` and `reasoning` (the level that was applied). `llm_cost_usd` is an estimate from public list prices for runs with your own key; it is `None` when unknown and always `None` for hosted runs, which are paid in credits. All four are `None` on jobs that do not have them, such as jobs run before these fields existed.

## Async

```python
import asyncio
from browsa import AsyncClient

async def main():
    async with AsyncClient(api_key="agt_live_...") as c:
        job = await c.run_task(
            task="Scrape the top 5 products on producthunt.com today.",
            llm="claude-opus-5-5",
            llm_api_key="sk-ant-...",
            country="US",
        )
        print(job.final_result)

asyncio.run(main())
```

## Webhooks

```python
from browsa import webhooks

# In your receiver (Flask/FastAPI/whatever):
ok = webhooks.verify_signature(
    body=raw_request_body,
    header=request.headers["X-Agents-Signature"],
    secret=os.environ["BROWSA_WEBHOOK_SECRET"],  # hex-encoded
)
if not ok:
    return 401
# Trust the payload only after this point.
```

## What you get

| Capability | Notes |
|---|---|
| Sync + async clients | `Client` + `AsyncClient`, same surface |
| Real `Job` envelope | Typed dataclass + `.raw` escape hatch |
| Hosted tiers + reasoning | `llm="browsa" / "browsa-fast" / "browsa-smart"`, `reasoning=`, `models()`, `job.usage` |
| Long-poll waits | `wait_for_job(timeout=...)` uses server-side `?wait=30` |
| Live step events | `for ev in client.stream_job_events(job_id, after=0)`; resume with `after=<last n>` |
| Webhook signature verify | HMAC-SHA256, constant-time compare, skew check |
| Canonical error envelope | `AuthError`, `InvalidIDError`, `RateLimitError`, `TimeoutError`, etc.; every one is a `BrowsaError` |
| Typed | Ships `py.typed`; works with `mypy --strict` and pyright |
| `X-Request-Id` propagation | Every error carries the server's request id |
| Zero deps | Single wheel, audit-friendly, no transitive surface |

## Advanced

### Long-running tasks with progress callback

```python
def show(job):
    print(f"  step {job.step_count}/{job.progress_total}  status={job.status}")

job = c.run_task(
    task="Open-ended research: scrape arxiv for papers on test-time compute, return top 10 by citation.",
    llm="claude-opus-5-5",
    llm_api_key="sk-ant-...",
    max_steps=80,
    on_progress=show,
)
```

### Interactive (input_required) tasks

If your task can pause for human input (captcha, decision point), watch for status `input_required` and respond. Hosted tasks solve reCAPTCHA v2 image grids of the 3 x 3 kind and image-text captchas in the browser's own session on workspaces that have bought a pack (fair use applies); the types and measured pass rates are at https://browsa.io/captcha. A type that is not supported yet, or a workspace on free credits only, may still need you here. Respond like this:

```python
job = c.create_task(task="...", llm="...", llm_api_key="...")
while not job.is_terminal:
    job = c.get_job(job.id, wait=30)
    if job.status == "input_required":
        answer = input(f"Agent asks: {job.input_question}\n> ")
        job = c.respond_to_job(job.id, answer)
```

### Sessions: follow-up messages on the same browser

Start a task with `create_session` and the browser stays up after it ends (15 minutes by default, `browser_ttl_seconds` up to 3600), so you can send follow-ups that continue on the same page. A follow-up pays no new browser, only the task's base and step credits.

```python
s = c.create_session("Go to example.com and return the page title.", llm="browsa")
first = c.wait_for_job(s.id)
print(first.final_result)

turn = c.run_message(s.session_id, "Now open the Learn more link and tell me its URL and H1")
print(turn.final_result)

session = c.get_session(s.session_id)
print(session.status, session.browser.expires_in_seconds, [t.final_result for t in session.turns])
c.stop_session(s.session_id)
```

`send_message` returns the new turn's `Job` right away (use `run_message` to wait). Model fields you leave out reuse the previous turn's model, but a BYOK `llm_api_key` must be sent again on every message. A closed browser raises `APIError` with `code == "BROWSER_EXPIRED"`; a turn still running raises `code == "SESSION_BUSY"`.

### JA3-spoofed sessions

Some sites fingerprint TLS handshake shape. Set a profile to spoof macOS Chrome:

```python
job = c.run_task(
    task="Go to a TLS-fingerprint-fingerprinted site",
    llm="claude-opus-5-5", llm_api_key="sk-...",
    ja3_profile="macos_chrome_137",  # uses utls
)
```

### Observe and act (no Playwright)

Read a running browser's page as compact text with element ids, then act on the ids. Each `act` returns what changed, not the whole page.

```python
b = c.create_agent(ttl="10m")
c.act(b["id"], "navigate", url="https://example.com/login")
view = c.observe(b["id"])
print(view["text"])                        # [3] textbox "Email"  empty …
r = c.act(b["id"], "type", id=3, text="ada@example.com")
print(r["status"], r["text"])              # ok  ~ [3] textbox "Email"  value "ada@example.com"
c.act(b["id"], "click", role="button", name="Sign in")
```

`status` is `ok`, `failed`, `blocked`, `challenge` or `stale`; none of them raises. `stale` means the ids came from a view the server no longer has (`ids_reset` is true): nothing was done and `text` carries a new view. Both calls are free. Format and actions: <https://browsa.io/docs#agents-observe>.

### Downloads and Phantom Live

Files a browser downloads are kept with the browser, not on your machine, so Playwright's `download.save_as()` cannot reach them. List and fetch them through the API before you stop the browser:

```python
files = c.list_downloads(b["id"])                   # [{"name", "size", "modified_at"}]
data = c.download_file(b["id"], files[0]["name"])   # bytes
```

With Playwright the name is the last part of `download.path()`.

`create_live_link` gives a link that shows a running browser in any web browser, to watch or to take over:

```python
link = c.create_live_link(b["id"], scope="control", ttl_seconds=600)
print(link["live_url"])                             # opens once; make one per person
```

`scope` is `"view"` (default) or `"control"`. Both calls are free.

## Docs

- API reference: <https://browsa.io/docs>
- Docs: <https://browsa.io/docs>
- Support: <mailto:support@browsa.io>

## License

MIT.
