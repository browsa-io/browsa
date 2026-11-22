<p align="center">
  <a href="https://browsa.io"><img src="https://browsa.io/browsa-logo-lockup.png" alt="Browsa" width="340"></a>
</p>

# Browsa

[Browsa](https://browsa.io) gives AI agents real cloud browsers: this repository holds its SDKs, its MCP server and its framework integrations. Every browser is Phantom, Browsa's own browser.

[![CI](https://github.com/browsa-io/browsa/actions/workflows/ci.yml/badge.svg)](https://github.com/browsa-io/browsa/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/browsa?label=PyPI%20browsa)](https://pypi.org/project/browsa/)
[![npm browsa](https://img.shields.io/npm/v/browsa?label=npm%20browsa)](https://www.npmjs.com/package/browsa)
[![npm @browsa/mcp](https://img.shields.io/npm/v/@browsa/mcp?label=npm%20%40browsa%2Fmcp)](https://www.npmjs.com/package/@browsa/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**You need a Browsa API key.** Create one at [app.browsa.io/dashboard/keys](https://app.browsa.io/dashboard/keys) and set it as `BROWSA_API_KEY`. New accounts get 100 free credits after email verification, no card.

## Packages

| Package | Install | Published | Source |
|---|---|---|---|
| Python SDK | `pip install browsa` | [![PyPI](https://img.shields.io/pypi/v/browsa?label=PyPI)](https://pypi.org/project/browsa/) | [`browsa-python`](browsa-python) |
| TypeScript SDK and CLI | `npm install browsa` | [![npm](https://img.shields.io/npm/v/browsa?label=npm)](https://www.npmjs.com/package/browsa) | [`browsa-ts`](browsa-ts) |
| MCP server | `npx -y @browsa/mcp` | [![npm](https://img.shields.io/npm/v/@browsa/mcp?label=npm)](https://www.npmjs.com/package/@browsa/mcp) | [`browsa-mcp`](browsa-mcp) |

## Quick start

Python:

```python
from browsa import Client

c = Client()  # reads BROWSA_API_KEY
job = c.run_task(task="Return the top 3 Hacker News stories as JSON", llm="browsa")
print(job.outcome, job.final_result)
```

TypeScript (save as `quickstart.mjs`, run with `node quickstart.mjs`):

```ts
import { Client } from "browsa";

const c = new Client(); // reads BROWSA_API_KEY
const job = await c.runTask({ task: "Return the top 3 Hacker News stories as JSON", llm: "browsa" });
console.log(job.outcome, job.finalResult);
```

MCP (Claude Desktop, Cursor, VS Code and other MCP clients; replace the key):

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

`llm="browsa"` is a hosted model: no LLM key needed. That task costs about 8 credits; [pricing](https://browsa.io/pricing) has the formula. More to paste and run, each with its cost: [`examples/`](examples).

## Integrations

| Integration | Install | Published | Source |
|---|---|---|---|
| LangChain tools and document loader | `pip install langchain-browsa` | [![PyPI](https://img.shields.io/pypi/v/langchain-browsa?label=PyPI)](https://pypi.org/project/langchain-browsa/) | [`integrations/langchain-browsa`](integrations/langchain-browsa) |
| CrewAI tools | `pip install crewai-browsa` | [![PyPI](https://img.shields.io/pypi/v/crewai-browsa?label=PyPI)](https://pypi.org/project/crewai-browsa/) | [`integrations/crewai-browsa`](integrations/crewai-browsa) |
| n8n community node | `npm install n8n-nodes-browsa` | [![npm](https://img.shields.io/npm/v/n8n-nodes-browsa?label=npm)](https://www.npmjs.com/package/n8n-nodes-browsa) | [`integrations/n8n-nodes-browsa`](integrations/n8n-nodes-browsa) |
| capbench, the captcha benchmark behind [browsa.io/captcha](https://browsa.io/captcha) | run from source | not on a registry | [`capbench`](capbench) |

## What you can do

- **Run an agent task**: describe the job, get JSON back.
- **Drive a browser yourself** with Playwright or Puppeteer over CDP.
- **Scrape, extract or screenshot** a page in one call.
- **Save a job as a robot** and run it on rows of input, on a schedule or from the API.
- **Solve captchas** through the captcha API, with the same key. Live types and prices: [captcha.browsa.io/types](https://captcha.browsa.io/types).

## Links

[Docs](https://browsa.io/docs) · [MCP guide](https://browsa.io/guides/mcp-server) · [Pricing](https://browsa.io/pricing) · [Status](https://browsa.io/status) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · support@browsa.io

## License

[MIT](LICENSE)
