"""Light typed wrappers around the API's JSON envelopes.

Intentionally NOT pydantic — zero deps is a feature (see RATIONALE).
These are tiny dataclasses that surface the fields you actually use.
The raw dict is always available on `.raw` for fields we haven't typed.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from dataclasses import field as dataclass_field
from typing import Any, Optional, TypedDict, Union


class JobStatus:
    """String enum of canonical job statuses. Compare with == to literals."""
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INPUT_REQUIRED = "input_required"

    @classmethod
    def is_terminal(cls, s: str) -> bool:
        return s in (cls.COMPLETED, cls.FAILED, cls.CANCELLED)


def _opt_int(v: Any) -> Optional[int]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return int(v)


def _opt_float(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _opt_str(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v else None


@dataclass
class Usage:
    """LLM token use of a finished task (``job.usage``). Counts the server
    did not send are 0."""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # Number of LLM requests the task made.
    requests: int = 0
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Usage":
        body = body if isinstance(body, dict) else {}
        return cls(
            input_tokens=_opt_int(body.get("input_tokens")) or 0,
            output_tokens=_opt_int(body.get("output_tokens")) or 0,
            cache_read_tokens=_opt_int(body.get("cache_read_tokens")) or 0,
            cache_write_tokens=_opt_int(body.get("cache_write_tokens")) or 0,
            requests=_opt_int(body.get("requests")) or 0,
            raw=body,
        )


@dataclass
class SavedSecret:
    """A workspace secret a run saved (``job.saved_secrets``): when the agent
    created a login (a signup), the runner stores it as a secret unless the
    task was sent with ``save_secrets=False``. Never carries a value.

    type is ``"login"`` or ``"value"``; username_masked is set on logins
    only ("al…@example.com"); existing is True when the run updated a secret
    that was already there instead of creating one."""
    name: str
    id: Optional[str] = None
    type: Optional[str] = None
    origins: list = field(default_factory=list)
    username_masked: Optional[str] = None
    existing: bool = False
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "SavedSecret":
        body = body if isinstance(body, dict) else {}
        origins = body.get("origins")
        return cls(
            name=body.get("name") or "",
            id=_opt_str(body.get("id")),
            type=_opt_str(body.get("type")),
            origins=[o for o in origins if isinstance(o, str)] if isinstance(origins, list) else [],
            username_masked=_opt_str(body.get("username_masked")),
            existing=body.get("existing") is True,
            raw=body,
        )


@dataclass
class SecretsNotSaved:
    """Why a run did not save the login it created (``job.secrets_not_saved``).

    code is one of KEY_SCOPE_REQUIRED (the API key lacks ``secrets:write``),
    SECRET_ROLE_REQUIRED (the member may not change secrets),
    OUTPUT_SECRETS_OFF, SECRETS_UNAVAILABLE, SECRET_LIMIT, NO_USERNAME or
    SAVE_FAILED."""
    code: str
    message: str = ""
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: Any) -> Optional["SecretsNotSaved"]:
        if not isinstance(body, dict) or not body.get("code"):
            return None
        return cls(code=str(body.get("code")), message=str(body.get("message") or ""), raw=body)


@dataclass
class Job:
    """Single job envelope returned by GET /v1/jobs/:id and POST /v1/tasks."""
    id: str
    status: str
    kind: str
    step_count: int
    progress_done: int
    progress_total: int
    framework: Optional[str] = None
    live_url: Optional[str] = None
    agent_id: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error_message: Optional[str] = None
    error_code: Optional[str] = None
    credits_charged: Optional[int] = None
    final_result: Optional[str] = None
    input_question: Optional[str] = None
    result_url: Optional[str] = None
    status_url: Optional[str] = None
    files: Optional[list] = None
    # Task secrets the job was given: [{"domain": ..., "name": ...}]. Never values.
    secret_names: Optional[list] = None
    # The task text (GET /v1/jobs/:id on a task job).
    task: Optional[str] = None
    # Sessions: the session this task belongs to. Set on the 202 of a task
    # created with keep_browser=True (with session_url), on the 202 of
    # send_message (with turn, the 1-based turn number). GET /v1/jobs/:id of
    # a turn has session_id but no turn; run_message() keeps the turn.
    session_id: Optional[str] = None
    session_url: Optional[str] = None
    turn: Optional[int] = None
    # Saved LLM key the job used (never the secret). llm_key_source is
    # "saved" when chosen by llm_key_id, "default" for the workspace default.
    llm_key_id: Optional[str] = None
    llm_key_masked: Optional[str] = None
    llm_key_source: Optional[str] = None
    # How the job ended: who or what ended it (completed, failed,
    # cancelled_by_user, timed_out, step_limit_reached, budget_reached,
    # blocked_by_bot_check, never_started, stalled). None until the job is
    # finished. Beside status / error_code, and can say more: a task a limit
    # stopped that still returned a partial result is "completed" with
    # outcome "step_limit_reached". outcome_message is one sentence about
    # it; signals lists what was seen on the way (bot_check_seen,
    # bot_check_passed, proxy_failed, ...), empty when nothing was; duration_ms is started_at
    # to completed_at.
    outcome: Optional[str] = None
    outcome_message: Optional[str] = None
    signals: list = field(default_factory=list)
    duration_ms: Optional[int] = None
    # From the finished job's result; all None on jobs that do not have them
    # (still running, or run before these existed).
    # usage: the task's LLM token counts.
    # llm_cost_usd: estimated LLM cost from public list prices. None when
    # unknown, and always None for hosted runs, which are paid in credits.
    # llm_tier: the hosted tier that ran it ("browsa", "browsa-fast",
    # "browsa-smart"); None with your own key.
    # reasoning: the reasoning level applied ("low", "medium", "high").
    usage: Optional[Usage] = None
    llm_cost_usd: Optional[float] = None
    llm_tier: Optional[str] = None
    reasoning: Optional[str] = None
    # Built-in proxy network (only where GET /v1/proxy-network reports
    # enabled). proxy_network is the tier the job's browser went through
    # ("datacenter" or "residential"), None when it used your own proxy or
    # none; proxy_bytes is the data that went through it and proxy_credits
    # the credits charged for that data (not part of credits_charged).
    proxy_network: Optional[str] = None
    proxy_bytes: int = 0
    proxy_credits: int = 0
    # Replays: True when the task was created with record_recipe; the recipe
    # draft recorded from the run, None until it is stored.
    record_recipe: bool = False
    recipe_draft_id: Optional[str] = None
    # Workspace secrets (``secret_ids``) the job was given, value-free:
    # [{"id", "name", "type", "origins", ...}]. Empty when none.
    secrets_used: list = field(default_factory=list)
    # Logins the run created and saved as workspace secrets (from the job's
    # result; see save_secrets on create_task). Empty when none.
    saved_secrets: "list[SavedSecret]" = field(default_factory=list)
    # Why a login the run created was not saved, or None.
    secrets_not_saved: Optional[SecretsNotSaved] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Job":
        result = body.get("result") or {}
        if not isinstance(result, dict):
            result = {}
        final_result = result.get("final_result")
        raw_files = result.get("files")
        files = [JobFile.from_response(f) for f in raw_files] if raw_files else None
        raw_usage = result.get("usage")
        return cls(
            id=body.get("id") or body.get("job_id") or "",
            status=body.get("status") or "",
            kind=body.get("kind") or "",
            step_count=int(body.get("step_count") or 0),
            progress_done=int(body.get("progress_done") or 0),
            progress_total=int(body.get("progress_total") or 0),
            framework=body.get("framework"),
            live_url=body.get("live_url"),
            agent_id=body.get("agent_id"),
            created_at=body.get("created_at"),
            started_at=body.get("started_at"),
            completed_at=body.get("completed_at"),
            error_message=body.get("error_message"),
            error_code=body.get("error_code"),
            credits_charged=body.get("credits_charged"),
            final_result=final_result,
            input_question=body.get("input_question"),
            result_url=body.get("result_url"),
            status_url=body.get("status_url"),
            files=files,
            secret_names=body.get("secret_names"),
            task=body.get("task"),
            session_id=body.get("session_id"),
            session_url=body.get("session_url"),
            turn=body.get("turn"),
            llm_key_id=body.get("llm_key_id"),
            llm_key_masked=body.get("llm_key_masked"),
            llm_key_source=body.get("llm_key_source"),
            outcome=body.get("outcome"),
            outcome_message=body.get("outcome_message"),
            signals=list(body.get("signals") or []),
            duration_ms=body.get("duration_ms"),
            usage=Usage.from_response(raw_usage) if isinstance(raw_usage, dict) else None,
            llm_cost_usd=_opt_float(result.get("llm_cost_usd")),
            llm_tier=_opt_str(result.get("llm_tier")),
            reasoning=_opt_str(result.get("reasoning")),
            proxy_network=body.get("proxy_network") or None,
            proxy_bytes=int(body.get("proxy_bytes") or 0),
            proxy_credits=int(body.get("proxy_credits") or 0),
            record_recipe=body.get("record_recipe") is True,
            recipe_draft_id=body.get("recipe_draft_id") or None,
            secrets_used=[s for s in (body.get("secrets_used") or []) if isinstance(s, dict)]
            if isinstance(body.get("secrets_used"), list) else [],
            saved_secrets=[SavedSecret.from_response(s) for s in (result.get("saved_secrets") or [])
                           if isinstance(s, dict)] if isinstance(result.get("saved_secrets"), list) else [],
            secrets_not_saved=SecretsNotSaved.from_response(result.get("secrets_not_saved")),
            raw=body,
        )

    @property
    def is_terminal(self) -> bool:
        return JobStatus.is_terminal(self.status)

    @property
    def succeeded(self) -> bool:
        return self.status == JobStatus.COMPLETED and not self.error_message

    def __str__(self) -> str:
        return f"Job(id={self.id[:8]}…, status={self.status}, steps={self.step_count}/{self.progress_total})"


@dataclass
class JobFile:
    """A downloadable output file a task agent wrote (incl. session.gif recording)."""
    name: str
    size: int
    created_at: Optional[str] = None

    @classmethod
    def from_response(cls, body: dict) -> "JobFile":
        return cls(name=body.get("name") or "", size=int(body.get("size") or 0),
                   created_at=body.get("created_at"))


@dataclass
class SessionTurn:
    """One message in a session and the agent's answer."""
    job_id: str
    task: str
    status: str
    final_result: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    step_count: int = 0
    duration_seconds: Optional[float] = None
    credits_charged: int = 0
    llm: Optional[str] = None
    live_url: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "SessionTurn":
        return cls(
            job_id=body.get("job_id") or "",
            task=body.get("task") or "",
            status=body.get("status") or "",
            final_result=body.get("final_result"),
            error_code=body.get("error_code"),
            error_message=body.get("error_message"),
            step_count=int(body.get("step_count") or 0),
            duration_seconds=body.get("duration_seconds"),
            credits_charged=int(body.get("credits_charged") or 0),
            llm=body.get("llm"),
            live_url=body.get("live_url"),
            created_at=body.get("created_at"),
            started_at=body.get("started_at"),
            completed_at=body.get("completed_at"),
            raw=body,
        )

    @property
    def is_terminal(self) -> bool:
        return JobStatus.is_terminal(self.status)


