"""Pure unit tests — no network. Run with `pytest tests/`."""
import time

import pytest

from browsa import errors, webhooks
from browsa.types import Job, JobStatus


# ─── Webhook signature verify ────────────────────────────────────────────


def _make_sig(body: bytes, secret_hex: str, t: int) -> str:
    import hashlib, hmac
    secret = bytes.fromhex(secret_hex)
    signed = f"{t}.".encode() + body
    v1 = hmac.new(secret, signed, hashlib.sha256).hexdigest()
    return f"t={t}, v1={v1}"


# Produced by the server's own signer (services/agents webhook dispatcher:
# SigningSecretHex + signPayload). Pins the SDK to the server's scheme: the
# hex secret is decoded to bytes before the HMAC.
_SERVER_VECTOR = {
    "secret": "d91fa6dc5ad9593624374801db6a037f3991e3e336448511948d7f97a8cfd426",
    "body": b'{"id":"evt_1","type":"job.completed","job_id":"j1"}',
    "header": "t=1700000000, v1=9c4aa64a67d46e2cc817ec2f689b9f1e9f542d4eb2975a43326bf5e48c41cecc",
}


def test_verify_signature_made_by_the_server_signer():
    v = _SERVER_VECTOR
    assert webhooks.verify_signature(v["body"], v["header"], v["secret"], skew_seconds=None) is True
    assert webhooks.verify_signature(v["body"], v["header"], bytes.fromhex(v["secret"]), skew_seconds=None) is True
    assert webhooks.verify_signature(v["body"] + b" ", v["header"], v["secret"], skew_seconds=None) is False
    # Old timestamp: rejected once the default 300s skew check is on.
    assert webhooks.verify_signature(v["body"], v["header"], v["secret"]) is False


def test_verify_good_signature():
    secret = "deadbeefcafebabe" * 4  # 64 hex chars = 32 bytes
    body = b'{"type":"job.completed"}'
    t = int(time.time())
    sig = _make_sig(body, secret, t)
    assert webhooks.verify_signature(body, sig, secret) is True


def test_verify_rejects_bad_signature():
    secret = "deadbeef" * 8
    body = b'{"hello":"world"}'
    t = int(time.time())
    sig = _make_sig(body, secret, t).replace("v1=", "v1=ffffff", 1)
    assert webhooks.verify_signature(body, sig, secret) is False


def test_verify_rejects_old_timestamp():
    secret = "11111111" * 8
    body = b"{}"
    # 1 hour ago — outside default 5-min skew
    t = int(time.time()) - 3600
    sig = _make_sig(body, secret, t)
    assert webhooks.verify_signature(body, sig, secret) is False


def test_verify_accepts_string_body():
    secret = "22222222" * 8
    body = '{"a":1}'
    t = int(time.time())
    sig = _make_sig(body.encode(), secret, t)
    assert webhooks.verify_signature(body, sig, secret) is True


def test_verify_empty_header():
    assert webhooks.verify_signature(b"{}", "", "00" * 32) is False


# ─── Error envelope parsing ──────────────────────────────────────────────


def test_from_response_auth():
    err = errors.from_response(401, {"code": "UNAUTHORIZED", "error": "bad key", "request_id": "r1"})
    assert isinstance(err, errors.AuthError)
    assert err.code == "UNAUTHORIZED"
    assert err.request_id == "r1"


def test_from_response_invalid_id():
    err = errors.from_response(400, {"code": "INVALID_ID", "error": "bad uuid", "request_id": "r2"})
    assert isinstance(err, errors.InvalidIDError)


def test_from_response_not_found():
    err = errors.from_response(404, {"code": "NOT_FOUND", "error": "no job"})
    assert isinstance(err, errors.NotFoundError)


def test_from_response_rate_limit():
    err = errors.from_response(429, {"code": "RATE_LIMIT", "error": "slow down"})
    assert isinstance(err, errors.RateLimitError)


def test_from_response_generic():
    err = errors.from_response(500, {"error": "boom"})
    assert isinstance(err, errors.APIError)


# ─── Job envelope ────────────────────────────────────────────────────────


def test_job_from_response_minimal():
    j = Job.from_response({"id": "abc", "status": "queued", "kind": "task"})
    assert j.id == "abc"
    assert j.status == "queued"
    assert j.is_terminal is False


def test_job_from_response_completed():
    j = Job.from_response({
        "id": "x", "status": "completed", "kind": "task",
        "step_count": 7, "progress_total": 10,
        "result": {"final_result": "hello"},
    })
    assert j.succeeded is True
    assert j.is_terminal is True
    assert j.final_result == "hello"


def test_job_status_terminal():
    assert JobStatus.is_terminal("completed")
    assert JobStatus.is_terminal("failed")
    assert JobStatus.is_terminal("cancelled")
    assert not JobStatus.is_terminal("running")
    assert not JobStatus.is_terminal("queued")
    assert not JobStatus.is_terminal("input_required")


