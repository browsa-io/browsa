# Changelog

## 0.1.1 (2026-11-16)

- The npm package no longer includes the TypeScript build cache (`tsconfig.tsbuildinfo`, 95 kB). No change to the node.
- First release published through npm's trusted publisher (GitHub Actions, OIDC) instead of a token.

## 0.1.0 (2026-11-16)

First version.

- **Browsa API** credential: API key in `X-API-Key`, tested with `GET /v1/credits`.
- **Browsa** node, usable as an AI Agent tool:
  - Task > Run: plain-language task on a hosted tier (`browsa`, `browsa-fast`, `browsa-smart`) or your own model key, optional JSON output schema, waits for the result with a timeout or returns the job ID. Surfaces `outcome` and `outcome_message`.
  - Job > Get, with optional waiting.
  - Page > Scrape, Extract Data, Take Screenshot (binary PNG) and Crawl (one item per page).