@dataclass
class SessionBrowser:
    """The session's browser right now.

    status is "starting", "live" or "closed"; mode is "burner" or
    "persistent" (an identity), None until known. credits is what the
    browser cost: 5 for a burner, 1 per identity session.
    """
    status: str
    mode: Optional[str] = None
    live_url: Optional[str] = None
    expires_at: Optional[str] = None
    expires_in_seconds: Optional[int] = None
    credits: int = 0

    @classmethod
    def from_response(cls, body: dict) -> "SessionBrowser":
        return cls(
            status=body.get("status") or "",
            mode=body.get("mode"),
            live_url=body.get("live_url"),
            expires_at=body.get("expires_at"),
            expires_in_seconds=body.get("expires_in_seconds"),
            credits=int(body.get("credits") or 0),
        )


@dataclass
class Session:
    """GET /v1/sessions/:id: follow-up messages on the same browser.

    status is "running" (a turn is queued or running), "idle" (it takes a
    follow-up now) or "closed" (its browser is gone; closed_reason says
    why: "expired", "stopped", "failed" or "single_task").
    """
    id: str
    status: str
    accepts_messages: bool
    title: str = ""
    closed_reason: Optional[str] = None
    keep_browser: bool = False
    agent_id: Optional[str] = None
    browser: Optional[SessionBrowser] = None
    credits_charged: int = 0
    turn_count: int = 0
    turns: list = field(default_factory=list)
    created_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Session":
        return cls(
            id=body.get("id") or "",
            status=body.get("status") or "",
            accepts_messages=bool(body.get("accepts_messages")),
            title=body.get("title") or "",
            closed_reason=body.get("closed_reason"),
            keep_browser=bool(body.get("keep_browser")),
            agent_id=body.get("agent_id"),
            browser=SessionBrowser.from_response(body.get("browser") or {}),
            credits_charged=int(body.get("credits_charged") or 0),
            turn_count=int(body.get("turn_count") or 0),
            turns=[SessionTurn.from_response(t) for t in body.get("turns") or []],
            created_at=body.get("created_at"),
            raw=body,
        )

    @property
    def last_turn(self) -> Optional[SessionTurn]:
        return self.turns[-1] if self.turns else None