# ─── Client init validation ──────────────────────────────────────────────


def test_client_requires_agt_prefix():
    from browsa import Client
    with pytest.raises(ValueError, match="agt_"):
        Client(api_key="sk-fake")


# ─── Spending caps (no network: the transport is replaced) ───────────────


class _RecordingTransport:
    def __init__(self, reply):
        self.calls = []
        self.reply = reply

    def request(self, method, path, body=None, **kw):
        self.calls.append((method, path, body))
        self.kwargs = getattr(self, "kwargs", []) + [kw]
        return self.reply


def test_create_task_sends_max_credits():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"id": "j1", "status": "queued"})
    c.create_task(task="x", llm="browsa", max_credits=40)
    method, path, body = c._t.calls[0]
    assert (method, path) == ("POST", "/v1/tasks")
    assert body["max_credits"] == 40
    c.create_task(task="x", llm="browsa")
    assert "max_credits" not in c._t.calls[1][2]


def test_set_key_budget_sets_and_removes():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"id": "k1", "monthly_budget_credits": 100, "spent_this_month": 12})
    c.set_key_budget("k1", 100)
    c.set_key_budget("k1", None)
    assert c._t.calls == [
        ("PUT", "/v1/keys/k1/budget", {"monthly_budget_credits": 100}),
        ("PUT", "/v1/keys/k1/budget", {"monthly_budget_credits": None}),
    ]


# ─── Sessions (no network: the transport is replaced) ────────────────────


_SESSION = {
    "id": "s1", "title": "Open example.com", "status": "idle", "accepts_messages": True,
    "keep_browser": True,
    "browser": {"status": "live", "mode": "burner", "live_url": "https://browsa.io/stream-view/x",
                "expires_at": "2026-11-07T12:15:00Z", "expires_in_seconds": 600, "credits": 5},
    "credits_charged": 12, "turn_count": 2,
    "turns": [
        {"job_id": "s1", "task": "Open example.com", "status": "completed", "final_result": "Example Domain",
         "step_count": 3, "duration_seconds": 21.5, "credits_charged": 2, "llm": "browsa",
         "created_at": "2026-11-07T12:00:00Z"},
        {"job_id": "j2", "task": "Now open the Learn more link", "status": "completed", "final_result": None,
         "step_count": 4, "duration_seconds": None, "credits_charged": 5,
         "created_at": "2026-11-07T12:01:00Z"},
    ],
    "created_at": "2026-11-07T12:00:00Z",
}


def test_create_task_keep_browser_fields():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"job_id": "s1", "status": "queued", "kind": "task",
                                "session_id": "s1", "session_url": "https://browsa.io/v1/sessions/s1"})
    j = c.create_task(task="x", llm="browsa", keep_browser=True, browser_ttl_seconds=600)
    body = c._t.calls[0][2]
    assert body["keep_browser"] is True
    assert body["browser_ttl_seconds"] == 600
    assert j.session_id == "s1"
    assert j.session_url == "https://browsa.io/v1/sessions/s1"
    c.create_task(task="x", llm="browsa")
    assert "keep_browser" not in c._t.calls[1][2]
    assert "browser_ttl_seconds" not in c._t.calls[1][2]


def test_create_session_sets_keep_browser():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"job_id": "s1", "status": "queued", "kind": "task", "session_id": "s1"})
    j = c.create_session("Open example.com", llm="browsa", agent_id="a1")
    method, path, body = c._t.calls[0]
    assert (method, path) == ("POST", "/v1/tasks")
    assert body["keep_browser"] is True
    assert body["agent_id"] == "a1"
    assert "browser_ttl_seconds" not in body
    assert j.id == "s1" and j.session_id == "s1"
    c.create_session("x", llm="browsa", browser_ttl_seconds=1800)
    assert c._t.calls[1][2]["browser_ttl_seconds"] == 1800


def test_send_message_body_and_idempotency_key():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"job_id": "j2", "status": "queued", "kind": "task",
                                "session_id": "s1", "turn": 2})
    j = c.send_message("s1", "Now open the Learn more link", llm_api_key="sk-ant-x",
                       max_credits=20, idempotency_key="k-1")
    method, path, body = c._t.calls[0]
    assert (method, path) == ("POST", "/v1/sessions/s1/messages")
    assert body == {"task": "Now open the Learn more link", "llm_api_key": "sk-ant-x", "max_credits": 20}
    assert c._t.kwargs[0]["extra_headers"] == {"Idempotency-Key": "k-1"}
    assert (j.id, j.session_id, j.turn) == ("j2", "s1", 2)
    c.send_message("s1", "again")
    assert c._t.calls[1][2] == {"task": "again"}
    assert c._t.kwargs[1]["extra_headers"] is None


