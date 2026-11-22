"""Runs every example as a subprocess against a local stand-in of the Browsa API and the captcha
API. No key, no network, no credits.

    pip install -e ../browsa-python pytest
    (cd ../browsa-ts && npm ci && npm run build) && npm install --no-save ../browsa-ts
    python -m pytest -q tests

The TypeScript examples need Node 22.18 or newer and `node_modules/browsa`; without them those
tests are skipped, except on CI (env CI set), where they fail.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent
KEY = "agt_test_examples"
SECRET = "ab" * 32
JOB_ID = "11111111-2222-3333-4444-555555555555"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
COST = {"charged": True, "amount": 0.008, "unit": "credits", "credits": 0.008, "note": "Charged once, for this solve."}
OK = {"errorId": 0, "errorCode": "", "errorDescription": ""}

EXAMPLES = sorted(p.name for p in HERE.iterdir() if re.match(r"\d\d_.+\.(py|ts)$", p.name))


# ── The stand-in API ─────────────────────────────────────────────────────


def job(status: str) -> dict:
    done = status == "completed"
    return {
        "id": JOB_ID, "status": status, "kind": "task", "step_count": 3 if done else 0,
        "progress_done": 3 if done else 0, "progress_total": 5,
        "outcome": "completed" if done else None, "credits_charged": 8 if done else None,
        "live_url": None if done else "https://browsa.io/live/abc",
        "result": {"final_result": "Example story title"} if done else None,
    }


def answer(method: str, path: str, body: dict, headers) -> tuple:
    """(HTTP status, JSON) for one request, in the shapes the SDK tests use."""
    if path.startswith("/v1/"):
        if headers.get("X-API-Key") != KEY:
            return 401, {"code": "UNAUTHORIZED", "error": "bad key"}
        if (method, path) == ("POST", "/v1/tasks"):
            return 202, job("queued")
        if method == "GET" and path == f"/v1/jobs/{JOB_ID}":
            return 200, job("completed")
        # The quick calls answer as production did on 2026-11-21: scrape gives `html` unless a format
        # is asked for; extract gives `data` with a model key and the page `text` + `schema` without.
        if (method, path) == ("POST", "/v1/quick/scrape"):
            page = {"url": body["url"], "http_status": 200, "cost_credits": 1, "duration_ms": 1200, "blocked": False,
                    "agent_id": "agt_example", "exit": {"network": "browsa", "attempts": 1}}
            if "markdown" in (body.get("formats") or []):
                page["markdown"] = "# Example Domain\n\nThis domain is for use in examples."
            else:
                page["html"] = "<html><body><h1>Example Domain</h1></body></html>"
            return 200, page
        if (method, path) == ("POST", "/v1/quick/extract"):
            out = {"url": body["url"], "cost_credits": 1, "duration_ms": 3600, "blocked": False}
            if body.get("llm_api_key") or body.get("llm_key_id"):
                out["data"] = {"books": [{"title": "A Light in the Attic", "price": "£51.77"}]}
            else:
                out.update(text="A Light in the Attic £51.77 Tipping the Velvet £53.74", schema=body.get("schema"))
            return 200, out
        if (method, path) == ("POST", "/v1/quick/screenshot"):
            return 200, {"url": body["url"], "http_status": 200, "cost_credits": 1,
                         "screenshot_png_b64": base64.b64encode(PNG).decode()}
        if (method, path) == ("GET", "/v1/credits"):
            return 200, {"balance": 92, "packs": []}
        if (method, path) == ("GET", "/v1/models"):
            return 200, {"hosted": [
                {"id": "browsa", "model": "model-a", "fallback_models": [], "reasoning": "low",
                 "credits_per_task": 5, "default": True},
                {"id": "browsa-fast", "model": "model-b", "fallback_models": [], "reasoning": None,
                 "credits_per_task": 5},
            ], "own_key": {"providers": ["anthropic", "openai", "google"], "default_models": {}}}
        return 404, {"code": "NOT_FOUND", "error": f"no mock for {method} {path}"}

    # the captcha API: always HTTP 200, errorId 0 or 1
    if path == "/types":
        return 200, {"errorId": 0, "types": []}
    if body.get("clientKey") != KEY:
        return 200, {"errorId": 1, "errorCode": "ERROR_KEY_DENIED_ACCESS", "errorDescription": "no", "charged": False}
    if path == "/createTask":
        task = body.get("task") or {}
        if task.get("type") == "TextCaptchaTask":
            return 200, {**OK, "taskId": "t-text", "status": "ready",
                         "solution": {"text": "Friday", "alternatives": ["friday"]},
                         "cost": {**COST, "amount": 0.004, "credits": 0.004}, "solveSeconds": 1.2}
        return 200, {**OK, "taskId": "t-turnstile", "status": "ready",
                     "solution": {"token": "0." + "x" * 60, "type": "turnstile"}, "cost": COST, "solveSeconds": 6.42}
    if path in ("/reportCorrect", "/reportIncorrect"):
        bad = path == "/reportIncorrect"
        return 200, {**OK, "taskId": body["taskId"], "status": "success", "outcome": "incorrect" if bad else "correct",
                     "refunded": bad, "refund": {"amount": 0.008 if bad else 0, "unit": "credits"}, "message": "Recorded."}
    if path == "/getCallbackSecret":
        return 200, {**OK, "secret": SECRET}
    return 200, {"errorId": 1, "errorCode": "ERROR_BAD_REQUEST", "errorDescription": "unknown method"}


class Mock:
    def __init__(self):
        self.calls = []
        mock = self

        class H(BaseHTTPRequestHandler):
            def _do(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                body = json.loads(raw) if raw else {}
                path = self.path.split("?")[0]
                mock.calls.append((self.command, path, body, self.headers.get("X-API-Key")))
                status, out = answer(self.command, path, body, self.headers)
                data = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _do

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def last(self, path: str):
        return next(c for c in reversed(self.calls) if c[1] == path)


@pytest.fixture()
def mock():
    m = Mock()
    yield m
    m.srv.shutdown()


# ── Running an example ───────────────────────────────────────────────────


def node_problem() -> str | None:
    """Why the TypeScript examples cannot run here, or None."""
    node = shutil.which("node")
    if not node:
        return "node is not installed"
    v = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v")
    if tuple(int(x) for x in v.split(".")[:2]) < (22, 18):
        return f"node {v} cannot run .ts files (22.18 or newer needed)"
    if not (HERE / "node_modules" / "browsa" / "dist" / "index.js").exists():
        return "node_modules/browsa is missing: build ../browsa-ts, then `npm install --no-save ../browsa-ts`"
    return None


def command(name: str) -> list:
    if name.endswith(".py"):
        return [sys.executable, str(HERE / name)]
    problem = node_problem()
    if problem:
        if os.environ.get("CI"):
            pytest.fail(problem)
        pytest.skip(problem)
    return ["node", str(HERE / name)]


def env_for(mock_url: str, **extra: str) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("BROWSA_")}
    env.update(BROWSA_API_KEY=KEY, BROWSA_BASE_URL=mock_url, BROWSA_CAPTCHA_URL=mock_url, NO_COLOR="1",
               NODE_NO_WARNINGS="1", **extra)
    return env


def run(name: str, mock: Mock, *args: str, cwd=None, **extra_env: str) -> str:
    env = env_for(mock.url, **extra_env)
    if "ANTHROPIC_API_KEY" not in extra_env:
        env.pop("ANTHROPIC_API_KEY", None)        # the developer's own key never reaches an example
    r = subprocess.run(command(name) + list(args), env=env, capture_output=True, text=True,
                       timeout=60, cwd=cwd or HERE)
    assert r.returncode == 0, f"{name} exited {r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    return r.stdout


# ── The examples ─────────────────────────────────────────────────────────


def test_there_are_ten_examples_in_both_languages():
    assert len(EXAMPLES) == 10, EXAMPLES
    assert [n[:2] for n in EXAMPLES] == [f"{i:02d}" for i in range(1, 11)]
    assert any(n.endswith(".py") for n in EXAMPLES) and any(n.endswith(".ts") for n in EXAMPLES)


@pytest.mark.parametrize("name", EXAMPLES)
def test_header_states_the_cost_and_the_readme_lists_it(name):
    text = (HERE / name).read_text()
    header = text.split('"""')[1] if name.endswith(".py") else "\n".join(
        line for line in text.splitlines()[:20] if line.startswith("//"))
    assert re.search(r"^(// )?Cost: .*\d.*credit", header, re.M), f"{name}: no `Cost:` line with a number of credits"
    assert "BROWSA_" in header and name in header, f"{name}: the header does not say how to run it"
    row = next((line for line in (HERE / "README.md").read_text().splitlines() if f"`{name}`" in line), None)
    assert row and row.count("|") == 5, f"{name} is not in the README table"
    assert "chromium" not in text.lower()


