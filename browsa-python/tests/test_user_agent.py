"""User-Agent: browsa-python/<version>, plus the suffix an integration adds.
No network: urlopen is replaced. Run with `pytest tests/`."""
import io
import json
import urllib.request

import browsa
from browsa import AsyncClient, Client
from browsa.client import USER_AGENT, user_agent


class _Resp(io.BytesIO):
    status = 200
    headers = {"Content-Type": "application/json"}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _capture(monkeypatch):
    seen = []

    def fake(req, timeout=None):
        seen.append(req.get_header("User-agent"))
        return _Resp(json.dumps({"balance": 1}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return seen


def test_user_agent_is_name_and_version():
    assert USER_AGENT == f"browsa-python/{browsa.__version__}"
    assert user_agent() == USER_AGENT
    assert user_agent("") == USER_AGENT
    assert user_agent("langchain-browsa/0.1.2") == f"{USER_AGENT} langchain-browsa/0.1.2"
    # Whitespace is folded and the suffix is kept short.
    assert user_agent(" crewai-browsa/0.1.1\n x ") == f"{USER_AGENT} crewai-browsa/0.1.1 x"
    assert len(user_agent("x" * 500)) == len(USER_AGENT) + 1 + 80


def test_client_sends_the_suffix(monkeypatch):
    seen = _capture(monkeypatch)
    Client("agt_live_test", base_url="http://127.0.0.1:9")._t.request("GET", "/v1/credits")
    Client("agt_live_test", base_url="http://127.0.0.1:9",
           user_agent_suffix="langchain-browsa/0.1.2")._t.request("GET", "/v1/credits")
    assert seen == [USER_AGENT, f"{USER_AGENT} langchain-browsa/0.1.2"]


def test_async_client_passes_the_suffix_on():
    c = AsyncClient("agt_live_test", base_url="http://127.0.0.1:9", user_agent_suffix="crewai-browsa/0.1.1")
    assert c._sync._t.user_agent == f"{USER_AGENT} crewai-browsa/0.1.1"
