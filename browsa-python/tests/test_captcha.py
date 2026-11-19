"""browsa.captcha against a local stand-in of the captcha API (stdlib HTTP server, no network)."""
import asyncio
import json
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from browsa import captcha, errors
from browsa.captcha import CaptchaClient, CaptchaError, CaptchaTimeoutError, tasks
from browsa.captcha.compat import ApiException, TwoCaptcha, ValidationException, use_with_anticaptcha

KEY = "agt_live_test"


class FakeApi:
    """createTask / getTaskResult / getBalance with the real API's answer shapes."""

    def __init__(self):
        self.calls = []
        self.polls = {}
        self.ready_after = 1   # token tasks: polls answered "processing" first

    def handle(self, path, body):
        self.calls.append((path, body))
        if body.get("clientKey") != KEY:
            return {"errorId": 1, "errorCode": "ERROR_KEY_DENIED_ACCESS", "errorDescription": "clientKey is missing or invalid"}
        if path == "/getBalance":
            return {"errorId": 0, "errorCode": "", "errorDescription": "", "balance": 4.2}
        if path == "/createTask":
            t = body["task"]
            if t["type"] == "ImageToTextTask":
                return {"errorId": 0, "errorCode": "", "errorDescription": "", "taskId": "t-img", "status": "ready",
                        "solution": {"text": "x7Kp2"}}
            if t["type"] not in tasks.TOKEN_TYPES:
                return {"errorId": 1, "errorCode": "ERROR_TASK_NOT_SUPPORTED", "errorDescription": f"task type {t['type']!r} is not supported"}
            if t.get("websiteKey") == "bad":
                tid = "t-bad"
            else:
                tid = "t-" + t["type"]
            self.polls[tid] = 0
            return {"errorId": 0, "errorCode": "", "errorDescription": "", "taskId": tid}
        if path == "/getTaskResult":
            tid = body.get("taskId")
            if tid == "t-img":
                return {"errorId": 0, "errorCode": "", "errorDescription": "", "taskId": tid, "status": "ready", "solution": {"text": "x7Kp2"}}
            if tid not in self.polls:
                return {"errorId": 1, "errorCode": "ERROR_TASKID_INVALID", "errorDescription": "task not found"}
            self.polls[tid] += 1
            if self.polls[tid] <= self.ready_after:
                return {"errorId": 0, "errorCode": "", "errorDescription": "", "taskId": tid, "status": "processing"}
            if tid == "t-bad":
                return {"errorId": 1, "errorCode": "ERROR_CAPTCHA_UNSOLVABLE", "errorDescription": "no token", "taskId": tid}
            if "Turnstile" in tid:
                sol = {"token": "0.cf-token", "type": "turnstile", "userAgent": "UA"}
            else:
                sol = {"gRecaptchaResponse": "03AF-token", "userAgent": "UA", "createTime": 1}
            return {"errorId": 0, "errorCode": "", "errorDescription": "", "taskId": tid, "status": "ready", "solution": sol}
        return {"errorId": 1, "errorCode": "ERROR_BAD_REQUEST", "errorDescription": "unknown method"}


@pytest.fixture()
def api():
    fake = FakeApi()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/html":
                out, ctype = b"<html>not found</html>", "text/html"
            else:
                out, ctype = json.dumps(fake.handle(self.path, body)).encode(), "application/json"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    fake.url = f"http://127.0.0.1:{srv.server_address[1]}"
    yield fake
    srv.shutdown()


def client(api, **kw):
    return CaptchaClient(KEY, base_url=api.url, poll_interval=0.01, **kw)


# ── builders and aliases ─────────────────────────────────────────────────