@pytest.mark.parametrize("name", ["01_run_task.py", "07_run_task.ts"])
def test_run_task(mock, name):
    out = run(name, mock)
    assert "status: completed | outcome: completed" in out
    assert "result: Example story title" in out and "credits charged: 8" in out
    method, path, body, key = mock.last("/v1/tasks")
    assert key == KEY and body["llm"] == "browsa" and body["max_steps"] == 5 and body["max_credits"] == 10
    assert any(c[1] == f"/v1/jobs/{JOB_ID}" for c in mock.calls)


def test_scrape_page(mock):
    out = run("02_scrape_page.py", mock, "https://example.com/")
    assert "HTTP 200 | blocked: False" in out and "# Example Domain" in out and "credits: 1" in out
    assert mock.last("/v1/quick/scrape")[2:] == ({"url": "https://example.com/", "formats": ["markdown"]}, KEY)


def test_extract_json(mock):
    out = run("03_extract_json.py", mock, ANTHROPIC_API_KEY="sk-ant-example")
    assert json.loads(out[:out.rindex("credits:")])["books"][0]["title"] == "A Light in the Attic"
    body = mock.last("/v1/quick/extract")[2]
    assert body["url"] == "https://books.toscrape.com/" and body["schema"]["required"] == ["books"]
    assert body["llm_api_key"] == "sk-ant-example"