def test_get_and_stop_session_parse():
    from browsa import Client, Session
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport(_SESSION)
    s = c.get_session("s1")
    assert isinstance(s, Session)
    assert (s.id, s.status, s.accepts_messages, s.turn_count) == ("s1", "idle", True, 2)
    assert s.browser.status == "live" and s.browser.mode == "burner"
    assert s.browser.expires_in_seconds == 600 and s.browser.credits == 5
    assert [t.job_id for t in s.turns] == ["s1", "j2"]
    assert s.turns[0].final_result == "Example Domain"
    assert s.turns[0].duration_seconds == 21.5
    assert s.last_turn.final_result is None and s.last_turn.is_terminal
    c.stop_session("s1")
    assert c._t.calls == [("GET", "/v1/sessions/s1", None), ("POST", "/v1/sessions/s1/stop", None)]


def test_closed_session_parse():
    s_body = {"id": "s1", "status": "closed", "accepts_messages": False, "closed_reason": "single_task",
              "keep_browser": False, "browser": {"status": "closed", "credits": 0},
              "credits_charged": 7, "turn_count": 1, "turns": []}
    from browsa import Session
    s = Session.from_response(s_body)
    assert s.closed_reason == "single_task"
    assert s.browser.mode is None and s.browser.live_url is None
    assert s.last_turn is None


def test_send_message_conflict_raises_with_code():
    from browsa import Client

    class _Conflict:
        def request(self, *_a, **_kw):
            raise errors.from_response(409, {"code": "BROWSER_EXPIRED", "error": "expired"})

    c = Client(api_key="agt_live_test")
    c._t = _Conflict()
    with pytest.raises(errors.APIError) as ei:
        c.send_message("s1", "x")
    assert ei.value.code == "BROWSER_EXPIRED" and ei.value.status == 409


def test_async_session_methods():
    import asyncio
    from browsa import AsyncClient
    c = AsyncClient("agt_test_x")
    c._sync._t = _RecordingTransport(_SESSION)

    async def run():
        await c.create_session("x", llm="browsa")
        await c.send_message("s1", "y", llm="browsa")
        s = await c.get_session("s1")
        await c.stop_session("s1")
        return s

    s = asyncio.run(run())
    assert s.status == "idle"
    assert [(m, p) for m, p, _ in c._sync._t.calls] == [
        ("POST", "/v1/tasks"), ("POST", "/v1/sessions/s1/messages"),
        ("GET", "/v1/sessions/s1"), ("POST", "/v1/sessions/s1/stop"),
    ]


# ─── stream_job_events (mocked HTTP) ─────────────────────────────────────


class _EventsServer:
    """Local HTTP server that answers GET /v1/jobs/<id>/events from a
    scripted list of bodies and records each request's query string."""

    def __init__(self, bodies):
        import http.server
        import json as _json
        import threading
        import urllib.parse as _up

        self.bodies = list(bodies)
        self.queries = []
        self.headers = []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                u = _up.urlparse(self.path)
                outer.queries.append((u.path, dict(_up.parse_qsl(u.query))))
                outer.headers.append(dict(self.headers))
                body = outer.bodies.pop(0) if outer.bodies else {"code": "NOT_FOUND", "error": "gone"}
                status = 404 if "code" in body else 200
                raw = _json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


def _step(n):
    return {"type": "step", "n": n, "action": "click", "url": "https://example.com"}


def test_stream_job_events_follows_cursor_until_done():
    from browsa import Client
    srv = _EventsServer([
        {"events": [_step(3), _step(4)], "next_after": 4, "done": False, "status": "running"},
        {"events": [], "next_after": 4, "done": False, "status": "running"},
        {"events": [_step(5), {"type": "status", "status": "completed", "error_code": None}],
         "next_after": 5, "done": True, "status": "completed"},
    ])
    try:
        c = Client("agt_test_x", base_url=srv.url)
        evs = list(c.stream_job_events("job-1", after=2, wait=99))
    finally:
        srv.close()
    assert [e.get("n") for e in evs] == [3, 4, 5, None]
    assert evs[-1] == {"type": "status", "status": "completed", "error_code": None}
    assert [q for _, q in srv.queries] == [
        {"after": "2", "wait": "30"},  # wait is capped at the server max
        {"after": "4", "wait": "30"},
        {"after": "4", "wait": "30"},
    ]
    assert all(p == "/v1/jobs/job-1/events" for p, _ in srv.queries)
    assert {k.lower(): v for k, v in srv.headers[0].items()}.get("x-api-key") == "agt_test_x"


def test_stream_job_events_raises_on_404():
    from browsa import Client
    srv = _EventsServer([])
    try:
        c = Client("agt_test_x", base_url=srv.url)
        with pytest.raises(errors.NotFoundError):
            list(c.stream_job_events("missing"))
    finally:
        srv.close()