@dataclass
class Schedule:
    """A recurring scheduled task (GET/POST /v1/schedules)."""
    id: str
    interval_seconds: int
    enabled: bool
    name: Optional[str] = None
    task: Optional[str] = None
    llm: Optional[str] = None
    next_run_at: Optional[str] = None
    last_run_at: Optional[str] = None
    last_job_id: Optional[str] = None
    run_count: int = 0
    created_at: Optional[str] = None
    # Saved LLM key the schedule runs with (the schedule stores no secret).
    llm_key_id: Optional[str] = None
    # Reasoning level its runs use; None for the tier's or provider's default.
    reasoning: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Schedule":
        return cls(
            id=body.get("id") or "",
            interval_seconds=int(body.get("interval_seconds") or 0),
            enabled=bool(body.get("enabled")),
            name=body.get("name"),
            task=body.get("task"),
            llm=body.get("llm"),
            next_run_at=body.get("next_run_at"),
            last_run_at=body.get("last_run_at"),
            last_job_id=body.get("last_job_id"),
            run_count=int(body.get("run_count") or 0),
            created_at=body.get("created_at"),
            llm_key_id=body.get("llm_key_id"),
            reasoning=_opt_str(body.get("reasoning")),
            raw=body,
        )


@dataclass
class Webhook:
    id: str
    url: str
    events: list
    created_at: Optional[str] = None
    last_sent_at: Optional[str] = None
    last_error: Optional[str] = None
    disabled_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Webhook":
        return cls(
            id=body.get("id") or "",
            url=body.get("url") or "",
            events=list(body.get("events") or []),
            created_at=body.get("created_at"),
            last_sent_at=body.get("last_sent_at"),
            last_error=body.get("last_error"),
            disabled_at=body.get("disabled_at"),
            raw=body,
        )


