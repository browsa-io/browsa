from __future__ import annotations

import json

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.tools import ToolException
from pydantic import ValidationError

from langchain_browsa import (
    BrowsaExtractTool,
    BrowsaScrapeTool,
    BrowsaScreenshotTool,
    BrowsaTaskTool,
)

from .conftest import JOB_ID, PNG_B64, TEST_KEY, FakeHTTP, HTTPFail, job

# ─── configuration ──────────────────────────────────────────────────────────


def test_api_key_from_env_is_sent_as_header(fake_http: FakeHTTP) -> None:
    BrowsaScrapeTool().invoke({"url": "https://example.com"})
    (req,) = fake_http.calls("POST", "/v1/quick/scrape")
    assert req.headers["x-api-key"] == TEST_KEY
    assert req.url.startswith("https://browsa.io/v1/")


def test_explicit_api_key_wins_over_env(fake_http: FakeHTTP) -> None:
    BrowsaScrapeTool(api_key="agt_live_explicit").invoke({"url": "https://example.com"})
    assert fake_http.requests[-1].headers["x-api-key"] == "agt_live_explicit"


def test_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BROWSA_API_KEY")
    with pytest.raises((ValueError, ValidationError), match="BROWSA_API_KEY"):
        BrowsaTaskTool()


def test_api_key_is_secret() -> None:
    tool = BrowsaTaskTool(llm_api_key="sk-ant-secret")
    assert TEST_KEY not in repr(tool)
    assert "sk-ant-secret" not in repr(tool)


def test_custom_base_url(fake_http: FakeHTTP) -> None:
    BrowsaScrapeTool(base_url="https://staging.example.test").invoke({"url": "https://example.com"})
    assert fake_http.requests[-1].url.startswith("https://staging.example.test/v1/quick/scrape")


# ─── task tool ──────────────────────────────────────────────────────────────


def test_task_defaults_to_hosted_tier_and_returns_outcome(fake_http: FakeHTTP) -> None:
    out = BrowsaTaskTool().invoke({"task": "Return the H1 of example.com"})
    (create,) = fake_http.calls("POST", "^/v1/tasks$")
    assert create.body["task"] == "Return the H1 of example.com"
    assert create.body["llm"] == "browsa"
    assert "llm_api_key" not in create.body
    assert out["status"] == "completed"
    assert out["outcome"] == "completed"
    assert out["succeeded"] is True
    assert out["final_result"] == "Example Domain"
    assert out["job_id"] == JOB_ID
    assert out["credits_charged"] == 9
    # The live link from the 202 is kept although the final job has none.
    assert out["live_url"] == "https://browsa.io/live/abc"


def test_task_completed_with_failed_outcome_is_not_success(fake_http: FakeHTTP) -> None:
    fake_http.add(
        "GET",
        rf"^/v1/jobs/{JOB_ID}$",
        job(
            "completed",
            outcome="failed",
            final_result="Could not find a search box on the page.",
            outcome_message="The agent finished but could not do the task.",
        ),
    )
    out = BrowsaTaskTool().invoke({"task": "Search for shoes"})
    assert out["status"] == "completed"
    assert out["outcome"] == "failed"
    assert out["succeeded"] is False
    assert out["outcome_message"].startswith("The agent finished")


def test_task_partial_result_is_not_success(fake_http: FakeHTTP) -> None:
    fake_http.add(
        "GET",
        rf"^/v1/jobs/{JOB_ID}$",
        job("completed", outcome="step_limit_reached", result={"partial": True}),
    )
    out = BrowsaTaskTool().invoke({"task": "List every product"})
    assert out["outcome"] == "step_limit_reached"
    assert out["partial"] is True
    assert out["succeeded"] is False


def test_task_failed_status(fake_http: FakeHTTP) -> None:
    fake_http.add(
        "GET",
        rf"^/v1/jobs/{JOB_ID}$",
        job(
            "failed",
            outcome="blocked_by_bot_check",
            final_result=None,
            error_code="BOT_CHECK_BLOCKED",
            error_message="A bot check stayed up.",
            signals=["bot_check_seen"],
        ),
    )
    out = BrowsaTaskTool().invoke({"task": "Open a protected page"})
    assert out["status"] == "failed"
    assert out["succeeded"] is False
    assert out["error_code"] == "BOT_CHECK_BLOCKED"
    assert out["signals"] == ["bot_check_seen"]
    assert out["final_result"] is None


def test_task_polls_until_terminal_and_reports_live_url(fake_http: FakeHTTP) -> None:
    fake_http.add("POST", "^/v1/tasks$", job("queued"))
    fake_http.add(
        "GET",
        rf"^/v1/jobs/{JOB_ID}$",
        [
            job("running", live_url="https://browsa.io/live/xyz"),
            job("running", live_url="https://browsa.io/live/xyz"),
            job("completed"),
        ],
    )
    seen: list[str] = []
    tool = BrowsaTaskTool(poll_interval=0, on_live_url=seen.append)
    out = tool.invoke({"task": "t"})
    assert out["succeeded"] is True
    assert out["live_url"] == "https://browsa.io/live/xyz"
    assert seen == ["https://browsa.io/live/xyz"]
    assert len(fake_http.calls("GET", "/v1/jobs/")) == 3
    assert fake_http.calls("GET", "/v1/jobs/")[0].query == {"wait": "30"}


