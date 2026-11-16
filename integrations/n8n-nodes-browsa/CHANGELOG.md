# Changelog

## 0.1.0 (unreleased)

First version.

- **Browsa API** credential: API key in `X-API-Key`, tested with `GET /v1/credits`.
- **Browsa** node, usable as an AI Agent tool:
  - Task > Run: plain-language task on a hosted tier (`browsa`, `browsa-fast`, `browsa-smart`) or your own model key, optional JSON output schema, waits for the result with a timeout or returns the job ID. Surfaces `outcome` and `outcome_message`.
  - Job > Get, with optional waiting.
  - Page > Scrape, Extract Data, Take Screenshot (binary PNG) and Crawl (one item per page).