@dataclass
class LLMKey:
    """A saved LLM provider key (GET/POST /v1/llm-keys).

    The API never returns the secret: ``masked`` is the known prefix plus
    the last 4 characters (e.g. ``"sk-ant-…a1b2"``).

    status is ``valid`` | ``invalid`` | ``unchecked``; status_detail is
    ``ok`` | ``invalid_key`` | ``insufficient_quota`` | ``rate_limited`` |
    ``provider_unreachable`` | ``unexpected_response`` | ``not_checked``, and
    status_message is the plain-language text for it.
    """
    id: str
    provider: str
    masked: str
    name: str = ""
    base_url: Optional[str] = None
    is_default: bool = False
    status: str = ""
    status_detail: Optional[str] = None
    status_message: Optional[str] = None
    last_validated_at: Optional[str] = None
    last_used_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "LLMKey":
        body = body or {}
        return cls(
            id=body.get("id") or "",
            provider=body.get("provider") or "",
            masked=body.get("masked") or "",
            name=body.get("name") or "",
            base_url=body.get("base_url"),
            is_default=bool(body.get("is_default")),
            status=body.get("status") or "",
            status_detail=body.get("status_detail"),
            status_message=body.get("status_message"),
            last_validated_at=body.get("last_validated_at"),
            last_used_at=body.get("last_used_at"),
            created_at=body.get("created_at"),
            updated_at=body.get("updated_at"),
            raw=body,
        )


@dataclass
class HostedModel:
    """One hosted tier from GET /v1/models. ``id`` is the value to pass as
    ``llm`` ("browsa", "browsa-fast", "browsa-smart").

    model is what the tier runs on now and fallback_models what it falls back
    to, in order; reasoning is the tier's default level (None: the model's
    own default); credits_per_task is the flat number of credits the tier
    adds to a task (None if the server did not say). These are server
    settings and can change.
    """
    id: str
    model: str = ""
    fallback_models: list = field(default_factory=list)
    reasoning: Optional[str] = None
    credits_per_task: Optional[int] = None
    default: bool = False
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "HostedModel":
        body = body if isinstance(body, dict) else {}
        return cls(
            id=body.get("id") or "",
            model=body.get("model") or "",
            fallback_models=list(body.get("fallback_models") or []),
            reasoning=_opt_str(body.get("reasoning")),
            credits_per_task=_opt_int(body.get("credits_per_task")),
            default=bool(body.get("default")),
            raw=body,
        )


