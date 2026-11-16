"""LangChain standard tool tests (langchain-tests).

``ToolsUnitTests`` run as intended: offline. The ``ToolsIntegrationTests``
suite is also run here against the fake HTTP layer from conftest.py, so the
invoke and ToolCall contract is checked without the network. The same
suite against the live API is in tests/integration_tests.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool
from langchain_tests.integration_tests import ToolsIntegrationTests
from langchain_tests.unit_tests import ToolsUnitTests

from langchain_browsa import (
    BrowsaExtractTool,
    BrowsaScrapeTool,
    BrowsaScreenshotTool,
    BrowsaTaskTool,
)

from .conftest import TEST_KEY

ENV = {"BROWSA_API_KEY": "agt_live_from_env"}
EXPECTED = {"api_key": "agt_live_from_env"}


class _Base:
    @property
    def tool_constructor_params(self) -> dict[str, Any]:
        return {"api_key": TEST_KEY}

    @property
    def init_from_env_params(self) -> tuple[dict, dict, dict]:
        return ENV, {}, EXPECTED


class _Task(_Base):
    @property
    def tool_constructor(self) -> type[BaseTool]:
        return BrowsaTaskTool

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"task": "Open example.com and return the H1.", "initial_url": "https://example.com"}


class TestBrowsaTaskToolUnit(_Task, ToolsUnitTests):
    pass


class TestBrowsaTaskToolOffline(_Task, ToolsIntegrationTests):
    pass


class _Scrape(_Base):
    @property
    def tool_constructor(self) -> type[BaseTool]:
        return BrowsaScrapeTool

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"url": "https://example.com", "formats": ["markdown", "links"]}


class TestBrowsaScrapeToolUnit(_Scrape, ToolsUnitTests):
    pass


class TestBrowsaScrapeToolOffline(_Scrape, ToolsIntegrationTests):
    pass


class _Extract(_Base):
    @property
    def tool_constructor(self) -> type[BaseTool]:
        return BrowsaExtractTool

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"url": "https://example.com", "prompt": "Return the page heading."}


class TestBrowsaExtractToolUnit(_Extract, ToolsUnitTests):
    pass


class TestBrowsaExtractToolOffline(_Extract, ToolsIntegrationTests):
    pass


class _Screenshot(_Base):
    @property
    def tool_constructor(self) -> type[BaseTool]:
        return BrowsaScreenshotTool

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"url": "https://example.com", "full_page": False}


class TestBrowsaScreenshotToolUnit(_Screenshot, ToolsUnitTests):
    pass


class TestBrowsaScreenshotToolOffline(_Screenshot, ToolsIntegrationTests):
    pass
