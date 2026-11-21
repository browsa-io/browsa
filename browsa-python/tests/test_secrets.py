"""Secrets (client.secrets), secret_ids / save_secrets passthrough and saved_secrets
parsing, against a mocked urlopen. No network. Every value here is an obvious dummy."""
import asyncio
import io
import json
import urllib.error
import urllib.parse

import pytest

import browsa
from browsa import errors
from browsa.types import Job, SavedSecret, Secret, SecretsNotSaved


class _Resp:
    def __init__(self, body, status=200):
        self._b = json.dumps(body).encode()
        self.status = status
        self.headers = {"Content-Type": "application/json"}

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def http(monkeypatch):
    calls = []
    handlers = {}

    def fake_urlopen(req, timeout=None):
        u = urllib.parse.urlsplit(req.full_url)
        key = f"{req.get_method()} {u.path}"
        body = json.loads(req.data) if req.data else None
        calls.append({"key": key, "query": dict(urllib.parse.parse_qsl(u.query)), "body": body})
        h = handlers.get(key)
        if h is None:
            raise AssertionError(f"no mock for {key}")
        status, out = h
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "err", {}, io.BytesIO(json.dumps(out).encode()))
        return _Resp(out, status)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return handlers, calls


def client():
    return browsa.Client("agt_live_test", base_url="https://api.test")


SECRET = {
    "id": "7b0c0000-0000-0000-0000-000000000001", "name": "DUMMY_LOGIN", "type": "login",
    "description": "Test account", "origins": ["https://*.example.com"], "username_masked": "du…",
    "has_value": True, "has_totp": True, "totp": {"digits": 6, "algorithm": "SHA1", "period": 30},
    "placeholders": ["DUMMY_LOGIN:username", "DUMMY_LOGIN:password", "TOTP:DUMMY_LOGIN"],
    "keypair_id": None, "created_by": {"type": "key", "id": "k1"}, "last_used_at": None,
    "created_at": "2026-11-19T10:00:00Z", "updated_at": "2026-11-19T10:00:00Z",
    "used_by": [{"kind": "robot", "id": "rb1", "name": "Invoices"}],
}


def test_list_and_get(http):
    handlers, calls = http
    handlers["GET /v1/secrets"] = (200, {"secrets": [SECRET], "limit": 500})
    handlers["GET /v1/secrets/DUMMY_LOGIN"] = (200, SECRET)
    c = client()
    out = c.secrets.list()
    assert isinstance(out[0], Secret) and out[0].name == "DUMMY_LOGIN"
    assert out[0].used_by[0]["kind"] == "robot" and out[0].has_totp and out[0].totp["digits"] == 6
    assert c.secrets.list_page()["limit"] == 500
    s = c.secrets.get("DUMMY_LOGIN")
    assert s.type == "login" and s.username_masked == "du…" and s.placeholders[1] == "DUMMY_LOGIN:password"


def test_create_login_and_value_shapes(http):
    handlers, calls = http
    handlers["POST /v1/secrets"] = (201, SECRET)
    c = client()
    c.secrets.create("DUMMY_LOGIN", "login", ["example.com"], description="Test account",
                     username="dummy-user", password="dummy-pass", totp_secret="JBSWY3DPEHPK3PXP",
                     totp_code="000000")
    assert calls[0]["body"] == {
        "name": "DUMMY_LOGIN", "type": "login", "origins": ["example.com"], "description": "Test account",
        "username": "dummy-user", "password": "dummy-pass", "totp_secret": "JBSWY3DPEHPK3PXP",
        "totp_code": "000000",
    }
    c.secrets.create("DUMMY_TOKEN", "value", ["*"], value="dummy-value", allow_any_origin=True)
    assert calls[1]["body"] == {"name": "DUMMY_TOKEN", "type": "value", "origins": ["*"],
                                "value": "dummy-value", "allow_any_origin": True}
    # Sealed fields go through as extra keyword arguments.
    c.secrets.create("DUMMY_SEALED", "value", ["example.com"], sealed_value="ZHVtbXk=", keypair_id="kp_1")
    assert calls[2]["body"] == {"name": "DUMMY_SEALED", "type": "value", "origins": ["example.com"],
                                "sealed_value": "ZHVtbXk=", "keypair_id": "kp_1"}


def test_update_sends_only_given_fields(http):
    handlers, calls = http
    handlers["PATCH /v1/secrets/DUMMY_LOGIN"] = (200, SECRET)
    c = client()
    c.secrets.update("DUMMY_LOGIN", origins=["github.com"], totp_secret="")
    assert calls[0]["body"] == {"origins": ["github.com"], "totp_secret": ""}
    c.secrets.update("DUMMY_LOGIN", description="New text", digits=8, algorithm="SHA256", period=60)
    assert calls[1]["body"] == {"description": "New text", "digits": 8, "algorithm": "SHA256", "period": 60}


