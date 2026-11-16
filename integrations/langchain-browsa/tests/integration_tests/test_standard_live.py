"""LangChain standard tool tests against the live Browsa API.

Skipped unless BROWSA_API_KEY is set. They spend credits (see README,
"Costs"): run them by hand, never in CI on every push.

    BROWSA_API_KEY=agt_live_... pytest tests/integration_tests
"""

from __future__ import annotations

import os

import pytest
from langchain_core.tools import BaseTool
from langchain_tests.integration_tests import ToolsIntegrationTests

from langchain_browsa import BrowsaLoader, BrowsaScrapeTool, BrowsaTaskTool

pytestmark = [
    pytest.mark.requires_api_key,
    pytest.mark.skipif(not os.environ.get("BROWSA_API_KEY"), reason="BROWSA_API_KEY not set"),
]


class TestBrowsaScrapeToolLive(ToolsIntegrationTests):
    @property
    def tool_constructor(self) -> type[BaseTool]:
        return BrowsaScrapeTool

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"url": "https://example.com"}


class TestBrowsaTaskToolLive(ToolsIntegrationTests):
    @property
    def tool_constructor(self) -> type[BaseTool]:
        return BrowsaTaskTool

    @property
    def tool_constructor_params(self) -> dict:
        return {"llm": "browsa-fast", "max_steps": 5, "max_credits": 15}

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"task": "Open https://example.com and return the text of its H1 heading."}


def test_loader_live() -> None:
    docs = BrowsaLoader("https://example.com").load()
    # The scrape's Markdown keeps the body text; check that, not the H1 title.
    assert docs and "documentation examples" in docs[0].page_content
