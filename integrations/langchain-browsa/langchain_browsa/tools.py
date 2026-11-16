"""LangChain tools for Browsa: agent tasks and the one-call quick endpoints.

Every tool runs in Phantom, Browsa's cloud browser. Configure the key with
the ``BROWSA_API_KEY`` environment variable or ``api_key=...``.
"""

from __future__ import annotations

import base64
from typing import Any, Callable, Literal, Optional

from browsa import Job
from browsa.errors import BrowsaError
from browsa.errors import TimeoutError as BrowsaTimeoutError
from langchain_core.callbacks import (
    AsyncCallbackManagerForToolRun,
    CallbackManagerForToolRun,
)
from langchain_core.tools import ToolException
from pydantic import BaseModel, Field, SecretStr, model_validator

from langchain_browsa._common import (
    BrowsaBaseTool,
    call_async,
    drop_none,
    job_result,
    to_tool_error,
)

Reasoning = Literal["low", "medium", "high"]
ScrapeFormat = Literal["markdown", "html", "text", "links"]


def _secret(v: Optional[SecretStr]) -> Optional[str]:
    return v.get_secret_value() if v is not None else None


# ─── Agent task ─────────────────────────────────────────────────────────────


class BrowsaTaskInput(BaseModel):
    """Input of the Browsa task tool."""

    task: str = Field(
        description=(
            "What the browser agent should do, in plain language, including "
            "what to return. Example: 'Open news.ycombinator.com and return "
            "the title and points of the top story.'"
        )
    )
    initial_url: Optional[str] = Field(
        default=None,
        description="Optional URL to open before the agent starts.",
    )


def task_result(job: Job, live_url: Optional[str]) -> dict:
    """Summarize a finished task job for a model.

    ``succeeded`` is True only when the job is ``completed`` AND its
    ``outcome`` is ``completed``: a job can be ``completed`` with outcome
    ``failed`` (the agent finished but could not do the task) or with a limit
    outcome such as ``step_limit_reached`` (a partial result).
    """
    result = job_result(job)
    outcome = job.outcome
    succeeded = (
        job.status == "completed"
        and (outcome == "completed" or (outcome is None and not job.error_code))
        and not result.get("partial")
    )
    out = {
        "job_id": job.id,
        "status": job.status,
        "outcome": outcome,
        "succeeded": succeeded,
        "final_result": job.final_result,
        "structured_output": result.get("structured_output"),
        "partial": result.get("partial"),
        "outcome_message": job.outcome_message,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "signals": job.signals or None,
        "step_count": job.step_count,
        "credits_charged": job.credits_charged,
        "duration_ms": job.duration_ms,
        "live_url": live_url,
    }
    return drop_none(
        out, keep=("status", "outcome", "succeeded", "final_result", "live_url")
    )


