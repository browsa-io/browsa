"""Test fixtures: a fake HTTP layer under the browsa SDK. No network.

The browsa SDK sends every request through ``urllib.request.urlopen``. The
``api`` fixture replaces it with a router that records each request and
answers from canned responses, and blocks real sockets as a safety net.
"""

from __future__ import annotations

import io
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

import pytest

TEST_KEY = "agt_live_test_0000000000000000"


@dataclass
class Sent:
    method: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: Any


class _Resp:
    def __init__(self, status: int, body: Any) -> None:
        self.status = status
        self._data = b"" if body is None else json.dumps(body).encode()
        self.headers = {"Content-Type": "application/json"}

    def read(self) -> bytes:
        return self._data

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


@dataclass
class FakeAPI:
    routes: dict[tuple[str, str], deque] = field(default_factory=lambda: defaultdict(deque))
    sent: list[Sent] = field(default_factory=list)

    def add(
        self,
        method: str,
        path: str,
        body: Any = None,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> FakeAPI:
        """Queue a response. The last one queued for a route repeats."""
        self.routes[(method.upper(), path)].append((status, body, headers or {}))
        return self

    def calls(self, method: str, path: str) -> list[Sent]:
        return [s for s in self.sent if s.method == method.upper() and s.path == path]

    def urlopen(self, req: urllib.request.Request, timeout: float | None = None) -> _Resp:
        parsed = urllib.parse.urlsplit(req.full_url)
        body = json.loads(req.data) if req.data else None
        self.sent.append(
            Sent(
                method=req.get_method(),
                path=parsed.path,
                query=dict(urllib.parse.parse_qsl(parsed.query)),
                headers={k.lower(): v for k, v in req.header_items()},
                body=body,
            )
        )
        queue = self.routes.get((req.get_method(), parsed.path))
        if not queue:
            raise AssertionError(f"unexpected request {req.get_method()} {parsed.path}")
        status, payload, headers = queue[0] if len(queue) == 1 else queue.popleft()
        if status >= 400:
            raise urllib.error.HTTPError(
                req.full_url, status, "error", headers, io.BytesIO(json.dumps(payload).encode())
            )
        return _Resp(status, payload)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_: Any, **__: Any) -> None:
        raise RuntimeError("network access in a unit test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.delenv("BROWSA_API_KEY", raising=False)
    monkeypatch.delenv("BROWSA_BASE_URL", raising=False)


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> FakeAPI:
    fake = FakeAPI()
    monkeypatch.setattr(urllib.request, "urlopen", fake.urlopen)
    return fake
