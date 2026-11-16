"""Unit tests for crewai-browsa. The HTTP layer is faked (see conftest.py)."""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import pytest
from crewai.tools import BaseTool, ToolFailure

import crewai_browsa
from crewai_browsa import (
    BrowsaExtractTool,
    BrowsaScrapeTool,
    BrowsaScreenshotTool,
    BrowsaTaskTool,
    _common,
)

from .conftest import TEST_KEY, FakeAPI

JOB_ID = "11111111-2222-3333-4444-555555555555"
JOB_PATH = f"/v1/jobs/{JOB_ID}"
LIVE = "https://app.browsa.io/live/abc"


def _accepted(**extra: object) -> dict:
    return {"id": JOB_ID, "status": "queued", "kind": "task", "live_url": LIVE, **extra}


def _finished(
    status: str = "completed", outcome: str | None = "completed", **extra: object
) -> dict:
    body = {
        "id": JOB_ID,
        "status": status,
        "kind": "task",
        "outcome": outcome,
        "outcome_message": extra.pop("outcome_message", None),
        "credits_charged": extra.pop("credits_charged", 8),
        "result": extra.pop("result", {"final_result": "done"}),
    }
    body.update(extra)
    return body


# ── configuration ─────────────────────────────────────────────────────────


def test_missing_api_key_raises() -> None:
    with pytest.raises(ValueError, match="BROWSA_API_KEY"):
        BrowsaScrapeTool()


def test_api_key_from_env(monkeypatch: pytest.MonkeyPatch, api: FakeAPI) -> None:
    monkeypatch.setenv("BROWSA_API_KEY", TEST_KEY)
    api.add("POST", "/v1/quick/scrape", {"url": "https://example.com", "markdown": "# Hi"})
    BrowsaScrapeTool().run(url="https://example.com")
    sent = api.calls("POST", "/v1/quick/scrape")[0]
    assert sent.headers["x-api-key"] == TEST_KEY


def test_explicit_key_and_base_url(api: FakeAPI) -> None:
    api.add("POST", "/v1/quick/scrape", {"markdown": "x"})
    tool = BrowsaScrapeTool(api_key=TEST_KEY, base_url="https://staging.example.test")
    tool.run(url="https://example.com")
    assert api.sent[0].headers["x-api-key"] == TEST_KEY


def test_base_url_from_env(monkeypatch: pytest.MonkeyPatch, api: FakeAPI) -> None:
    monkeypatch.setenv("BROWSA_BASE_URL", "https://staging.example.test")
    tool = BrowsaScrapeTool(api_key=TEST_KEY)
    assert tool.client._t.base_url == "https://staging.example.test"


def test_bad_key_prefix_is_rejected_by_sdk() -> None:
    with pytest.raises(ValueError, match="agt_"):
        BrowsaTaskTool(api_key="sk-not-a-browsa-key")


def test_secrets_not_in_repr_or_dump() -> None:
    tool = BrowsaTaskTool(api_key=TEST_KEY, llm="openai:gpt-6", llm_api_key="sk-secret-123")
    assert "sk-secret-123" not in repr(tool)
    assert "sk-secret-123" not in json.dumps(tool.model_dump(mode="json"), default=str)
    assert TEST_KEY not in repr(tool)


def test_tools_are_crewai_tools_with_described_args() -> None:
    tools = [
        BrowsaTaskTool(api_key=TEST_KEY),
        BrowsaScrapeTool(api_key=TEST_KEY),
        BrowsaExtractTool(api_key=TEST_KEY),
        BrowsaScreenshotTool(api_key=TEST_KEY),
    ]
    names = set()
    for tool in tools:
        assert isinstance(tool, BaseTool)
        assert "Phantom" in tool.description
        assert "Chromium" not in tool.description
        names.add(tool.name)
        schema = tool.args_schema.model_json_schema()
        for prop in schema["properties"].values():
            assert prop.get("description"), f"{tool.name}: undocumented argument"
        tool.to_structured_tool()  # what an Agent converts it to
        assert [e.name for e in tool.env_vars] == ["BROWSA_API_KEY"]
        assert tool.package_dependencies == ["browsa"]
    assert len(names) == 4


def test_public_exports() -> None:
    for name in ("BrowsaTaskTool", "BrowsaScrapeTool", "BrowsaExtractTool", "BrowsaScreenshotTool"):
        assert name in crewai_browsa.__all__
    assert crewai_browsa.__version__


# ── BrowsaTaskTool ────────────────────────────────────────────────────────


