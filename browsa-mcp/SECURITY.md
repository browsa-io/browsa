# Security

## Report a vulnerability

Write to <security@browsa.io> with what you found and how to reproduce it. Please do not open a public issue for a vulnerability. Supported: the latest published version of `@browsa/mcp`.

## What leaves your machine

The server is a local process started by your MCP client. It talks to two hosts, both Browsa's, over HTTPS, and only when a tool that needs them is called.

| When | Where | What is sent |
|---|---|---|
| `detect_captcha` | nowhere | Nothing. The HTML, URL and resource list you pass are read in this process and dropped. No key is needed. |
| `captcha_allowance` | nowhere | Nothing. It reads counters kept in memory. |
| Startup, only when a tool of the `captcha_page` group is listed | `GET https://captcha.browsa.io/types` | Nothing about you: no key, no parameters. It fetches the public list of captcha types, once, and is not waited for. `BROWSA_CAPTCHA_CATALOGUE=bundled` stops it; the list bundled with the package is used instead. |
| `solve_captcha_on_page`, `solve_captcha_task` | `https://captcha.browsa.io` | Your API key and the task: the task type, the page's address (`websiteURL`), the site key, and the optional fields you or `detect_captcha` filled in (action, cdata, your proxy, a user agent), or the image for a picture task. The page's HTML is never sent, also when you pass `html` to `solve_captcha_on_page`: detection runs here and only the parameters go out. `solve_captcha_on_page` may also refresh the type list (the `GET` above), at most once an hour. |
| `list_captcha_types` | `GET https://captcha.browsa.io/types` | No key, no parameters. |
| `report_captcha_result` | `https://captcha.browsa.io` | Your API key, the task id and whether the site accepted the solution. |
| The nine core tools and the other groups | `https://browsa.io` | Your API key and the call's arguments (a URL to open, an action, a task text). Pages are loaded by the cloud browser, not by this process. |

What the server does not do:

- **No telemetry.** No analytics, no usage pings, no crash reports, no update checks. Every request is one of the rows above. Requests carry a `User-Agent` that names this package or the `browsa` SDK and its version, and nothing that identifies the machine.
- **It never touches your browser.** `solve_captcha_on_page` returns an expression or cookies; your own tools apply them.
- **It writes no files.** State (open cloud browsers, a flow being recorded, captcha spend and limits) is in memory and ends with the process.
- **It opens no port.** The transport is stdio.
- **Secrets by reference.** Saved secrets are typed by Browsa inside the cloud browser; their values never pass through this process or the model.

`BROWSA_BASE_URL` and `BROWSA_CAPTCHA_URL` point the server at other hosts (staging); leave them unset for the hosts above.

## The apply expression

`solve_captcha_on_page` returns JavaScript for you to evaluate in a page. It is built by this process from a fixed template (`src/captcha/apply.ts`) and three values: the solution token, and the callback name and field name read from the page's own markup. All three are embedded as JSON string literals, never as code. It sets the answer field, calls the page's own callback, and makes the widget's `getResponse` (and, for a v3 token, `execute`) answer the token. It makes no request and reads nothing else from the page. Read it before running it if you like: it is short.

## Keys and limits

- The API key is read from the environment and sent only to the two hosts above. It is never written to an answer, a log line or a file.
- Tokens in URLs (`token`, `key`, `session`, `code`, `signature`, ...) are masked as `***` in every tool answer.
- `BROWSA_CAPTCHA_MAX_CREDITS`, `BROWSA_CAPTCHA_RATE_PER_MINUTE` and `BROWSA_CAPTCHA_CONCURRENCY` bound what an agent can spend on captcha solves in one session. They are enforced in this process before any request is made. The workspace's own limits (its balance and its monthly spending limit) are enforced by Browsa and still apply.
- Set the local cap for agents you do not watch: it is the only limit that is per session.
