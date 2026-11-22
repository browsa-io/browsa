"""browsa.captcha: held calls (waitSeconds), cost on solutions, reports, the type catalogue,
against a local stand-in of the captcha API (stdlib HTTP server, no network)."""
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from browsa import webhooks
from browsa.captcha import AsyncCaptchaClient, CaptchaClient, CaptchaError, tasks
from browsa.captcha.compat import TwoCaptcha

KEY = "agt_live_test"
OK = {"errorId": 0, "errorCode": "", "errorDescription": ""}
COST = {"charged": True, "amount": 0.008, "unit": "credits", "credits": 0.008, "note": "Charged once, for this solve."}
SECRET = "ab" * 32


class FakeApi:
    """A server that holds getTaskResult for `hold` seconds when asked to wait, then answers ready."""

    def __init__(self):
        self.calls, self.reported, self.hold = [], {}, 1.1

    def handle(self, method, path, body):
        self.calls.append((method, path, body))
        if path == "/types":
            return {"errorId": 0, "types": [{"type": "ImageToTextTask", "status": "live", "required": [],
                                             "price": {"usdPer1000": 0.4, "creditsPerSolve": 0.004}, "measured": []}]}
        if body.get("clientKey") != KEY:
            return {"errorId": 1, "errorCode": "ERROR_KEY_DENIED_ACCESS", "errorDescription": "no", "fix": "Send your key.",
                    "charged": False}
        if path == "/createTask":
            return {**OK, "taskId": "t-1", **({"status": "processing"} if body.get("waitSeconds") else {})}
        if path == "/getTaskResult":
            if body.get("waitSeconds"):
                time.sleep(min(self.hold, body["waitSeconds"]))
            elif len([c for c in self.calls if c[1] == "/getTaskResult"]) < 2:
                return {**OK, "taskId": "t-1", "status": "processing"}
            return {**OK, "taskId": "t-1", "status": "ready", "solution": {"token": "0.cf"}, "cost": COST,
                    "solveSeconds": 6.42}
        if path in ("/reportCorrect", "/reportIncorrect"):
            tid = body["taskId"]
            if tid in self.reported:
                return {"errorId": 1, "errorCode": "ERROR_ALREADY_REPORTED", "taskId": tid, "charged": False,
                        "errorDescription": "this solve was already reported as incorrect and refunded.",
                        "fix": "Nothing to do: the first report stands, and a refund is made only once."}
            bad = path == "/reportIncorrect"
            self.reported[tid] = bad
            return {**OK, "taskId": tid, "status": "success", "outcome": "incorrect" if bad else "correct",
                    "refunded": bad, "refund": {"amount": 0.008 if bad else 0, "unit": "credits"}, "message": "Recorded."}
        if path == "/getCallbackSecret":
            return {**OK, "secret": SECRET}
        if path == "/rotateCallbackSecret":
            return {**OK, "secret": "cd" * 32, "rotated": True}
        return {"errorId": 1, "errorCode": "ERROR_BAD_REQUEST", "errorDescription": "unknown method"}