def test_builders_pick_proxyless_without_a_proxy():
    t = tasks.recaptcha_v2("https://a.example/x", "6Lk", invisible=True)
    assert t == {"type": "ReCaptchaV2TaskProxyLess", "websiteURL": "https://a.example/x", "websiteKey": "6Lk", "isInvisible": True}
    t = tasks.recaptcha_v3("https://a.example", "6Lk", page_action="login", enterprise=True,
                           proxy={"type": "http", "host": "1.2.3.4", "port": 8080, "username": "u", "password": "p:w"})
    assert t["type"] == "ReCaptchaV3EnterpriseTask"
    assert t["proxy"] == "http://u:p%3Aw@1.2.3.4:8080"
    assert t["pageAction"] == "login"
    t = tasks.turnstile("https://a.example", "0x4", action="signup", cdata="c1")
    assert t == {"type": "AntiTurnstileTaskProxyLess", "websiteURL": "https://a.example", "websiteKey": "0x4",
                 "metadata": {"action": "signup", "cdata": "c1"}}


def test_image_builders_encode_bytes():
    t = tasks.image_to_text(b"\x89PNG..", module="common")
    assert t["type"] == "ImageToTextTask" and t["body"] == "iVBORy4u" and t["module"] == "common"
    assert tasks.image_to_text([b"a", "Yg=="])["images"] == ["YQ==", "Yg=="]
    g = tasks.recaptcha_v2_classification(b"img", "/m/015qff", size=3)
    assert g == {"type": "ReCaptchaV2Classification", "image": "aW1n", "question": "/m/015qff", "size": 3}
    assert tasks.aws_waf_classification([b"a"], "bed")["question"] == "aws:grid:bed"
    assert tasks.slider(b"bg", b"pc") == {"type": "VisionEngine", "module": "slider_1", "imageBackground": "Ymc=", "image": "cGM="}
    with pytest.raises(ValueError):
        tasks.recaptcha_v2_classification(b"x", "/m/0k4j", size=2)
    with pytest.raises(ValueError):
        tasks.recaptcha_v2("", "k")


@pytest.mark.parametrize("given,proxy,expected", [
    ("RecaptchaV2TaskProxyless", False, "ReCaptchaV2TaskProxyLess"),     # Anti-Captcha, 2Captcha v2
    ("NoCaptchaTaskProxyless", False, "ReCaptchaV2TaskProxyLess"),       # older Anti-Captcha / CapMonster
    ("RecaptchaV2Task", False, "ReCaptchaV2TaskProxyLess"),              # CapMonster without a proxy
    ("RecaptchaV2Task", True, "ReCaptchaV2Task"),
    ("RecaptchaV3TaskProxyless", False, "ReCaptchaV3TaskProxyLess"),
    ("RecaptchaV3EnterpriseTask", False, "ReCaptchaV3EnterpriseTaskProxyLess"),
    ("TurnstileTaskProxyless", False, "AntiTurnstileTaskProxyLess"),
    ("TurnstileTask", False, "AntiTurnstileTaskProxyLess"),
    ("TurnstileTask", True, "AntiTurnstileTask"),
    ("ReCaptchaV2TaskProxyLess", False, "ReCaptchaV2TaskProxyLess"),     # CapSolver: as it is
    ("imagetotexttask", False, "ImageToTextTask"),
    ("FunCaptchaTaskProxyless", False, "FunCaptchaTaskProxyless"),       # unknown: left for the server to refuse
])
def test_normalize_task(given, proxy, expected):
    t = {"type": given, "websiteURL": "https://a.example", "websiteKey": "k"}
    if proxy:
        t.update(proxyType="http", proxyAddress="1.2.3.4", proxyPort=8080)
    assert tasks.normalize_task(t)["type"] == expected


def test_normalize_moves_turnstile_fields_and_keeps_cloudflare_tasks():
    t = tasks.normalize_task({"type": "TurnstileTask", "websiteURL": "u", "websiteKey": "k", "pageAction": "a", "data": "c"})
    assert t["metadata"] == {"action": "a", "cdata": "c"} and "pageAction" not in t and "data" not in t
    cf = {"type": "TurnstileTask", "cloudflareTaskType": "cf_clearance", "websiteURL": "u", "websiteKey": "k"}
    assert tasks.normalize_task(cf) == cf


