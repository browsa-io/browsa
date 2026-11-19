"""Client for Browsa's captcha API: createTask, getTaskResult, getBalance.

Every answer is HTTP 200 with ``errorId`` 0 (ok) or 1 (error, with ``errorCode``), as at
CapSolver, Anti-Captcha and CapMonster. Recognition tasks are answered inside createTask;
token tasks return a ``taskId`` to poll. Stdlib only, like the rest of the SDK.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Mapping, Optional

from .. import errors
from .._version import __version__
from .tasks import normalize_task

DEFAULT_CAPTCHA_URL = "https://captcha.browsa.io"
DEFAULT_TIMEOUT = 30.0          # one HTTP request
DEFAULT_SOLVE_TIMEOUT = 180.0   # createTask to a ready token (a reCAPTCHA v2 puzzle can take 2 minutes)
DEFAULT_POLL_INTERVAL = 3.0
USER_AGENT = f"browsa-python/{__version__} (captcha)"


class CaptchaError(errors.BrowsaError):
    """The API answered ``errorId`` 1. ``code`` is the API's ``errorCode``
    (``ERROR_CAPTCHA_UNSOLVABLE``, ``ERROR_ZERO_BALANCE``, ...); ``task_id`` is set when the
    task exists. Failed and unsolvable tasks are not charged."""

    def __init__(self, message: str, *, code: Optional[str] = None, task_id: Optional[str] = None,
                 status: Optional[int] = None, body: Any = None) -> None:
        super().__init__(message, code=code, status=status, body=body)
        self.task_id = task_id
        self.description = message


class CaptchaTimeoutError(CaptchaError, errors.TimeoutError):
    """Local: ``solve`` gave up waiting. The task may still finish; it is charged only if solved."""


class Solution(dict):  # type: ignore[type-arg]
    """The task's ``solution`` object, with the task id as ``.task_id``."""

    task_id: str = ""


def _raise_for(body: Any, status: int) -> Dict[str, Any]:
    if not isinstance(body, dict) or "errorId" not in body:
        raise CaptchaError(f"unexpected answer (HTTP {status})", code=f"HTTP_{status}", status=status, body=body)
    if body.get("errorId"):
        raise CaptchaError(body.get("errorDescription") or body.get("errorCode") or "error",
                           code=body.get("errorCode") or None, task_id=body.get("taskId"), status=status, body=body)
    return body


