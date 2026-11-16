"""CrewAI tools for Browsa (https://browsa.io).

Each tool calls the official ``browsa`` Python SDK. Every page is opened in
Phantom, Browsa's cloud browser.

Costs in credits (https://browsa.io/pricing):

- BrowsaTaskTool: browser time (1 credit per started 12 minutes) + 1 + 1 per
  5 steps, plus 5 on a hosted tier (``llm="browsa"``, the default here). A
  task that fails gets its browser charge back and is not charged for steps
  or the hosted surcharge.
- BrowsaScrapeTool, BrowsaExtractTool, BrowsaScreenshotTool: 1 credit per page.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from pathlib import Path
from typing import Any, Literal

from browsa.errors import BrowsaError
from pydantic import BaseModel, Field

from ._common import BrowsaBaseTool, failure, failure_from_error

# Outcomes (GET /v1/jobs/{id}) of a task that ended with a usable answer.
# "completed" is a full answer. The three limits below can stop a task that
# still returned a partial result: its status is then "completed".
_PARTIAL_OUTCOMES = {"step_limit_reached", "budget_reached", "timed_out"}
_TERMINAL = {"completed", "failed", "cancelled"}


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _truncate(text: str, limit: int | None) -> str:
    if limit is None or limit <= 0 or len(text) <= limit:
        return text
    return text[:limit] + f"\n\n[truncated: {len(text) - limit} more characters]"


# ── BrowsaTaskTool ─────────────────────────────────────────────────────────


class BrowsaTaskToolSchema(BaseModel):
    """Input for BrowsaTaskTool."""

    task: str = Field(
        ...,
        description=(
            "What the browser agent should do, in plain language, as one "
            "self-contained instruction. Name the website or URL to start from "
            "and say exactly what to return, e.g. 'Go to books.toscrape.com, "
            "open the Travel category and return the title and price of the "
            "first 3 books.'"
        ),
    )
    start_url: str | None = Field(
        default=None,
        description="Optional URL the browser opens before the agent starts.",
    )
    output_schema: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional JSON Schema for the answer, when you need structured data. "
            "The top level must be an object, e.g. "
            '{"type": "object", "properties": {"price": {"type": "number"}}, '
            '"required": ["price"]}. For a list, wrap it in an object property. '
            "No $ref, oneOf, anyOf or allOf. Leave empty for a text answer."
        ),
    )


class BrowsaTaskTool(BrowsaBaseTool):
    """Run a plain-language task in a Phantom cloud browser and return the answer.

    A browser agent on Browsa opens pages, clicks, types and reads, then
    returns its answer. By default it runs on Browsa's hosted model tier
    ``browsa`` (no model key needed, 5 extra credits per task). Pass your own
    model with ``llm`` plus ``llm_api_key`` (or a saved ``llm_key_id``) to pay
    your provider for tokens instead.

    The result is JSON with ``result`` (``structured_output`` when an
    ``output_schema`` was given, otherwise the agent's text answer),
    ``outcome``, ``outcome_message``, ``job_id``, ``live_url`` and
    ``credits_charged``. A task whose ``outcome`` is not a success (for example
    ``failed`` with status ``completed``: the agent finished but could not do
    the task) is reported as a tool failure.

    Args:
        api_key: Browsa API key; defaults to ``BROWSA_API_KEY``.
        llm: Model. A hosted tier (``"browsa"``, ``"browsa-fast"``,
            ``"browsa-smart"``) or your own, e.g.
            ``"anthropic:claude-sonnet-5-5"``. Defaults to ``"browsa"``.
        llm_api_key: Your own model provider key, used for this task only.
        llm_key_id: A model key saved in the Browsa workspace.
        reasoning: ``"low"``, ``"medium"`` or ``"high"``.
        max_steps: Most agent steps (Browsa default 20, max 100).
        max_credits: Most credits one task may charge.
        output_schema: Default JSON Schema for every call; the agent's own
            ``output_schema`` argument overrides it.
        timeout: Seconds to wait for the task (default 600).
        cancel_unfinished: Cancel the task when it is still running at
            ``timeout`` or stops to ask a question (default True), so it does
            not keep its browser.
        task_options: Any other ``POST /v1/tasks`` fields, e.g.
            ``{"allowed_domains": ["example.com"], "country": "US"}``.
    """

    name: str = "Browsa browser task"
    description: str = (
        "Runs a task in a real cloud web browser (Phantom, by Browsa) driven by a "
        "browser agent: it opens websites, clicks, types, searches, scrolls and "
        "reads, then returns the answer. Use it for anything that needs a live "
        "website, interaction or several pages: comparing prices across stores, "
        "searching a site, reading pages behind menus or forms. Describe the "
        "whole job in one instruction and say what to return. Slower than "
        "reading a single page, since the agent works step by step. Returns "
        "JSON with result, outcome and live_url."
    )
    args_schema: type[BaseModel] = BrowsaTaskToolSchema

    llm: str | None = "browsa"
    llm_api_key: str | None = Field(default=None, repr=False, exclude=True)
    llm_key_id: str | None = None
    reasoning: Literal["low", "medium", "high"] | None = None
    max_steps: int | None = Field(default=None, ge=1, le=100)
    max_credits: int | None = None
    output_schema: dict[str, Any] | None = None
    timeout: float = 600.0
    poll_wait: int = Field(default=30, ge=1, le=120)
    cancel_unfinished: bool = True
    task_options: dict[str, Any] = Field(default_factory=dict)

    def _run(
        self,
        task: str,
        start_url: str | None = None,
        output_schema: dict[str, Any] | None = None,
        **_: Any,
    ) -> Any:
        schema = output_schema or self.output_schema
        body: dict[str, Any] = dict(self.task_options)
        for key, value in {
            "llm": self.llm,
            "llm_api_key": self.llm_api_key,
            "llm_key_id": self.llm_key_id,
            "reasoning": self.reasoning,
            "max_steps": self.max_steps,
            "max_credits": self.max_credits,
            "initial_url": start_url,
            "output_schema": schema,
        }.items():
            if value is not None:
                body[key] = value

        try:
            job = self.client.create_task(task=task, **body)
        except BrowsaError as err:
            return failure_from_error("task", err)

        live_url = job.live_url
        deadline = time.monotonic() + self.timeout
        try:
            while job.status not in _TERMINAL:
                if job.status == "input_required":
                    return self._stop_unfinished(
                        job,
                        live_url,
                        "The browser agent stopped to ask a question this tool cannot answer.",
                        code="INPUT_REQUIRED",
                    )
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._stop_unfinished(
                        job,
                        live_url,
                        f"The task did not finish within {self.timeout:g} seconds.",
                        code="TOOL_TIMEOUT",
                    )
                wait = max(1, min(self.poll_wait, int(remaining)))
                job = self.client.get_job(job.id, wait=wait)
                live_url = live_url or job.live_url
        except BrowsaError as err:
            return failure_from_error("task", err)

        return self._report(job, live_url)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)

    def _stop_unfinished(self, job: Any, live_url: str | None, message: str, *, code: str) -> Any:
        cancelled = False
        if self.cancel_unfinished:
            try:
                self.client.cancel_job(job.id)
                cancelled = True
            except BrowsaError:
                cancelled = False
        tail = " It was cancelled." if cancelled else " It is still running on Browsa."
        return failure(
            message + tail,
            code=code,
            retryable=code == "TOOL_TIMEOUT",
            details={
                "job_id": job.id,
                "status": job.status,
                "question": job.input_question,
                "live_url": live_url,
                "cancelled": cancelled,
            },
        )

    @staticmethod
    def _report(job: Any, live_url: str | None) -> Any:
        raw_result = job.raw.get("result") if isinstance(job.raw, dict) else None
        raw_result = raw_result if isinstance(raw_result, dict) else {}
        structured = raw_result.get("structured_output")
        answer = structured if structured is not None else job.final_result

        outcome = job.outcome or (
            "completed" if job.status == "completed" and not job.error_code else None
        )
        report: dict[str, Any] = {
            "result": answer,
            "status": job.status,
            "outcome": outcome,
            "outcome_message": job.outcome_message,
            "partial": outcome in _PARTIAL_OUTCOMES,
            "job_id": job.id,
            "live_url": live_url,
            "credits_charged": job.credits_charged,
        }
        if raw_result.get("purchase_blocked"):
            report["purchase_blocked"] = raw_result["purchase_blocked"]
        if job.signals:
            report["signals"] = job.signals

        # Read the outcome, not only the status: "completed" with outcome
        # "failed" means the agent finished but could not do the task.
        succeeded = job.status == "completed" and (
            outcome == "completed" or (outcome in _PARTIAL_OUTCOMES and answer)
        )
        if succeeded:
            return _dumps({k: v for k, v in report.items() if v is not None})

        report["error_code"] = job.error_code
        report["error_message"] = job.error_message
        message = job.outcome_message or job.error_message or "The browser task did not succeed."
        return failure(
            f"Browsa task ended with outcome '{outcome or job.status}': {message}",
            code=job.error_code or outcome,
            retryable=outcome in ("stalled", "timed_out", "blocked_by_bot_check"),
            details=report,
        )


# ── BrowsaScrapeTool ───────────────────────────────────────────────────────

ScrapeFormat = Literal["markdown", "html", "text", "links"]


def _default_formats() -> list[ScrapeFormat]:
    return ["markdown", "links"]


class BrowsaScrapeToolSchema(BaseModel):
    """Input for BrowsaScrapeTool."""

    url: str = Field(
        ..., description="Full URL of the page to read, starting with http:// or https://."
    )


class BrowsaScrapeTool(BrowsaBaseTool):
    """Open one URL in a Phantom cloud browser and return the rendered page.

    No model involved; 1 credit per page. Returns the page as Markdown by
    default (JavaScript runs first, so single-page apps work).

    Args:
        api_key: Browsa API key; defaults to ``BROWSA_API_KEY``.
        formats: Any of ``"markdown"``, ``"html"``, ``"text"``, ``"links"``.
            Default ``["markdown", "links"]``.
        max_chars: Cap on text and Markdown (Browsa default 100000; here 30000
            to keep the agent's context small).
        wait_ms: Extra settle time after load, in milliseconds.
        country: ISO-2 country; see Browsa's proxy docs.
        block: Resource types to block, e.g. ``["image", "font", "media"]``.
        max_links: Most links listed in the output (default 100).
    """

    name: str = "Browsa scrape page"
    description: str = (
        "Reads one web page in a real cloud browser (Phantom, by Browsa) and "
        "returns its rendered content as Markdown plus the page's links. "
        "JavaScript runs first, so dynamic pages work. Use it to read a known "
        "URL; it does not click or type. Input: the full URL."
    )
    args_schema: type[BaseModel] = BrowsaScrapeToolSchema

    formats: list[ScrapeFormat] = Field(default_factory=_default_formats)
    max_chars: int | None = 30000
    wait_ms: int | None = Field(default=None, ge=0, le=60000)
    country: str | None = None
    block: list[str] | None = None
    max_links: int = 100

    def _run(self, url: str, **_: Any) -> Any:
        opts: dict[str, Any] = {"formats": list(self.formats)}
        for key, value in {
            "max_chars": self.max_chars,
            "wait_ms": self.wait_ms,
            "country": self.country,
            "block": self.block,
        }.items():
            if value is not None:
                opts[key] = value
        try:
            page = self.client.scrape(url, **opts)
        except BrowsaError as err:
            return failure_from_error("scrape", err)
        if not isinstance(page, dict):
            return failure("Browsa scrape returned no page.", details={"url": url})

        parts = [f"URL: {page.get('url') or url}"]
        if page.get("http_status") is not None:
            parts.append(f"HTTP status: {page['http_status']}")
        for fmt in ("markdown", "text", "html"):
            if fmt in self.formats and page.get(fmt):
                parts.append(f"\n{_truncate(str(page[fmt]), self.max_chars)}")
        links = page.get("links") or []
        if "links" in self.formats and links:
            shown = links[: self.max_links]
            more = f" (first {len(shown)} of {len(links)})" if len(links) > len(shown) else ""
            parts.append(f"\nLinks{more}:\n" + "\n".join(f"- {link}" for link in shown))
        return "\n".join(parts)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)


# ── BrowsaExtractTool ──────────────────────────────────────────────────────


class BrowsaExtractToolSchema(BaseModel):
    """Input for BrowsaExtractTool."""

    url: str = Field(..., description="Full URL of the page to extract data from.")
    prompt: str | None = Field(
        default=None,
        description="What to extract, in plain language, e.g. 'product name, price and stock status'.",
    )
    extraction_schema: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional JSON Schema of the fields to extract, e.g. "
            '{"type": "object", "properties": {"price": {"type": "number"}}}. '
            "Give this or prompt (the schema wins if both are given)."
        ),
    )


class BrowsaExtractTool(BrowsaBaseTool):
    """Extract structured data from one page rendered in a Phantom cloud browser.

    1 credit per page. With ``llm_api_key`` (an Anthropic or
    Anthropic-compatible key) or a saved ``llm_key_id``, Browsa runs the
    extraction and the tool returns the extracted JSON; your provider bills
    the tokens. Without a key, Browsa returns the page's clean text and the
    schema, and the tool hands both to your crew's own model to fill in.

    Args:
        api_key: Browsa API key; defaults to ``BROWSA_API_KEY``.
        llm_api_key: Anthropic(-compatible) key, used in memory for the call.
        llm_key_id: An Anthropic key saved in the Browsa workspace.
        llm: Model, e.g. ``"anthropic:claude-sonnet-5-5"``.
        llm_base_url: Anthropic-compatible proxy base URL.
        max_chars: Cap on page text returned when there is no key (30000).
        wait_ms: Extra settle time after load, in milliseconds.
        country: ISO-2 country.
    """

    name: str = "Browsa extract data"
    description: str = (
        "Extracts specific fields from one web page rendered in a real cloud "
        "browser (Phantom, by Browsa), e.g. a product's name, price and "
        "availability. Input: the URL plus a prompt describing the fields or a "
        "JSON Schema. Returns JSON, or the page text and schema for you to "
        "read the fields from."
    )
    args_schema: type[BaseModel] = BrowsaExtractToolSchema

    llm_api_key: str | None = Field(default=None, repr=False, exclude=True)
    llm_key_id: str | None = None
    llm: str | None = None
    llm_base_url: str | None = None
    max_chars: int | None = 30000
    wait_ms: int | None = Field(default=None, ge=0, le=60000)
    country: str | None = None

    def _run(
        self,
        url: str,
        prompt: str | None = None,
        extraction_schema: dict[str, Any] | None = None,
        **_: Any,
    ) -> Any:
        if not prompt and not extraction_schema:
            return failure(
                "Give either prompt (what to extract) or extraction_schema (a JSON Schema).",
                code="BAD_REQUEST",
            )
        opts: dict[str, Any] = {}
        for key, value in {
            "llm_api_key": self.llm_api_key,
            "llm_key_id": self.llm_key_id,
            "llm": self.llm,
            "llm_base_url": self.llm_base_url,
            "wait_ms": self.wait_ms,
            "country": self.country,
        }.items():
            if value is not None:
                opts[key] = value
        try:
            out = self.client.extract(url, schema=extraction_schema, prompt=prompt, **opts)
        except BrowsaError as err:
            return failure_from_error("extract", err)
        if not isinstance(out, dict):
            return failure("Browsa extract returned nothing.", details={"url": url})

        if out.get("data") is not None:
            return _dumps({"url": out.get("url") or url, "data": out["data"]})

        # No model key: Browsa returns the clean text and the schema so the
        # calling model can read the fields itself.
        lines = [
            f"URL: {out.get('url') or url}",
            "Read the requested fields from the page text below.",
        ]
        if prompt:
            lines.append(f"Requested: {prompt}")
        if out.get("schema"):
            lines.append("Schema:\n" + _dumps(out["schema"]))
        lines.append("Page text:\n" + _truncate(str(out.get("text") or ""), self.max_chars))
        return "\n".join(lines)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)


# ── BrowsaScreenshotTool ───────────────────────────────────────────────────


class BrowsaScreenshotToolSchema(BaseModel):
    """Input for BrowsaScreenshotTool."""

    url: str = Field(..., description="Full URL of the page to capture.")
    full_page: bool = Field(
        default=True,
        description="True for the full scrollable page, False for the visible viewport only.",
    )


class BrowsaScreenshotTool(BrowsaBaseTool):
    """Capture a PNG of a page in a Phantom cloud browser and save it to disk.

    1 credit per page. The PNG is written to ``output_dir`` and the tool
    returns its path (a base64 image would fill the agent's context).

    Args:
        api_key: Browsa API key; defaults to ``BROWSA_API_KEY``.
        output_dir: Folder for the PNG files (default ``browsa_screenshots``).
        wait_ms: Extra settle time after load, in milliseconds.
        country: ISO-2 country.
    """

    name: str = "Browsa screenshot page"
    description: str = (
        "Takes a PNG screenshot of a web page in a real cloud browser (Phantom, "
        "by Browsa) and saves it to a file. Returns the file path. Use it when "
        "you need an image of how a page looks. Input: the URL and whether to "
        "capture the full page."
    )
    args_schema: type[BaseModel] = BrowsaScreenshotToolSchema

    output_dir: str = "browsa_screenshots"
    wait_ms: int | None = None
    country: str | None = None

    def _run(self, url: str, full_page: bool = True, **_: Any) -> Any:
        opts: dict[str, Any] = {}
        if self.wait_ms is not None:
            opts["wait_ms"] = self.wait_ms
        if self.country is not None:
            opts["country"] = self.country
        try:
            out = self.client.screenshot(url, full_page=full_page, **opts)
        except BrowsaError as err:
            return failure_from_error("screenshot", err)
        b64 = out.get("screenshot_png_b64") if isinstance(out, dict) else None
        if not b64:
            return failure("Browsa returned no screenshot.", details={"url": url})
        try:
            png = base64.b64decode(b64)
        except ValueError:
            return failure(
                "Browsa returned a screenshot that is not valid base64.", details={"url": url}
            )

        folder = Path(self.output_dir)
        folder.mkdir(parents=True, exist_ok=True)
        slug = (
            re.sub(r"[^A-Za-z0-9]+", "-", re.sub(r"^https?://", "", url)).strip("-")[:60] or "page"
        )
        path = folder / f"{slug}-{int(time.time() * 1000)}.png"
        path.write_bytes(png)
        return _dumps(
            {
                "url": out.get("url") or url,
                "path": str(path.resolve()),
                "bytes": len(png),
                "full_page": full_page,
            }
        )

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)


__all__ = [
    "BrowsaExtractTool",
    "BrowsaExtractToolSchema",
    "BrowsaScrapeTool",
    "BrowsaScrapeToolSchema",
    "BrowsaScreenshotTool",
    "BrowsaScreenshotToolSchema",
    "BrowsaTaskTool",
    "BrowsaTaskToolSchema",
]
