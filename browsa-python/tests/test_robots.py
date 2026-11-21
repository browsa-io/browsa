"""Robot methods (client.robots, client.robot_runs) against a mocked urlopen. No network."""
import asyncio
import io
import json
import urllib.error
import urllib.parse

import pytest

import browsa
from browsa import errors
from browsa.types import Robot, RobotAlert, RobotRun


class _Resp:
    def __init__(self, body, status=200, ctype="application/json"):
        self._b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.status = status
        self.headers = {"Content-Type": ctype}

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def http(monkeypatch):
    """Route urlopen to handlers keyed by 'METHOD /path'; record each call."""
    calls = []
    handlers = {}

    def fake_urlopen(req, timeout=None):
        u = urllib.parse.urlsplit(req.full_url)
        key = f"{req.get_method()} {u.path}"
        body = json.loads(req.data) if req.data else None
        query = dict(urllib.parse.parse_qsl(u.query))
        calls.append({"key": key, "query": query, "body": body})
        h = handlers.get(key)
        if h is None:
            raise AssertionError(f"no mock for {key}")
        if callable(h):
            h = h(query)
        status, out = h[0], h[1]
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "err", {}, io.BytesIO(json.dumps(out).encode()))
        return _Resp(out, status, *(h[2:] or ()))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return handlers, calls


RUN = {"id": "rr1", "robot_id": "rb1", "trigger": "api", "status": "queued", "rows_total": 2, "rows_ok": 0,
       "rows_failed": 0, "rows_pending": 2, "credits": 0, "site": "books.toscrape.com", "stop_reason": None,
       "created_at": "2026-11-19T00:00:00Z", "started_at": None, "finished_at": None}
ROBOT = {
    "id": "rb1", "name": "Book prices", "description": "", "recipe_id": "r1", "status": "active",
    "paused_reason": None, "profile_id": None, "inputs": [{"url": "https://a"}, {"url": "https://b"}],
    "destinations": [{"type": "webhook", "url": "https://hook"}], "monitors": [{"field": "price", "op": "lt", "value": 20}],
    "schedule": {"id": "s1", "interval_seconds": 86400, "enabled": True, "next_run_at": "t", "at": "09:00", "weekday": None, "tz": "UTC"},
    "settings": {"model": {"llm": "browsa-smart"}, "proxy": {"network": "residential", "country": "us"}, "browser": None},
    "source_job_id": "job-1",
    "health": {"pass_rate": 0.5, "rows_counted": 4, "last_failure": "blocked", "recipe_version": 1, "versions": 1,
               "repairs": 0, "price_credits": 3, "schedule_active": True, "site": "books.toscrape.com"},
    "alerts_unread": 1, "last_run": RUN,
}


def client():
    return browsa.Client("agt_live_test", base_url="https://api.test")


def test_create_sends_fields_and_parses(http):
    handlers, calls = http
    handlers["POST /v1/robots"] = (201, ROBOT)
    settings = {"model": {"llm": "browsa"}, "proxy": {"network": "datacenter", "country": "de"},
                "browser": {"os": "windows", "screen": "1920x1080"}}
    rb = client().robots.create(
        name="Book prices", from_job_id="job-1", inputs=[{"url": "https://a"}],
        schedule={"interval_seconds": 86400, "at": "09:00"}, monitors=[{"field": "price", "op": "changed"}],
        settings=settings,
    )
    assert calls[0]["body"] == {
        "name": "Book prices", "from_job_id": "job-1", "inputs": [{"url": "https://a"}],
        "schedule": {"interval_seconds": 86400, "at": "09:00"}, "monitors": [{"field": "price", "op": "changed"}],
        "settings": settings,
    }
    assert isinstance(rb, Robot) and rb.id == "rb1" and rb.recipe_id == "r1"
    assert rb.settings == {"model": {"llm": "browsa-smart"}, "proxy": {"network": "residential", "country": "us"},
                           "browser": None, "secrets": []}
    assert rb.health.pass_rate == 0.5 and rb.health.price_credits == 3 and rb.health.last_failure == "blocked"
    assert rb.schedule["interval_seconds"] == 86400
    assert isinstance(rb.last_run, RobotRun) and rb.last_run.id == "rr1"
    assert rb.alerts_unread == 1


def test_create_from_recipe_auto_settings(http):
    handlers, calls = http
    handlers["POST /v1/robots"] = (201, {**ROBOT, "settings": {"model": None, "proxy": None, "browser": None}, "health": None})
    rb = client().robots.create(name="x", recipe_id="r9")
    assert calls[0]["body"] == {"name": "x", "recipe_id": "r9"}
    assert rb.settings == {"model": None, "proxy": None, "browser": None, "secrets": []}
    assert rb.health is None


