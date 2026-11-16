from __future__ import annotations

import langchain_browsa
from langchain_browsa import (
    BrowsaExtractTool,
    BrowsaScrapeTool,
    BrowsaScreenshotTool,
    BrowsaTaskTool,
    BrowsaToolkit,
)

from .conftest import FakeHTTP


def test_all_exports() -> None:
    assert set(langchain_browsa.__all__) == {
        "BrowsaExtractTool",
        "BrowsaLoader",
        "BrowsaScrapeTool",
        "BrowsaScreenshotTool",
        "BrowsaTaskTool",
        "BrowsaToolkit",
        "__version__",
    }


def test_toolkit_returns_all_tools_sharing_one_client() -> None:
    toolkit = BrowsaToolkit()
    tools = toolkit.get_tools()
    assert [type(t) for t in tools] == [
        BrowsaTaskTool,
        BrowsaScrapeTool,
        BrowsaExtractTool,
        BrowsaScreenshotTool,
    ]
    assert len({t.name for t in tools}) == 4
    assert all(t.client is toolkit.client for t in tools)
    assert all(t.async_client is toolkit.async_client for t in tools)


def test_toolkit_options(fake_http: FakeHTTP) -> None:
    toolkit = BrowsaToolkit(
        include_extract=False,
        include_screenshot=False,
        task_kwargs={"llm": "browsa-smart", "max_credits": 30},
    )
    task, scrape = toolkit.get_tools()
    assert isinstance(task, BrowsaTaskTool) and task.llm == "browsa-smart"
    task.invoke({"task": "t"})
    assert fake_http.calls("POST", "^/v1/tasks$")[0].body["max_credits"] == 30
    assert isinstance(scrape, BrowsaScrapeTool)