def test_async_stream_job_events():
    import asyncio
    from browsa import AsyncClient
    srv = _EventsServer([
        {"events": [_step(1), {"type": "status", "status": "failed", "error_code": "CANCELLED"}],
         "next_after": 1, "done": True, "status": "failed"},
    ])

    async def run():
        c = AsyncClient("agt_test_x", base_url=srv.url)
        return [e async for e in c.stream_job_events("j", wait=5)]

    try:
        evs = asyncio.run(run())
    finally:
        srv.close()
    assert [e["type"] for e in evs] == ["step", "status"]
    assert evs[1]["error_code"] == "CANCELLED"
    assert srv.queries[0][1] == {"after": "0", "wait": "5"}


# ─── Saved LLM keys (no network: the transport is replaced) ──────────────

_KEY_OBJ = {
    "id": "k-1", "name": "Prod Anthropic", "provider": "anthropic",
    "masked": "sk-ant-…a1b2", "base_url": None, "is_default": True,
    "status": "valid", "status_detail": "ok",
    "status_message": "Key works. Checked with a free model-list call.",
    "last_validated_at": "2026-11-07T10:00:00Z", "last_used_at": None,
    "created_at": "2026-11-07T10:00:00Z", "updated_at": "2026-11-07T10:00:00Z",
}


def _client(reply):
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport(reply)
    return c


def test_llm_key_endpoints_method_path_body():
    from browsa import LLMKey
    c = _client(_KEY_OBJ)
    k = c.create_llm_key("anthropic", "sk-ant-test-not-real", name="Prod Anthropic", default=True)
    assert isinstance(k, LLMKey)
    assert (k.id, k.masked, k.is_default, k.status, k.status_detail) == (
        "k-1", "sk-ant-…a1b2", True, "valid", "ok")
    c.create_llm_key("openai_compatible", "x-test", base_url="https://llm.example/v1")
    c.get_llm_key("k-1")
    c.validate_llm_key("k-1")
    c.rotate_llm_key("k-1", "sk-ant-new-not-real")
    c.rotate_llm_key("k-1", "x-new", base_url="https://llm2.example/v1")
    c.update_llm_key("k-1", name="Renamed")
    c.update_llm_key("k-1", default=False)
    c.delete_llm_key("k-1")
    assert c._t.calls == [
        ("POST", "/v1/llm-keys", {"provider": "anthropic", "api_key": "sk-ant-test-not-real",
                                  "name": "Prod Anthropic", "default": True}),
        ("POST", "/v1/llm-keys", {"provider": "openai_compatible", "api_key": "x-test",
                                  "base_url": "https://llm.example/v1"}),
        ("GET", "/v1/llm-keys/k-1", None),
        ("POST", "/v1/llm-keys/k-1/validate", None),
        ("POST", "/v1/llm-keys/k-1/rotate", {"api_key": "sk-ant-new-not-real"}),
        ("POST", "/v1/llm-keys/k-1/rotate", {"api_key": "x-new", "base_url": "https://llm2.example/v1"}),
        ("POST", "/v1/llm-keys/k-1", {"name": "Renamed"}),
        ("POST", "/v1/llm-keys/k-1", {"default": False}),
        ("DELETE", "/v1/llm-keys/k-1", None),
    ]
    with pytest.raises(ValueError):
        c.update_llm_key("k-1")


def test_list_llm_keys_parses_envelope():
    c = _client({"llm_keys": [_KEY_OBJ, {**_KEY_OBJ, "id": "k-2", "is_default": False}], "limit": 20})
    keys = c.list_llm_keys()
    assert c._t.calls == [("GET", "/v1/llm-keys", None)]
    assert [k.id for k in keys] == ["k-1", "k-2"]
    assert [k.is_default for k in keys] == [True, False]


def test_create_llm_key_repr_never_shows_secret():
    c = _client(_KEY_OBJ)
    k = c.create_llm_key("anthropic", "sk-ant-SUPERSECRET")
    assert "SUPERSECRET" not in repr(k)
    assert "SUPERSECRET" not in str(k.raw)


def test_job_outcome_signals_and_duration():
    from browsa.types import Job
    j = Job.from_response({
        "id": "j1", "status": "completed", "kind": "task", "outcome": "step_limit_reached",
        "outcome_message": "The agent used all of its steps before it finished.",
        "signals": ["bot_check_seen", "partial_result"], "duration_ms": 61000})
    assert (j.status, j.outcome, j.duration_ms) == ("completed", "step_limit_reached", 61000)
    assert j.signals == ["bot_check_seen", "partial_result"]
    assert "steps" in j.outcome_message
    # Still running, or an older server that sends none of the fields.
    for body in ({"id": "j2", "status": "running", "outcome": None, "signals": None, "duration_ms": None},
                 {"id": "j3", "status": "running"}):
        r = Job.from_response(body)
        assert (r.outcome, r.outcome_message, r.duration_ms, r.signals) == (None, None, None, [])