class BrowsaTaskTool(BrowsaBaseTool):
    """Run a plain-language task in a Phantom cloud browser with Browsa.

    An agent opens a real browser, clicks, types and reads pages until the
    task is done, then returns the answer. By default it runs on Browsa's
    hosted model tier ``llm="browsa"``, so no LLM key is needed.

    Setup:
        .. code-block:: bash

            pip install -U langchain-browsa
            export BROWSA_API_KEY="agt_live_..."

    Instantiate:
        .. code-block:: python

            from langchain_browsa import BrowsaTaskTool

            tool = BrowsaTaskTool()  # hosted tier "browsa"
            # Your own model key instead:
            # tool = BrowsaTaskTool(llm="anthropic:claude-sonnet-5-5",
            #                       llm_api_key="sk-ant-...")

    Invoke:
        .. code-block:: python

            out = tool.invoke({"task": "Open example.com and return the H1."})
            out["outcome"], out["final_result"]

    The result dict has ``status`` (the run ended), ``outcome`` (how it
    ended), ``succeeded``, ``final_result``, ``structured_output`` (with
    ``output_schema``), ``credits_charged`` and ``live_url``. Read
    ``outcome``, not only ``status``: ``status == "completed"`` with
    ``outcome == "failed"`` means the agent finished but could not do the task.
    """

    name: str = "browsa_task"
    description: str = (
        "Runs a task in a real cloud web browser (Phantom) driven by an AI "
        "agent: it opens pages, clicks, types and reads content, then returns "
        "the answer. Use it for anything that "
        "needs interaction with a website. Input: a plain-language task that "
        "says what to return. Output: final_result, plus outcome ('completed' "
        "means the task was done; any other value means it was not, or only "
        "partly) and succeeded (true or false)."
    )
    args_schema: type[BaseModel] = BrowsaTaskInput

    llm: Optional[str] = "browsa"
    """Model: a hosted tier (``"browsa"``, ``"browsa-fast"``, ``"browsa-smart"``,
    no key needed) or a provider model such as ``"anthropic:claude-sonnet-5-5"``
    with ``llm_api_key``, ``llm_key_id`` or a default key saved in the workspace."""

    llm_api_key: Optional[SecretStr] = None
    """Your own LLM provider key for this task. Browsa deletes it when the task ends."""

    llm_key_id: Optional[str] = None
    """Id of an LLM key saved in the Browsa workspace."""

    llm_base_url: Optional[str] = None
    """Anthropic- or OpenAI-compatible endpoint for your own key."""

    reasoning: Optional[Reasoning] = None
    """How much the model reasons: ``"low"``, ``"medium"`` or ``"high"``."""

    task_output_schema: Optional[dict[str, Any]] = None
    """JSON Schema (an object at the top level) for the answer, sent as the
    API's ``output_schema``. The validated answer is returned as
    ``structured_output``. The constructor also accepts it as
    ``output_schema=...`` (the attribute has another name because
    ``output_schema`` is already a LangChain ``Runnable`` property)."""

    max_steps: Optional[int] = None
    """Most agent steps (API default 20, max 100)."""

    max_credits: Optional[int] = None
    """Most credits the task may charge. The task stops before going over it."""

    allowed_domains: Optional[list[str]] = None
    """Only sites the agent may open, e.g. ``["example.com", "*.example.com"]``."""

    task_options: dict[str, Any] = Field(default_factory=dict)
    """Other ``browsa.Client.create_task`` options, e.g. ``country``, ``proxy``,
    ``proxy_id``, ``secrets``, ``os_type``."""

    wait_timeout: Optional[float] = 600
    """Seconds to wait for the task to finish (None: no limit)."""

    poll_interval: float = 2.0
    """Seconds between job polls (the SDK long-polls in between)."""

    on_live_url: Optional[Callable[[str], None]] = Field(default=None, exclude=True)
    """Called once with the Phantom Live link as soon as it is known. The link
    works only while the task runs and opens once."""

    @model_validator(mode="before")
    @classmethod
    def _accept_output_schema(cls, data: Any) -> Any:
        if isinstance(data, dict) and "output_schema" in data:
            data = dict(data)
            schema = data.pop("output_schema")
            data.setdefault("task_output_schema", schema)
        return data

    def _create_kwargs(self, task: str, initial_url: Optional[str]) -> dict[str, Any]:
        kw: dict[str, Any] = dict(self.task_options)
        kw.update(
            task=task,
            llm=self.llm,
            llm_api_key=_secret(self.llm_api_key),
            llm_key_id=self.llm_key_id,
            llm_base_url=self.llm_base_url,
            reasoning=self.reasoning,
            max_steps=self.max_steps,
            max_credits=self.max_credits,
        )
        if initial_url:
            kw["initial_url"] = initial_url
        if self.task_output_schema is not None:
            kw["output_schema"] = self.task_output_schema
        if self.allowed_domains is not None:
            kw["allowed_domains"] = self.allowed_domains
        return kw

    def _live_tracker(self, first: Job) -> tuple[dict, Callable[[Job], None]]:
        seen: dict = {"live_url": None}

        def note(j: Job) -> None:
            if j.live_url and not seen["live_url"]:
                seen["live_url"] = j.live_url
                if self.on_live_url is not None:
                    self.on_live_url(j.live_url)

        note(first)
        return seen, note

    def _timeout_error(self, job_id: str) -> ToolException:
        return ToolException(
            f"Browsa task {job_id} is still running after {self.wait_timeout}s. "
            "It keeps running; check it later with browsa.Client.get_job("
            f"'{job_id}') or cancel it with cancel_job."
        )

    def _run(
        self,
        task: str,
        initial_url: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> dict:
        job = self._call("create_task", **self._create_kwargs(task, initial_url))
        seen, note = self._live_tracker(job)
        try:
            done = self.client.wait_for_job(
                job.id,
                poll=self.poll_interval,
                timeout=self.wait_timeout,
                on_progress=note,
            )
        except BrowsaTimeoutError as e:
            raise self._timeout_error(job.id) from e
        except BrowsaError as e:
            raise to_tool_error(e) from e
        note(done)
        return task_result(done, seen["live_url"])

    async def _arun(
        self,
        task: str,
        initial_url: Optional[str] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> dict:
        job = await self._acall("create_task", **self._create_kwargs(task, initial_url))
        seen, note = self._live_tracker(job)
        try:
            done = await call_async(
                self.async_client,
                self.client,
                "wait_for_job",
                job.id,
                poll=self.poll_interval,
                timeout=self.wait_timeout,
                on_progress=note,
            )
        except BrowsaTimeoutError as e:
            raise self._timeout_error(job.id) from e
        except BrowsaError as e:
            raise to_tool_error(e) from e
        note(done)
        return task_result(done, seen["live_url"])


# ─── Quick scrape ───────────────────────────────────────────────────────────


class BrowsaScrapeInput(BaseModel):
    """Input of the Browsa scrape tool."""

    url: str = Field(description="The URL of the page to fetch.")
    formats: Optional[list[ScrapeFormat]] = Field(
        default=None,
        description=(
            "What to return: any of 'markdown', 'html', 'text', 'links'. "
            "Default: markdown."
        ),
    )


class BrowsaScrapeTool(BrowsaBaseTool):
    """Fetch one page in a Phantom cloud browser and return it as Markdown,
    HTML, text and/or links (``POST /v1/quick/scrape``). No LLM involved.

    Instantiate:
        .. code-block:: python

            from langchain_browsa import BrowsaScrapeTool

            tool = BrowsaScrapeTool()

    Invoke:
        .. code-block:: python

            page = tool.invoke({"url": "https://example.com"})
            page["markdown"], page["http_status"]
    """

    name: str = "browsa_scrape"
    description: str = (
        "Fetches one web page in a real cloud browser (Phantom), after its "
        "JavaScript runs, and returns its content as Markdown (or html, text, "
        "links). Input: url. Use it to read a page; it does not click or type."
    )
    args_schema: type[BaseModel] = BrowsaScrapeInput

    formats: list[str] = Field(default_factory=lambda: ["markdown"])
    """Default formats when the call does not name any. ``"screenshot"`` adds
    a viewport PNG as base64."""

    wait_ms: Optional[int] = None
    """Extra settle time after load, in ms (API default 3000, max 60000)."""

    max_chars: Optional[int] = None
    """Cap for text and Markdown, in characters (API default 100000)."""

    country: Optional[str] = None
    """ISO-2 country code."""

    block: Optional[list[str]] = None
    """Resource types to block, e.g. ``["image", "font", "media"]``."""

    scrape_options: dict[str, Any] = Field(default_factory=dict)
    """Other options passed to ``browsa.Client.scrape``."""

    def _kwargs(self, formats: Optional[list[str]]) -> dict[str, Any]:
        kw: dict[str, Any] = dict(self.scrape_options)
        kw["formats"] = list(formats or self.formats)
        for k, v in (
            ("wait_ms", self.wait_ms),
            ("max_chars", self.max_chars),
            ("country", self.country),
            ("block", self.block),
        ):
            if v is not None:
                kw[k] = v
        return kw

    def _run(
        self,
        url: str,
        formats: Optional[list[str]] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> dict:
        return self._call("scrape", url, **self._kwargs(formats))

    async def _arun(
        self,
        url: str,
        formats: Optional[list[str]] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> dict:
        return await self._acall("scrape", url, **self._kwargs(formats))


# ─── Quick extract ──────────────────────────────────────────────────────────


class BrowsaExtractInput(BaseModel):
    """Input of the Browsa extract tool."""

    url: str = Field(description="The URL of the page to extract data from.")
    prompt: Optional[str] = Field(
        default=None,
        description="What to extract, in plain language. Give this or json_schema.",
    )
    json_schema: Optional[dict[str, Any]] = Field(
        default=None,
        description="JSON Schema of the data to extract. Give this or prompt.",
    )


class BrowsaExtractTool(BrowsaBaseTool):
    """Extract structured data from one page (``POST /v1/quick/extract``).

    With an Anthropic key (``llm_api_key``) or a saved key id
    (``llm_key_id``), Browsa runs the extraction and the result has ``data``.
    Without a key, the result has the page's clean ``text`` and the ``schema``
    so your own model can do the extraction.

    Instantiate:
        .. code-block:: python

            from langchain_browsa import BrowsaExtractTool

            tool = BrowsaExtractTool(llm_api_key="sk-ant-...")

    Invoke:
        .. code-block:: python

            out = tool.invoke({
                "url": "https://example.com",
                "prompt": "Return the page heading and the first link.",
            })
            out.get("data")
    """

    name: str = "browsa_extract"
    description: str = (
        "Extracts structured data from one web page loaded in a real cloud "
        "browser (Phantom). Input: url plus either prompt (what to extract) or "
        "json_schema. Output: the extracted data as JSON (or the page text "
        "and schema when no extraction model key is configured)."
    )
    args_schema: type[BaseModel] = BrowsaExtractInput

    json_schema: Optional[dict[str, Any]] = None
    """Default schema when a call gives neither prompt nor json_schema."""

    llm_api_key: Optional[SecretStr] = None
    """Anthropic(-compatible) key for the extraction, used in memory for one call."""

    llm_key_id: Optional[str] = None
    """A saved Anthropic key in the workspace, instead of ``llm_api_key``."""

    llm: Optional[str] = None
    """Extraction model, e.g. ``"anthropic:claude-sonnet-5-5"``."""

    llm_base_url: Optional[str] = None
    """Anthropic-compatible base URL (not with ``llm_key_id``)."""

    wait_ms: Optional[int] = None
    country: Optional[str] = None
    block: Optional[list[str]] = None

    extract_options: dict[str, Any] = Field(default_factory=dict)
    """Other options passed to ``browsa.Client.extract``."""

    def _kwargs(
        self, prompt: Optional[str], json_schema: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        schema = json_schema if json_schema is not None else (
            None if prompt else self.json_schema
        )
        if schema is None and not prompt:
            raise ToolException("browsa_extract needs a prompt or a json_schema.")
        kw: dict[str, Any] = dict(self.extract_options)
        kw["schema"] = schema
        kw["prompt"] = prompt
        for k, v in (
            ("llm_api_key", _secret(self.llm_api_key)),
            ("llm_key_id", self.llm_key_id),
            ("llm", self.llm),
            ("llm_base_url", self.llm_base_url),
            ("wait_ms", self.wait_ms),
            ("country", self.country),
            ("block", self.block),
        ):
            if v is not None:
                kw[k] = v
        return kw

    def _run(
        self,
        url: str,
        prompt: Optional[str] = None,
        json_schema: Optional[dict[str, Any]] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> dict:
        return self._call("extract", url, **self._kwargs(prompt, json_schema))

    async def _arun(
        self,
        url: str,
        prompt: Optional[str] = None,
        json_schema: Optional[dict[str, Any]] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> dict:
        return await self._acall("extract", url, **self._kwargs(prompt, json_schema))


# ─── Quick screenshot ───────────────────────────────────────────────────────


class BrowsaScreenshotInput(BaseModel):
    """Input of the Browsa screenshot tool."""

    url: str = Field(description="The URL of the page to capture.")
    full_page: bool = Field(
        default=True,
        description="Capture the full scrollable page (true) or only the viewport.",
    )


class BrowsaScreenshotTool(BrowsaBaseTool):
    """Capture a PNG screenshot of a page (``POST /v1/quick/screenshot``).

    The tool returns content and an artifact. The content is a short text
    for the model (plus the image itself when ``include_image=True``, for
    models that accept images in tool results). The artifact is the API's
    response, with the PNG as base64 in ``screenshot_png_b64``; it is on
    ``ToolMessage.artifact`` when the tool is called with a ``ToolCall``.

    Instantiate:
        .. code-block:: python

            from langchain_browsa import BrowsaScreenshotTool

            tool = BrowsaScreenshotTool()

    Invoke:
        .. code-block:: python

            msg = tool.invoke({
                "name": tool.name, "type": "tool_call", "id": "1",
                "args": {"url": "https://example.com"},
            })
            png_b64 = msg.artifact["screenshot_png_b64"]
    """

    name: str = "browsa_screenshot"
    description: str = (
        "Takes a PNG screenshot of a web page in a real cloud browser "
        "(Phantom). Input: url and full_page. Use it to see how a page looks."
    )
    args_schema: type[BaseModel] = BrowsaScreenshotInput
    response_format: Literal["content", "content_and_artifact"] = "content_and_artifact"

    include_image: bool = False
    """Also put the image in the content as an image block. Leave False for
    model providers that accept only text in tool results."""

    wait_ms: Optional[int] = None
    country: Optional[str] = None

    screenshot_options: dict[str, Any] = Field(default_factory=dict)
    """Other options passed to ``browsa.Client.screenshot``."""

    def _kwargs(self, full_page: bool) -> dict[str, Any]:
        kw: dict[str, Any] = dict(self.screenshot_options)
        kw["full_page"] = full_page
        if self.wait_ms is not None:
            kw["wait_ms"] = self.wait_ms
        if self.country is not None:
            kw["country"] = self.country
        return kw

    def _content(self, url: str, full_page: bool, resp: dict) -> tuple[Any, dict]:
        b64 = resp.get("screenshot_png_b64") if isinstance(resp, dict) else None
        if not b64:
            raise ToolException(f"Browsa returned no screenshot for {url}.")
        try:
            size = len(base64.b64decode(b64, validate=False))
        except Exception:
            size = len(b64) * 3 // 4
        where = resp.get("url") or url
        text = (
            f"Captured a PNG screenshot of {where} "
            f"({'full page' if full_page else 'viewport'}, {size} bytes)."
        )
        if self.include_image:
            content: Any = [
                {"type": "text", "text": text},
                {"type": "image", "base64": b64, "mime_type": "image/png"},
            ]
        else:
            content = text
        return content, resp

    def _run(
        self,
        url: str,
        full_page: bool = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> tuple[Any, dict]:
        resp = self._call("screenshot", url, **self._kwargs(full_page))
        return self._content(url, full_page, resp)

    async def _arun(
        self,
        url: str,
        full_page: bool = True,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> tuple[Any, dict]:
        resp = await self._acall("screenshot", url, **self._kwargs(full_page))
        return self._content(url, full_page, resp)


__all__ = [
    "BrowsaExtractInput",
    "BrowsaExtractTool",
    "BrowsaScrapeInput",
    "BrowsaScrapeTool",
    "BrowsaScreenshotInput",
    "BrowsaScreenshotTool",
    "BrowsaTaskInput",
    "BrowsaTaskTool",
    "task_result",
]