@pytest.fixture()
def api():
    fake = FakeApi()

    class H(BaseHTTPRequestHandler):
        def _answer(self, body):
            out = json.dumps(fake.handle(self.command, self.path, body)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def do_POST(self):
            self._answer(json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"))

        def do_GET(self):
            self._answer({})

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    fake.url = f"http://127.0.0.1:{srv.server_address[1]}"
    yield fake
    srv.shutdown()


def client(api, **kw):
    return CaptchaClient(KEY, base_url=api.url, **kw)


def test_solve_asks_the_api_to_hold_and_does_not_sleep_between_calls(api):
    cap = client(api, poll_interval=30)                     # a poll timer would make this test take 30 s
    t0 = time.monotonic()
    sol = cap.solve(tasks.turnstile("https://a.example", "0x4"))
    took = time.monotonic() - t0
    assert sol["token"] == "0.cf" and sol.task_id == "t-1"
    assert 1.0 < took < 5.0
    create, result = api.calls[0], api.calls[1]
    assert create[1] == "/createTask" and create[2]["waitSeconds"] == 20
    assert result[1] == "/getTaskResult" and result[2]["waitSeconds"] == 20
    assert len(api.calls) == 2


def test_the_wait_never_outlasts_the_http_timeout_or_the_deadline(api):
    cap = client(api, timeout=12)
    cap.solve(tasks.turnstile("https://a.example", "0x4"))
    assert api.calls[0][2]["waitSeconds"] == 7              # 12 s request, 5 s of margin
    api.calls.clear()
    client(api).solve(tasks.turnstile("https://a.example", "0x4"), timeout=4)
    assert api.calls[0][2]["waitSeconds"] <= 4


def test_wait_seconds_zero_polls_as_before(api):
    cap = client(api, wait_seconds=0, poll_interval=0.05)
    sol = cap.solve(tasks.turnstile("https://a.example", "0x4"))
    assert sol["token"] == "0.cf"
    assert all("waitSeconds" not in c[2] for c in api.calls)


def test_a_server_that_does_not_hold_is_polled_politely(api):
    api.hold = 0.0                                           # answers at once although asked to wait
    orig = api.handle

    def handle(method, path, body):
        if path == "/getTaskResult" and len([c for c in api.calls if c[1] == path]) < 3:
            api.calls.append((method, path, body))
            return {**OK, "taskId": "t-1", "status": "processing"}
        return orig(method, path, body)
    api.handle = handle
    cap = client(api, poll_interval=0.2)
    t0 = time.monotonic()
    cap.solve(tasks.turnstile("https://a.example", "0x4"))
    assert time.monotonic() - t0 >= 0.55                     # three sleeps, not a busy loop


def test_solution_carries_cost_and_time(api):
    sol = client(api).solve(tasks.turnstile("https://a.example", "0x4"))
    assert sol.cost == COST and sol.cost["charged"] is True
    assert sol.solve_seconds == 6.42
    assert dict(sol) == {"token": "0.cf"}                    # the solution itself is unchanged


def test_explicit_wait_on_the_raw_methods(api):
    cap = client(api)
    cap.create_task(tasks.turnstile("https://a.example", "0x4"), wait_seconds=10)
    body = api.calls[-1][2]
    assert body["waitSeconds"] == 10 and "callbackUrl" not in body
    cap.create_task(tasks.turnstile("https://a.example", "0x4"))
    assert "waitSeconds" not in api.calls[-1][2] and "callbackUrl" not in api.calls[-1][2]
    api.hold = 0.0
    assert cap.get_task_result("t-1", wait_seconds=5)["status"] == "ready"
    assert api.calls[-1][2] == {"clientKey": KEY, "taskId": "t-1", "waitSeconds": 5}


def test_report_incorrect_refunds_and_a_second_report_raises(api):
    cap = client(api)
    r = cap.report_incorrect("t-1")
    assert (r["outcome"], r["refunded"], r["refund"]["amount"]) == ("incorrect", True, 0.008)
    assert api.calls[-1][1:] == ("/reportIncorrect", {"clientKey": KEY, "taskId": "t-1"})
    with pytest.raises(CaptchaError) as e:
        cap.report_incorrect("t-1")
    assert e.value.code == "ERROR_ALREADY_REPORTED" and e.value.task_id == "t-1"
    assert e.value.charged is False and e.value.fix.startswith("Nothing to do")
    assert cap.report_correct("t-2")["outcome"] == "correct"
    assert cap.report("t-3", correct=False)["refunded"] is True


def test_errors_carry_fix_and_charged(api):
    with pytest.raises(CaptchaError) as e:
        CaptchaClient("agt_live_wrong", base_url=api.url).get_balance()
    assert (e.value.code, e.value.fix, e.value.charged) == ("ERROR_KEY_DENIED_ACCESS", "Send your key.", False)


def test_list_types_needs_no_key_in_the_request(api):
    types = client(api).list_types()
    assert types[0]["type"] == "ImageToTextTask" and types[0]["status"] == "live"
    method, path, body = api.calls[-1]
    assert (method, path, body) == ("GET", "/types", {})


def _sign(raw: bytes, secret_hex: str, t: int) -> str:
    """The service's signature (services/captcha-api README): key = the secret's bytes from hex,
    message = "<t>.<raw body>"."""
    import hashlib
    import hmac
    return f"t={t}, v1=" + hmac.new(bytes.fromhex(secret_hex), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()


def test_callback_url_is_sent_on_create_and_solve_and_only_when_given(api):
    cap = client(api)
    cap.create_task(tasks.turnstile("https://a.example", "0x4"), callback_url="https://hooks.example.com/c")
    assert api.calls[-1][2]["callbackUrl"] == "https://hooks.example.com/c"
    cap.create_task(tasks.turnstile("https://a.example", "0x4"))
    assert "callbackUrl" not in api.calls[-1][2]
    api.hold = 0
    api.calls.clear()
    sol = cap.solve(tasks.turnstile("https://a.example", "0x4"), callback_url="https://hooks.example.com/c")
    assert sol["token"] == "0.cf"
    created = [c for c in api.calls if c[1] == "/createTask"]
    assert len(created) == 1 and created[0][2]["callbackUrl"] == "https://hooks.example.com/c"
    assert all("callbackUrl" not in c[2] for c in api.calls if c[1] == "/getTaskResult")


def test_callback_secret_and_rotate_and_the_verifier_takes_the_hex_secret(api):
    cap = client(api)
    secret = cap.callback_secret()
    assert secret == SECRET and api.calls[-1][1:] == ("/getCallbackSecret", {"clientKey": KEY})
    raw = b'{"taskId":"t-1","status":"ready"}'
    t = int(time.time())
    header = _sign(raw, secret, t)
    assert webhooks.verify_signature(raw, header, secret)
    assert not webhooks.verify_signature(raw + b" ", header, secret)                 # body changed
    assert not webhooks.verify_signature(raw, _sign(raw, secret, t - 301), secret)   # older than 5 minutes
    new = cap.rotate_callback_secret()
    assert new == "cd" * 32 and api.calls[-1][1] == "/rotateCallbackSecret"
    assert not webhooks.verify_signature(raw, header, new)                           # signed with the old one


def test_a_receiver_echoes_the_challenge_and_drops_a_repeat(api):
    """The three jobs of a callback endpoint, as the README shows them."""
    secret, seen = SECRET, set()

    def handle(raw, headers):
        if not webhooks.verify_signature(raw, headers.get("X-Browsa-Signature", ""), secret):
            return 401, "bad signature"
        msg = json.loads(raw)
        if msg.get("type") == "callback.verify":
            return 200, json.dumps({"challenge": msg["challenge"]})
        if msg["taskId"] in seen:
            return 200, "duplicate"
        seen.add(msg["taskId"])
        return 200, "ok"

    t = int(time.time())
    verify = json.dumps({"type": "callback.verify", "challenge": "c-123"}).encode()
    assert handle(verify, {"X-Browsa-Signature": _sign(verify, secret, t)}) == (200, '{"challenge": "c-123"}')
    done = json.dumps({"errorId": 0, "taskId": "t-1", "status": "ready", "solution": {"token": "x"}}).encode()
    assert handle(done, {"X-Browsa-Signature": _sign(done, secret, t)}) == (200, "ok")
    assert handle(done, {"X-Browsa-Signature": _sign(done, secret, t)}) == (200, "duplicate")
    assert handle(done, {"X-Browsa-Signature": _sign(done, "ef" * 32, t)})[0] == 401  # another account's secret
    assert handle(done, {})[0] == 401


def test_twocaptcha_shim_report(api):
    solver = TwoCaptcha(KEY, base_url=api.url)
    assert solver.report("t-9", False)["refunded"] is True
    assert api.calls[-1][1] == "/reportIncorrect"
    assert solver.report("t-10", True)["outcome"] == "correct"


def test_async_client(api):
    async def go():
        async with AsyncCaptchaClient(KEY, base_url=api.url) as cap:
            sol = await cap.solve(tasks.turnstile("https://a.example", "0x4"))
            rep = await cap.report_incorrect(sol.task_id)
            types = await cap.list_types()
            await cap.create_task(tasks.turnstile("https://a.example", "0x4"), callback_url="https://h.example.com/c")
            sent = api.calls[-1][2].get("callbackUrl")
            return sol, rep, types, sent, await cap.callback_secret(), await cap.rotate_callback_secret()
    sol, rep, types, sent, secret, rotated = asyncio.run(go())
    assert sol.cost == COST and rep["outcome"] == "incorrect" and types
    assert (sent, secret, rotated) == ("https://h.example.com/c", SECRET, "cd" * 32)


def test_question_drag_and_box_builders():
    q = tasks.text_question("If tomorrow is Saturday, what day is today?", website_url="https://a.example/")
    assert q == {"type": "TextCaptchaTask", "comment": "If tomorrow is Saturday, what day is today?",
                 "websiteURL": "https://a.example/"}
    d = tasks.drag_drop(b"bg", [b"p1", "cDI="])
    assert d == {"type": "DragDropTask", "body": "Ymc=", "pieces": ["cDE=", "cDI="]}
    b = tasks.bounding_box("aW1n", "the red car", many=True)
    assert b == {"type": "BoundingBoxTask", "body": "aW1n", "comment": "the red car", "many": True}
    assert "many" not in tasks.bounding_box("aW1n", "the red car")
    for bad in (lambda: tasks.text_question(" "), lambda: tasks.drag_drop("bg", []),
                lambda: tasks.drag_drop("bg", ["p"] * 7), lambda: tasks.drag_drop("bg", "one-string"),
                lambda: tasks.bounding_box("aW1n", "")):
        with pytest.raises(ValueError):
            bad()
    assert {"TextCaptchaTask", "DragDropTask", "BoundingBoxTask"} <= set(tasks.TASK_TYPES)


def test_missing_key_message_names_the_variable_and_where_to_create_a_key(monkeypatch):
    monkeypatch.delenv("BROWSA_API_KEY", raising=False)
    with pytest.raises(ValueError) as e:
        CaptchaClient()
    assert "BROWSA_API_KEY" in str(e.value) and "Create a key at https://app.browsa.io/dashboard/keys" in str(e.value)


def test_new_builders_use_the_catalogue_names():
    v3 = tasks.geetest_slide_v3(b"\x89PNG-bg", b"\x89PNG-full", css_width=260)
    assert (v3["type"], v3["version"], v3["cssWidth"]) == ("GeeTestSlide", 3, 260) and "shuffled" not in v3
    assert tasks.geetest_slide_v3("a", "b", shuffled=False)["shuffled"] is False
    v4 = tasks.geetest_slide_v4("a", "b", top=80, bg_css_width=300, slice_css_width=60)
    assert v4 == {"type": "GeeTestSlide", "version": 4, "imageBackground": "a", "imageSlice": "b", "top": 80,
                  "bgCssWidth": 300, "sliceCssWidth": 60}
    cf = tasks.cloudflare_challenge("https://a.example/", {"host": "203.0.113.7", "port": 8080}, user_agent="UA")
    assert cf == {"type": "AntiCloudflareTask", "websiteURL": "https://a.example/", "proxy": "http://203.0.113.7:8080",
                  "userAgent": "UA"}
    with pytest.raises(ValueError):
        tasks.cloudflare_challenge("https://a.example/", None)
    assert {"GeeTestSlide", "AntiCloudflareTask"} <= set(tasks.TASK_TYPES)
    assert tasks.normalize_task({"type": "anticloudflaretask", "proxy": "http://h:1"})["type"] == "AntiCloudflareTask"


# The 31 types GET https://captcha.browsa.io/types listed as live on 2026-11-22.
LIVE_20261122 = {
    "ImageToTextTask", "ReCaptchaV2Classification", "AwsWafClassification", "GeeTestSlide", "RotateTask",
    "ClickOrderTask", "GeeTestGridTask", "GeeTestIconTask", "GeeTestNineTask", "GeeTestShapeTask", "SliderGapTask",
    "TileSwapTask", "JigsawTask", "MtCaptchaTask", "CyberSiaraTask", "AudioTask", "HCaptchaTask", "TextCaptchaTask",
    "BoundingBoxTask", "DragDropTask", "AntiTurnstileTaskProxyLess", "AntiTurnstileTask", "ReCaptchaV3TaskProxyLess",
    "ReCaptchaV3Task", "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask", "ReCaptchaV2TaskProxyLess",
    "ReCaptchaV2Task", "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask", "AntiCloudflareTask",
}


def test_task_types_know_every_type_live_on_22_november():
    assert len(LIVE_20261122) == 31
    assert LIVE_20261122 <= set(tasks.TASK_TYPES)
    assert len(set(tasks.TASK_TYPES)) == len(tasks.TASK_TYPES)
    for t in ("HCaptchaTask", "AudioTask"):
        assert tasks.normalize_task({"type": t.lower()})["type"] == t