@dataclass
class OwnKeyModels:
    """What you can run with your own LLM key: the providers, and the model
    used for each when ``llm`` is omitted."""
    providers: list = field(default_factory=list)
    default_models: dict = field(default_factory=dict)

    @classmethod
    def from_response(cls, body: dict) -> "OwnKeyModels":
        body = body if isinstance(body, dict) else {}
        return cls(
            providers=list(body.get("providers") or []),
            default_models=dict(body.get("default_models") or {}),
        )


@dataclass
class Models:
    """GET /v1/models: the hosted tiers and the own-key providers."""
    hosted: list = field(default_factory=list)
    own_key: OwnKeyModels = field(default_factory=OwnKeyModels)
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Models":
        body = body if isinstance(body, dict) else {}
        return cls(
            hosted=[HostedModel.from_response(h) for h in body.get("hosted") or []],
            own_key=OwnKeyModels.from_response(body.get("own_key") or {}),
            raw=body,
        )

    def tier(self, tier_id: str) -> Optional[HostedModel]:
        """The hosted tier with this id, or None."""
        for h in self.hosted:
            if h.id == tier_id:
                return h
        return None


# ─── Proxies ─────────────────────────────────────────────────────────────
# The `proxy` argument of create_task(), create_schedule() and
# create_agent() takes one of two forms.


class ProxyConfig(TypedDict, total=False):
    """Your own HTTP, HTTPS or SOCKS5 proxy. Give host and port, or server
    as "host:port" / "scheme://[user:pass@]host:port"."""
    type: str
    host: str
    port: int
    server: str
    username: str
    password: str
    country: str


class _NetworkProxyRequired(TypedDict):
    network: str


class NetworkProxy(_NetworkProxyRequired, total=False):
    """A tier of Browsa's built-in proxy network, billed per GB from
    credits: ``{"network": "datacenter"}`` or ``{"network": "residential",
    "country": "us"}``. country is a lowercase ISO alpha-2 code and may be
    left out. Nothing else goes next to network (no host, port, server,
    username, password or type), and no proxy_id with it.

    Available only when ``Client.proxy_network()`` reports ``enabled``; its
    tiers list the networks, their countries and the price per GB.
    """
    country: str


Proxy = Union[ProxyConfig, NetworkProxy]


@dataclass
class ProxyNetworkTier:
    """One tier of the built-in proxy network (GET /v1/proxy-network)."""
    network: str
    credits_per_gb: Optional[int] = None
    mb_per_credit: Optional[int] = None
    countries: list = field(default_factory=list)
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "ProxyNetworkTier":
        return cls(
            network=body.get("network") or "",
            credits_per_gb=body.get("credits_per_gb"),
            mb_per_credit=body.get("mb_per_credit"),
            countries=list(body.get("countries") or []),
            raw=body,
        )


@dataclass
class ProxyNetwork:
    """GET /v1/proxy-network: whether the built-in proxy network is on for
    this server, and its tiers. enabled is False and tiers is empty when it
    is off."""
    enabled: bool = False
    tiers: list = field(default_factory=list)
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: Any) -> "ProxyNetwork":
        if not isinstance(body, dict):
            return cls()
        return cls(
            enabled=body.get("enabled") is True,
            tiers=[ProxyNetworkTier.from_response(t) for t in (body.get("tiers") or []) if isinstance(t, dict)],
            raw=body,
        )

    def tier(self, network: str) -> Optional[ProxyNetworkTier]:
        """The tier with that name, or None when it is not offered."""
        for t in self.tiers:
            if t.network == network:
                return t
        return None


# ─── Recipes (replays) ──────────────────────────────────────────────────


@dataclass
class Recipe:
    """A recipe: a versioned JSON program recorded from a task run or uploaded."""
    id: str
    name: str
    status: str  # "draft" or "active"
    current_version: Optional[int] = None
    repair_mode: str = "auto"
    # Credits one successful run costs: the same as the job run as an agent
    # task. Fixed; failed runs cost nothing.
    price_credits: int = 0
    source_job_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    # Body of the current version (get_recipe, create_recipe).
    recipe: Optional[dict] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Recipe":
        cv = body.get("current_version")
        return cls(
            id=body.get("id") or "",
            name=body.get("name") or "",
            status=body.get("status") or "",
            current_version=int(cv) if isinstance(cv, (int, float)) else None,
            repair_mode=body.get("repair_mode") or "",
            price_credits=int(body.get("price_credits") or 0),
            source_job_id=body.get("source_job_id"),
            created_at=body.get("created_at"),
            updated_at=body.get("updated_at"),
            recipe=body.get("recipe") if isinstance(body.get("recipe"), dict) else None,
            raw=body,
        )


