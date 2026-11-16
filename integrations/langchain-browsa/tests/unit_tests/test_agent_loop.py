"""The README's agent example, run offline: a scripted chat model calls the
Browsa tools through LangChain's create_agent (a LangGraph graph)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage

from langchain_browsa import BrowsaToolkit

from .conftest import FakeHTTP

agents = pytest.importorskip("langchain.agents")


class ScriptedModel(FakeMessagesListChatModel):
    """Answers from a fixed list and accepts bind_tools."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self


def _script() -> ScriptedModel:
    return ScriptedModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "browsa_task",
                        "args": {"task": "Open example.com and return the H1."},
                        "id": "call_task",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "browsa_scrape",
                        "args": {"url": "https://example.com"},
                        "id": "call_scrape",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="The H1 is Example Domain."),
        ]
    )


def test_agent_calls_browsa_tools(fake_http: FakeHTTP) -> None:
    agent = agents.create_agent(_script(), tools=BrowsaToolkit().get_tools())
    state = agent.invoke({"messages": [{"role": "user", "content": "What is the H1 of example.com?"}]})
    tool_msgs = [m for m in state["messages"] if isinstance(m, ToolMessage)]
    assert [m.name for m in tool_msgs] == ["browsa_task", "browsa_scrape"]
    task_out = json.loads(tool_msgs[0].content)
    assert task_out["outcome"] == "completed" and task_out["final_result"] == "Example Domain"
    assert state["messages"][-1].content == "The H1 is Example Domain."
    assert len(fake_http.calls("POST", "^/v1/tasks$")) == 1
    assert len(fake_http.calls("POST", "/v1/quick/scrape")) == 1


async def test_agent_calls_browsa_tools_async(fake_http: FakeHTTP) -> None:
    agent = agents.create_agent(_script(), tools=BrowsaToolkit().get_tools())
    state = await agent.ainvoke({"messages": [{"role": "user", "content": "H1?"}]})
    assert state["messages"][-1].content == "The H1 is Example Domain."
    assert len(fake_http.calls("POST", "^/v1/tasks$")) == 1