def test_llm_key_id_on_tasks_schedules_auto():
    c = _client({"id": "j1", "status": "queued", "llm_key_id": "k-1",
                 "llm_key_masked": "sk-ant-…a1b2", "llm_key_source": "saved"})
    j = c.create_task(task="x", llm_key_id="k-1")
    assert (j.llm_key_id, j.llm_key_masked, j.llm_key_source) == ("k-1", "sk-ant-…a1b2", "saved")
    method, path, body = c._t.calls[0]
    assert (method, path) == ("POST", "/v1/tasks")
    assert body["llm_key_id"] == "k-1"
    # llm omitted: not sent, so the server can pick the workspace default key.
    assert "llm" not in body and "llm_api_key" not in body

    c.create_schedule(interval_seconds=3600, task="x", llm="anthropic:claude-sonnet-5-5", llm_key_id="k-1")
    method, path, body = c._t.calls[1]
    assert (method, path) == ("POST", "/v1/schedules")
    assert body["llm_key_id"] == "k-1" and body["llm"] == "anthropic:claude-sonnet-5-5"

    c.auto("go to example.com", llm_key_id="k-1")
    method, path, body = c._t.calls[2]
    assert (method, path, body["llm_key_id"]) == ("POST", "/v1/auto", "k-1")

    # No key at all: nothing key-related is sent (workspace default applies).
    c.create_task(task="x")
    assert set(c._t.calls[3][2]) == {"task", "framework"}


def test_run_task_forwards_llm_key_id():
    from browsa import Job
    c = _client({"id": "j1", "status": "completed", "kind": "task"})
    c.get_job = lambda job_id, wait=0: Job.from_response(
        {"id": job_id, "status": "completed", "kind": "task"})
    j = c.run_task(task="x", llm_key_id="k-9")
    assert j.status == "completed"
    assert c._t.calls[0][2]["llm_key_id"] == "k-9"


def test_schedule_from_response_llm_key_id():
    from browsa import Schedule
    s = Schedule.from_response({"id": "s1", "interval_seconds": 3600, "enabled": True, "llm_key_id": "k-1"})
    assert s.llm_key_id == "k-1"


def test_async_llm_keys():
    import asyncio
    from browsa import AsyncClient

    async def run():
        c = AsyncClient("agt_live_test")
        c._sync._t = _RecordingTransport(_KEY_OBJ)
        await c.create_llm_key("google", "g-test", name="G")
        await c.rotate_llm_key("k-1", "g-new")
        await c.update_llm_key("k-1", default=True)
        await c.delete_llm_key("k-1")
        return c._sync._t.calls

    calls = asyncio.run(run())
    assert [(m, p) for m, p, _ in calls] == [
        ("POST", "/v1/llm-keys"), ("POST", "/v1/llm-keys/k-1/rotate"),
        ("POST", "/v1/llm-keys/k-1"), ("DELETE", "/v1/llm-keys/k-1"),
    ]
    assert calls[0][2] == {"provider": "google", "api_key": "g-test", "name": "G"}


# ─── DX fixes ────────────────────────────────────────────────────────────


def test_download_job_file_returns_bytes_even_for_json_content_type():
    # A .json output file served as application/json must stay bytes, not
    # come back parsed as a dict.
    from browsa import Client
    srv = _EventsServer([{"rows": [1, 2]}])
    try:
        c = Client("agt_test_x", base_url=srv.url)
        data = c.download_job_file("job-1", "out.json")
    finally:
        srv.close()
    assert isinstance(data, bytes)
    assert data == b'{"rows": [1, 2]}'
    assert srv.queries[0][0] == "/v1/jobs/job-1/files/out.json"


def test_run_message_keeps_turn_and_session_id():
    # GET /v1/jobs/:id of a turn has no "turn"; run_message keeps it from the 202.
    from browsa import Client

    class T:
        def __init__(self):
            self.calls = []

        def request(self, method, path, body=None, **kw):
            self.calls.append((method, path))
            if method == "POST":
                return {"job_id": "j2", "status": "queued", "kind": "task", "session_id": "s1", "turn": 2}
            return {"id": "j2", "status": "completed", "kind": "task", "session_id": "s1",
                    "result": {"final_result": "ok"}}

    c = Client(api_key="agt_live_test")
    c._t = T()
    j = c.run_message("s1", "next", llm="browsa")
    assert (j.id, j.status, j.turn, j.session_id, j.final_result) == ("j2", "completed", 2, "s1", "ok")
    assert c._t.calls == [("POST", "/v1/sessions/s1/messages"), ("GET", "/v1/jobs/j2")]


def test_create_session_llm_is_optional():
    # Like create_task: with llm left out the workspace's default saved key is used.
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"job_id": "s1", "status": "queued", "kind": "task", "session_id": "s1"})
    c.create_session("Open example.com")
    body = c._t.calls[0][2]
    assert body["keep_browser"] is True
    assert "llm" not in body


