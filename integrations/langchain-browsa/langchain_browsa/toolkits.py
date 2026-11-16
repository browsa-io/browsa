"""Toolkit with every Browsa tool, sharing one set of SDK clients."""

from __future__ import annotations

from typing import Any, Optional

from browsa.client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT
from langchain_core.tools import BaseTool, BaseToolkit
from langchain_core.utils import secret_from_env
from pydantic import ConfigDict, Field, SecretStr, model_validator
from typing_extensions import Self

from langchain_browsa._common import API_KEY_ENV, build_clients
from langchain_browsa.tools import (
    BrowsaExtractTool,
    BrowsaScrapeTool,
    BrowsaScreenshotTool,
    BrowsaTaskTool,
)


class BrowsaToolkit(BaseToolkit):
    """All Browsa tools: task, scrape, extract and screenshot.

    Instantiate:
        .. code-block:: python

            from langchain_browsa import BrowsaToolkit

            toolkit = BrowsaToolkit()          # reads BROWSA_API_KEY
            tools = toolkit.get_tools()

    Per-tool settings go in ``task_kwargs``, ``scrape_kwargs``,
    ``extract_kwargs`` and ``screenshot_kwargs``, e.g.
    ``BrowsaToolkit(task_kwargs={"llm": "browsa-smart", "max_credits": 30})``.
    """

    api_key: Optional[SecretStr] = Field(
        default_factory=secret_from_env(API_KEY_ENV, default=None)
    )
    base_url: str = DEFAULT_BASE_URL
    request_timeout: float = DEFAULT_TIMEOUT
    client: Any = Field(default=None, exclude=True)
    async_client: Any = Field(default=None, exclude=True)

    include_task: bool = True
    include_scrape: bool = True
    include_extract: bool = True
    include_screenshot: bool = True

    task_kwargs: dict[str, Any] = Field(default_factory=dict)
    scrape_kwargs: dict[str, Any] = Field(default_factory=dict)
    extract_kwargs: dict[str, Any] = Field(default_factory=dict)
    screenshot_kwargs: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(arbitrary_types_allowed=True)

    @model_validator(mode="after")
    def _init_clients(self) -> Self:
        self.client, self.async_client = build_clients(
            self.api_key,
            base_url=self.base_url,
            timeout=self.request_timeout,
            client=self.client,
            async_client=self.async_client,
        )
        return self

    def get_tools(self) -> list[BaseTool]:
        """Return the tools, all using this toolkit's clients."""
        shared = {
            "api_key": self.api_key,
            "base_url": self.base_url,
            "client": self.client,
            "async_client": self.async_client,
        }
        tools: list[BaseTool] = []
        if self.include_task:
            tools.append(BrowsaTaskTool(**shared, **self.task_kwargs))
        if self.include_scrape:
            tools.append(BrowsaScrapeTool(**shared, **self.scrape_kwargs))
        if self.include_extract:
            tools.append(BrowsaExtractTool(**shared, **self.extract_kwargs))
        if self.include_screenshot:
            tools.append(BrowsaScreenshotTool(**shared, **self.screenshot_kwargs))
        return tools


__all__ = ["BrowsaToolkit"]