class CaptchaClient:
    """Sync client.

        from browsa.captcha import CaptchaClient, tasks
        cap = CaptchaClient()                       # BROWSA_API_KEY from the environment
        sol = cap.solve(tasks.turnstile("https://example.com", "0x4AAAA..."))
        print(sol["token"])

    Args:
        api_key: your Browsa API key (the same key and credits as the browser API);
            default ``BROWSA_API_KEY``.
        base_url: default ``BROWSA_CAPTCHA_URL`` or ``https://captcha.browsa.io``.
        normalize: map other services' task type names to Browsa's (default on).
        opener: replaces ``urllib.request.urlopen`` (tests).
    """

    def __init__(self, api_key: Optional[str] = None, *, base_url: Optional[str] = None,
                 timeout: float = DEFAULT_TIMEOUT, poll_interval: float = DEFAULT_POLL_INTERVAL,
                 normalize: bool = True, opener: Optional[Callable[..., Any]] = None) -> None:
        key = api_key or os.environ.get("BROWSA_API_KEY") or ""
        if not key:
            raise ValueError("api_key is required (or set BROWSA_API_KEY)")
        self.api_key = key
        self.base_url = (base_url or os.environ.get("BROWSA_CAPTCHA_URL") or DEFAULT_CAPTCHA_URL).rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.normalize = normalize
        self._open = opener or urllib.request.urlopen

    # ── raw methods ──────────────────────────────────────────────────────

    def call(self, method: str, payload: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """POST ``/{method}`` with ``clientKey`` added; returns the answer, raises CaptchaError."""
        body = {"clientKey": self.api_key, **(payload or {})}
        req = urllib.request.Request(
            f"{self.base_url}/{method}", method="POST", data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with self._open(req, timeout=self.timeout) as resp:
                status, raw = getattr(resp, "status", 200), resp.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise errors.TimeoutError(f"request timed out after {self.timeout}s") from e
            raise errors.BrowsaError(f"network error: {e}") from e
        except (socket.timeout, TimeoutError) as e:
            raise errors.TimeoutError(f"request timed out after {self.timeout}s") from e
        except OSError as e:
            raise errors.BrowsaError(f"network error: {e}") from e
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        return _raise_for(parsed, status)

    def create_task(self, task: Mapping[str, Any]) -> Dict[str, Any]:
        """``{"taskId", "status": "ready", "solution"}`` for recognition, ``{"taskId"}`` for tokens."""
        return self.call("createTask", {"task": normalize_task(task) if self.normalize else dict(task)})

    def get_task_result(self, task_id: str) -> Dict[str, Any]:
        """``{"status": "processing"}`` or ``{"status": "ready", "solution"}``; a failed task raises."""
        return self.call("getTaskResult", {"taskId": task_id})

    def get_balance(self) -> float:
        """Balance: credits with a Browsa key."""
        return float(self.call("getBalance").get("balance") or 0.0)

    # ── create and wait ──────────────────────────────────────────────────

    def solve(self, task: Mapping[str, Any], *, timeout: float = DEFAULT_SOLVE_TIMEOUT,
              poll_interval: Optional[float] = None) -> Solution:
        """Create the task and wait for its solution."""
        created = self.create_task(task)
        tid = str(created.get("taskId") or "")
        if created.get("status") == "ready" and created.get("solution") is not None:
            return _solution(created, tid)
        if not tid:
            raise CaptchaError("createTask returned no taskId", code="ERROR_NO_TASK_ID", body=created)
        interval = self.poll_interval if poll_interval is None else poll_interval
        deadline = time.monotonic() + timeout
        while True:
            time.sleep(min(interval, max(0.0, deadline - time.monotonic())))
            r = self.get_task_result(tid)
            if r.get("status") == "ready":
                return _solution(r, tid)
            if time.monotonic() >= deadline:
                raise CaptchaTimeoutError(f"no solution after {timeout:.0f}s", code="TIMEOUT", task_id=tid)


def _solution(body: Mapping[str, Any], tid: str) -> Solution:
    s = Solution(body.get("solution") or {})
    s.task_id = tid
    return s


class AsyncCaptchaClient:
    """Async client: the sync client on a worker thread (``asyncio.to_thread``), like ``AsyncClient``."""

    def __init__(self, api_key: Optional[str] = None, **kwargs: Any) -> None:
        self._sync = CaptchaClient(api_key, **kwargs)

    async def __aenter__(self) -> "AsyncCaptchaClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def create_task(self, task: Mapping[str, Any]) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_task, task)

    async def get_task_result(self, task_id: str) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_task_result, task_id)

    async def get_balance(self) -> float:
        return await asyncio.to_thread(self._sync.get_balance)

    async def solve(self, task: Mapping[str, Any], *, timeout: float = DEFAULT_SOLVE_TIMEOUT,
                    poll_interval: Optional[float] = None) -> Solution:
        created = await self.create_task(task)
        tid = str(created.get("taskId") or "")
        if created.get("status") == "ready" and created.get("solution") is not None:
            return _solution(created, tid)
        if not tid:
            raise CaptchaError("createTask returned no taskId", code="ERROR_NO_TASK_ID", body=created)
        interval = self._sync.poll_interval if poll_interval is None else poll_interval
        deadline = time.monotonic() + timeout
        while True:
            await asyncio.sleep(min(interval, max(0.0, deadline - time.monotonic())))
            r = await self.get_task_result(tid)
            if r.get("status") == "ready":
                return _solution(r, tid)
            if time.monotonic() >= deadline:
                raise CaptchaTimeoutError(f"no solution after {timeout:.0f}s", code="TIMEOUT", task_id=tid)