def test_batch_sends_no_mode_and_rejects_other_modes():
    # The API's batch only scrapes and ignores "mode"; extract/screenshot
    # requests silently came back as plain scrapes.
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"job_id": "b1", "status": "queued", "kind": "batch"})
    r = c.batch(["https://a.example", "https://b.example"], max_chars=500)
    assert r["job_id"] == "b1"
    assert c._t.calls[0] == ("POST", "/v1/quick/batch",
                             {"urls": ["https://a.example", "https://b.example"], "max_chars": 500})
    with pytest.raises(ValueError, match="only scrapes"):
        c.batch(["https://a.example"], mode="extract")
    assert len(c._t.calls) == 1


def test_list_webhook_deliveries():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"deliveries": [{"id": "d1", "event_type": "webhook.test", "status_code": 405}], "count": 1})
    rows = c.list_webhook_deliveries("whk_1", limit=5)
    assert rows[0]["status_code"] == 405
    assert c._t.calls[0][:2] == ("GET", "/v1/webhooks/whk_1/deliveries")
    assert c._t.kwargs[0]["query"] == {"limit": 5}
    c.list_webhook_deliveries("whk_1")
    assert c._t.kwargs[1]["query"] is None


def test_async_client_has_every_client_method():
    from browsa import AsyncClient, Client
    missing = [m for m in dir(Client) if not m.startswith("_") and not hasattr(AsyncClient, m)]
    assert missing == []


def test_async_agent_helpers():
    import asyncio
    from browsa import AsyncClient
    c = AsyncClient("agt_test_x")
    c._sync._t = _RecordingTransport({"id": "agt_1", "profile_id": "p1", "routed_via": "scrape"})
    c._sync._t.api_key = "agt_test_x"

    async def run():
        await c.fingerprint("agt_1")
        await c.trust_breakdown("agt_1")
        await c.detection_signal("agt_1")
        await c.auto("Go to https://example.com and return the h1", llm="browsa")
        return await c.connect("agt_1", framework="curl")

    snip = asyncio.run(run())
    assert [(m, p) for m, p, _ in c._sync._t.calls] == [
        ("GET", "/v1/agents/agt_1/fingerprint"), ("GET", "/v1/agents/agt_1/trust"),
        ("GET", "/v1/agents/agt_1/detection-signal"), ("POST", "/v1/auto"),
        ("GET", "/v1/agents/agt_1"),
    ]
    assert snip["framework"] == "curl" and "p1" in snip["cdp_http"]


# ─── Hosted tiers, reasoning, models, usage and cost ─────────────────────


# Example GET /v1/models body. The model ids and credit numbers are server
# settings; the SDK must not depend on these values.
_MODELS = {
    "hosted": [
        {"id": "browsa", "model": "claude-opus-4-8", "fallback_models": ["claude-sonnet-4-6"],
         "reasoning": "low", "credits_per_task": 5, "default": True},
        {"id": "browsa-fast", "model": "gemini-3.1-flash-lite",
         "fallback_models": ["claude-sonnet-4-6", "claude-opus-4-8"], "reasoning": None, "credits_per_task": 5},
        {"id": "browsa-smart", "model": "claude-opus-4-8", "fallback_models": ["claude-sonnet-4-6"],
         "reasoning": "high", "credits_per_task": 5},
    ],
    "own_key": {"providers": ["anthropic", "openai", "google", "openai_compatible"],
                "default_models": {"anthropic": "a-model", "openai": "o-model", "google": "g-model"}},
}


def test_create_task_sends_tier_and_reasoning():
    c = _client({"id": "j1", "status": "queued"})
    c.create_task(task="x", llm="browsa-smart", reasoning="high")
    method, path, body = c._t.calls[0]
    assert (method, path) == ("POST", "/v1/tasks")
    assert body == {"task": "x", "framework": "browser-use", "llm": "browsa-smart", "reasoning": "high"}
    c.create_task(task="x", llm="browsa-fast")
    assert c._t.calls[1][2]["llm"] == "browsa-fast"
    assert "reasoning" not in c._t.calls[1][2]


def test_reasoning_on_run_task_session_message_and_schedule():
    from browsa import Job
    c = _client({"id": "j1", "status": "queued", "kind": "task", "session_id": "j1", "turn": 2})
    c.get_job = lambda job_id, wait=0: Job.from_response(
        {"id": job_id, "status": "completed", "kind": "task"})
    c.run_task(task="x", llm="browsa", reasoning="medium")
    c.create_session("x", llm="browsa-fast", reasoning="low")
    c.send_message("s1", "next", reasoning="high")
    c.run_message("s1", "again", llm="browsa-smart", reasoning="medium")
    c.create_schedule(interval_seconds=3600, task="x", llm="browsa-smart", reasoning="high")
    bodies = [b for _, _, b in c._t.calls]
    assert [(m, p) for m, p, _ in c._t.calls] == [
        ("POST", "/v1/tasks"), ("POST", "/v1/tasks"), ("POST", "/v1/sessions/s1/messages"),
        ("POST", "/v1/sessions/s1/messages"), ("POST", "/v1/schedules"),
    ]
    assert (bodies[0]["llm"], bodies[0]["reasoning"]) == ("browsa", "medium")
    assert (bodies[1]["llm"], bodies[1]["reasoning"], bodies[1]["keep_browser"]) == ("browsa-fast", "low", True)
    assert bodies[2] == {"task": "next", "reasoning": "high"}
    assert bodies[3] == {"task": "again", "llm": "browsa-smart", "reasoning": "medium"}
    assert (bodies[4]["llm"], bodies[4]["reasoning"]) == ("browsa-smart", "high")
    # Left out: not sent, so the tier's or provider's default applies.
    c.send_message("s1", "plain")
    c.create_schedule(interval_seconds=3600, task="x")
    assert "reasoning" not in c._t.calls[5][2] and "reasoning" not in c._t.calls[6][2]