def test_list_get_pause_resume_delete(http):
    handlers, calls = http
    handlers["GET /v1/robots"] = (200, {"robots": [ROBOT]})
    handlers["GET /v1/robots/rb1"] = (200, ROBOT)
    handlers["POST /v1/robots/rb1/pause"] = (200, {**ROBOT, "status": "paused"})
    handlers["POST /v1/robots/rb1/resume"] = (200, ROBOT)
    handlers["DELETE /v1/robots/rb1"] = (200, {"deleted": True, "id": "rb1"})
    c = client()
    assert c.robots.list(limit=10)[0].name == "Book prices"
    assert calls[0]["query"] == {"limit": "10"}
    assert c.robots.get("rb1").health.repairs == 0
    assert c.robots.pause("rb1").status == "paused"
    assert c.robots.resume("rb1").status == "active"
    assert c.robots.delete("rb1") is None


def test_update_sends_only_given_fields_none_clears(http):
    handlers, calls = http
    handlers["PATCH /v1/robots/rb1"] = (200, ROBOT)
    c = client()
    c.robots.update("rb1", name="New", schedule=None, settings=None)
    # settings=None resets everything: no read first.
    assert [x["key"] for x in calls] == ["PATCH /v1/robots/rb1"]
    assert calls[0]["body"] == {"name": "New", "schedule": None, "settings": None}
    c.robots.update("rb1", name="Only name")
    assert calls[1]["body"] == {"name": "Only name"}


# The API's PATCH replaces settings whole (services/agents robots.go), so a
# settings update reads the robot and sends its settings with the new parts over them.
SECRET_ROBOT = {**ROBOT, "settings": {
    "model": {"llm": "browsa-smart"}, "proxy": {"network": "residential", "country": "us"},
    "browser": {"os": "mac", "screen": "1440x900"}, "secrets": ["DUMMY_LOGIN", "DUMMY_TOKEN"]}}


def test_update_proxy_only_keeps_secrets_and_other_parts(http):
    handlers, calls = http
    handlers["GET /v1/robots/rb1"] = (200, SECRET_ROBOT)
    handlers["PATCH /v1/robots/rb1"] = (200, SECRET_ROBOT)
    rb = client().robots.update("rb1", settings={"proxy": {"proxy_id": "p1"}})
    assert [x["key"] for x in calls] == ["GET /v1/robots/rb1", "PATCH /v1/robots/rb1"]
    assert calls[1]["body"] == {"settings": {
        "model": {"llm": "browsa-smart"}, "proxy": {"proxy_id": "p1"},
        "browser": {"os": "mac", "screen": "1440x900"}, "secrets": ["DUMMY_LOGIN", "DUMMY_TOKEN"]}}
    assert rb.settings["secrets"] == ["DUMMY_LOGIN", "DUMMY_TOKEN"]


def test_update_settings_none_part_goes_auto_and_secrets_can_change(http):
    handlers, calls = http
    handlers["GET /v1/robots/rb1"] = (200, SECRET_ROBOT)
    handlers["PATCH /v1/robots/rb1"] = (200, ROBOT)
    c = client()
    c.robots.update("rb1", settings={"model": None, "secrets": ["DUMMY_TOKEN"]})
    assert calls[1]["body"]["settings"] == {
        "model": None, "proxy": {"network": "residential", "country": "us"},
        "browser": {"os": "mac", "screen": "1440x900"}, "secrets": ["DUMMY_TOKEN"]}


def test_update_settings_on_robot_without_settings(http):
    handlers, calls = http
    handlers["GET /v1/robots/rb1"] = (200, {**ROBOT, "settings": None})
    handlers["PATCH /v1/robots/rb1"] = (200, ROBOT)
    client().robots.update("rb1", name="n", settings={"secrets": ["DUMMY_LOGIN"]})
    assert calls[1]["body"] == {"name": "n", "settings": {"secrets": ["DUMMY_LOGIN"]}}


def test_robot_parses_secrets_and_warnings():
    rb = Robot.from_response({**SECRET_ROBOT, "settings_warnings": [
        {"code": "SECRET_NOT_FOUND", "secret": "LATER_KEY", "message": "LATER_KEY is not in this workspace's Secrets."}]})
    assert rb.settings["secrets"] == ["DUMMY_LOGIN", "DUMMY_TOKEN"]
    assert rb.settings_warnings[0]["code"] == "SECRET_NOT_FOUND"


