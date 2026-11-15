"""
browsa — real browsers for AI agents.

Quickstart:

    from browsa import Client

    client = Client(api_key="agt_live_...")

    # Run a task synchronously (blocks until the agent finishes)
    job = client.run_task(
        task="Go to news.ycombinator.com and return the top story title.",
        llm="claude-opus-5-5",
        llm_api_key="sk-ant-...",
    )
    print(job.final_result)
    print(f"Live stream: {job.live_url}")

That's it. Five lines of Python to drive a real browser through
an AI agent, get back structured output, and a live noVNC viewer URL.

For async usage:

    from browsa import AsyncClient

    async with AsyncClient(api_key="agt_live_...") as c:
        job = await c.run_task(task="...", llm="claude-opus-5-5", ...)

For webhooks see browsa.webhooks.verify_signature.
"""
from .client import Client, AsyncClient
from .types import (
    HostedModel, Job, JobFile, JobStatus, LLMKey, Models, OwnKeyModels, Schedule,
    Session, SessionBrowser, SessionTurn, Usage, Webhook,
    NetworkProxy, Proxy, ProxyConfig, ProxyNetwork, ProxyNetworkTier,
)
from .errors import (
    BrowsaError,
    APIError,
    AuthError,
    RateLimitError,
    InvalidIDError,
    NotFoundError,
    TimeoutError,
)
from . import webhooks

from ._version import __version__

__all__ = [
    "Client",
    "AsyncClient",
    "HostedModel",
    "Job",
    "JobFile",
    "JobStatus",
    "LLMKey",
    "Models",
    "OwnKeyModels",
    "Schedule",
    "Session",
    "SessionBrowser",
    "SessionTurn",
    "Usage",
    "Webhook",
    "NetworkProxy",
    "Proxy",
    "ProxyConfig",
    "ProxyNetwork",
    "ProxyNetworkTier",
    "BrowsaError",
    "APIError",
    "AuthError",
    "RateLimitError",
    "InvalidIDError",
    "NotFoundError",
    "TimeoutError",
    "webhooks",
    "__version__",
]
