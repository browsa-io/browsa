"""Shared plumbing for the Browsa tools: config, the client and failures."""

from __future__ import annotations

import json
import os
from typing import Any

from browsa import Client
from browsa.errors import BrowsaError, RateLimitError
from crewai.tools import BaseTool, EnvVar
from pydantic import Field, PrivateAttr

from crewai_browsa._version import __version__

_ToolFailure: Any
try:  # crewai versions with ToolFailure record a returned one as a failed call.
    from crewai.tools import ToolFailure as _ToolFailure
except ImportError:  # pragma: no cover - exercised by a test that hides it
    _ToolFailure = None

API_KEY_ENV = "BROWSA_API_KEY"
BASE_URL_ENV = "BROWSA_BASE_URL"
DEFAULT_BASE_URL = "https://browsa.io"
# Added to the SDK's User-Agent so Browsa can count calls through this package.
USER_AGENT_SUFFIX = f"crewai-browsa/{__version__}"


def _new_client(**kwargs: Any) -> Any:
    """browsa.Client with the User-Agent suffix; an SDK release from before
    user_agent_suffix gets the plain call."""
    try:
        return Client(user_agent_suffix=USER_AGENT_SUFFIX, **kwargs)
    except TypeError:
        return Client(**kwargs)

# Error codes after which the same call may well work: no free browser
# slot (429), Browsa's browser failed (502 UPSTREAM_UNAVAILABLE), a timeout.
_RETRYABLE_CODES = {
    "TOO_MANY_REQUESTS",
    "RATE_LIMIT",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_TIMEOUT",
    "TIMEOUT",
}


def failure(
    message: str,
    *,
    code: str | None = None,
    retryable: bool = False,
    details: dict[str, Any] | None = None,
) -> Any:
    """Report a failed call.

    On crewai versions that have ``ToolFailure`` this returns one, so the
    framework records the call as failed (and its failure policy applies).
    On older versions it returns the same text the agent would have seen.
    """
    details = {k: v for k, v in (details or {}).items() if v not in (None, "", [])}
    if _ToolFailure is not None:
        return _ToolFailure(
            message=_with_details(message, details),
            code=code,
            retryable=retryable,
            details=details,
        )
    text = _with_details(message, details)
    return f"{text} (code: {code})" if code else text


def _with_details(message: str, details: dict[str, Any]) -> str:
    if not details:
        return message
    return f"{message}\n{json.dumps(details, ensure_ascii=False, indent=2)}"


def failure_from_error(action: str, err: BrowsaError) -> Any:
    """Turn an SDK error (HTTP error envelope, timeout, network) into a failure."""
    code = getattr(err, "code", None)
    status = getattr(err, "status", None)
    retryable = (
        isinstance(err, RateLimitError)
        or (code in _RETRYABLE_CODES)
        or status in (429, 502, 503, 504)
    )
    message = f"Browsa {action} failed: {err.args[0] if err.args else err}"
    details: dict[str, Any] = {
        "http_status": status,
        "request_id": getattr(err, "request_id", None),
    }
    retry_after = getattr(err, "retry_after", None)
    if retry_after:
        details["retry_after_seconds"] = retry_after
    return failure(message, code=code, retryable=retryable, details=details)


class BrowsaBaseTool(BaseTool):
    """Base class: reads the API key and builds one ``browsa.Client``.

    Args:
        api_key: A Browsa API key (``agt_live_...``). Defaults to the
            ``BROWSA_API_KEY`` environment variable.
        base_url: API base URL. Defaults to ``BROWSA_BASE_URL`` or
            https://browsa.io.
        client: An existing ``browsa.Client`` to use instead (then
            ``api_key`` and ``base_url`` are ignored).
    """

    package_dependencies: list[str] = Field(default_factory=lambda: ["browsa"])
    env_vars: list[EnvVar] = Field(
        default_factory=lambda: [
            EnvVar(
                name=API_KEY_ENV,
                description="Browsa API key (agt_live_...), from https://app.browsa.io/dashboard/keys",
                required=True,
            ),
        ]
    )

    _client: Any = PrivateAttr(default=None)

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        client: Any | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if client is None:
            key = api_key or os.getenv(API_KEY_ENV)
            if not key:
                raise ValueError(
                    f"A Browsa API key is required: pass api_key=... or set {API_KEY_ENV}. "
                    "Create one at https://app.browsa.io/dashboard/keys"
                )
            client = _new_client(
                api_key=key,
                base_url=base_url or os.getenv(BASE_URL_ENV) or DEFAULT_BASE_URL,
            )
        self._client = client

    @property
    def client(self) -> Any:
        """The ``browsa.Client`` this tool calls."""
        return self._client