def test_run_runs_alerts_read(http):
    handlers, calls = http
    handlers["POST /v1/robots/rb1/run"] = (202, RUN)
    handlers["GET /v1/robots/rb1/runs"] = (200, {"robot_id": "rb1", "runs": [RUN]})
    handlers["GET /v1/robots/rb1/alerts"] = (200, {"robot_id": "rb1", "alerts": [
        {"id": "a1", "robot_id": "rb1", "robot_run_id": "rr1", "row": 0, "field": "price", "rule": "lt 20", "old": 25, "new": 18}]})
    handlers["POST /v1/robots/rb1/alerts/read"] = (200, {"robot_id": "rb1", "alerts_unread": 0})
    c = client()
    run = c.robots.run("rb1", inputs=[{"url": "https://c"}])
    assert calls[0]["body"] == {"inputs": [{"url": "https://c"}]}
    assert run.status == "queued" and run.rows_pending == 2 and not run.done
    c.robots.run("rb1")
    assert calls[1]["body"] == {}
    assert c.robots.runs("rb1")[0].id == "rr1"
    a = c.robots.alerts("rb1", limit=5)[0]
    assert isinstance(a, RobotAlert) and a.field == "price" and a.rule == "lt 20" and a.new == 18
    assert c.robots.mark_alerts_read("rb1") is None


def test_robot_runs_get_and_wait(http, monkeypatch):
    handlers, calls = http
    done = {**RUN, "status": "partial", "rows_ok": 1, "rows_failed": 1, "rows_pending": 0, "credits": 3, "rows": [
        {"row": 0, "input": {"url": "https://a"}, "status": "ok", "output": {"price": 18}, "credits": 3,
         "recipe_run_id": "x1", "duration_ms": 2100, "alerts": [], "changed_fields": ["price"]},
        {"row": 1, "input": {"url": "https://b"}, "status": "failed", "output": None, "error_code": "blocked",
         "error_message": "bot wall", "credits": 0, "recipe_run_id": "x2", "alerts": [], "changed_fields": []},
    ]}
    seq = [{**RUN, "status": "running"}, done]
    handlers["GET /v1/robot-runs/rr1"] = lambda q: (200, seq.pop(0))
    monkeypatch.setattr(browsa.client.time, "sleep", lambda s: None)
    run = client().robot_runs.wait("rr1", poll=0.01)
    assert run.status == "partial" and run.done and run.credits == 3
    assert run.rows[0].output == {"price": 18} and run.rows[0].changed_fields == ["price"]
    assert run.rows[1].error_code == "blocked" and run.rows[1].credits == 0


def test_robot_runs_wait_times_out(http):
    handlers, _ = http
    handlers["GET /v1/robot-runs/rr1"] = (200, {**RUN, "status": "running"})
    with pytest.raises(errors.TimeoutError):
        client().robot_runs.wait("rr1", timeout=0.0, poll=1.0)


def test_robot_runs_export_csv_and_json(http):
    handlers, calls = http
    handlers["GET /v1/robot-runs/rr1/export"] = lambda q: (
        (200, {"robot_run_id": "rr1", "rows": [{"row": 0}]}) if q.get("format") == "json"
        else (200, b"row,url,price\n0,https://a,18\n", "text/csv; charset=utf-8"))
    c = client()
    csv = c.robot_runs.export("rr1")
    assert isinstance(csv, str) and csv.startswith("row,url,price")
    assert calls[0]["query"] == {"format": "csv"}
    j = c.robot_runs.export("rr1", format="json", items=10)
    assert j["rows"] == [{"row": 0}]
    assert calls[1]["query"] == {"format": "json", "items": "10"}


def test_errors_carry_code(http):
    handlers, _ = http
    handlers["POST /v1/robots/rb1/run"] = (503, {"error": "robots are off", "code": "ROBOTS_UNAVAILABLE"})
    with pytest.raises(errors.APIError) as ei:
        client().robots.run("rb1")
    assert ei.value.code == "ROBOTS_UNAVAILABLE"


def test_async_client_robots(http):
    handlers, calls = http
    handlers["GET /v1/robots"] = (200, {"robots": [ROBOT]})
    handlers["GET /v1/robot-runs/rr1"] = (200, {**RUN, "status": "completed"})

    async def go():
        async with browsa.AsyncClient("agt_live_test", base_url="https://api.test") as c:
            rbs = await c.robots.list()
            run = await c.robot_runs.wait("rr1")
            return rbs, run

    rbs, run = asyncio.run(go())
    assert rbs[0].id == "rb1" and run.status == "completed"