# ── client ───────────────────────────────────────────────────────────────


def test_recognition_answered_in_create_task(api):
    sol = client(api).solve(tasks.image_to_text(b"\x89PNG"))
    assert sol == {"text": "x7Kp2"} and sol.task_id == "t-img"
    assert [c[0] for c in api.calls] == ["/createTask"]
    assert api.calls[0][1]["clientKey"] == KEY


def test_token_task_polled_until_ready(api):
    api.ready_after = 2
    sol = client(api).solve(tasks.recaptcha_v3("https://a.example", "6Lk"))
    assert sol["gRecaptchaResponse"] == "03AF-token" and sol.task_id == "t-ReCaptchaV3TaskProxyLess"
    assert [c[0] for c in api.calls] == ["/createTask", "/getTaskResult", "/getTaskResult", "/getTaskResult"]


def test_competitor_task_names_are_sent_as_browsa_names(api):
    c = client(api)
    sol = c.solve({"type": "TurnstileTaskProxyless", "websiteURL": "https://a.example", "websiteKey": "0x4"})
    assert sol["token"] == "0.cf-token"
    assert api.calls[0][1]["task"]["type"] == "AntiTurnstileTaskProxyLess"
    raw = client(api, normalize=False)
    with pytest.raises(CaptchaError) as e:
        raw.create_task({"type": "TurnstileTaskProxyless", "websiteURL": "https://a.example", "websiteKey": "0x4"})
    assert e.value.code == "ERROR_TASK_NOT_SUPPORTED"


def test_failed_task_raises_with_code_and_task_id(api):
    with pytest.raises(CaptchaError) as e:
        client(api).solve(tasks.recaptcha_v2("https://a.example", "bad"))
    assert e.value.code == "ERROR_CAPTCHA_UNSOLVABLE" and e.value.task_id == "t-bad"
    assert isinstance(e.value, errors.BrowsaError)


def test_bad_key_and_balance(api):
    assert client(api).get_balance() == 4.2
    with pytest.raises(CaptchaError) as e:
        CaptchaClient("agt_live_wrong", base_url=api.url).get_balance()
    assert e.value.code == "ERROR_KEY_DENIED_ACCESS"


def test_local_timeout(api):
    api.ready_after = 10_000
    with pytest.raises(CaptchaTimeoutError) as e:
        client(api).solve(tasks.turnstile("https://a.example", "0x4"), timeout=0.05)
    assert e.value.task_id == "t-AntiTurnstileTaskProxyLess"
    assert isinstance(e.value, errors.TimeoutError)


def test_non_json_answer(api):
    with pytest.raises(CaptchaError) as e:
        CaptchaClient(KEY, base_url=api.url).call("html")
    assert e.value.code == "HTTP_200"


def test_key_from_environment(monkeypatch):
    monkeypatch.setenv("BROWSA_API_KEY", "agt_live_env")
    monkeypatch.setenv("BROWSA_CAPTCHA_URL", "http://x.example/cap/")
    c = CaptchaClient()
    assert c.api_key == "agt_live_env" and c.base_url == "http://x.example/cap"
    monkeypatch.delenv("BROWSA_API_KEY")
    with pytest.raises(ValueError):
        CaptchaClient()


def test_async_client(api):
    async def run():
        async with captcha.AsyncCaptchaClient(KEY, base_url=api.url, poll_interval=0.01) as c:
            return await c.solve(tasks.recaptcha_v2("https://a.example", "6Lk")), await c.get_balance()
    sol, bal = asyncio.run(run())
    assert sol["gRecaptchaResponse"] == "03AF-token" and bal == 4.2


# ── 2Captcha shim ────────────────────────────────────────────────────────


