"""Offline test harness: the SDK's HTTP layer (urllib.request.urlopen) is
replaced by a fake that answers from canned responses. Sockets are disabled,
so a test that tried to reach the network would fail."""

from __future__ import annotations

import base64
import io
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Union

import pytest
import pytest_socket

TEST_KEY = "agt_test_0123456789abcdef"
JOB_ID = "11111111-2222-3333-4444-555555555555"
PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24).decode()

Responder = Union[dict, list, Callable[["Request"], Any], "HTTPFail"]


@dataclass
class HTTPFail:
    status: int
    body: dict


@dataclass
class Request:
    method: str
    url: str
    path: str
    query: dict
    headers: dict
    body: Any


class _Resp:
    def __init__(self, payload: Any) -> None:
        self._data = json.dumps(payload).encode()
        self.headers = {"Content-Type": "application/json"}

    def read(self) -> bytes:
        return self._data

    def __enter__(self) -> "_Resp":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


@dataclass
class FakeHTTP:
    routes: list = field(default_factory=list)
    requests: list = field(default_factory=list)

    def add(self, method: str, pattern: str, responder: Responder) -> None:
        """Answer METHOD requests whose path matches ``pattern`` (a regex).
        Routes added later win. A list answers one item per call and then
        keeps answering its last item."""
        self.routes.insert(0, (method.upper(), re.compile(pattern), responder))

    def calls(self, method: str, pattern: str) -> list[Request]:
        rx = re.compile(pattern)
        return [r for r in self.requests if r.method == method.upper() and rx.search(r.path)]

    def urlopen(self, req: urllib.request.Request, timeout: Any = None) -> _Resp:
        parsed = urllib.parse.urlsplit(req.full_url)
        body = json.loads(req.data) if req.data else None
        headers = {k.lower(): v for k, v in req.header_items()}
        r = Request(
            method=req.get_method(),
            url=req.full_url,
            path=parsed.path,
            query=dict(urllib.parse.parse_qsl(parsed.query)),
            headers=headers,
            body=body,
        )
        self.requests.append(r)
        for method, rx, responder in self.routes:
            if method != r.method or not rx.search(r.path):
                continue
            if isinstance(responder, list):
                payload = responder.pop(0) if len(responder) > 1 else responder[0]
            elif callable(responder):
                payload = responder(r)
            else:
                payload = responder
            if isinstance(payload, HTTPFail):
                raise urllib.error.HTTPError(
                    req.full_url,
                    payload.status,
                    "error",
                    {},  # type: ignore[arg-type]
                    io.BytesIO(json.dumps(payload.body).encode()),
                )
            return _Resp(payload)
        raise AssertionError(f"unexpected request {r.method} {r.url}")


def job(
    status: str = "completed",
    *,
    outcome: Any = "completed",
    final_result: Any = "Example Domain",
    live_url: Any = None,
    result: Any = None,
    **extra: Any,
) -> dict:
    res = {"final_result": final_result}
    if result:
        res.update(result)
    body = {
        "id": JOB_ID,
        "status": status,
        "kind": "task",
        "step_count": 3,
        "progress_done": 3,
        "progress_total": 3,
        "outcome": outcome if status in ("completed", "failed", "cancelled") else None,
        "credits_charged": 9 if status == "completed" else None,
        "live_url": live_url,
        "result": res if status == "completed" else None,
    }
    body.update(extra)
    return body


def scrape_payload(url: str = "https://example.com/", **extra: Any) -> dict:
    p = {
        "url": url,
        "http_status": 200,
        "markdown": "# Example Domain\n\nThis domain is for use in examples.",
        "text": "Example Domain This domain is for use in examples.",
        "agent_id": "a1",
        "cost_credits": 1,
        "duration_ms": 1200,
        "meta": {"title": "Example Domain"},
    }
    p.update(extra)
    return p


def install_defaults(fake: FakeHTTP) -> None:
    fake.add("POST", r"^/v1/tasks$", job("queued", live_url="https://browsa.io/live/abc"))
    fake.add("GET", rf"^/v1/jobs/{JOB_ID}$", job("completed"))
    fake.add("POST", r"^/v1/quick/scrape$", lambda r: scrape_payload(r.body["url"]))
    fake.add(
        "POST",
        r"^/v1/quick/extract$",
        lambda r: {
            "url": r.body["url"],
            "data": {"title": "Example Domain"},
            "text": "Example Domain",
            "schema": r.body.get("schema") or {"type": "object"},
            "cost_credits": 1,
        },
    )
    fake.add(
        "POST",
        r"^/v1/quick/screenshot$",
        lambda r: {"url": r.body["url"], "http_status": 200, "screenshot_png_b64": PNG_B64, "cost_credits": 1},
    )


@pytest.fixture(autouse=True)
def no_network():
    pytest_socket.disable_socket(allow_unix_socket=True)
    yield
    pytest_socket.enable_socket()


@pytest.fixture(autouse=True)
def fake_http(monkeypatch: pytest.MonkeyPatch) -> FakeHTTP:
    fake = FakeHTTP()
    install_defaults(fake)
    monkeypatch.setattr(urllib.request, "urlopen", fake.urlopen)
    monkeypatch.setenv("BROWSA_API_KEY", TEST_KEY)
    return fake
