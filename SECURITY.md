# Security

## Report a vulnerability

Write to <security@browsa.io> with what you found and how to reproduce it. Please do not open a public issue or pull request for a vulnerability.

- Every report is read and answered.
- We tell you when a fix is released, and credit you in the changelog if you want.
- Good-faith research on your own account and your own data is welcome. Do not access other customers' data, and do not run load or denial-of-service tests against browsa.io.

This covers the code in this repository (the SDKs, the MCP server, the integrations) and the Browsa service itself.

## Supported versions

Fixes go into the latest published version of each package:

| Package | Registry |
|---|---|
| `browsa` | [PyPI](https://pypi.org/project/browsa/), [npm](https://www.npmjs.com/package/browsa) |
| `@browsa/mcp` | [npm](https://www.npmjs.com/package/@browsa/mcp) |
| `langchain-browsa`, `crewai-browsa` | PyPI |
| `n8n-nodes-browsa` | npm |

## Your API key

- A key starts with `agt_live_`. Keep it in an environment variable (`BROWSA_API_KEY`) or your secret store, never in source.
- If a key leaks, delete it at [app.browsa.io/dashboard/keys](https://app.browsa.io/dashboard/keys) and create a new one. A deleted key stops working at once.
- A key can carry a monthly credit limit, which caps what a leaked key can spend.

## What the packages do with your data

- The Python and TypeScript SDKs have no runtime dependencies. They send your key and your requests to `browsa.io` and, for the captcha client, `captcha.browsa.io`, over HTTPS. They make no other request and collect no telemetry.
- The MCP server: see [`browsa-mcp/SECURITY.md`](browsa-mcp/SECURITY.md) for every request it makes.
- Webhooks and captcha callbacks are signed. Verify the signature before you trust a delivery: `browsa.webhooks.verify_signature` (Python), `verifySignature` from `browsa/webhooks` (TypeScript).

## How releases are built

npm packages can be published from this repository's GitHub Actions with npm trusted publishing and a provenance statement ([workflows](.github/workflows)); a version on npm that carries provenance was built from the tagged commit here.
