# Browsa SDKs and MCP server

Official clients for [Browsa](https://browsa.io), cloud browsers for AI agents. Each browser is Phantom, Browsa's own browser.

[![PyPI](https://img.shields.io/pypi/v/browsa?label=PyPI%20browsa)](https://pypi.org/project/browsa/)
[![npm browsa](https://img.shields.io/npm/v/browsa?label=npm%20browsa)](https://www.npmjs.com/package/browsa)
[![npm @browsa/mcp](https://img.shields.io/npm/v/@browsa/mcp?label=npm%20%40browsa%2Fmcp)](https://www.npmjs.com/package/@browsa/mcp)

| Package | Install | Published at | Source |
|---|---|---|---|
| Python SDK | `pip install browsa` | [PyPI: browsa](https://pypi.org/project/browsa/) | [`browsa-python`](browsa-python) |
| TypeScript SDK | `npm i browsa` | [npm: browsa](https://www.npmjs.com/package/browsa) | [`browsa-ts`](browsa-ts) |
| MCP server for Claude, Cursor and other MCP clients | `npx -y @browsa/mcp` | [npm: @browsa/mcp](https://www.npmjs.com/package/@browsa/mcp) | [`browsa-mcp`](browsa-mcp) |

## What you can do

- **Run an agent task.** Describe the job in plain language and get JSON back. Use your own Anthropic, OpenAI or Google key, or a hosted tier (`"llm": "browsa"`) with no key.
- **Drive a browser yourself.** Start a Phantom browser in the cloud and connect Playwright or Puppeteer over CDP.
- **Scrape, extract or screenshot a page** in one call.
- **Schedule a task and receive results** on a signed webhook.

```python
from browsa import Client

c = Client(api_key="agt_live_...")
job = c.run_task(task="Return the top 3 Hacker News stories as JSON", llm="browsa")
print(job.final_result)
```

```ts
import { Client } from "browsa";

const c = new Client({ apiKey: "agt_live_..." });
const job = await c.runTask({ task: "Return the top 3 Hacker News stories as JSON", llm: "browsa" });
console.log(job.finalResult);
```

New accounts get 100 free credits after email verification: no card, and credits never expire. Browsa does not supply proxies; you can bring your own HTTP, HTTPS or SOCKS5 proxy per browser.

## Links

- Website: https://browsa.io
- API docs: https://browsa.io/docs
- MCP setup guide: https://browsa.io/guides/mcp-server
- Pricing: https://browsa.io/pricing
- Status: https://browsa.io/status
- Support: support@browsa.io

## Issues

Bug reports and questions about the SDKs are welcome as GitHub issues in this repository. For account or billing questions, email support@browsa.io.

## License

MIT. See each package's `LICENSE` file.
