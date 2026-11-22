"""Receive captcha answers on your own endpoint (callback_url), standard library only.

Cost: 0 credits to run. Each solve sent with callback_url costs what the solve costs.

Run (behind a public https address, port 443 or 8443, that forwards to PORT):
    pip install browsa
    BROWSA_API_KEY=agt_live_... PORT=8080 python 06_captcha_callback_receiver.py

Then send a task with it:
    cap.solve(tasks.turnstile(url, site_key), callback_url="https://hooks.your-host.com/captcha")

The endpoint does three things:
  1. Host check, once per host: echo the "callback.verify" challenge.
  2. Check X-Browsa-Signature on every delivery (HMAC-SHA256, 5 minute window).
  3. De-duplicate on taskId: a delivery can arrive more than once.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from browsa import webhooks


def load_secret() -> str:
    """The hex secret callbacks are signed with: BROWSA_CALLBACK_SECRET, or asked from the API (free)."""
    secret = os.environ.get("BROWSA_CALLBACK_SECRET")
    if not secret:
        from browsa.captcha import CaptchaClient
        secret = CaptchaClient().callback_secret()
    return secret


SECRET = load_secret()
SEEN = set()  # task ids already handled; use a database in production


def handle(raw: bytes, signature: str):
    """(HTTP status, reply body) for one POST."""
    if not webhooks.verify_signature(raw, signature, SECRET):
        return 401, "bad signature"
    msg = json.loads(raw)
    if msg.get("type") == "callback.verify":
        return 200, json.dumps({"challenge": msg["challenge"]})
    task_id = msg.get("taskId")
    if task_id in SEEN:
        return 200, "duplicate"
    SEEN.add(task_id)
    if msg.get("errorId"):
        print(f"task {task_id} failed: {msg.get('errorCode')}", flush=True)
    else:
        print(f"task {task_id} solved: {msg.get('solution')} cost={msg.get('cost')}", flush=True)
    return 200, "ok"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))  # the raw bytes, before parsing
        status, body = handle(raw, self.headers.get("X-Browsa-Signature", ""))
        out = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json" if body.startswith("{") else "text/plain")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"listening on :{server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