def test_extract_json_without_a_model_key_prints_the_page_text(mock):
    out = run("03_extract_json.py", mock)
    assert "No model key was given" in out and "A Light in the Attic" in out and "credits: 1" in out
    assert "llm_api_key" not in mock.last("/v1/quick/extract")[2]


def test_screenshot(mock, tmp_path):
    out = run("04_screenshot.py", mock, "https://example.com/", str(tmp_path / "shot.png"))
    assert (tmp_path / "shot.png").read_bytes() == PNG and f"({len(PNG)} bytes)" in out
    assert mock.last("/v1/quick/screenshot")[2] == {"url": "https://example.com/", "full_page": True}


def test_solve_turnstile_and_report(mock):
    out = run("05_solve_turnstile.py", mock)
    assert "token: 0.xxx" in out and "task: t-turnstile" in out and "'amount': 0.008" in out
    assert "--report correct or --report incorrect" in out
    task = mock.last("/createTask")[2]["task"]
    assert task == {"type": "AntiTurnstileTaskProxyLess", "websiteURL": "https://captcha-check.browsa.io/",
                    "websiteKey": "0x4AAAAAAGEprtbosKnaIPao"}
    assert not any(c[1].startswith("/report") for c in mock.calls)      # nothing is reported unasked

    out = run("05_solve_turnstile.py", mock, "--report", "incorrect", "--url", "https://a.example/", "--key", "0x4")
    assert "reported: incorrect | refunded: True" in out
    assert mock.last("/reportIncorrect")[2] == {"clientKey": KEY, "taskId": "t-turnstile"}
    assert mock.last("/createTask")[2]["task"]["websiteURL"] == "https://a.example/"


def test_balance_and_models(mock):
    out = run("08_balance_and_models.ts", mock)
    assert "balance: 92 credits" in out
    assert "browsa (default): model-a, +5 credits per task" in out and "browsa-fast: model-b" in out
    assert "own key providers: anthropic, openai, google" in out
    assert {c[1] for c in mock.calls} == {"/v1/credits", "/v1/models"} and all(c[3] == KEY for c in mock.calls)


def test_text_question_captcha(mock):
    out = run("09_text_question_captcha.ts", mock, "What is two plus two?")
    assert "answer: Friday (also: friday)" in out and "task: t-text" in out and '"amount":0.004' in out
    assert mock.last("/createTask")[2]["task"] == {"type": "TextCaptchaTask", "comment": "What is two plus two?"}
    assert mock.last("/createTask")[2]["clientKey"] == KEY