def test_task_options_output_schema_and_own_key(fake_http: FakeHTTP) -> None:
    schema = {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
    }
    fake_http.add(
        "GET",
        rf"^/v1/jobs/{JOB_ID}$",
        job(
            "completed",
            final_result='{"title": "Example Domain"}',
            result={"structured_output": {"title": "Example Domain"}},
        ),
    )
    tool = BrowsaTaskTool(
        llm="anthropic:claude-sonnet-5-5",
        llm_api_key="sk-ant-test",
        reasoning="low",
        output_schema=schema,
        max_steps=15,
        max_credits=20,
        allowed_domains=["example.com"],
        task_options={"country": "US"},
    )
    out = tool.invoke({"task": "Return the title", "initial_url": "https://example.com"})
    (create,) = fake_http.calls("POST", "^/v1/tasks$")
    assert create.body["llm"] == "anthropic:claude-sonnet-5-5"
    assert create.body["llm_api_key"] == "sk-ant-test"
    assert create.body["reasoning"] == "low"
    assert create.body["output_schema"] == schema
    assert create.body["max_steps"] == 15
    assert create.body["max_credits"] == 20
    assert create.body["allowed_domains"] == ["example.com"]
    assert create.body["country"] == "US"
    assert create.body["initial_url"] == "https://example.com"
    assert out["structured_output"] == {"title": "Example Domain"}


def test_task_timeout_raises_tool_exception_with_job_id(fake_http: FakeHTTP) -> None:
    fake_http.add("GET", rf"^/v1/jobs/{JOB_ID}$", job("running"))
    tool = BrowsaTaskTool(wait_timeout=0, poll_interval=0)
    with pytest.raises(ToolException, match=JOB_ID):
        tool.invoke({"task": "slow"})


def test_api_error_becomes_tool_exception(fake_http: FakeHTTP) -> None:
    fake_http.add(
        "POST",
        "^/v1/tasks$",
        HTTPFail(402, {"error": "out of credit", "code": "INSUFFICIENT_CREDIT", "request_id": "r1"}),
    )
    with pytest.raises(ToolException, match="INSUFFICIENT_CREDIT"):
        BrowsaTaskTool().invoke({"task": "t"})
    msg = BrowsaTaskTool(handle_tool_error=True).invoke({"task": "t"})
    assert "INSUFFICIENT_CREDIT" in msg


def test_task_as_tool_call_returns_json_tool_message() -> None:
    tool = BrowsaTaskTool()
    msg = tool.invoke({"name": tool.name, "args": {"task": "t"}, "id": "call_1", "type": "tool_call"})
    assert isinstance(msg, ToolMessage)
    assert msg.tool_call_id == "call_1"
    data = json.loads(msg.content)
    assert data["outcome"] == "completed"
    assert data["final_result"] == "Example Domain"


async def test_task_async(fake_http: FakeHTTP) -> None:
    fake_http.add(
        "GET",
        rf"^/v1/jobs/{JOB_ID}$",
        [job("running", live_url="https://browsa.io/live/a"), job("completed", outcome="failed")],
    )
    out = await BrowsaTaskTool(poll_interval=0).ainvoke({"task": "t"})
    assert out["outcome"] == "failed"
    assert out["succeeded"] is False
    assert out["live_url"] == "https://browsa.io/live/abc"  # from the 202


async def test_task_async_timeout(fake_http: FakeHTTP) -> None:
    fake_http.add("GET", rf"^/v1/jobs/{JOB_ID}$", job("running"))
    with pytest.raises(ToolException, match="still running"):
        await BrowsaTaskTool(wait_timeout=0, poll_interval=0).ainvoke({"task": "t"})


def test_tool_schema_is_what_the_model_sees() -> None:
    schema = BrowsaTaskTool().tool_call_schema.model_json_schema()
    assert set(schema["properties"]) == {"task", "initial_url"}
    assert schema["required"] == ["task"]


# ─── scrape ─────────────────────────────────────────────────────────────────


def test_scrape_defaults_to_markdown(fake_http: FakeHTTP) -> None:
    out = BrowsaScrapeTool().invoke({"url": "https://example.com"})
    (req,) = fake_http.calls("POST", "/v1/quick/scrape")
    assert req.body == {"url": "https://example.com", "formats": ["markdown"]}
    assert out["markdown"].startswith("# Example Domain")
    assert out["http_status"] == 200


def test_scrape_options_and_formats(fake_http: FakeHTTP) -> None:
    tool = BrowsaScrapeTool(wait_ms=500, max_chars=1000, country="DE", block=["image"])
    tool.invoke({"url": "https://example.com", "formats": ["text", "links"]})
    (req,) = fake_http.calls("POST", "/v1/quick/scrape")
    assert req.body == {
        "url": "https://example.com",
        "formats": ["text", "links"],
        "wait_ms": 500,
        "max_chars": 1000,
        "country": "DE",
        "block": ["image"],
    }


