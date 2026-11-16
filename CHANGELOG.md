# Changelog

Covers the three packages: npm `browsa`, npm `@browsa/mcp` and PyPI `browsa`. They share a version number.

## 0.3.2 (`@browsa/mcp` only)

### Fixed

- **MCP, no key set:** the server starts and lists its tools when `BROWSA_API_KEY` is missing, and each tool call answers that the key is not set. 0.3.1 exited at once, so MCP directories such as Glama could not read its tools. With a key, nothing changes.

## 0.3.1 (2026-11-16)

Found by installing the published 0.3.0 packages in clean containers and running them against production.

### Fixed

- **TypeScript, CommonJS projects:** types now resolve under `moduleResolution: node16` or `nodenext`. 0.3.0 pointed `require` at the ESM declaration file, and `tsc` refused the import (TS1479). `require("browsa")` itself always worked.
- **TypeScript, `browsa/webhooks`:** types now resolve under the classic `node10` resolution, and the declarations no longer need `@types/node` (`verifySignature` takes `Uint8Array | string`; a `Buffer` is a `Uint8Array`).
- **Python, timeouts:** a request that times out raises `browsa.TimeoutError`. 0.3.0 let the built-in `TimeoutError` (or `socket.timeout` on Python 3.9) through, so `except BrowsaError` missed it. A connection dropped mid-response now raises `BrowsaError` too.
- **Python, typing:** the package ships `py.typed`. 0.3.0 did not, and `mypy --strict` rejected `import browsa` as untyped.
- **MCP, job results:** `run_task` and `get_job` return `outcome`, `outcome_message` and `signals`. 0.3.0 returned only `status`, so a run that ended `completed` without doing the task looked like a success.
- **MCP, `run_task` description:** tells the model to read `outcome`; no longer promises a noVNC link.
- **CLI:** `browsa run` shows the live link while the task runs and no longer prints `live: undefined` at the end; it prints the outcome when it differs from the status, and labels a hosted tier as such.

### Added

- `listDownloads` / `downloadFile` (Python: `list_downloads` / `download_file`): the files a running browser downloaded.
- `createLiveLink` (Python: `create_live_link`): a Phantom Live link to watch or take over a running browser.

### Docs

- The first sample in each README runs on the hosted model, so it works with only a Browsa key, and reads `outcome`.
- READMEs say when `liveUrl` exists (while the task runs) and that a link opens once.
- MCP README lists the `proxy_network` tool and no longer says Browsa supplies no proxies.

## 0.3.0 (2026-11-16)

Hosted tiers and `reasoning`, the models listing, token usage and cost on jobs, the built-in proxy network, the `bot_check_passed` signal, `observe` and `act`.