@dataclass
class RecipeVersion:
    """One version of a recipe. Only verified versions can be promoted."""
    version: int
    status: str  # "draft", "active" or "retired"
    verified_at: Optional[str] = None
    promoted_at: Optional[str] = None
    created_at: Optional[str] = None
    created_from_job: Optional[str] = None
    created_from_run: Optional[str] = None
    recipe: Optional[dict] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "RecipeVersion":
        return cls(
            version=int(body.get("version") or 0),
            status=body.get("status") or "",
            verified_at=body.get("verified_at"),
            promoted_at=body.get("promoted_at"),
            created_at=body.get("created_at"),
            created_from_job=body.get("created_from_job"),
            created_from_run=body.get("created_from_run"),
            recipe=body.get("recipe") if isinstance(body.get("recipe"), dict) else None,
            raw=body,
        )


@dataclass
class RecipeRun:
    """One run of a recipe (GET /v1/recipe-runs/:id).

    status: "queued", "running", "ok", "failed" or "cancelled". A failed run
    has a typed error_code: blocked, needs_login, site_changed,
    invalid_output, params_invalid or timeout, and costs nothing. A
    successful run costs the recipe's price_credits.
    """
    id: str
    status: str
    job_id: str = ""
    recipe_id: Optional[str] = None
    version: int = 0
    params: Optional[dict] = None
    output: Any = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    layers: Any = None
    # step id -> layer it ran on (1 in-page network, 2 DOM, 3 repair).
    layer_used: Optional[dict] = None
    repaired: bool = False
    repaired_steps: list = field(default_factory=list)
    new_version: Optional[int] = None
    duration_ms: Optional[int] = None
    # The recipe's price when queued; credits is what the run charged (the
    # price when it succeeded, 0 when it failed or was cancelled).
    price_credits: int = 0
    credits: int = 0
    created_at: Optional[str] = None
    finished_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def done(self) -> bool:
        return self.status in ("ok", "failed", "cancelled")

    @classmethod
    def from_response(cls, body: dict) -> "RecipeRun":
        nv = body.get("new_version")
        dm = body.get("duration_ms")
        return cls(
            id=body.get("id") or "",
            status=body.get("status") or "",
            job_id=body.get("job_id") or body.get("id") or "",
            recipe_id=body.get("recipe_id"),
            version=int(body.get("version") or 0),
            params=body.get("params") if isinstance(body.get("params"), dict) else None,
            output=body.get("output"),
            error_code=body.get("error_code"),
            error_message=body.get("error_message"),
            layers=body.get("layers"),
            layer_used=body.get("layer_used") if isinstance(body.get("layer_used"), dict) else None,
            repaired=bool(body.get("repaired")),
            repaired_steps=list(body.get("repaired_steps") or []),
            new_version=int(nv) if isinstance(nv, (int, float)) else None,
            duration_ms=int(dm) if isinstance(dm, (int, float)) else None,
            price_credits=int(body.get("price_credits") or 0),
            credits=int(body.get("credits") or 0),
            created_at=body.get("created_at"),
            finished_at=body.get("finished_at"),
            raw=body,
        )


# ── Robots ────────────────────────────────────────────────────────────────


@dataclass
class RobotHealth:
    """A robot's health: pass rate over the last 20 rows (0 to 1, None
    before any run) and price_credits, what one successful row costs (the
    recipe's price). Failed rows are free."""
    pass_rate: Optional[float] = None
    rows_counted: int = 0
    last_failure: Optional[str] = None
    last_failure_at: Optional[str] = None
    recipe_version: Optional[int] = None
    versions: int = 0
    repairs: int = 0
    price_credits: int = 0
    next_run_at: Optional[str] = None
    schedule_active: bool = False
    site: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "RobotHealth":
        return cls(
            pass_rate=_opt_float(body.get("pass_rate")),
            rows_counted=int(body.get("rows_counted") or 0),
            last_failure=_opt_str(body.get("last_failure")),
            last_failure_at=body.get("last_failure_at"),
            recipe_version=_opt_int(body.get("recipe_version")),
            versions=int(body.get("versions") or 0),
            repairs=int(body.get("repairs") or 0),
            price_credits=int(body.get("price_credits") or 0),
            next_run_at=body.get("next_run_at"),
            schedule_active=bool(body.get("schedule_active")),
            site=_opt_str(body.get("site")),
            raw=body,
        )


