"""
browsa — real browsers for AI agents.

Quickstart:

    from browsa import Client

    client = Client(api_key="agt_live_...")

    # Run a task and wait for it (hosted model: no LLM key needed)
    job = client.run_task(
        task="Go to news.ycombinator.com and return the top story title.",
        llm="browsa",
    )
    print(job.outcome, job.final_result)

job.status says the run ended; job.outcome says how ("failed" with status
"completed": the agent finished but could not do the task).

For async usage:

    from browsa import AsyncClient

    async with AsyncClient(api_key="agt_live_...") as c:
        job = await c.run_task(task="...", llm="browsa")

For webhooks see browsa.webhooks.verify_signature.
"""
from .client import Client, AsyncClient
from .types import (
    HostedModel, Job, JobFile, JobStatus, LLMKey, Models, OwnKeyModels, Schedule,
    Recipe, RecipeRun, RecipeVersion,
    Robot, RobotAlert, RobotHealth, RobotRun, RobotRunRow,
    SavedSecret, Secret, SecretsNotSaved,
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
    "Recipe",
    "RecipeRun",
    "RecipeVersion",
    "Robot",
    "RobotAlert",
    "RobotHealth",
    "RobotRun",
    "RobotRunRow",
    "SavedSecret",
    "Secret",
    "SecretsNotSaved",
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