def test_reasoning_is_not_validated_client_side():
    # Like the other task fields, the value goes to the API as given; the
    # API answers 400 for anything but low, medium or high.
    c = _client({"id": "j1", "status": "queued"})
    c.create_task(task="x", reasoning="extreme")
    assert c._t.calls[0][2]["reasoning"] == "extreme"


def test_models_parses_response():
    from browsa import HostedModel, Models
    c = _client(_MODELS)
    m = c.models()
    assert c._t.calls == [("GET", "/v1/models", None)]
    assert isinstance(m, Models) and all(isinstance(h, HostedModel) for h in m.hosted)
    assert [h.id for h in m.hosted] == ["browsa", "browsa-fast", "browsa-smart"]
    assert [h.default for h in m.hosted] == [True, False, False]
    fast = m.tier("browsa-fast")
    assert fast.model == "gemini-3.1-flash-lite"
    assert fast.fallback_models == ["claude-sonnet-4-6", "claude-opus-4-8"]
    assert fast.reasoning is None and fast.credits_per_task == 5
    assert m.tier("browsa-smart").reasoning == "high"
    assert m.tier("nope") is None
    assert m.own_key.providers == ["anthropic", "openai", "google", "openai_compatible"]
    assert m.own_key.default_models["openai"] == "o-model"
    assert m.raw is _MODELS


def test_models_tolerates_missing_keys():
    from browsa import Models
    for body in ({}, None, {"hosted": None, "own_key": None}):
        m = Models.from_response(body)
        assert m.hosted == [] and m.own_key.providers == [] and m.own_key.default_models == {}
    m = Models.from_response({"hosted": [{"id": "browsa"}]})
    h = m.hosted[0]
    assert (h.id, h.model, h.fallback_models, h.reasoning, h.credits_per_task, h.default) == (
        "browsa", "", [], None, None, False)


def test_job_usage_cost_tier_and_reasoning():
    from browsa import Usage
    # Own key: usage and an estimated cost, no tier.
    j = Job.from_response({"id": "j1", "status": "completed", "kind": "task", "result": {
        "final_result": "ok",
        "usage": {"input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 800,
                  "cache_write_tokens": 100, "requests": 4},
        "llm_cost_usd": 0.0123, "reasoning": "medium"}})
    assert isinstance(j.usage, Usage)
    assert (j.usage.input_tokens, j.usage.output_tokens, j.usage.cache_read_tokens,
            j.usage.cache_write_tokens, j.usage.requests) == (1200, 300, 800, 100, 4)
    assert j.llm_cost_usd == 0.0123 and j.llm_tier is None and j.reasoning == "medium"
    assert j.final_result == "ok"
    # Hosted: a tier, and the cost is null (paid in credits).
    h = Job.from_response({"id": "j2", "status": "completed", "kind": "task", "result": {
        "usage": {"input_tokens": 10, "output_tokens": 2}, "llm_cost_usd": None,
        "llm_tier": "browsa-smart", "reasoning": "high"}})
    assert (h.llm_cost_usd, h.llm_tier, h.reasoning) == (None, "browsa-smart", "high")
    assert (h.usage.cache_read_tokens, h.usage.cache_write_tokens, h.usage.requests) == (0, 0, 0)


def test_job_without_the_new_result_keys_still_parses():
    for body in ({"id": "j1", "status": "completed", "kind": "task", "result": {"final_result": "hello"}},
                 {"id": "j2", "status": "running", "kind": "task"},
                 {"id": "j3", "status": "failed", "kind": "task", "result": None},
                 {"id": "j4", "status": "completed", "kind": "task", "result": {"usage": None}}):
        j = Job.from_response(body)
        assert (j.usage, j.llm_cost_usd, j.llm_tier, j.reasoning) == (None, None, None, None)
    j = Job.from_response({"id": "j1", "status": "completed", "result": {"final_result": "hello"}})
    assert j.final_result == "hello" and j.succeeded