# ── The two receivers ────────────────────────────────────────────────────


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Receiver:
    """An example server started on a free port; `post` sends it one request."""

    def __init__(self, name: str, mock: Mock, **env: str):
        self.port = free_port()
        self.proc = subprocess.Popen(command(name), env=env_for(mock.url, PORT=str(self.port), **env), cwd=HERE,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.monotonic() + 20
        while True:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                break
            except OSError:
                if self.proc.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError(f"{name} did not start:\n{self.stop()}")
                time.sleep(0.05)

    def post(self, raw: bytes, headers: dict) -> tuple:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/hook", data=raw, method="POST",
                                     headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def stop(self) -> str:
        if self.proc.poll() is None:
            self.proc.terminate()
        try:
            return self.proc.communicate(timeout=10)[0]
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.communicate()[0]


def sign(raw: bytes, secret_hex: str = SECRET, age: int = 0) -> str:
    """The services' signature: HMAC-SHA256, key = the secret's bytes from hex, message = "<t>.<raw body>"."""
    t = int(time.time()) - age
    return f"t={t}, v1=" + hmac.new(bytes.fromhex(secret_hex), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()


@pytest.mark.parametrize("secret_from", ["env", "api"])
def test_captcha_callback_receiver(mock, secret_from):
    env = {"BROWSA_CALLBACK_SECRET": SECRET} if secret_from == "env" else {}
    rx = Receiver("06_captcha_callback_receiver.py", mock, **env)
    try:
        if secret_from == "api":                                       # asked from the API when not given
            assert mock.last("/getCallbackSecret")[2] == {"clientKey": KEY}
        verify = json.dumps({"type": "callback.verify", "challenge": "c-123"}).encode()
        status, body = rx.post(verify, {"X-Browsa-Signature": sign(verify), "X-Browsa-Event": "callback.verify"})
        assert status == 200 and json.loads(body) == {"challenge": "c-123"}
        done = json.dumps({"errorId": 0, "taskId": "t-1", "status": "ready", "solution": {"token": "tok"},
                           "cost": COST, "solveSeconds": 6.4}).encode()
        assert rx.post(done, {"X-Browsa-Signature": sign(done)}) == (200, "ok")
        assert rx.post(done, {"X-Browsa-Signature": sign(done)}) == (200, "duplicate")
        assert rx.post(done, {"X-Browsa-Signature": sign(done, "ef" * 32)})[0] == 401     # another secret
        assert rx.post(done, {"X-Browsa-Signature": sign(done, age=301)})[0] == 401        # too old
        assert rx.post(done, {})[0] == 401
        failed = json.dumps({"errorId": 1, "errorCode": "ERROR_CAPTCHA_UNSOLVABLE", "taskId": "t-2"}).encode()
        assert rx.post(failed, {"X-Browsa-Signature": sign(failed)}) == (200, "ok")
    finally:
        out = rx.stop()
    assert out.count("task t-1 solved") == 1 and "task t-2 failed: ERROR_CAPTCHA_UNSOLVABLE" in out


def test_webhook_receiver(mock):
    rx = Receiver("10_webhook_receiver.ts", mock, BROWSA_WEBHOOK_SECRET=SECRET)
    try:
        event = json.dumps({"type": "job.completed", "job_id": JOB_ID, "job_kind": "task"}).encode()
        status, body = rx.post(event, {"X-Agents-Signature": sign(event)})
        assert status == 200 and json.loads(body) == {"ok": True}
        assert rx.post(event + b" ", {"X-Agents-Signature": sign(event)})[0] == 401        # body changed
        assert rx.post(event, {"X-Agents-Signature": sign(event, "ef" * 32)})[0] == 401
        assert rx.post(event, {})[0] == 401
    finally:
        out = rx.stop()
    assert out.count(f"event=job.completed job={JOB_ID} error=none") == 1


def test_webhook_receiver_needs_its_secret(mock):
    r = subprocess.run(command("10_webhook_receiver.ts"), env=env_for(mock.url), capture_output=True, text=True,
                       timeout=30, cwd=HERE)
    assert r.returncode == 2 and "BROWSA_WEBHOOK_SECRET" in r.stderr
