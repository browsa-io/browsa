# Contributing

Bug reports, fixes and small improvements are welcome. For a larger change, open an issue first so we can agree on the shape before you write it.

- **A bug in an SDK, the MCP server or an integration:** open an [issue](https://github.com/browsa-io/browsa/issues/new/choose).
- **A question about your account, billing or the service:** email support@browsa.io.
- **A vulnerability:** see [SECURITY.md](SECURITY.md). Do not open a public issue.

## Layout

| Folder | Package | Tests |
|---|---|---|
| [`browsa-python`](browsa-python) | PyPI `browsa` | `pytest` |
| [`browsa-ts`](browsa-ts) | npm `browsa` | `node --test` |
| [`browsa-mcp`](browsa-mcp) | npm `@browsa/mcp` | `node --test`, the server over stdio |
| [`integrations/`](integrations) | `langchain-browsa`, `crewai-browsa`, `n8n-nodes-browsa` | each folder's README |
| [`examples/`](examples) | ten runnable scripts | `pytest` against a local stand-in |

## Build and test

No test needs a Browsa API key: they run against local stand-ins of the API. Live tests skip themselves unless `BROWSA_API_KEY` is set, and then they spend credits.

```bash
# Python SDK (3.9 or newer)
cd browsa-python
python -m venv .venv && . .venv/bin/activate
pip install -e . pytest pytest-asyncio
pytest -q

# TypeScript SDK (Node 20 or newer)
cd browsa-ts
npm ci && npm run build && npx tsc --noEmit -p . && npm test

# MCP server (Node 20 or newer)
cd browsa-mcp
npm ci && npm run build && npx tsc --noEmit -p . && npm test

# Examples (Python 3.9 or newer and Node 22.18 or newer; build browsa-ts first)
pip install -e browsa-python pytest
cd examples && npm install --no-save ../browsa-ts typescript@5 @types/node@20
npx tsc --noEmit -p . && python -m pytest -q tests
```

CI runs the same commands on every pull request ([ci.yml](.github/workflows/ci.yml)).

## Pull requests

- One change per pull request, with a test that fails without it.
- Keep the Python and TypeScript SDKs in step: a new method or option goes into both, with the same meaning, in each language's naming (`callback_url` / `callbackUrl`).
- The SDKs have no runtime dependencies. Please keep it that way.
- Add a line to [CHANGELOG.md](CHANGELOG.md) (or the integration's own changelog) under the next version.
- Call the browser Phantom in text. The engine's name belongs only in code a developer types (`chromium.connect_over_cdp`); CI checks the prose.
- Do not put a key in an issue, a test or a commit. Examples use `agt_live_...`.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Releases

Maintainers release by tag. `browsa-ts-v<version>` and `browsa-mcp-v<version>` publish to npm with provenance and create the GitHub Release from the changelog; `browsa-python-v<version>` creates the release for a version uploaded to PyPI. See the comments at the top of each file in [.github/workflows](.github/workflows).