def test_delete_force_and_in_use(http):
    handlers, calls = http
    c = client()
    handlers["DELETE /v1/secrets/DUMMY_LOGIN"] = (409, {
        "error": "DUMMY_LOGIN is in use", "code": "SECRET_IN_USE", "id": "s1", "name": "DUMMY_LOGIN",
        "used_by": [{"kind": "schedule", "id": "sc1", "name": "Nightly"}]})
    with pytest.raises(errors.APIError) as ei:
        c.secrets.delete("DUMMY_LOGIN")
    assert ei.value.code == "SECRET_IN_USE" and ei.value.status == 409
    assert ei.value.body["used_by"][0]["kind"] == "schedule"
    assert calls[0]["query"] == {}
    handlers["DELETE /v1/secrets/DUMMY_LOGIN"] = (200, {"deleted": True, "id": "s1", "name": "DUMMY_LOGIN"})
    assert c.secrets.delete("DUMMY_LOGIN", force=True)["deleted"] is True
    assert calls[1]["query"] == {"force": "1"}


def test_import_env_usage_keypair(http):
    handlers, calls = http
    handlers["POST /v1/secrets/import"] = (201, {"secrets": [{**SECRET, "name": "DUMMY_A", "type": "value"}],
                                                 "created": 1, "updated": 0, "skipped": ["DUMMY_B"]})
    handlers["GET /v1/secrets/DUMMY_LOGIN/usage"] = (200, {
        "secret_id": "s1", "name": "DUMMY_LOGIN", "limit": 10, "next_cursor": "MTc5",
        "usage": [{"job_id": "j1", "origin": "https://example.com", "action": "typed", "source": "task",
                   "at": "2026-11-19T10:05:00Z"}]})
    handlers["GET /v1/secrets/keypair"] = (200, {"id": "kp_1", "public_key": "AAAA", "info_prefix": "browsa-secrets/v1:ws:"})
    c = client()
    out = c.secrets.import_env("DUMMY_A=dummy-a\nDUMMY_B=dummy-b\n", ["example.com"],
                               description="dummies", on_conflict="skip")
    assert calls[0]["body"] == {"env": "DUMMY_A=dummy-a\nDUMMY_B=dummy-b\n", "origins": ["example.com"],
                                "description": "dummies", "on_conflict": "skip"}
    assert isinstance(out["secrets"][0], Secret) and out["created"] == 1 and out["skipped"] == ["DUMMY_B"]
    u = c.secrets.usage("DUMMY_LOGIN", limit=10, cursor="abc")
    assert calls[1]["query"] == {"limit": "10", "cursor": "abc"}
    assert u["usage"][0]["action"] == "typed" and u["next_cursor"] == "MTc5"
    c.secrets.usage("DUMMY_LOGIN")
    assert calls[2]["query"] == {}
    assert c.secrets.keypair()["id"] == "kp_1"


def test_secret_ids_and_save_secrets_passthrough(http):
    handlers, calls = http
    job = {"id": "j1", "status": "queued", "kind": "task"}
    handlers["POST /v1/tasks"] = (202, job)
    handlers["POST /v1/auto"] = (202, {"job_id": "j2", "routed_via": "task"})
    handlers["POST /v1/schedules"] = (201, {"id": "sc1", "interval_seconds": 3600})
    handlers["POST /v1/recipes/r1/run"] = (202, {"id": "rr1", "recipe_id": "r1", "status": "queued"})
    handlers["POST /v1/sessions/j1/messages"] = (202, {**job, "session_id": "j1", "turn": 2})
    c = client()
    task = "Log in with secrets.DUMMY_LOGIN and read the balance"

    c.create_task(task=task, llm="browsa", secret_ids=["DUMMY_LOGIN"], save_secrets=False)
    assert calls[-1]["body"]["secret_ids"] == ["DUMMY_LOGIN"] and calls[-1]["body"]["save_secrets"] is False

    # save_secrets is sent only when given.
    c.create_task(task=task, llm="browsa", secret_ids=("DUMMY_LOGIN",))
    assert calls[-1]["body"]["secret_ids"] == ["DUMMY_LOGIN"] and "save_secrets" not in calls[-1]["body"]
    c.create_task(task="plain", llm="browsa")
    assert "secret_ids" not in calls[-1]["body"] and "save_secrets" not in calls[-1]["body"]

    c.auto(task, secret_ids=["DUMMY_LOGIN"], save_secrets=True)
    assert calls[-1]["body"]["secret_ids"] == ["DUMMY_LOGIN"] and calls[-1]["body"]["save_secrets"] is True

    c.create_schedule(interval_seconds=3600, task=task, llm="browsa", secret_ids=["DUMMY_LOGIN"], save_secrets=False)
    assert calls[-1]["body"]["secret_ids"] == ["DUMMY_LOGIN"] and calls[-1]["body"]["save_secrets"] is False

    c.run_recipe("r1", params={"q": "x"}, secret_ids=["DUMMY_LOGIN"])
    assert calls[-1]["body"] == {"params": {"q": "x"}, "secret_ids": ["DUMMY_LOGIN"]}

    c.send_message("j1", task, secret_ids=["DUMMY_LOGIN"], save_secrets=False)
    assert calls[-1]["body"] == {"task": task, "secret_ids": ["DUMMY_LOGIN"], "save_secrets": False}

    c.create_session(task, llm="browsa", secret_ids=["DUMMY_LOGIN"])
    assert calls[-1]["body"]["secret_ids"] == ["DUMMY_LOGIN"] and calls[-1]["body"]["keep_browser"] is True


