"""Client for Browsa's captcha API: createTask, getTaskResult, getBalance, reports, callbacks and the type catalogue.

Every answer is HTTP 200 with ``errorId`` 0 (ok) or 1 (error, with ``errorCode``), the common
format of captcha-solving APIs. Recognition tasks are answered inside createTask; token tasks
return a ``taskId``. Stdlib only, like the rest of the SDK.

``solve`` does not poll on a timer: it asks the API to hold each call until the task ends
(``waitSeconds``), so the answer arrives when it exists. Against a server that does not hold calls
it falls back to polling every ``poll_interval`` seconds.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Mapping, Optional

from .. import errors
from .._version import __version__
from .tasks import normalize_task

DEFAULT_CAPTCHA_URL = "https://captcha.browsa.io"
DEFAULT_TIMEOUT = 30.0          # one HTTP request
DEFAULT_SOLVE_TIMEOUT = 180.0   # createTask to a ready token (a reCAPTCHA v2 puzzle can take 2 minutes)
DEFAULT_POLL_INTERVAL = 3.0
DEFAULT_WAIT_SECONDS = 20.0     # how long the API is asked to hold one call (it allows up to 25)
USER_AGENT = f"browsa-python/{__version__} (captcha)"


class CaptchaError(errors.BrowsaError):
    """The API answered ``errorId`` 1. ``code`` is the API's ``errorCode``
    (``ERROR_CAPTCHA_UNSOLVABLE``, ``ERROR_ZERO_BALANCE``, ...); ``task_id`` is set when the
    task exists; ``fix`` says what to change and ``charged`` whether the request cost anything
    (failed and unsolvable tasks are not charged)."""

    def __init__(self, message: str, *, code: Optional[str] = None, task_id: Optional[str] = None,
                 status: Optional[int] = None, body: Any = None) -> None:
        super().__init__(message, code=code, status=status, body=body)
        self.task_id = task_id
        self.description = message
        self.fix: Optional[str] = body.get("fix") if isinstance(body, dict) else None
        self.charged: bool = bool(body.get("charged")) if isinstance(body, dict) else False


class CaptchaTimeoutError(CaptchaError, errors.TimeoutError):
    """Local: ``solve`` gave up waiting. The task may still finish; it is charged only if solved."""


class Solution(dict):  # type: ignore[type-arg]
    """The task's ``solution`` object. ``.task_id`` is the task id, ``.cost`` what the solve cost
    (``{"charged", "amount", "unit", "note"}``; ``{}`` from a server that does not say) and
    ``.solve_seconds`` how long it took (``None`` when not given)."""

    task_id: str = ""
    cost: Dict[str, Any] = {}
    solve_seconds: Optional[float] = None


def _raise_for(body: Any, status: int) -> Dict[str, Any]:
    if not isinstance(body, dict) or "errorId" not in body:
        raise CaptchaError(f"unexpected answer (HTTP {status})", code=f"HTTP_{status}", status=status, body=body)
    if body.get("errorId"):
        raise CaptchaError(body.get("errorDescription") or body.get("errorCode") or "error",
                           code=body.get("errorCode") or None, task_id=body.get("taskId"), status=status, body=body)
    return body


def _wait_for(wait_seconds: Optional[float], request_timeout: float) -> float:
    """The waitSeconds to send: never longer than the HTTP request itself can last."""
    if not wait_seconds or wait_seconds <= 0:
        return 0.0
    return max(0.0, min(float(wait_seconds), 25.0, request_timeout - 5.0))


class CaptchaClient:
    """Sync client.

        from browsa.captcha import CaptchaClient, tasks
        cap = CaptchaClient()                       # BROWSA_API_KEY from the environment
        sol = cap.solve(tasks.turnstile("https://example.com", "0x4AAAA..."))
        print(sol["token"], sol.cost, sol.solve_seconds)
        cap.report_correct(sol.task_id)             # the site took it
        # cap.report_incorrect(sol.task_id)         # the site refused it: that solve is refunded once,
        #                                           # within the workspace's report limits

    Args:
        api_key: your Browsa API key (the same key and credits as the browser API);
            default ``BROWSA_API_KEY``.
        base_url: default ``BROWSA_CAPTCHA_URL`` or ``https://captcha.browsa.io``.
        normalize: map other services' task type names to Browsa's (default on).
        wait_seconds: how long the API is asked to hold each call in ``solve`` (default 20,
            at most 25; 0 polls every ``poll_interval`` seconds instead).
        opener: replaces ``urllib.request.urlopen`` (tests).
    """

    def __init__(self, api_key: Optional[str] = None, *, base_url: Optional[str] = None,
                 timeout: float = DEFAULT_TIMEOUT, poll_interval: float = DEFAULT_POLL_INTERVAL,
                 normalize: bool = True, wait_seconds: float = DEFAULT_WAIT_SECONDS,
                 opener: Optional[Callable[..., Any]] = None) -> None:
        key = api_key or os.environ.get("BROWSA_API_KEY") or ""
        if not key:
            raise ValueError("api_key is required: pass api_key or set BROWSA_API_KEY. "
                             "Create a key at https://app.browsa.io/dashboard/keys")
        self.api_key = key
        self.base_url = (base_url or os.environ.get("BROWSA_CAPTCHA_URL") or DEFAULT_CAPTCHA_URL).rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.normalize = normalize
        self.wait_seconds = wait_seconds
        self._open = opener or urllib.request.urlopen

    # ── raw methods ──────────────────────────────────────────────────────

    def _send(self, req: urllib.request.Request) -> Dict[str, Any]:
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

    def call(self, method: str, payload: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """POST ``/{method}`` with ``clientKey`` added; returns the answer, raises CaptchaError."""
        body = {"clientKey": self.api_key, **(payload or {})}
        return self._send(urllib.request.Request(
            f"{self.base_url}/{method}", method="POST", data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT},
        ))

    def create_task(self, task: Mapping[str, Any], *, wait_seconds: Optional[float] = None,
                    callback_url: Optional[str] = None) -> Dict[str, Any]:
        """``{"taskId", "status": "ready", "solution"}`` for recognition, ``{"taskId"}`` for tokens.

        ``wait_seconds``: hold the call until a token task ends or the wait runs out; the answer is
        then ``status`` ``ready`` with the solution, or ``processing``.

        ``callback_url``: the API also POSTs the finished answer (the JSON ``get_task_result`` gives)
        to this public ``https://`` URL, signed. The receiver has three jobs:

        1. Once per host, the API first POSTs ``{"type": "callback.verify", "challenge": "..."}``
           and the endpoint must answer 2xx with JSON ``{"challenge": "<the same value>"}``.
           Until it has, ``create_task`` raises ``ERROR_INVALID_CALLBACK_URL`` (no task, no charge).
        2. Check every delivery: ``browsa.webhooks.verify_signature(raw_body,
           headers["X-Browsa-Signature"], cap.callback_secret())``.
        3. De-duplicate on the body's ``taskId``: a delivery can arrive more than once.

        One host receives at most 60 requests a minute. The result stays in ``get_task_result``
        for 10 minutes whether or not the callback arrives."""
        payload: Dict[str, Any] = {"task": normalize_task(task) if self.normalize else dict(task)}
        if wait_seconds:
            payload["waitSeconds"] = wait_seconds
        if callback_url:
            payload["callbackUrl"] = callback_url
        return self.call("createTask", payload)

    def get_task_result(self, task_id: str, *, wait_seconds: Optional[float] = None) -> Dict[str, Any]:
        """``{"status": "processing"}`` or ``{"status": "ready", "solution", "cost", "solveSeconds"}``;
        a failed task raises. ``wait_seconds`` (up to 25): the call is held until the task ends."""
        payload: Dict[str, Any] = {"taskId": task_id}
        if wait_seconds:
            payload["waitSeconds"] = wait_seconds
        return self.call("getTaskResult", payload)

    def get_balance(self) -> float:
        """Balance: credits with a Browsa key."""
        return float(self.call("getBalance").get("balance") or 0.0)

    # ── reports ──────────────────────────────────────────────────────────

    def report(self, task_id: str, correct: bool) -> Dict[str, Any]:
        """Tell the API whether the site took the solution. One report per task, within 15
        minutes of the solve. An incorrect report refunds that solve once, within the workspace's
        report limits: ``refunded`` in the answer says whether a refund was made. Returns the API's
        answer (``outcome``, ``refunded``, ``message``, ...);
        raises CaptchaError (``ERROR_ALREADY_REPORTED``, ``ERROR_REPORT_TOO_LATE``, ``ERROR_REPORT_LIMIT``)."""
        return self.call("reportCorrect" if correct else "reportIncorrect", {"taskId": task_id})

    def report_correct(self, task_id: str) -> Dict[str, Any]:
        return self.report(task_id, True)

    def report_incorrect(self, task_id: str) -> Dict[str, Any]:
        return self.report(task_id, False)

    # ── catalogue and callbacks ──────────────────────────────────────────

    def list_types(self) -> List[Dict[str, Any]]:
        """Every task type the API accepts (no key needed): ``type``, ``status`` (``live`` / ``off``),
        ``required`` and ``optional`` parameters, ``price`` and ``measured`` numbers with their date."""
        req = urllib.request.Request(f"{self.base_url}/types", method="GET",
                                     headers={"Accept": "application/json", "User-Agent": USER_AGENT})
        return list(self._send(req).get("types") or [])

    def callback_secret(self) -> str:
        """The secret this account's callbacks are signed with, as hex (made on first use).
        Pass it to ``browsa.webhooks.verify_signature`` as it is."""
        return str(self.call("getCallbackSecret").get("secret") or "")

    def rotate_callback_secret(self) -> str:
        """Replace the callback secret and return the new one. Deliveries are signed with the
        new secret from then on, so update the receiver at the same time."""
        return str(self.call("rotateCallbackSecret").get("secret") or "")

    # ── create and wait ──────────────────────────────────────────────────

    def solve(self, task: Mapping[str, Any], *, timeout: float = DEFAULT_SOLVE_TIMEOUT,
              poll_interval: Optional[float] = None, callback_url: Optional[str] = None) -> Solution:
        """Create the task and wait for its solution. ``callback_url``: the API also POSTs the
        answer there (see ``create_task``)."""
        wait = _wait_for(self.wait_seconds, self.timeout)
        deadline = time.monotonic() + timeout
        created = self.create_task(task, wait_seconds=min(wait, timeout) or None, callback_url=callback_url)
        tid = str(created.get("taskId") or "")
        if created.get("status") == "ready" and created.get("solution") is not None:
            return _solution(created, tid)
        if not tid:
            raise CaptchaError("createTask returned no taskId", code="ERROR_NO_TASK_ID", body=created)
        interval = self.poll_interval if poll_interval is None else poll_interval
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise CaptchaTimeoutError(f"no solution after {timeout:.0f}s", code="TIMEOUT", task_id=tid)
            held = min(wait, left)
            if held < 1:                         # not asking the API to hold: wait here, as before
                time.sleep(min(interval, left))
                held = 0.0
            asked = time.monotonic()
            r = self.get_task_result(tid, wait_seconds=held or None)
            if r.get("status") == "ready":
                return _solution(r, tid)
            if held and time.monotonic() - asked < min(1.0, held):
                # answered at once though asked to hold (an older server): do not spin
                time.sleep(min(interval, max(0.0, deadline - time.monotonic())))


def _solution(body: Mapping[str, Any], tid: str) -> Solution:
    s = Solution(body.get("solution") or {})
    s.task_id = tid
    s.cost = dict(body.get("cost") or {})
    seconds = body.get("solveSeconds")
    s.solve_seconds = float(seconds) if isinstance(seconds, (int, float)) else None
    return s


class AsyncCaptchaClient:
    """Async client: the sync client on a worker thread (``asyncio.to_thread``), like ``AsyncClient``."""

    def __init__(self, api_key: Optional[str] = None, **kwargs: Any) -> None:
        self._sync = CaptchaClient(api_key, **kwargs)

    async def __aenter__(self) -> "AsyncCaptchaClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def create_task(self, task: Mapping[str, Any], *, wait_seconds: Optional[float] = None,
                          callback_url: Optional[str] = None) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_task, task, wait_seconds=wait_seconds,
                                       callback_url=callback_url)

    async def get_task_result(self, task_id: str, *, wait_seconds: Optional[float] = None) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_task_result, task_id, wait_seconds=wait_seconds)

    async def get_balance(self) -> float:
        return await asyncio.to_thread(self._sync.get_balance)

    async def report(self, task_id: str, correct: bool) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync.report, task_id, correct)

    async def report_correct(self, task_id: str) -> Dict[str, Any]:
        return await self.report(task_id, True)

    async def report_incorrect(self, task_id: str) -> Dict[str, Any]:
        return await self.report(task_id, False)

    async def list_types(self) -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._sync.list_types)

    async def callback_secret(self) -> str:
        return await asyncio.to_thread(self._sync.callback_secret)

    async def rotate_callback_secret(self) -> str:
        return await asyncio.to_thread(self._sync.rotate_callback_secret)

    async def solve(self, task: Mapping[str, Any], *, timeout: float = DEFAULT_SOLVE_TIMEOUT,
                    poll_interval: Optional[float] = None, callback_url: Optional[str] = None) -> Solution:
        c = self._sync
        wait = _wait_for(c.wait_seconds, c.timeout)
        deadline = time.monotonic() + timeout
        created = await self.create_task(task, wait_seconds=min(wait, timeout) or None, callback_url=callback_url)
        tid = str(created.get("taskId") or "")
        if created.get("status") == "ready" and created.get("solution") is not None:
            return _solution(created, tid)
        if not tid:
            raise CaptchaError("createTask returned no taskId", code="ERROR_NO_TASK_ID", body=created)
        interval = c.poll_interval if poll_interval is None else poll_interval
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise CaptchaTimeoutError(f"no solution after {timeout:.0f}s", code="TIMEOUT", task_id=tid)
            held = min(wait, left)
            if held < 1:
                await asyncio.sleep(min(interval, left))
                held = 0.0
            asked = time.monotonic()
            r = await self.get_task_result(tid, wait_seconds=held or None)
            if r.get("status") == "ready":
                return _solution(r, tid)
            if held and time.monotonic() - asked < min(1.0, held):
                await asyncio.sleep(min(interval, max(0.0, deadline - time.monotonic())))