def test_scrape_rejects_unknown_format() -> None:
    with pytest.raises(ValidationError):
        BrowsaScrapeTool().invoke({"url": "https://example.com", "formats": ["pdf"]})


async def test_scrape_async(fake_http: FakeHTTP) -> None:
    out = await BrowsaScrapeTool().ainvoke({"url": "https://example.org"})
    assert out["url"] == "https://example.org"
    assert len(fake_http.calls("POST", "/v1/quick/scrape")) == 1


# ─── extract ────────────────────────────────────────────────────────────────


def test_extract_with_prompt_and_key(fake_http: FakeHTTP) -> None:
    tool = BrowsaExtractTool(llm_api_key="sk-ant-x", llm="anthropic:claude-sonnet-5-5")
    out = tool.invoke({"url": "https://example.com", "prompt": "Return the title"})
    (req,) = fake_http.calls("POST", "/v1/quick/extract")
    assert req.body == {
        "url": "https://example.com",
        "prompt": "Return the title",
        "llm_api_key": "sk-ant-x",
        "llm": "anthropic:claude-sonnet-5-5",
    }
    assert out["data"] == {"title": "Example Domain"}


def test_extract_with_schema_and_saved_key(fake_http: FakeHTTP) -> None:
    schema = {"type": "object", "properties": {"title": {"type": "string"}}}
    BrowsaExtractTool(llm_key_id="key_1").invoke({"url": "https://example.com", "json_schema": schema})
    (req,) = fake_http.calls("POST", "/v1/quick/extract")
    assert req.body == {"url": "https://example.com", "schema": schema, "llm_key_id": "key_1"}


def test_extract_default_schema(fake_http: FakeHTTP) -> None:
    schema = {"type": "object", "properties": {"price": {"type": "number"}}}
    BrowsaExtractTool(json_schema=schema).invoke({"url": "https://example.com"})
    (req,) = fake_http.calls("POST", "/v1/quick/extract")
    assert req.body["schema"] == schema


def test_extract_needs_prompt_or_schema(fake_http: FakeHTTP) -> None:
    with pytest.raises(ToolException, match="prompt or a json_schema"):
        BrowsaExtractTool().invoke({"url": "https://example.com"})
    assert fake_http.calls("POST", "/v1/quick/extract") == []


async def test_extract_async(fake_http: FakeHTTP) -> None:
    out = await BrowsaExtractTool().ainvoke({"url": "https://example.com", "prompt": "title"})
    assert out["text"] == "Example Domain"


# ─── screenshot ─────────────────────────────────────────────────────────────


def test_screenshot_direct_invoke_returns_text(fake_http: FakeHTTP) -> None:
    out = BrowsaScreenshotTool().invoke({"url": "https://example.com"})
    assert isinstance(out, str)
    assert "PNG screenshot of https://example.com" in out
    assert "full page" in out
    (req,) = fake_http.calls("POST", "/v1/quick/screenshot")
    assert req.body == {"url": "https://example.com", "full_page": True}


def test_screenshot_tool_call_has_png_artifact(fake_http: FakeHTTP) -> None:
    tool = BrowsaScreenshotTool()
    msg = tool.invoke(
        {"name": tool.name, "args": {"url": "https://example.com", "full_page": False}, "id": "c1", "type": "tool_call"}
    )
    assert isinstance(msg, ToolMessage)
    assert msg.artifact["screenshot_png_b64"] == PNG_B64
    assert "viewport" in msg.content
    assert fake_http.calls("POST", "/v1/quick/screenshot")[0].body["full_page"] is False


def test_screenshot_include_image_block() -> None:
    tool = BrowsaScreenshotTool(include_image=True)
    msg = tool.invoke({"name": tool.name, "args": {"url": "https://example.com"}, "id": "c1", "type": "tool_call"})
    blocks = msg.content
    assert blocks[0]["type"] == "text"
    assert blocks[1] == {"type": "image", "base64": PNG_B64, "mime_type": "image/png"}


def test_screenshot_without_image_is_an_error(fake_http: FakeHTTP) -> None:
    fake_http.add("POST", r"^/v1/quick/screenshot$", {"url": "https://example.com", "http_status": 200})
    with pytest.raises(ToolException, match="no screenshot"):
        BrowsaScreenshotTool().invoke({"url": "https://example.com"})


async def test_screenshot_async() -> None:
    out = await BrowsaScreenshotTool().ainvoke({"url": "https://example.com"})
    assert "PNG screenshot" in out


# ─── async without an AsyncClient ───────────────────────────────────────────


async def test_async_falls_back_to_sync_client_in_thread(
    fake_http: FakeHTTP, monkeypatch: pytest.MonkeyPatch
) -> None:
    from browsa import Client

    monkeypatch.delenv("BROWSA_API_KEY")
    tool = BrowsaScrapeTool(client=Client(TEST_KEY))
    assert tool.async_client is None
    out = await tool.ainvoke({"url": "https://example.com"})
    assert out["http_status"] == 200