def test_run_task_passes_secret_ids(http, monkeypatch):
    handlers, calls = http
    handlers["POST /v1/tasks"] = (202, {"id": "j1", "status": "queued", "kind": "task"})
    handlers["GET /v1/jobs/j1"] = (200, {"id": "j1", "status": "completed", "kind": "task", "result": {
        "final_result": "done",
        "saved_secrets": [{"name": "EXAMPLE_COM_LOGIN", "id": "s9", "type": "login",
                           "origins": ["https://*.example.com"], "username_masked": "du…", "existing": False}]}})
    job = client().run_task(task="Sign up on example.com", llm="browsa", secret_ids=["DUMMY_LOGIN"], save_secrets=True)
    assert calls[0]["body"]["secret_ids"] == ["DUMMY_LOGIN"] and calls[0]["body"]["save_secrets"] is True
    assert job.saved_secrets[0].name == "EXAMPLE_COM_LOGIN"


def test_act_secret_passthrough(http):
    handlers, calls = http
    handlers["POST /v1/agents/agt1/act"] = (200, {"text": "type [14] secret DUMMY_LOGIN:password (hidden)",
                                                  "status": "ok", "secret": "DUMMY_LOGIN:password"})
    r = client().act("agt1", "type", id=14, secret="DUMMY_LOGIN:password")
    assert calls[0]["body"] == {"action": "type", "id": 14, "secret": "DUMMY_LOGIN:password"}
    assert r["status"] == "ok"


def test_job_parses_saved_secrets_and_not_saved():
    j = Job.from_response({"id": "j1", "status": "completed", "kind": "task",
                           "secrets_used": [{"id": "s1", "name": "DUMMY_LOGIN", "type": "login"}],
                           "result": {
        "saved_secrets": [
            {"name": "EXAMPLE_COM_LOGIN", "id": "s9", "type": "login", "origins": ["https://*.example.com"],
             "username_masked": "du…", "existing": False},
            {"name": "EXAMPLE_API_KEY", "id": "s10", "type": "value", "origins": ["https://api.example.com"],
             "existing": True},
        ],
        "secrets_not_saved": {"code": "SECRET_LIMIT", "message": "The workspace has 500 secrets."}}})
    assert [s.name for s in j.saved_secrets] == ["EXAMPLE_COM_LOGIN", "EXAMPLE_API_KEY"]
    a, b = j.saved_secrets
    assert isinstance(a, SavedSecret) and a.type == "login" and a.username_masked == "du…" and a.existing is False
    assert b.type == "value" and b.username_masked is None and b.existing is True
    assert b.origins == ["https://api.example.com"]
    assert isinstance(j.secrets_not_saved, SecretsNotSaved) and j.secrets_not_saved.code == "SECRET_LIMIT"
    assert j.secrets_used[0]["name"] == "DUMMY_LOGIN"


def test_job_without_secret_fields():
    j = Job.from_response({"id": "j1", "status": "completed", "kind": "task", "result": {"final_result": "x"}})
    assert j.saved_secrets == [] and j.secrets_not_saved is None and j.secrets_used == []
    j = Job.from_response({"id": "j1", "status": "running", "kind": "task", "result": None})
    assert j.saved_secrets == [] and j.secrets_not_saved is None
    j = Job.from_response({"id": "j1", "status": "completed", "kind": "task",
                           "result": {"saved_secrets": "bad", "secrets_not_saved": {"message": "no code"}}})
    assert j.saved_secrets == [] and j.secrets_not_saved is None


def test_async_client_secrets(http):
    handlers, calls = http
    handlers["GET /v1/secrets"] = (200, {"secrets": [SECRET], "limit": 500})

    async def go():
        async with browsa.AsyncClient("agt_live_test", base_url="https://api.test") as c:
            return await c.secrets.list()

    assert asyncio.run(go())[0].name == "DUMMY_LOGIN"