@dataclass
class RobotAlert:
    """A monitor hit: ``field`` moved from ``old`` to ``new`` on one row."""
    id: str
    robot_id: str = ""
    robot_run_id: str = ""
    row: int = 0
    field: str = ""
    rule: str = ""
    old: Any = None
    new: Any = None
    created_at: Optional[str] = None
    raw: dict = dataclass_field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "RobotAlert":
        return cls(
            id=body.get("id") or "",
            robot_id=body.get("robot_id") or "",
            robot_run_id=body.get("robot_run_id") or "",
            row=int(body.get("row") or 0),
            field=body.get("field") or "",
            rule=body.get("rule") or "",
            old=body.get("old"),
            new=body.get("new"),
            created_at=body.get("created_at"),
            raw=body,
        )


@dataclass
class RobotRunRow:
    """One input row of a robot run."""
    row: int
    status: str
    input: Optional[dict] = None
    output: Any = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    credits: int = 0
    recipe_run_id: Optional[str] = None
    duration_ms: Optional[int] = None
    alerts: list = field(default_factory=list)
    changed_fields: list = field(default_factory=list)

    @classmethod
    def from_response(cls, body: dict) -> "RobotRunRow":
        return cls(
            row=int(body.get("row") or 0),
            status=body.get("status") or "",
            input=body.get("input") if isinstance(body.get("input"), dict) else None,
            output=body.get("output"),
            error_code=body.get("error_code"),
            error_message=body.get("error_message"),
            credits=int(body.get("credits") or 0),
            recipe_run_id=_opt_str(body.get("recipe_run_id")),
            duration_ms=_opt_int(body.get("duration_ms")),
            alerts=[RobotAlert.from_response(a) for a in body.get("alerts") or []],
            changed_fields=list(body.get("changed_fields") or []),
        )


ROBOT_RUN_TERMINAL = ("completed", "partial", "failed")


@dataclass
class RobotRun:
    """One run of a robot (GET /v1/robot-runs/:id).

    status: "queued", "running", "completed", "partial" or "failed".
    trigger: "manual", "schedule" or "api". credits is what the run charged:
    the recipe's price per successful row. rows is set by robot_runs.get.
    """
    id: str
    status: str
    robot_id: str = ""
    trigger: str = ""
    rows_total: int = 0
    rows_ok: int = 0
    rows_failed: int = 0
    rows_pending: int = 0
    credits: int = 0
    site: Optional[str] = None
    stop_reason: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    rows: Optional[list] = None
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def done(self) -> bool:
        return self.status in ROBOT_RUN_TERMINAL

    @classmethod
    def from_response(cls, body: dict) -> "RobotRun":
        rows = body.get("rows")
        return cls(
            id=body.get("id") or "",
            status=body.get("status") or "",
            robot_id=body.get("robot_id") or "",
            trigger=body.get("trigger") or "",
            rows_total=int(body.get("rows_total") or 0),
            rows_ok=int(body.get("rows_ok") or 0),
            rows_failed=int(body.get("rows_failed") or 0),
            rows_pending=int(body.get("rows_pending") or 0),
            credits=int(body.get("credits") or 0),
            site=_opt_str(body.get("site")),
            stop_reason=_opt_str(body.get("stop_reason")),
            created_at=body.get("created_at"),
            started_at=body.get("started_at"),
            finished_at=body.get("finished_at"),
            rows=[RobotRunRow.from_response(r) for r in rows] if isinstance(rows, list) else None,
            raw=body,
        )