def test_schedule_from_response_reasoning():
    from browsa import Schedule
    s = Schedule.from_response({"id": "s1", "interval_seconds": 3600, "enabled": True,
                                "llm": "browsa-smart", "reasoning": "high"})
    assert (s.llm, s.reasoning) == ("browsa-smart", "high")
    assert Schedule.from_response({"id": "s2", "interval_seconds": 3600, "enabled": True}).reasoning is None


def test_async_models():
    import asyncio
    from browsa import AsyncClient
    c = AsyncClient("agt_test_x")
    c._sync._t = _RecordingTransport(_MODELS)
    m = asyncio.run(c.models())
    assert m.tier("browsa").default is True
    assert c._sync._t.calls == [("GET", "/v1/models", None)]
# ─── Built-in proxy network ──────────────────────────────────────────────


_PROXY_NETWORK_ON = {
    "enabled": True,
    "tiers": [
        {"network": "datacenter", "credits_per_gb": 5, "mb_per_credit": 200, "countries": ["de", "us"]},
        {"network": "residential", "credits_per_gb": 50, "mb_per_credit": 20, "countries": ["us", "gb"]},
    ],
}


def test_proxy_network_reads_the_tiers():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport(_PROXY_NETWORK_ON)
    pn = c.proxy_network()
    assert c._t.calls[0][:2] == ("GET", "/v1/proxy-network")
    assert pn.enabled is True
    assert [t.network for t in pn.tiers] == ["datacenter", "residential"]
    assert pn.tier("datacenter").credits_per_gb == 5
    assert pn.tier("datacenter").mb_per_credit == 200
    assert pn.tier("residential").countries == ["us", "gb"]
    assert pn.tier("mobile") is None


def test_proxy_network_off_and_older_api():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"enabled": False, "tiers": []})
    pn = c.proxy_network()
    assert pn.enabled is False and pn.tiers == []

    class _NotFound:
        def request(self, *a, **kw):
            raise errors.from_response(404, {"code": "NOT_FOUND", "error": "no such route"})
    c._t = _NotFound()
    pn = c.proxy_network()
    assert pn.enabled is False and pn.tiers == []

    # Any other error is raised: a wrong key is not "the network is off".
    class _Unauthorized:
        def request(self, *a, **kw):
            raise errors.from_response(401, {"code": "INVALID_API_KEY", "error": "bad key"})
    c._t = _Unauthorized()
    with pytest.raises(errors.AuthError):
        c.proxy_network()


def test_network_proxy_is_sent_as_given():
    from browsa import Client
    c = Client(api_key="agt_live_test")
    c._t = _RecordingTransport({"id": "j1", "status": "queued"})
    c.create_task(task="x", llm="browsa", proxy={"network": "residential", "country": "gb"})
    assert c._t.calls[-1][2]["proxy"] == {"network": "residential", "country": "gb"}
    assert "proxy_id" not in c._t.calls[-1][2]
    c.create_task(task="x", llm="browsa", proxy_id="px_1")
    assert c._t.calls[-1][2]["proxy_id"] == "px_1"
    assert "proxy" not in c._t.calls[-1][2]
    c.create_task(task="x", llm="browsa")
    assert "proxy" not in c._t.calls[-1][2] and "proxy_id" not in c._t.calls[-1][2]

    c._t = _RecordingTransport({"id": "s1", "interval_seconds": 3600})
    c.create_schedule(interval_seconds=3600, task="x", llm="browsa", proxy={"network": "datacenter", "country": "de"})
    assert c._t.calls[0][:2] == ("POST", "/v1/schedules")
    assert c._t.calls[0][2]["proxy"] == {"network": "datacenter", "country": "de"}

    c._t = _RecordingTransport({"id": "agt_1"})
    c.create_agent(ttl="5m", proxy={"network": "datacenter", "country": "us"})
    assert c._t.calls[0][:2] == ("POST", "/v1/agents")
    assert c._t.calls[0][2] == {"ttl": "5m", "proxy": {"network": "datacenter", "country": "us"}}


def test_job_proxy_usage_fields():
    j = Job.from_response({"id": "j1", "status": "completed", "proxy_network": "datacenter",
                           "proxy_bytes": 12300000, "proxy_credits": 1})
    assert (j.proxy_network, j.proxy_bytes, j.proxy_credits) == ("datacenter", 12300000, 1)
    j = Job.from_response({"id": "j2", "status": "completed", "proxy_network": None})
    assert (j.proxy_network, j.proxy_bytes, j.proxy_credits) == (None, 0, 0)
    j = Job.from_response({"id": "j3", "status": "completed"})
    assert (j.proxy_network, j.proxy_bytes, j.proxy_credits) == (None, 0, 0)


def test_async_proxy_network():
    import asyncio
    from browsa import AsyncClient

    async def go():
        c = AsyncClient(api_key="agt_live_test")
        c._sync._t = _RecordingTransport(_PROXY_NETWORK_ON)
        pn = await c.proxy_network()
        assert pn.enabled and pn.tier("residential").credits_per_gb == 50
    asyncio.run(go())
