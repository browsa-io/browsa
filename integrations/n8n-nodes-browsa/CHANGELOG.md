# Changelog

Published on npm: **0.1.2** (`npm view n8n-nodes-browsa version`). 0.2.0 below is in this repository and not on npm yet.

## 0.2.0 (unreleased: not on npm)

- **Robot** resource: Run (a robot from a list or by ID, on its saved inputs or on rows given as JSON; waits for the run or returns at once; one item for the run or one item per row) and Get Run.
- **Recipe** resource: Run (a recipe with JSON parameters, waits with the server's long poll) and Get Run.
- **Browsa Trigger** node: registers a Browsa webhook when the workflow is activated and removes it when it is deactivated. Events: Robot Run Completed, Robot Alert, Robot Failed, Recipe Run Completed, Task Completed, Task Needs User. Checks the `X-Agents-Signature` HMAC (5 minute window) and answers 401 to a bad signature. When Browsa does not know an event name yet, it subscribes to every event and filters them itself.
- Resource list is now alphabetical. The default resource stays Task, so existing workflows do not change.
- Every call sends `User-Agent: n8n-nodes-browsa/<version>`.

## 0.1.2 (2026-11-16)

- Fixes 0.1.1, which was published without the compiled node (only the icons). Do not use 0.1.1.
- Builds are no longer incremental, so no TypeScript build cache is created or packaged.
- The publish workflow now refuses to publish a package that lacks the compiled node or credential.

## 0.1.1 (2026-11-16, broken: do not use)

- The npm package no longer includes the TypeScript build cache (`tsconfig.tsbuildinfo`, 95 kB). No change to the node.
- First release published through npm's trusted publisher (GitHub Actions, OIDC) instead of a token.

## 0.1.0 (2026-11-16)

First version.

- **Browsa API** credential: API key in `X-API-Key`, tested with `GET /v1/credits`.
- **Browsa** node, usable as an AI Agent tool:
  - Task > Run: plain-language task on a hosted tier (`browsa`, `browsa-fast`, `browsa-smart`) or your own model key, optional JSON output schema, waits for the result with a timeout or returns the job ID. Surfaces `outcome` and `outcome_message`.
  - Job > Get, with optional waiting.
  - Page > Scrape, Extract Data, Take Screenshot (binary PNG) and Crawl (one item per page).