def test_twocaptcha_shim(api, tmp_path):
    solver = TwoCaptcha(KEY, base_url=api.url, pollingInterval=0)
    solver._client.poll_interval = 0.01
    r = solver.recaptcha(sitekey="6Lk", url="https://a.example/login")
    assert r == {"captchaId": "t-ReCaptchaV2TaskProxyLess", "code": "03AF-token"}
    r = solver.recaptcha(sitekey="6Lk", url="https://a.example/login", version="v3", action="login",
                         proxy={"type": "HTTPS", "uri": "u:p@1.2.3.4:3128"})
    assert r["code"] == "03AF-token"
    sent = api.calls[-3][1]["task"]
    assert sent["type"] == "ReCaptchaV3Task" and sent["proxy"] == "https://u:p@1.2.3.4:3128" and sent["pageAction"] == "login"
    assert solver.turnstile(sitekey="0x4", url="https://a.example", action="a", data="c")["code"] == "0.cf-token"
    img = tmp_path / "c.png"
    img.write_bytes(b"\x89PNG")
    assert solver.normal(str(img)) == {"captchaId": "t-img", "code": "x7Kp2"}
    assert solver.normal("iVBORw==")["code"] == "x7Kp2"
    assert solver.balance() == 4.2
    with pytest.raises(ApiException) as e:
        solver.recaptcha(sitekey="bad", url="https://a.example")
    assert e.value.code == "ERROR_CAPTCHA_UNSOLVABLE"
    with pytest.raises(ValidationException):
        solver.turnstile(sitekey="", url="https://a.example")


def test_twocaptcha_server_argument_can_name_browsa():
    s = TwoCaptcha(KEY, server="captcha.browsa.io")
    assert s._client.base_url == "https://captcha.browsa.io"
    assert TwoCaptcha(KEY, server="2captcha.com")._client.base_url == "https://captcha.browsa.io"


# ── Anti-Captcha bridge (with a stand-in for anticaptchaofficial) ────────


def _fake_anticaptcha(monkeypatch):
    """The parts of anticaptchaofficial the bridge touches: antinetworking.antiNetworking.make_request."""
    pkg = types.ModuleType("anticaptchaofficial")
    net = types.ModuleType("anticaptchaofficial.antinetworking")

    class antiNetworking:
        client_key = ""
        err_string = ""

        def log(self, *a):
            pass

        def make_request(self, method, data):
            raise AssertionError("the real host would be called")

    net.antiNetworking = antiNetworking
    pkg.antinetworking = net
    monkeypatch.setitem(sys.modules, "anticaptchaofficial", pkg)
    monkeypatch.setitem(sys.modules, "anticaptchaofficial.antinetworking", net)
    return antiNetworking


def test_use_with_anticaptcha(api, monkeypatch):
    cls = _fake_anticaptcha(monkeypatch)
    undo = use_with_anticaptcha(api.url)
    s = cls()
    r = s.make_request("createTask", {"clientKey": KEY, "task": {"type": "RecaptchaV2TaskProxyless", "websiteURL": "https://a.example",
                                                               "websiteKey": "6Lk", "websiteSToken": None}})
    assert r["errorId"] == 0 and r["taskId"] == "t-ReCaptchaV2TaskProxyLess"
    assert api.calls[-1][1]["task"] == {"type": "ReCaptchaV2TaskProxyLess", "websiteURL": "https://a.example", "websiteKey": "6Lk"}
    assert s.make_request("getBalance", {"clientKey": KEY})["balance"] == 4.2
    undo()
    with pytest.raises(AssertionError):
        cls().make_request("getBalance", {})


def test_use_with_anticaptcha_network_error_keeps_its_contract(monkeypatch):
    cls = _fake_anticaptcha(monkeypatch)
    undo = use_with_anticaptcha("http://127.0.0.1:9")
    s = cls()
    assert s.make_request("getBalance", {"clientKey": KEY}) == 0
    assert s.err_string.startswith("Connection error")
    undo()
