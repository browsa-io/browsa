# capbench

Runs a fixed set of public captcha test pages against any browser that speaks CDP, and prints per captcha type: attempts, passes, and the median seconds of a pass. It is the script behind [browsa.io/captcha](https://browsa.io/captcha).

It solves nothing itself. It does what a person does before a puzzle appears: one click on a checkbox or "verify" button, then submit. If the browser's vendor has a built-in solver, that solver is free to act, so the result shows what that browser gets through.

## Run

```bash
npm install

# Any vendor: pass the CDP websocket of a running browser
CDP_URL=wss://... node capbench.js

# Browsa: a fresh browser for every attempt
BROWSA_API_KEY=... node capbench.js
BROWSA_API_KEY=... PROXY=socks5://user:pass@host:port node capbench.js
```

| Variable | Default | Meaning |
|---|---|---|
| `ROUNDS` | 5 | attempts per target |
| `ONLY`, `SKIP` | | comma-separated target ids |
| `OUT` | `.` | folder for the results JSON and failure screenshots |
| `LABEL` | `run` | name of the results file |
| `SHARED` | | `1` runs all targets of a round in one browser |

## What counts

| Result | Meaning |
|---|---|
| `pass` | the site's server accepted it: a success page, a score, or the protected page loaded |
| `token` | a token was issued, but the test page has no server-side check to confirm it |
| `challenge` | a puzzle was shown and nothing solved it |
| `blocked` | the test page refused the browser outright |
| `fail`, `error` | submitted and rejected, or the run broke |

Only `pass` is a pass. Rows marked `*` in the summary are test pages without a server-side check.

## Limits

- With `CDP_URL` the script cannot create browsers, so one browser runs every target of a round and later targets see the cookies of earlier ones. Say so when you publish numbers from that mode.
- The targets are third-party test pages and change without notice. A row that starts returning `error` usually means the page changed, not the browser.
- DataDome and press-and-hold checks have no neutral test page. The DataDome row loads a site protected by it; press-and-hold is not in this script.
- Results depend on the address the browser leaves from. Publish the exit (data center, residential, country) with every number.
- The click uses raw mouse input. It never calls Playwright's `locator.click()` or `fill()`, which dispatch marker events a page can listen for.

## Targets

`recaptcha_v2_checkbox`, `recaptcha_v2_invisible`, `recaptcha_v3_score`, `recaptcha_enterprise_v2`, `hcaptcha_official`, `hcaptcha_enterprise`, `turnstile_form`, `turnstile_noninteractive`, `turnstile_invisible`, `cloudflare_challenge`, `datadome_site`, `aws_waf`, `friendly_captcha`, `image_text`.
