"""Document loader: Browsa scrape, batch and crawl results as LangChain Documents."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterator, Sequence
from typing import Any, Literal, Optional, Union

from browsa import AsyncClient, BrowsaError, Client, Job
from browsa.client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT
from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document

from langchain_browsa._common import (
    build_clients,
    call_async,
    envelope_job_id,
    job_result,
)

logger = logging.getLogger(__name__)

Mode = Literal["scrape", "batch", "crawl"]
ContentFormat = Literal["markdown", "text", "html"]


class BrowsaLoader(BaseLoader):
    """Load web pages as Documents, fetched in Phantom, Browsa's cloud browser.

    Modes:

    * ``"scrape"``: one ``POST /v1/quick/scrape`` per URL, in order.
    * ``"batch"``: all URLs as one batch job (``POST /v1/quick/batch``, up to
      100 URLs), then wait for it.
    * ``"crawl"``: follow links from one start URL (``POST /v1/quick/crawl``),
      up to ``max_pages``, then wait for it.

    Each Document's ``page_content`` is the page in ``content_format``
    (Markdown by default) and its metadata has ``source`` (the URL the
    browser landed on), ``requested_url``, ``http_status`` and, for batch
    and crawl, ``job_id``. Pages that failed are skipped and logged.

    Setup:
        .. code-block:: bash

            pip install -U langchain-browsa
            export BROWSA_API_KEY="agt_live_..."

    Instantiate:
        .. code-block:: python

            from langchain_browsa import BrowsaLoader

            loader = BrowsaLoader("https://example.com")
            crawl = BrowsaLoader("https://docs.example.com", mode="crawl", max_pages=10)

    Load:
        .. code-block:: python

            docs = loader.load()
            docs[0].page_content[:200], docs[0].metadata["source"]
    """

    def __init__(
        self,
        url: Union[str, Sequence[str]],
        *,
        mode: Mode = "scrape",
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        content_format: ContentFormat = "markdown",
        formats: Optional[Sequence[str]] = None,
        max_pages: int = 25,
        wait_timeout: Optional[float] = 600,
        request_timeout: float = DEFAULT_TIMEOUT,
        client: Optional[Client] = None,
        async_client: Optional[AsyncClient] = None,
        **params: Any,
    ) -> None:
        """Create the loader.

        Args:
            url: One URL or a list of URLs. ``"crawl"`` takes exactly one start URL.
            mode: ``"scrape"``, ``"batch"`` or ``"crawl"``.
            api_key: Browsa API key; defaults to the ``BROWSA_API_KEY`` env var.
            base_url: API base URL.
            content_format: Which format becomes ``page_content``.
            formats: Formats to request; defaults to ``[content_format]``.
                ``"links"`` adds the page's links to the metadata.
            max_pages: Page cap for ``"crawl"``.
            wait_timeout: Seconds to wait for a batch or crawl job.
            request_timeout: Per-request HTTP timeout of the SDK client.
            client: A ``browsa.Client`` to use instead of building one.
            async_client: A ``browsa.AsyncClient`` to use instead of building one.
            **params: Other endpoint options, e.g. ``wait_ms``, ``max_chars``,
                ``country``, ``block``; for crawl ``max_depth``,
                ``same_domain``, ``include_regex``, ``exclude_regex``.
        """
        urls = [url] if isinstance(url, str) else list(url)
        if not urls:
            raise ValueError("BrowsaLoader needs at least one URL.")
        if mode not in ("scrape", "batch", "crawl"):
            raise ValueError(f"mode must be 'scrape', 'batch' or 'crawl', not {mode!r}")
        if mode == "crawl" and len(urls) != 1:
            raise ValueError("mode='crawl' takes exactly one start URL.")
        self.urls = urls
        self.mode: Mode = mode
        self.content_format: ContentFormat = content_format
        fmts = list(formats) if formats else [content_format]
        if content_format not in fmts:
            fmts.append(content_format)
        self.formats = fmts
        self.max_pages = max_pages
        self.wait_timeout = wait_timeout
        self.params = params
        self.client, self.async_client = build_clients(
            api_key,
            base_url=base_url,
            timeout=request_timeout,
            client=client,
            async_client=async_client,
        )

    # ── helpers ──────────────────────────────────────────────────────────

    def _scrape_kwargs(self) -> dict[str, Any]:
        kw = dict(self.params)
        kw["formats"] = list(self.formats)
        return kw

    def _crawl_kwargs(self) -> dict[str, Any]:
        kw = self._scrape_kwargs()
        kw["max_pages"] = self.max_pages
        return kw

    def _to_document(
        self, data: dict, requested_url: str, job_id: Optional[str] = None
    ) -> Document:
        content = data.get(self.content_format)
        if not isinstance(content, str):
            content = data.get("markdown") or data.get("text") or data.get("html") or ""
        meta: dict[str, Any] = {
            "source": data.get("url") or requested_url,
            "requested_url": requested_url,
            "http_status": data.get("http_status"),
        }
        page_meta = data.get("meta")
        if isinstance(page_meta, dict):
            title = page_meta.get("title")
            if isinstance(title, str) and title:
                meta["title"] = title
        if isinstance(data.get("links"), list):
            meta["links"] = data["links"]
        if job_id:
            meta["job_id"] = job_id
        meta["mode"] = self.mode
        return Document(page_content=content, metadata=meta)

    def _job_documents(self, job: Job) -> Iterator[Document]:
        if job.status != "completed":
            raise BrowsaError(
                f"Browsa {self.mode} job {job.id} ended {job.status}"
                f" (outcome {job.outcome}): {job.error_code or ''} {job.error_message or ''}".rstrip(),
                code=job.error_code,
            )
        result = job_result(job)
        items = result.get("pages" if self.mode == "crawl" else "items") or []
        for item in items:
            if not isinstance(item, dict):
                continue
            data = item.get("data")
            if item.get("status") != "completed" or not isinstance(data, dict):
                logger.warning(
                    "Browsa %s: skipped %s (%s %s)",
                    self.mode,
                    item.get("url"),
                    item.get("error_code"),
                    item.get("error_message"),
                )
                continue
            yield self._to_document(data, item.get("url") or "", job.id)

    def _submit(self) -> dict:
        if self.mode == "crawl":
            return self.client.crawl(self.urls[0], **self._crawl_kwargs())
        return self.client.batch(self.urls, **self._scrape_kwargs())

    async def _asubmit(self) -> dict:
        if self.mode == "crawl":
            return await call_async(
                self.async_client, self.client, "crawl", self.urls[0], **self._crawl_kwargs()
            )
        return await call_async(
            self.async_client, self.client, "batch", self.urls, **self._scrape_kwargs()
        )

    # ── BaseLoader ───────────────────────────────────────────────────────

    def lazy_load(self) -> Iterator[Document]:
        """Load pages one by one (scrape) or after the job ends (batch, crawl)."""
        if self.mode == "scrape":
            for u in self.urls:
                data = self.client.scrape(u, **self._scrape_kwargs())
                yield self._to_document(data, u)
            return
        job_id = envelope_job_id(self._submit())
        job = self.client.wait_for_job(job_id, timeout=self.wait_timeout)
        yield from self._job_documents(job)

    async def alazy_load(self) -> AsyncIterator[Document]:
        """Async version of :meth:`lazy_load`, using ``browsa.AsyncClient``."""
        if self.mode == "scrape":
            for u in self.urls:
                data = await call_async(
                    self.async_client, self.client, "scrape", u, **self._scrape_kwargs()
                )
                yield self._to_document(data, u)
            return
        job_id = envelope_job_id(await self._asubmit())
        job = await call_async(
            self.async_client, self.client, "wait_for_job", job_id, timeout=self.wait_timeout
        )
        for doc in self._job_documents(job):
            yield doc


__all__ = ["BrowsaLoader"]