@dataclass
class Robot:
    """A robot: a saved browser job over a recipe, run on demand, on a
    schedule or from the API. One run covers every input row; a row costs
    the recipe's price_credits (``health.price_credits``), failed rows are free.

    settings is ``{"model", "proxy", "browser", "secrets"}``: model, proxy
    and browser are None when Auto; secrets is a list of secret names or
    ids (``[]`` when none). settings_warnings lists what may stop a row
    from typing a secret, as ``{"code", "secret", "message"}`` (codes
    SECRET_NOT_FOUND, SECRET_ORIGIN_MISMATCH, SECRET_NO_ORIGINS,
    SECRETS_UNAVAILABLE).
    schedule is ``{"interval_seconds", "at", "weekday", "tz", "next_run_at",
    "enabled", "id"}`` or None.
    """
    id: str
    name: str
    status: str
    description: str = ""
    recipe_id: Optional[str] = None
    paused_reason: Optional[str] = None
    profile_id: Optional[str] = None
    inputs: list = field(default_factory=list)
    destinations: list = field(default_factory=list)
    monitors: list = field(default_factory=list)
    schedule: Optional[dict] = None
    settings: dict = field(default_factory=lambda: {"model": None, "proxy": None, "browser": None, "secrets": []})
    settings_warnings: list = field(default_factory=list)
    source_job_id: Optional[str] = None
    health: Optional[RobotHealth] = None
    alerts_unread: int = 0
    last_run: Optional[RobotRun] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Robot":
        raw_st = body.get("settings")
        st: dict = raw_st if isinstance(raw_st, dict) else {}
        h = body.get("health")
        lr = body.get("last_run")
        return cls(
            id=body.get("id") or "",
            name=body.get("name") or "",
            status=body.get("status") or "",
            description=body.get("description") or "",
            recipe_id=_opt_str(body.get("recipe_id")),
            paused_reason=_opt_str(body.get("paused_reason")),
            profile_id=_opt_str(body.get("profile_id")),
            inputs=list(body.get("inputs") or []),
            destinations=list(body.get("destinations") or []),
            monitors=list(body.get("monitors") or []),
            schedule=body.get("schedule") if isinstance(body.get("schedule"), dict) else None,
            settings={"model": None, "proxy": None, "browser": None, **st,
                      "secrets": list(st.get("secrets") or [])},
            settings_warnings=list(body.get("settings_warnings") or []),
            source_job_id=_opt_str(body.get("source_job_id")),
            health=RobotHealth.from_response(h) if isinstance(h, dict) else None,
            alerts_unread=int(body.get("alerts_unread") or 0),
            last_run=RobotRun.from_response(lr) if isinstance(lr, dict) else None,
            created_at=body.get("created_at"),
            updated_at=body.get("updated_at"),
            raw=body,
        )


@dataclass
class Secret:
    """A workspace secret (``client.secrets``). Values are write-only: no
    route returns a value, a seed or anything derived from one except
    ``username_masked``.

    type is ``"login"``, ``"totp"`` or ``"value"``. origins are where it may
    be typed (``["https://*.github.com"]``, or ``["*"]`` with any_origin).
    placeholders are the references act(secret=...) takes
    ("GITHUB_LOGIN:password", "TOTP:GITHUB_LOGIN"). totp is ``{"digits",
    "algorithm", "period"}`` when the secret has a one-time-code seed.
    used_by (list and get only) lists the robots and schedules that name it:
    ``[{"kind": "robot" | "schedule", "id", "name"}]``. needs_origins: saved
    before origins were required; typed nowhere until they are set.
    """
    id: str
    name: str
    type: str
    description: str = ""
    origins: list = field(default_factory=list)
    username_masked: Optional[str] = None
    has_value: bool = False
    has_totp: bool = False
    totp: Optional[dict] = None
    placeholders: list = field(default_factory=list)
    any_origin: bool = False
    needs_origins: bool = False
    warning: Optional[str] = None
    keypair_id: Optional[str] = None
    created_by: Optional[dict] = None
    used_by: list = field(default_factory=list)
    last_used_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, body: dict) -> "Secret":
        body = body if isinstance(body, dict) else {}
        totp = body.get("totp")
        created_by = body.get("created_by")
        return cls(
            id=body.get("id") or "",
            name=body.get("name") or "",
            type=body.get("type") or "",
            description=body.get("description") or "",
            origins=list(body.get("origins") or []),
            username_masked=_opt_str(body.get("username_masked")),
            has_value=body.get("has_value") is True,
            has_totp=body.get("has_totp") is True,
            totp=totp if isinstance(totp, dict) else None,
            placeholders=list(body.get("placeholders") or []),
            any_origin=body.get("any_origin") is True,
            needs_origins=body.get("needs_origins") is True,
            warning=_opt_str(body.get("warning")),
            keypair_id=_opt_str(body.get("keypair_id")),
            created_by=created_by if isinstance(created_by, dict) else None,
            used_by=list(body.get("used_by") or []),
            last_used_at=body.get("last_used_at"),
            created_at=body.get("created_at"),
            updated_at=body.get("updated_at"),
            raw=body,
        )