def test_task_hosted_default_returns_result_outcome_and_live_link(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add("GET", JOB_PATH, {"id": JOB_ID, "status": "running", "kind": "task"})
    api.add("GET", JOB_PATH, _finished(result={"final_result": "Top story: X"}))

    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="Return the top HN story title")

    data = json.loads(out)
    assert data["result"] == "Top story: X"
    assert data["outcome"] == "completed"
    assert data["status"] == "completed"
    assert data["partial"] is False
    assert data["live_url"] == LIVE  # kept from the 202: finished jobs drop it
    assert data["job_id"] == JOB_ID
    assert data["credits_charged"] == 8

    body = api.calls("POST", "/v1/tasks")[0].body
    assert body["task"] == "Return the top HN story title"
    assert body["llm"] == "browsa"
    assert "llm_api_key" not in body
    polls = api.calls("GET", JOB_PATH)
    assert len(polls) == 2
    assert polls[0].query["wait"] == "30"


def test_task_output_schema_returns_structured_output(api: FakeAPI) -> None:
    schema = {"type": "object", "properties": {"price": {"type": "number"}}, "required": ["price"]}
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add(
        "GET",
        JOB_PATH,
        _finished(
            result={"final_result": '{"price": 19.99}', "structured_output": {"price": 19.99}}
        ),
    )

    out = BrowsaTaskTool(api_key=TEST_KEY).run(
        task="Find the price", start_url="https://shop.example.com/p/1", output_schema=schema
    )

    assert json.loads(out)["result"] == {"price": 19.99}
    body = api.calls("POST", "/v1/tasks")[0].body
    assert body["output_schema"] == schema
    assert body["initial_url"] == "https://shop.example.com/p/1"


def test_task_default_output_schema_and_options(api: FakeAPI) -> None:
    schema = {"type": "object", "properties": {"title": {"type": "string"}}}
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add("GET", JOB_PATH, _finished(result={"structured_output": {"title": "T"}}))
    tool = BrowsaTaskTool(
        api_key=TEST_KEY,
        output_schema=schema,
        max_steps=30,
        max_credits=40,
        reasoning="high",
        task_options={"allowed_domains": ["example.com"]},
    )
    assert json.loads(tool.run(task="t"))["result"] == {"title": "T"}
    body = api.calls("POST", "/v1/tasks")[0].body
    assert body["output_schema"] == schema
    assert body["max_steps"] == 30
    assert body["max_credits"] == 40
    assert body["reasoning"] == "high"
    assert body["allowed_domains"] == ["example.com"]


