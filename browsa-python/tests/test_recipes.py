"""Recipe (replay) methods against a mocked HTTP layer (urlopen). No network."""
import asyncio
import io
import json
import urllib.error
import urllib.parse

import pytest

import browsa
from browsa import errors
from browsa.types import Recipe, RecipeRun, RecipeVersion


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
    """Route urlopen to handlers keyed by 'METHOD /path'; record each call."""
    calls = []
    handlers = {}

    def fake_urlopen(req, timeout=None):
        u = urllib.parse.urlsplit(req.full_url)
        key = f"{req.get_method()} {u.path}"
        body = json.loads(req.data) if req.data else None
        calls.append({"key": key, "query": dict(urllib.parse.parse_qsl(u.query)), "body": body, "timeout": timeout})
        h = handlers.get(key)
        if h is None:
            raise AssertionError(f"no mock for {key}")
        status, out = h
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "err", {}, io.BytesIO(json.dumps(out).encode()))
        return _Resp(out, status)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return handlers, calls


RECIPE = {"id": "r1", "name": "shop-search", "status": "active", "current_version": 1, "repair_mode": "auto", "price_credits": 8,
          "recipe": {"name": "shop-search", "version": 1}}
RUN = {"id": "run1", "job_id": "run1", "recipe_id": "r1", "version": 1, "status": "ok", "params": {"query": "tv"},
       "output": {"items": [1]}, "error_code": None, "layers": [{"step": "s1", "layer": 1}], "layer_used": {"s1": 1},
       "repaired": False, "repaired_steps": [], "new_version": None, "duration_ms": 2100, "credits": 8,
       "price_credits": 8, "finished_at": "2026-11-18T00:00:03Z"}


def client():
    return browsa.Client("agt_live_test", base_url="https://api.test")


def test_create_recipe_from_job_and_upload(http):
    handlers, calls = http
    handlers["POST /v1/recipes"] = (201, RECIPE)
    r = client().create_recipe(from_job_id="job-1", name="shop-search", repair_mode="review")
    assert isinstance(r, Recipe) and r.id == "r1" and r.current_version == 1 and r.price_credits == 8
    assert calls[0]["body"] == {"from_job_id": "job-1", "name": "shop-search", "repair_mode": "review"}
    client().create_recipe(recipe={"name": "x", "steps": []})
    assert list(calls[1]["body"]) == ["recipe"]


def test_list_get_versions_promote_rollback_delete(http):
    handlers, calls = http
    handlers["GET /v1/recipes"] = (200, {"recipes": [RECIPE]})
    handlers["GET /v1/recipes/r1"] = (200, RECIPE)
    handlers["GET /v1/recipes/r1/versions"] = (200, {"versions": [{"version": 2, "status": "draft", "verified_at": "t"}]})
    handlers["POST /v1/recipes/r1/versions/2/promote"] = (200, dict(RECIPE, current_version=2))
    handlers["POST /v1/recipes/r1/rollback"] = (200, RECIPE)
    handlers["DELETE /v1/recipes/r1"] = (200, {"deleted": True})
    c = client()
    assert c.list_recipes(limit=5)[0].name == "shop-search"
    assert calls[0]["query"] == {"limit": "5"}
    assert c.get_recipe("r1").recipe["version"] == 1
    vs = c.list_recipe_versions("r1", include_recipe=True)
    assert isinstance(vs[0], RecipeVersion) and vs[0].version == 2 and vs[0].verified_at == "t"
    assert calls[2]["query"] == {"include": "recipe"}
    assert c.promote_recipe_version("r1", 2).current_version == 2
    c.rollback_recipe("r1", version=1)
    assert calls[4]["body"] == {"version": 1}
    c.rollback_recipe("r1")
    assert calls[5]["body"] == {}
    c.delete_recipe("r1")
    assert calls[6]["key"] == "DELETE /v1/recipes/r1"


def test_run_recipe_with_wait(http):
    handlers, calls = http
    handlers["POST /v1/recipes/r1/run"] = (200, RUN)
    run = client().run_recipe("r1", params={"query": "tv"}, wait=30, webhook_url="https://e.com/h",
                              proxy={"network": "residential", "country": "us"}, profile_id="agt_1")
    assert calls[0]["body"] == {"params": {"query": "tv"}, "wait": 30, "webhook_url": "https://e.com/h",
                                "proxy": {"network": "residential", "country": "us"}, "profile_id": "agt_1"}
    assert calls[0]["timeout"] == 40  # longer than the server's wait
    assert isinstance(run, RecipeRun) and run.done and run.output == {"items": [1]}
    assert run.credits == 8 and run.price_credits == 8 and run.layer_used == {"s1": 1} and run.duration_ms == 2100


def test_run_recipe_params_invalid(http):
    handlers, _ = http
    handlers["POST /v1/recipes/r1/run"] = (400, {"code": "PARAMS_INVALID", "error": "params do not match"})
    with pytest.raises(errors.APIError) as e:
        client().run_recipe("r1", params={})
    assert "params" in str(e.value)


def test_get_recipe_run_wait_is_capped_and_cancel(http):
    handlers, calls = http
    handlers["GET /v1/recipe-runs/run1"] = (200, dict(RUN, status="failed", error_code="blocked", credits=0))
    handlers["POST /v1/recipe-runs/run1/cancel"] = (200, dict(RUN, status="cancelled", error_code="cancelled"))
    run = client().get_recipe_run("run1", wait=90)
    assert calls[0]["query"] == {"wait": "60"}
    assert run.error_code == "blocked" and run.credits == 0
    assert client().cancel_recipe_run("run1").status == "cancelled"


def test_create_task_record_recipe_and_job_draft_id(http):
    handlers, calls = http
    handlers["POST /v1/tasks"] = (202, {"id": "j1", "status": "queued", "kind": "task"})
    handlers["GET /v1/jobs/j1"] = (200, {"id": "j1", "status": "completed", "kind": "task",
                                         "record_recipe": True, "recipe_draft_id": "r9"})
    c = client()
    c.create_task(task="find tvs", llm="browsa", record_recipe=True)
    assert calls[0]["body"]["record_recipe"] is True
    job = c.get_job("j1")
    assert job.record_recipe is True and job.recipe_draft_id == "r9"
    c.create_task(task="x", llm="browsa")
    assert "record_recipe" not in calls[2]["body"]


def test_async_run_recipe(http):
    handlers, _ = http
    handlers["POST /v1/recipes/r1/run"] = (202, dict(RUN, status="queued", output=None, finished_at=None))

    async def go():
        async with browsa.AsyncClient("agt_live_test", base_url="https://api.test") as c:
            return await c.run_recipe("r1", params={"query": "tv"})

    run = asyncio.run(go())
    assert run.status == "queued" and not run.done
