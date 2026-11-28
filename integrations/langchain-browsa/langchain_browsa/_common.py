"""Shared helpers: API key resolution, client construction, error mapping."""

from __future__ import annotations

import asyncio
import os
from importlib import metadata
from typing import Any, Optional

from browsa import AsyncClient, BrowsaError, Client, Job
from browsa.client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT
from langchain_core.tools import BaseTool, ToolException
from langchain_core.utils import secret_from_env
from pydantic import Field, SecretStr, model_validator
from typing_extensions import Self

API_KEY_ENV = "BROWSA_API_KEY"


def _user_agent_suffix() -> str:
    """``langchain-browsa/<version>``, added to the SDK's User-Agent so Browsa
    can count calls that come through this package."""
    try:
        return "langchain-browsa/" + metadata.version("langchain-browsa")
    except metadata.PackageNotFoundError:  # a source checkout
        return "langchain-browsa"


USER_AGENT_SUFFIX = _user_agent_suffix()


def _new_client(cls: Any, key: str, **kwargs: Any) -> Any:
    """cls(key, ...) with the User-Agent suffix; an SDK release from before
    user_agent_suffix gets the plain call."""
    try:
        return cls(key, user_agent_suffix=USER_AGENT_SUFFIX, **kwargs)
    except TypeError:
        return cls(key, **kwargs)

_MISSING_KEY = (
    "No Browsa API key. Set the BROWSA_API_KEY environment variable or pass "
    "api_key=... (keys start with 'agt_'; create one at "
    "https://app.browsa.io/dashboard/keys)."
)


def resolve_api_key(api_key: Optional[Any]) -> Optional[str]:
    """Return the explicit key (str or SecretStr) or BROWSA_API_KEY, or None."""
    if isinstance(api_key, SecretStr):
        api_key = api_key.get_secret_value()
    if api_key:
        return str(api_key)
    return os.environ.get(API_KEY_ENV) or None


def build_clients(
    api_key: Optional[Any],
    *,
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = DEFAULT_TIMEOUT,
    client: Optional[Client] = None,
    async_client: Optional[AsyncClient] = None,
) -> tuple[Client, Optional[AsyncClient]]:
    """Build the sync and async SDK clients that are not given.

    With only ``client`` given and no key available, the async client stays
    None and async calls run the sync client in a worker thread.
    """
    key = resolve_api_key(api_key)
    if client is None:
        if not key:
            raise ValueError(_MISSING_KEY)
        client = _new_client(Client, key, base_url=base_url, timeout=timeout)
    if async_client is None and key:
        async_client = _new_client(AsyncClient, key, base_url=base_url, timeout=timeout)
    return client, async_client


async def call_async(
    async_client: Optional[AsyncClient],
    client: Client,
    method: str,
    *args: Any,
    **kwargs: Any,
) -> Any:
    """Call ``method`` on the async client, or on the sync one in a thread."""
    if async_client is not None:
        return await getattr(async_client, method)(*args, **kwargs)
    return await asyncio.to_thread(getattr(client, method), *args, **kwargs)


def to_tool_error(err: BrowsaError) -> ToolException:
    """Map an SDK error to a ToolException with the API's code and request id."""
    return ToolException(f"Browsa API error: {err}")


def envelope_job_id(envelope: Any) -> str:
    """Job id from a 202 envelope (``job_id``, or ``id`` on some endpoints)."""
    if isinstance(envelope, dict):
        jid = envelope.get("job_id") or envelope.get("id")
        if jid:
            return str(jid)
    raise ToolException(f"Browsa did not return a job id: {envelope!r}")


def job_result(job: Job) -> dict:
    """The ``result`` object of a finished job (empty dict if there is none)."""
    result = job.raw.get("result") if isinstance(job.raw, dict) else None
    return result if isinstance(result, dict) else {}


def drop_none(d: dict, keep: tuple[str, ...] = ()) -> dict:
    return {k: v for k, v in d.items() if v is not None or k in keep}


class BrowsaBaseTool(BaseTool):
    """Base class of the Browsa tools: holds the key and the SDK clients."""

    api_key: Optional[SecretStr] = Field(
        default_factory=secret_from_env(API_KEY_ENV, default=None)
    )
    """Browsa API key (``agt_live_...``). Read from ``BROWSA_API_KEY`` if not set."""

    base_url: str = DEFAULT_BASE_URL
    """API base URL. Leave the default unless Browsa support tells you otherwise."""

    request_timeout: float = DEFAULT_TIMEOUT
    """Per-request HTTP timeout of the SDK client, in seconds."""

    client: Any = Field(default=None, exclude=True)
    """A ``browsa.Client`` to use instead of building one."""

    async_client: Any = Field(default=None, exclude=True)
    """A ``browsa.AsyncClient`` to use instead of building one."""

    @model_validator(mode="after")
    def _init_clients(self) -> Self:
        self.client, self.async_client = build_clients(
            self.api_key,
            base_url=self.base_url,
            timeout=self.request_timeout,
            client=self.client,
            async_client=self.async_client,
        )
        return self

    def _call(self, method: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return getattr(self.client, method)(*args, **kwargs)
        except BrowsaError as e:
            raise to_tool_error(e) from e

    async def _acall(self, method: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return await call_async(self.async_client, self.client, method, *args, **kwargs)
        except BrowsaError as e:
            raise to_tool_error(e) from e


__all__ = [
    "API_KEY_ENV",
    "BrowsaBaseTool",
    "build_clients",
    "call_async",
    "drop_none",
    "envelope_job_id",
    "job_result",
    "resolve_api_key",
    "to_tool_error",
]