def test_task_own_model_key(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add("GET", JOB_PATH, _finished())
    BrowsaTaskTool(
        api_key=TEST_KEY, llm="anthropic:claude-sonnet-5-5", llm_api_key="sk-ant-xyz"
    ).run(task="t")
    body = api.calls("POST", "/v1/tasks")[0].body
    assert body["llm"] == "anthropic:claude-sonnet-5-5"
    assert body["llm_api_key"] == "sk-ant-xyz"


def test_task_saved_key_and_no_llm(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add("GET", JOB_PATH, _finished())
    BrowsaTaskTool(api_key=TEST_KEY, llm=None, llm_key_id="key-1").run(task="t")
    body = api.calls("POST", "/v1/tasks")[0].body
    assert "llm" not in body
    assert body["llm_key_id"] == "key-1"


def test_task_completed_status_with_failed_outcome_is_a_failure(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add(
        "GET",
        JOB_PATH,
        _finished(
            outcome="failed",
            outcome_message="The agent finished but could not do the task.",
            result={"final_result": "Could not find the product", "success": False},
        ),
    )

    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")

    assert isinstance(out, ToolFailure)
    assert out.code == "failed"
    assert "could not do the task" in out.message
    assert out.details["status"] == "completed"
    assert out.details["outcome"] == "failed"
    assert out.details["live_url"] == LIVE
    assert out.details["result"] == "Could not find the product"


def test_task_failed_status_is_a_failure_with_error_code(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add(
        "GET",
        JOB_PATH,
        _finished(
            status="failed",
            outcome="blocked_by_bot_check",
            outcome_message="A bot check stayed up.",
            error_code="BOT_CHECK_BLOCKED",
            error_message="blocked",
            result={},
        ),
    )
    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")
    assert isinstance(out, ToolFailure)
    assert out.code == "BOT_CHECK_BLOCKED"
    assert out.retryable is True
    assert out.details["error_code"] == "BOT_CHECK_BLOCKED"


def test_task_partial_result_is_returned_and_flagged(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add(
        "GET",
        JOB_PATH,
        _finished(
            outcome="step_limit_reached",
            outcome_message="The agent used all of its steps before it finished.",
            result={"final_result": "2 of 3 prices", "partial": True},
        ),
    )
    data = json.loads(BrowsaTaskTool(api_key=TEST_KEY).run(task="t"))
    assert data["partial"] is True
    assert data["outcome"] == "step_limit_reached"
    assert data["result"] == "2 of 3 prices"


def test_task_limit_without_result_is_a_failure(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add(
        "GET",
        JOB_PATH,
        _finished(status="failed", outcome="step_limit_reached", error_code="STALLED", result={}),
    )
    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")
    assert isinstance(out, ToolFailure)
    assert out.code == "STALLED"


def test_task_input_required_is_cancelled(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add(
        "GET",
        JOB_PATH,
        {"id": JOB_ID, "status": "input_required", "kind": "task", "input_question": "Which size?"},
    )
    api.add("POST", f"{JOB_PATH}/cancel", None, status=204)

    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")

    assert isinstance(out, ToolFailure)
    assert out.code == "INPUT_REQUIRED"
    assert out.details["question"] == "Which size?"
    assert out.details["cancelled"] is True
    assert len(api.calls("POST", f"{JOB_PATH}/cancel")) == 1


def test_task_timeout_cancels(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add("POST", f"{JOB_PATH}/cancel", None, status=204)
    out = BrowsaTaskTool(api_key=TEST_KEY, timeout=0).run(task="t")
    assert isinstance(out, ToolFailure)
    assert out.code == "TOOL_TIMEOUT"
    assert out.retryable is True
    assert out.details["live_url"] == LIVE
    assert len(api.calls("POST", f"{JOB_PATH}/cancel")) == 1


def test_task_timeout_can_leave_job_running(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    out = BrowsaTaskTool(api_key=TEST_KEY, timeout=0, cancel_unfinished=False).run(task="t")
    assert isinstance(out, ToolFailure)
    assert out.details["cancelled"] is False
    assert "still running" in out.message
    assert api.calls("POST", f"{JOB_PATH}/cancel") == []


def test_task_insufficient_credit(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/tasks",
        {"error": "not enough credits", "code": "INSUFFICIENT_CREDIT", "request_id": "req-1"},
        status=402,
    )
    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")
    assert isinstance(out, ToolFailure)
    assert out.code == "INSUFFICIENT_CREDIT"
    assert out.retryable is False
    assert out.details["request_id"] == "req-1"
    assert out.details["http_status"] == 402


def test_task_rate_limited_is_retryable(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/tasks",
        {"error": "no free browser slot", "code": "TOO_MANY_REQUESTS"},
        status=429,
        headers={"Retry-After": "30"},
    )
    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")
    assert isinstance(out, ToolFailure)
    assert out.retryable is True
    assert out.details["retry_after_seconds"] == 30.0


def test_task_arun(api: FakeAPI) -> None:
    api.add("POST", "/v1/tasks", _accepted(), status=202)
    api.add("GET", JOB_PATH, _finished(result={"final_result": "async ok"}))
    out = asyncio.run(BrowsaTaskTool(api_key=TEST_KEY).arun(task="t"))
    assert json.loads(out)["result"] == "async ok"


def test_task_args_are_validated() -> None:
    tool = BrowsaTaskTool(api_key=TEST_KEY)
    with pytest.raises(ValueError, match="validation failed"):
        tool.run(output_schema={"type": "object"})  # task missing


def test_failure_without_toolfailure_support(monkeypatch: pytest.MonkeyPatch, api: FakeAPI) -> None:
    monkeypatch.setattr(_common, "_ToolFailure", None)
    api.add("POST", "/v1/tasks", {"error": "bad key", "code": "UNAUTHORIZED"}, status=401)
    out = BrowsaTaskTool(api_key=TEST_KEY).run(task="t")
    assert isinstance(out, str)
    assert out.startswith("Browsa task failed: bad key")
    assert out.endswith("(code: UNAUTHORIZED)")


# ── BrowsaScrapeTool ──────────────────────────────────────────────────────


def test_scrape_returns_markdown_and_links(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/quick/scrape",
        {
            "url": "https://example.com/final",
            "http_status": 200,
            "markdown": "# Example\nBody",
            "links": ["https://example.com/a", "https://example.com/b"],
            "cost_credits": 1,
        },
    )
    out = BrowsaScrapeTool(api_key=TEST_KEY).run(url="https://example.com")
    assert "URL: https://example.com/final" in out
    assert "HTTP status: 200" in out
    assert "# Example\nBody" in out
    assert "- https://example.com/b" in out
    body = api.sent[0].body
    assert body == {
        "url": "https://example.com",
        "formats": ["markdown", "links"],
        "max_chars": 30000,
    }


def test_scrape_options_and_truncation(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/quick/scrape",
        {"text": "x" * 50, "links": [f"https://e.com/{i}" for i in range(5)]},
    )
    tool = BrowsaScrapeTool(
        api_key=TEST_KEY,
        formats=["text", "links"],
        max_chars=10,
        wait_ms=500,
        country="US",
        block=["image"],
        max_links=2,
    )
    out = tool.run(url="https://example.com")
    assert "x" * 10 + "\n\n[truncated: 40 more characters]" in out
    assert "Links (first 2 of 5)" in out
    assert "https://e.com/3" not in out
    body = api.sent[0].body
    assert body["formats"] == ["text", "links"]
    assert body["wait_ms"] == 500
    assert body["country"] == "US"
    assert body["block"] == ["image"]


def test_scrape_target_unreachable(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/quick/scrape",
        {"error": "the site failed", "code": "TARGET_UNREACHABLE"},
        status=502,
    )
    out = BrowsaScrapeTool(api_key=TEST_KEY).run(url="https://nope.invalid")
    assert isinstance(out, ToolFailure)
    assert out.code == "TARGET_UNREACHABLE"
    assert "Browsa scrape failed" in out.message


def test_scrape_rejects_bad_format() -> None:
    with pytest.raises(ValueError):
        BrowsaScrapeTool(api_key=TEST_KEY, formats=["pdf"])


# ── BrowsaExtractTool ─────────────────────────────────────────────────────


def test_extract_with_model_key_returns_data(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/quick/extract",
        {"url": "https://shop.example.com/p", "data": {"name": "Kettle", "price": 39.5}},
    )
    schema = {
        "type": "object",
        "properties": {"name": {"type": "string"}, "price": {"type": "number"}},
    }
    out = BrowsaExtractTool(api_key=TEST_KEY, llm_api_key="sk-ant-1").run(
        url="https://shop.example.com/p", extraction_schema=schema
    )
    assert json.loads(out) == {
        "url": "https://shop.example.com/p",
        "data": {"name": "Kettle", "price": 39.5},
    }
    body = api.sent[0].body
    assert body["schema"] == schema
    assert body["llm_api_key"] == "sk-ant-1"
    assert "prompt" not in body


def test_extract_without_model_key_returns_text_for_the_crew_model(api: FakeAPI) -> None:
    api.add(
        "POST",
        "/v1/quick/extract",
        {
            "url": "https://shop.example.com/p",
            "text": "Kettle. Price: $39.50. In stock.",
            "schema": {"type": "object", "properties": {"price": {"type": "number"}}},
        },
    )
    out = BrowsaExtractTool(api_key=TEST_KEY).run(
        url="https://shop.example.com/p", prompt="the price"
    )
    assert "Requested: the price" in out
    assert "Price: $39.50" in out
    assert '"price"' in out
    body = api.sent[0].body
    assert body["prompt"] == "the price"
    assert "llm_api_key" not in body


def test_extract_needs_prompt_or_schema(api: FakeAPI) -> None:
    out = BrowsaExtractTool(api_key=TEST_KEY).run(url="https://example.com")
    assert isinstance(out, ToolFailure)
    assert api.sent == []


# ── BrowsaScreenshotTool ──────────────────────────────────────────────────


PNG = b"\x89PNG\r\n\x1a\nfake"


def test_screenshot_saves_png(api: FakeAPI, tmp_path: Path) -> None:
    api.add(
        "POST",
        "/v1/quick/screenshot",
        {"url": "https://example.com/", "screenshot_png_b64": base64.b64encode(PNG).decode()},
    )
    out = BrowsaScreenshotTool(api_key=TEST_KEY, output_dir=str(tmp_path)).run(
        url="https://example.com/", full_page=False
    )
    data = json.loads(out)
    path = Path(data["path"])
    assert path.parent == tmp_path.resolve()
    assert path.name.startswith("example-com-")
    assert path.read_bytes() == PNG
    assert data["bytes"] == len(PNG)
    assert api.sent[0].body == {"url": "https://example.com/", "full_page": False}


def test_screenshot_missing_image_is_a_failure(api: FakeAPI, tmp_path: Path) -> None:
    api.add("POST", "/v1/quick/screenshot", {"url": "https://example.com/"})
    out = BrowsaScreenshotTool(api_key=TEST_KEY, output_dir=str(tmp_path)).run(
        url="https://example.com/"
    )
    assert isinstance(out, ToolFailure)
    assert list(tmp_path.iterdir()) == []
