# Examples

Ten small scripts for [Browsa](https://browsa.io). Each one states its credit cost at the top.

You need a Browsa API key: create one at <https://app.browsa.io/dashboard/keys>. New accounts get 100 free credits after email verification, no card.

| File | Language | What it does | Cost in credits |
|---|---|---|---|
| [`01_run_task.py`](01_run_task.py) | Python | Run an agent task on the hosted model | about 8 (capped at 10) |
| [`02_scrape_page.py`](02_scrape_page.py) | Python | A page as Markdown | 1 per page |
| [`03_extract_json.py`](03_extract_json.py) | Python | JSON from a page, with a JSON Schema (your Anthropic key runs the extraction) | 1 per page |
| [`04_screenshot.py`](04_screenshot.py) | Python | A PNG screenshot saved to a file | 1 per page |
| [`05_solve_turnstile.py`](05_solve_turnstile.py) | Python | Solve a Turnstile captcha, report the result | 0.008 per solved token |
| [`06_captcha_callback_receiver.py`](06_captcha_callback_receiver.py) | Python | Endpoint for captcha callbacks: host check, signature, duplicates | 0 |
| [`07_run_task.ts`](07_run_task.ts) | TypeScript | Run an agent task on the hosted model | about 8 (capped at 10) |
| [`08_balance_and_models.ts`](08_balance_and_models.ts) | TypeScript | Credit balance and hosted model tiers | 0 |
| [`09_text_question_captcha.ts`](09_text_question_captcha.ts) | TypeScript | Answer a captcha question asked in words | 0.004 per solved question |
| [`10_webhook_receiver.ts`](10_webhook_receiver.ts) | TypeScript | Endpoint for webhooks, with signature check | 0 |

A failed task or a failed captcha solve is not charged. Live prices: <https://browsa.io/pricing> and `GET https://captcha.browsa.io/types`.

## Run

```bash
export BROWSA_API_KEY=agt_live_...

pip install "browsa>=0.7.1"
python 02_scrape_page.py

npm i browsa@latest                  # 0.7.1 or newer
node 08_balance_and_models.ts        # Node 22.18 or newer; on older Node: npx tsx 08_balance_and_models.ts
```

Run the TypeScript files from this folder: its `package.json` sets `"type": "module"`. In a project of your own, set that too or save the file as `.mts`.

No script signs in anywhere or places an order. They open public pages only.

## Tests

The tests run every script against a local stand-in of the API. No key, no network, no credits.

```bash
pip install -e ../browsa-python pytest
(cd ../browsa-ts && npm ci && npm run build)
npm install --no-save ../browsa-ts
python -m pytest -q tests
```
