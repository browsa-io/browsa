"""Sync and async REST clients for browsa.io.

Zero third-party deps — uses urllib + asyncio + stdlib json. The SDK ships
as a single small wheel with no transitive dependency surface, which means
agencies running it inside locked-down LLM agent environments don't have to
think about wheelhouse builds, version conflicts, or supply-chain audits.

If we ever need streaming we can adopt httpx + sse-starlette gracefully —
this stays pure-stdlib until then.
"""
from __future__ import annotations

import asyncio
import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, AsyncIterator, Iterable, Iterator, List, Optional, Union

from . import errors
from .types import (
    Job, JobFile, JobStatus, LLMKey, Models, Proxy, ProxyNetwork, Recipe, RecipeRun, RecipeVersion,
    Robot, RobotAlert, RobotRun, Schedule, Secret, Session, Webhook,
)
from ._version import __version__

DEFAULT_BASE_URL = "https://browsa.io"
# Browser connections (CDP over WebSocket) have a host of their own that no
# CDN sits in front of. The API's cdp_http / cdp_url always win; this is only
# the fallback connect() builds when an agent carries no CDP address.
# wss://browsa.io/api/v1/cdp/... keeps working.
DEFAULT_CDP_BASE_URL = "https://cdp.browsa.io"
DEFAULT_TIMEOUT = 30.0
DEFAULT_POLL_INTERVAL = 2.0  # seconds between job-status polls
USER_AGENT = f"browsa-python/{__version__}"


def _llm_key_path(llm_key_id: str) -> str:
    return "/v1/llm-keys/" + urllib.parse.quote(str(llm_key_id), safe="")


def _q(segment: str) -> str:
    """One URL path segment, escaped."""
    return urllib.parse.quote(str(segment), safe="")


class _Transport:
    """Internal sync HTTP transport. Splits request → response → error parsing
    so the same logic can be reused by AsyncClient via run_in_executor."""

    def __init__(self, api_key: str, base_url: str, timeout: float) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Optional[dict] = None,
        timeout: Optional[float] = None,
        extra_headers: Optional[dict] = None,
        raw: bool = False,
    ) -> Any:
        """raw=True returns the response body as bytes whatever its
        Content-Type (file downloads: a .json output file stays bytes)."""
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})}"

        data = None
        headers = {
            "X-API-Key": self.api_key,
            "Accept": "*/*" if raw else "application/json",
            "User-Agent": USER_AGENT,
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if extra_headers:
            # Caller-provided headers (e.g. Idempotency-Key) take priority
            # but never overwrite auth — silently drop X-API-Key overrides.
            for k, v in extra_headers.items():
                if k.lower() in ("x-api-key", "authorization"):
                    continue
                if v is not None:
                    headers[k] = str(v)

        req = urllib.request.Request(url, method=method.upper(), headers=headers, data=data)
        eff_timeout = timeout if timeout is not None else self.timeout

        try:
            with urllib.request.urlopen(req, timeout=eff_timeout) as resp:
                data_bytes = resp.read()
                if raw:
                    return data_bytes
                ctype = (resp.headers.get("Content-Type") or "").lower()
                if not data_bytes:
                    return None
                if "application/json" in ctype:
                    return json.loads(data_bytes)
                # Some endpoints (CSV/NDJSON export) return raw bytes.
                return data_bytes
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read())
            except Exception:
                err_body = {"error": e.reason or str(e), "code": None, "request_id": None}
            retry_after = None
            try:
                ra = e.headers.get("Retry-After") if e.headers else None
                if ra:
                    retry_after = float(ra)
            except Exception:
                pass
            if e.code == 429:
                raise errors.RateLimitError(
                    err_body.get("error") or "rate limited",
                    code=err_body.get("code"),
                    request_id=err_body.get("request_id"),
                    status=e.code,
                    body=err_body,
                    retry_after=retry_after,
                )
            raise errors.from_response(e.code, err_body)
        except urllib.error.URLError as e:
            # A connect timeout arrives wrapped in URLError.
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise errors.TimeoutError(f"request timed out after {eff_timeout}s") from e
            raise errors.BrowsaError(f"network error: {e}") from e
        except (socket.timeout, TimeoutError) as e:
            # A read timeout is raised bare by http.client, not as URLError.
            # (socket.timeout is TimeoutError itself from Python 3.10.)
            raise errors.TimeoutError(f"request timed out after {eff_timeout}s") from e
        except (http.client.HTTPException, OSError) as e:
            # Connection reset or closed mid-response.
            raise errors.BrowsaError(f"network error: {e}") from e


_UNSET: Any = object()


class Robots:
    """``client.robots``: saved browser jobs over recipes, run on demand, on a
    schedule or from the API. A row costs the recipe's price_credits; failed
    rows are free.

    ``settings`` is ``{"model": {"llm", "llm_key_id"?}, "proxy": {"network":
    "datacenter" | "residential", "country"?} or {"proxy_id"}, "browser":
    {"os": "mac" | "windows" | "linux", "screen": "1920x1080"}, "secrets":
    ["GITHUB_LOGIN", ...]}``; a missing or None part is Auto (no secrets).
    ``secrets`` names the workspace secrets (names or ids) every row may
    type. ``schedule`` is ``{"interval_seconds": 86400, "at": "09:00",
    "weekday": 1, "tz": "Europe/Paris"}``.
    """

    def __init__(self, t: _Transport) -> None:
        self._t = t

    @staticmethod
    def _path(robot_id: str, rest: str = "") -> str:
        return f"/v1/robots/{_q(robot_id)}{rest}"

    def create(
        self,
        *,
        name: str,
        from_job_id: Optional[str] = None,
        recipe_id: Optional[str] = None,
        description: Optional[str] = None,
        inputs: Optional[List[dict]] = None,
        schedule: Optional[dict] = None,
        destinations: Optional[List[dict]] = None,
        monitors: Optional[List[dict]] = None,
        profile_id: Optional[str] = None,
        settings: Optional[dict] = None,
    ) -> Robot:
        """POST /v1/robots from a task run recorded with ``record_recipe=True``
        (``from_job_id``) or from a recipe (``recipe_id``). ``inputs``: one
        dict per row, up to 500."""
        body = {k: v for k, v in {
            "name": name, "from_job_id": from_job_id, "recipe_id": recipe_id,
            "description": description, "inputs": inputs, "schedule": schedule,
            "destinations": destinations, "monitors": monitors,
            "profile_id": profile_id, "settings": settings,
        }.items() if v is not None}
        return Robot.from_response(self._t.request("POST", "/v1/robots", body=body))

    def list(self, *, limit: Optional[int] = None) -> List[Robot]:
        """GET /v1/robots, newest first."""
        body = self._t.request("GET", "/v1/robots", query={"limit": limit}) or {}
        return [Robot.from_response(r) for r in body.get("robots") or []]

    def get(self, robot_id: str) -> Robot:
        """GET /v1/robots/:id with health and the last run."""
        return Robot.from_response(self._t.request("GET", self._path(robot_id)))

    def update(
        self,
        robot_id: str,
        *,
        name: Any = _UNSET,
        description: Any = _UNSET,
        inputs: Any = _UNSET,
        schedule: Any = _UNSET,
        destinations: Any = _UNSET,
        monitors: Any = _UNSET,
        profile_id: Any = _UNSET,
        settings: Any = _UNSET,
        from_job_id: Any = _UNSET,
        recipe_id: Any = _UNSET,
    ) -> Robot:
        """PATCH /v1/robots/:id. Only the fields you pass change. None clears
        ``schedule``, ``profile_id`` and ``settings`` (every part Auto, no
        secrets). ``from_job_id`` re-records the robot.

        ``settings`` changes only the parts you pass: ``settings={"proxy":
        {"network": "residential"}}`` keeps the robot's model, browser and
        secrets. The API replaces the whole settings object, so the SDK reads
        the robot first and sends its current settings with your parts over
        them (one extra GET). A part set to None goes back to Auto;
        ``{"secrets": []}`` removes every secret."""
        fields = {
            "name": name, "description": description, "inputs": inputs, "schedule": schedule,
            "destinations": destinations, "monitors": monitors, "profile_id": profile_id,
            "settings": settings, "from_job_id": from_job_id, "recipe_id": recipe_id,
        }
        body = {k: v for k, v in fields.items() if v is not _UNSET}
        if isinstance(settings, dict):
            body["settings"] = self._merged_settings(robot_id, settings)
        return Robot.from_response(self._t.request("PATCH", self._path(robot_id), body=body))

    def _merged_settings(self, robot_id: str, parts: dict) -> dict:
        """The robot's current settings with ``parts`` over them, key by key.
        PATCH /v1/robots/:id replaces settings whole, so sending only the
        given parts would drop the others (settings.secrets among them)."""
        current = self._t.request("GET", self._path(robot_id)) or {}
        cur = current.get("settings") if isinstance(current, dict) else None
        merged = dict(cur) if isinstance(cur, dict) else {}
        merged.update(parts)
        return merged

    def delete(self, robot_id: str) -> None:
        """DELETE /v1/robots/:id. Past runs stay as billing history."""
        self._t.request("DELETE", self._path(robot_id))

    def run(self, robot_id: str, *, inputs: Optional[List[dict]] = None) -> RobotRun:
        """POST /v1/robots/:id/run. ``inputs`` replaces the saved rows for this
        run only. Returns the queued run; see robot_runs.wait."""
        body = {"inputs": inputs} if inputs is not None else {}
        return RobotRun.from_response(self._t.request("POST", self._path(robot_id, "/run"), body=body))

    def pause(self, robot_id: str) -> Robot:
        return Robot.from_response(self._t.request("POST", self._path(robot_id, "/pause")))

    def resume(self, robot_id: str) -> Robot:
        return Robot.from_response(self._t.request("POST", self._path(robot_id, "/resume")))

    def runs(self, robot_id: str, *, limit: Optional[int] = None) -> List[RobotRun]:
        """GET /v1/robots/:id/runs, newest first (rows come with robot_runs.get)."""
        body = self._t.request("GET", self._path(robot_id, "/runs"), query={"limit": limit}) or {}
        return [RobotRun.from_response(r) for r in body.get("runs") or []]

    def alerts(self, robot_id: str, *, limit: Optional[int] = None) -> List[RobotAlert]:
        """GET /v1/robots/:id/alerts: what the monitors caught, newest first."""
        body = self._t.request("GET", self._path(robot_id, "/alerts"), query={"limit": limit}) or {}
        return [RobotAlert.from_response(a) for a in body.get("alerts") or []]

    def mark_alerts_read(self, robot_id: str) -> None:
        """POST /v1/robots/:id/alerts/read: alerts_unread goes to 0."""
        self._t.request("POST", self._path(robot_id, "/alerts/read"))


class RobotRuns:
    """``client.robot_runs``: one run of a robot, with a row per input."""

    def __init__(self, t: _Transport) -> None:
        self._t = t

    def get(self, run_id: str) -> RobotRun:
        """GET /v1/robot-runs/:id with rows."""
        return RobotRun.from_response(self._t.request("GET", f"/v1/robot-runs/{_q(run_id)}"))

    def wait(self, run_id: str, *, timeout: float = 600.0, poll: float = 3.0) -> RobotRun:
        """Poll get() until the run is completed, partial or failed."""
        deadline = time.monotonic() + timeout
        while True:
            run = self.get(run_id)
            if run.done:
                return run
            if time.monotonic() + poll > deadline:
                raise errors.TimeoutError(f"robot run {run_id} still {run.status} after {timeout}s")
            time.sleep(poll)

    def export(self, run_id: str, *, format: str = "csv", items: Optional[int] = None) -> Any:
        """GET /v1/robot-runs/:id/export. CSV (default) comes back as a str,
        JSON as a dict with ``rows``. ``items`` caps list items per CSV cell
        (default 5, up to 50)."""
        out = self._t.request("GET", f"/v1/robot-runs/{_q(run_id)}/export",
                              query={"format": format, "items": items})
        if isinstance(out, (bytes, bytearray)):
            text = out.decode("utf-8")
            return json.loads(text) if format == "json" else text
        return out


def _secret_path(id_or_name: str, rest: str = "") -> str:
    return f"/v1/secrets/{_q(id_or_name)}{rest}"


class Secrets:
    """``client.secrets``: the workspace vault for what an agent may type but
    must never read: site logins (``type="login"``: username, password and
    an optional one-time-code seed), one-time-code seeds (``"totp"``) and
    plain values such as API keys (``"value"``). Values are write-only; no
    call returns one.

    Use a secret by attaching it, by name or id, in ``secret_ids`` on
    create_task / run_task / auto / create_schedule / run_recipe /
    send_message (or a robot's ``settings["secrets"]``), and refer to it in
    the task text: ``secrets.NAME`` (the value, or a login's username and
    password as the page needs), ``secrets.NAME.username``,
    ``secrets.NAME.password``, ``secrets.NAME.totp`` (the current one-time
    code). Attachment is explicit: a reference to a secret that is not in
    ``secret_ids`` is 400 SECRET_NOT_ATTACHED, an unknown name 400
    SECRET_NOT_FOUND. The older ``{{secret:NAME}}`` and ``%NAME%`` forms
    still work. A secret is typed only on its ``origins``.

    Values may be sent plain (over TLS). To seal them on your side instead,
    fetch keypair() and send ``sealed_<field>`` with ``keypair_id`` as extra
    keyword arguments of create() / update() (RFC 9180 HPKE base mode; the
    SDK adds no crypto dependency, so bring your own HPKE library).

    Changing secrets needs a key with the ``secrets:write`` scope (403
    KEY_SCOPE_REQUIRED otherwise) or, from the dashboard, an owner or admin.
    """

    def __init__(self, t: _Transport) -> None:
        self._t = t

    def list(self) -> List[Secret]:
        """GET /v1/secrets: every secret of the workspace with ``used_by``.
        The workspace limit is on ``list_page()["limit"]``."""
        return self.list_page()["secrets"]

    def list_page(self) -> dict:
        """GET /v1/secrets as ``{"secrets": [Secret], "limit": int}``."""
        body = self._t.request("GET", "/v1/secrets") or {}
        return {"secrets": [Secret.from_response(s) for s in body.get("secrets") or []],
                "limit": body.get("limit")}

    def get(self, id_or_name: str) -> Secret:
        """GET /v1/secrets/:id_or_name with ``used_by``."""
        return Secret.from_response(self._t.request("GET", _secret_path(id_or_name)))

    def create(
        self,
        name: str,
        type: str,
        origins: List[str],
        *,
        description: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        value: Optional[str] = None,
        totp_secret: Optional[str] = None,
        digits: Optional[int] = None,
        algorithm: Optional[str] = None,
        period: Optional[int] = None,
        totp_code: Optional[str] = None,
        allow_any_origin: Optional[bool] = None,
        **extra: Any,
    ) -> Secret:
        """POST /v1/secrets. ``name`` is ``[A-Z0-9_]`` (lower case is
        upper-cased). ``type``: ``"login"`` (username + password, optional
        totp_secret), ``"totp"`` (value or totp_secret: a base32 seed or an
        otpauth:// URI) or ``"value"`` (value, one line). ``origins``:
        where it may be typed, e.g. ``["github.com"]`` (it and its
        subdomains) or ``["https://app.example.com"]``; ``["*"]`` only with
        ``allow_any_origin=True``. ``totp_code``: the code your
        authenticator shows now, checked before anything is saved.
        ``description`` is shown to the model: say what it is for, never the
        value. Sealed fields (``sealed_password=..., keypair_id=...``) go in
        as extra keyword arguments."""
        body: dict = {"name": name, "type": type, "origins": list(origins)}
        for k, v in {
            "description": description, "username": username, "password": password,
            "value": value, "totp_secret": totp_secret, "digits": digits,
            "algorithm": algorithm, "period": period, "totp_code": totp_code,
            "allow_any_origin": allow_any_origin,
        }.items():
            if v is not None:
                body[k] = v
        body.update({k: v for k, v in extra.items() if v is not None})
        return Secret.from_response(self._t.request("POST", "/v1/secrets", body=body))

    def update(
        self,
        id_or_name: str,
        *,
        description: Optional[str] = None,
        origins: Optional[List[str]] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        value: Optional[str] = None,
        totp_secret: Optional[str] = None,
        digits: Optional[int] = None,
        algorithm: Optional[str] = None,
        period: Optional[int] = None,
        totp_code: Optional[str] = None,
        allow_any_origin: Optional[bool] = None,
        **extra: Any,
    ) -> Secret:
        """PATCH /v1/secrets/:id_or_name. Only the fields you pass change;
        the name and type are fixed. ``totp_secret=""`` removes a login's
        one-time-code seed."""
        body: dict = {}
        for k, v in {
            "description": description, "origins": list(origins) if origins is not None else None,
            "username": username, "password": password, "value": value,
            "totp_secret": totp_secret, "digits": digits, "algorithm": algorithm,
            "period": period, "totp_code": totp_code, "allow_any_origin": allow_any_origin,
        }.items():
            if v is not None:
                body[k] = v
        body.update({k: v for k, v in extra.items() if v is not None})
        return Secret.from_response(self._t.request("PATCH", _secret_path(id_or_name), body=body))

    def delete(self, id_or_name: str, *, force: bool = False) -> dict:
        """DELETE /v1/secrets/:id_or_name -> ``{"deleted": True, "id", "name"}``.

        A secret a robot or schedule uses is not deleted: APIError with code
        ``SECRET_IN_USE`` (409) whose ``err.body["used_by"]`` lists them.
        ``force=True`` deletes it anyway (robots keep the name and warn,
        schedules fail their next run with SECRET_MISSING)."""
        query = {"force": "1"} if force else None
        return self._t.request("DELETE", _secret_path(id_or_name), query=query) or {}

    def import_env(
        self,
        env: str,
        origins: List[str],
        *,
        description: Optional[str] = None,
        on_conflict: Optional[str] = None,
        allow_any_origin: Optional[bool] = None,
    ) -> dict:
        """POST /v1/secrets/import: every ``NAME=value`` line of a .env text
        becomes a ``value`` secret typed only on ``origins``. ``on_conflict``:
        ``"fail"`` (default: nothing is written when one name exists),
        ``"skip"`` or ``"overwrite"``. One transaction, at most 100 lines.
        Returns ``{"secrets": [Secret], "created": int, "updated": int,
        "skipped": [names]}``."""
        body: dict = {"env": env, "origins": list(origins)}
        if description is not None:
            body["description"] = description
        if on_conflict is not None:
            body["on_conflict"] = on_conflict
        if allow_any_origin is not None:
            body["allow_any_origin"] = allow_any_origin
        out = self._t.request("POST", "/v1/secrets/import", body=body) or {}
        out = dict(out) if isinstance(out, dict) else {}
        out["secrets"] = [Secret.from_response(s) for s in out.get("secrets") or []]
        return out

    def usage(self, id_or_name: str, *, limit: Optional[int] = None,
              cursor: Optional[str] = None) -> dict:
        """GET /v1/secrets/:id_or_name/usage, newest first: ``{"usage":
        [{"job_id", "origin", "action": "typed" | "totp" | "blocked",
        "source", "at", ...}], "next_cursor"}``. Pass ``next_cursor`` back as
        ``cursor`` for older rows; it is None on the last page. ``limit`` up
        to 500 (default 100)."""
        return self._t.request("GET", _secret_path(id_or_name, "/usage"),
                               query={"limit": limit, "cursor": cursor}) or {}

    def keypair(self) -> dict:
        """GET /v1/secrets/keypair: the server's current HPKE public key for
        sealing values on your side (``id``, ``public_key``, ``suite``,
        ``info_prefix``, ``use_until``). Optional: plain values over TLS are
        accepted too."""
        return self._t.request("GET", "/v1/secrets/keypair") or {}


class _AsyncWrap:
    """Runs each method of a sync namespace in a worker thread."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        fn = getattr(self._inner, name)
        if not callable(fn):
            return fn

        async def call(*a: Any, **kw: Any) -> Any:
            return await asyncio.to_thread(fn, *a, **kw)

        call.__name__ = name
        call.__doc__ = fn.__doc__
        return call


KEYS_URL = "https://app.browsa.io/dashboard/keys"


def resolve_api_key(api_key: Optional[str] = None) -> str:
    """The key to use: the argument, or ``BROWSA_API_KEY`` from the environment.

    Raises ValueError with what to do when there is none, or when it is not a Browsa key."""
    key = (api_key or os.environ.get("BROWSA_API_KEY") or "").strip()
    if not key:
        raise ValueError(
            f"api_key is required: pass api_key or set BROWSA_API_KEY. Create a key at {KEYS_URL}"
        )
    if not key.startswith("agt_"):
        raise ValueError(f"api_key must start with 'agt_'. Create a key at {KEYS_URL}")
    return key


class Client:
    """Synchronous REST client.

    The simplest usage is `client.run_task(...)` which submits a task and
    blocks until it finishes. For fire-and-poll, call `create_task` +
    `get_job` directly.

    Args:
        api_key: An `agt_live_*` key. Default: the `BROWSA_API_KEY` environment
            variable. Create a key at https://app.browsa.io/dashboard/keys
        base_url: Another Browsa API (staging). Default: `BROWSA_BASE_URL`, else https://browsa.io
        timeout: Per-request HTTP timeout (seconds). Long-poll calls override
            this internally; this is the upper bound for one round trip.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        api_key = resolve_api_key(api_key)
        base_url = base_url or os.environ.get("BROWSA_BASE_URL") or DEFAULT_BASE_URL
        self._t = _Transport(api_key, base_url, timeout)
        #: Robots: saved browser jobs (create, list, get, update, delete, run, pause, resume).
        self.robots = Robots(self._t)
        #: One run of a robot (get, wait, export).
        self.robot_runs = RobotRuns(self._t)
        #: Secrets: the workspace vault (list, get, create, update, delete, import_env, usage, keypair).
        self.secrets = Secrets(self._t)
        # Page view sessions seen by observe()/act(): agent id ->
        # {"last": tab id, "tabs": {tab id: session}}. Sent back so the
        # server can tell when element ids are from a view it no longer has.
        self._page_sessions: dict = {}

    # ── Tasks ────────────────────────────────────────────────────────────

    def create_task(
        self,
        *,
        task: str,
        llm: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        llm_key_id: Optional[str] = None,
        framework: str = "browser-use",
        llm_base_url: Optional[str] = None,
        country: Optional[str] = None,
        os_type: Optional[str] = None,
        max_steps: Optional[int] = None,
        reasoning: Optional[str] = None,
        max_credits: Optional[int] = None,
        ja3_profile: Optional[str] = None,
        initial_url: Optional[str] = None,
        profile_id: Optional[str] = None,
        webhook_url: Optional[str] = None,
        # Round-4 fingerprint overrides. Forwarded to the burner the
        # task runs on (POST /v1/agents under the hood). Same accepted
        # values as create_agent().
        screen_resolution: Optional[str] = None,
        webrtc_mode: Optional[str] = None,
        geolocation_mode: Optional[str] = None,
        geolocation_data: Optional[str] = None,
        media_devices_mode: Optional[str] = None,
        port_scan_protection: Optional[str] = None,
        secrets: Optional[dict[str, dict[str, str]]] = None,
        keep_browser: Optional[bool] = None,
        browser_ttl_seconds: Optional[int] = None,
        proxy: Optional[Proxy] = None,
        proxy_id: Optional[str] = None,
        record_recipe: Optional[bool] = None,
        secret_ids: Optional[List[str]] = None,
        save_secrets: Optional[bool] = None,
        **extra: Any,
    ) -> Job:
        """POST /v1/tasks — submit a task; returns immediately with a job id.

        Which LLM key the task uses, first match wins:

        1. ``llm_api_key``: a per-task key (deleted from the job when it ends).
        2. ``llm_key_id``: a key saved in this workspace (see create_llm_key()).
        3. The workspace's default saved key for the provider of ``llm``
           (e.g. ``llm="anthropic:claude-sonnet-5-5"`` uses the default
           Anthropic key). With ``llm`` omitted, the first default key in the
           order anthropic, openai, google is used with that provider's
           default model.
        4. A hosted tier: ``llm="browsa"`` (the default hosted model),
           ``"browsa-fast"`` (fastest and lightest) or ``"browsa-smart"``
           (for harder tasks). No LLM key needed; each adds a flat number of
           credits per task. models() lists the tiers and what they cost.

        So with a default key saved in the dashboard you can omit both
        ``llm`` and ``llm_api_key``. See run_task() to block until completion.

        reasoning: how much the model reasons: ``"low"``, ``"medium"`` or
        ``"high"``. Omit for the tier's or the provider's default. The API
        answers 400 for any other value. The finished job has the level that
        was applied as ``job.reasoning``.

        max_credits: most credits this task may charge (its browser, base and
        step credits, and the hosted-model surcharge). The task stops before
        the step that would go over it: with a partial result it completes
        with ``partial``, otherwise it fails with error_code
        MAX_CREDITS_REACHED and keeps its browser charge. At least 7 on a new
        browser (3 with profile_id), plus the hosted tier's credits_per_task
        (see models()) when ``llm`` is a hosted tier; at most 10000.

        secrets: credentials the agent can type by name without the model
        reading them, as ``{"<domain>": {"<name>": "<value>"}}``, e.g.
        ``{"*.example.com": {"x_password": os.environ["EXAMPLE_PASSWORD"]}}``.
        Refer to a secret in the task by its name ("log in with x_password").
        The model is given only the names; a value is typed only on pages
        whose URL matches its domain ("example.com" = https://example.com,
        "*.example.com" = it and its subdomains). Up to 20 secrets; names
        are a-z, 0-9 and _ (max 40); values are 3 to 512 characters. Values
        are encrypted at rest and deleted when the task ends; the job shows
        only ``secret_names``.

        secret_ids: workspace secrets (``client.secrets``) the task may type,
        by name or id, at most 20. Refer to them in the task text as
        ``secrets.NAME``, ``secrets.NAME.username``, ``secrets.NAME.password``
        or ``secrets.NAME.totp`` (a one-time code), e.g. "log in with
        secrets.GITHUB_LOGIN". Attachment is explicit: a reference to a
        secret not in secret_ids is 400 SECRET_NOT_ATTACHED, an unknown name
        400 SECRET_NOT_FOUND. ``{{secret:NAME}}`` and ``%NAME%`` still work.

        save_secrets: when the run creates a login (a signup), the runner
        saves it as a workspace secret; the finished job lists it in
        ``job.saved_secrets`` (or says why not in ``job.secrets_not_saved``).
        On by default on the server; pass False to opt out. Sent only when
        given.

        keep_browser: start a session. The browser stays up after the task
        ends, until ``browser_ttl_seconds`` after it launched (300 to 3600,
        default 900), so send_message() can run follow-ups on it. The job
        then has ``session_id`` (equal to its id) and ``session_url``. Same
        price as a normal task browser. See create_session().

        proxy: the proxy of the task's browser, one of two forms. Your own
        proxy: ``{"type": "socks5", "host": ..., "port": ..., "username":
        ..., "password": ...}``. Or a tier of Browsa's built-in network,
        billed per GB from credits: ``{"network": "datacenter"}`` or
        ``{"network": "residential", "country": "us"}``, with nothing else
        next to network. The built-in network is available only when
        proxy_network() reports enabled; the price per GB is returned there.
        proxy_id: a saved proxy instead of proxy (not both, and not with a
        network).

        record_recipe: record the run as a recipe draft (replays). When the
        task has finished, ``job.recipe_draft_id`` is set; create_recipe(
        from_job_id=job.id) turns it into a recipe for run_recipe().
        """
        body: dict = {
            "task": task,
            "framework": framework,
        }
        for k, v in {
            "llm": llm,
            "llm_api_key": llm_api_key,
            "llm_key_id": llm_key_id,
            "llm_base_url": llm_base_url,
            "country": country,
            "os_type": os_type,
            "max_steps": max_steps,
            "reasoning": reasoning,
            "max_credits": max_credits,
            "ja3_profile": ja3_profile,
            "initial_url": initial_url,
            "profile_id": profile_id,
            "webhook_url": webhook_url,
            "screen_resolution": screen_resolution,
            "webrtc_mode": webrtc_mode,
            "geolocation_mode": geolocation_mode,
            "geolocation_data": geolocation_data,
            "media_devices_mode": media_devices_mode,
            "port_scan_protection": port_scan_protection,
            "secrets": secrets,
            "keep_browser": keep_browser,
            "browser_ttl_seconds": browser_ttl_seconds,
            "proxy": proxy,
            "proxy_id": proxy_id,
            "record_recipe": record_recipe,
            "secret_ids": list(secret_ids) if secret_ids is not None else None,
            "save_secrets": save_secrets,
        }.items():
            if v is not None:
                body[k] = v
        body.update(extra)
        return Job.from_response(self._t.request("POST", "/v1/tasks", body=body))

    def get_job(self, job_id: str, *, wait: int = 0) -> Job:
        """GET /v1/jobs/:id. Pass `wait=N` (1–120s) to long-poll until the job
        reaches a terminal state or N seconds elapse — saves polling round
        trips on short tasks.

        Client-side timeout is set to wait+10s so we don't race the server's
        own long-poll deadline (was: identical timeout caused TimeoutError
        right when the server was about to return). Discovered via the SDK
        end-to-end test against prod 2026-06-08.
        """
        query = {"wait": wait} if wait else None
        eff_timeout = (wait + 10.0) if wait else None
        return Job.from_response(
            self._t.request("GET", f"/v1/jobs/{job_id}", query=query, timeout=eff_timeout)
        )

    def get_job_status(self, job_id: str) -> str:
        """GET /v1/jobs/:id/status — lightweight status-only poll."""
        body = self._t.request("GET", f"/v1/jobs/{job_id}/status")
        return body.get("status") if isinstance(body, dict) else ""

    def cancel_job(self, job_id: str) -> None:
        """POST /v1/jobs/:id/cancel — 204 on success."""
        self._t.request("POST", f"/v1/jobs/{job_id}/cancel")

    def respond_to_job(self, job_id: str, response: str) -> Job:
        """POST /v1/jobs/:id/respond — answer an `input_required` question
        (e.g. captcha solutions, decision-point prompts) and flip the job
        back to `running`."""
        body = self._t.request("POST", f"/v1/jobs/{job_id}/respond", body={"response": response})
        return Job.from_response(body)

    def wait_for_job(
        self,
        job_id: str,
        *,
        poll: float = DEFAULT_POLL_INTERVAL,
        timeout: Optional[float] = None,
        on_progress: Optional[Any] = None,
    ) -> Job:
        """Block until the job reaches a terminal state.

        Uses a server-side long-poll (`wait=30`) when possible to minimize
        round trips; falls back to client-side sleep + GET if the server
        cuts the connection (e.g. NAT or LB idle timeout).

        Args:
            job_id: UUID of the job to wait on.
            poll: Backoff seconds between polls (default 2s).
            timeout: Total wall-clock seconds to wait. None = forever.
            on_progress: Optional callable(Job) called after every poll —
                great for tqdm progress bars or live UI updates.
        """
        start = time.monotonic()
        while True:
            j = self.get_job(job_id, wait=30)
            if on_progress is not None:
                try:
                    on_progress(j)
                except Exception:
                    # never let a user callback break the wait loop
                    pass
            if j.is_terminal:
                return j
            if timeout is not None and (time.monotonic() - start) > timeout:
                raise errors.TimeoutError(
                    f"wait_for_job exceeded {timeout}s — last status: {j.status}",
                    status=None,
                )
            time.sleep(poll)

    def stream_job_events(
        self,
        job_id: str,
        *,
        after: int = 0,
        wait: int = 25,
    ) -> Iterator[dict]:
        """Yield a job's events as they happen, ending when the job ends.

        Long-polls GET /v1/jobs/:id/events?after=<n>&wait=<wait>. Each item
        is a plain dict:

        - ``{"type": "step", "n", "t", "action", "url", "goal", "result"}``
          for every agent step with ``n > after``, in order.
        - ``{"type": "status", "status", "error_code"}`` once, last, when the
          job is ``completed`` or ``failed``. The generator then returns.

        To resume after a disconnect or a restart, call again with ``after``
        set to the ``n`` of the last step you handled; nothing is skipped or
        repeated. ``wait`` is how long each request may be held open (the
        server caps it at 30s). Errors (network, 404, ...) are raised, not
        retried.

        Example::

            for ev in client.stream_job_events(job.id):
                if ev["type"] == "step":
                    print(ev["n"], ev["action"], ev["url"])
                else:
                    print("finished:", ev["status"])
        """
        wait = max(0, min(int(wait), 30))
        cursor = max(0, int(after))
        while True:
            body = self._t.request(
                "GET",
                f"/v1/jobs/{job_id}/events",
                query={"after": cursor, "wait": wait},
                timeout=wait + 10.0,
            ) or {}
            for ev in body.get("events") or []:
                yield ev
            nxt = body.get("next_after")
            if isinstance(nxt, int) and nxt > cursor:
                cursor = nxt
            if body.get("done"):
                return

    def run_task(
        self,
        *,
        task: str,
        llm: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        framework: str = "browser-use",
        timeout: Optional[float] = 600,
        on_progress: Optional[Any] = None,
        secrets: Optional[dict[str, dict[str, str]]] = None,
        max_credits: Optional[int] = None,
        llm_key_id: Optional[str] = None,
        reasoning: Optional[str] = None,
        secret_ids: Optional[List[str]] = None,
        save_secrets: Optional[bool] = None,
        **kwargs: Any,
    ) -> Job:
        """One-shot: submit + wait + return the terminal Job. The "hello world"
        entry point — five lines from `pip install` to a real-browser-driven
        AI agent.

        secrets: ``{"<domain>": {"<name>": "<value>"}}`` credentials the agent
        types by name; the model sees only the names. See create_task().

        secret_ids: workspace secrets (names or ids) the task may type, as
        ``secrets.NAME`` in the task text. save_secrets=False: do not save a
        login the run creates (``job.saved_secrets``). See create_task().

        max_credits: per-task credit cap, see create_task().

        llm_key_id: a saved LLM key to use instead of llm_api_key. Omit both
        to use the workspace's default saved key. See create_task().

        reasoning: "low", "medium" or "high"; see create_task(). The returned
        job has ``usage``, ``llm_cost_usd``, ``llm_tier`` and ``reasoning``
        when the server reports them.
        """
        job = self.create_task(
            task=task,
            llm=llm,
            llm_api_key=llm_api_key,
            llm_key_id=llm_key_id,
            framework=framework,
            secrets=secrets,
            max_credits=max_credits,
            reasoning=reasoning,
            secret_ids=secret_ids,
            save_secrets=save_secrets,
            **kwargs,
        )
        return self.wait_for_job(job.id, timeout=timeout, on_progress=on_progress)

    # ── Sessions (follow-up messages on the same browser) ────────────────

    def create_session(
        self,
        task: str,
        *,
        llm: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        browser_ttl_seconds: Optional[int] = None,
        reasoning: Optional[str] = None,
        **kwargs: Any,
    ) -> Job:
        """POST /v1/tasks with keep_browser=True: run the first task of a
        session and keep its browser up afterwards.

        Returns the accepted Job; ``job.session_id`` (equal to ``job.id``) is
        what send_message(), get_session() and stop_session() take. The
        browser stays up until ``browser_ttl_seconds`` after it launched
        (300 to 3600, default 900). Same price as a normal task browser (5
        credits). Takes every create_task() option, including agent_id.
        """
        return self.create_task(
            task=task,
            llm=llm,
            llm_api_key=llm_api_key,
            keep_browser=True,
            browser_ttl_seconds=browser_ttl_seconds,
            reasoning=reasoning,
            **kwargs,
        )

    def send_message(
        self,
        session_id: str,
        task: str,
        *,
        llm: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        llm_base_url: Optional[str] = None,
        llm_key_id: Optional[str] = None,
        max_steps: Optional[int] = None,
        reasoning: Optional[str] = None,
        # Accepted and ignored by the API; use max_credits to cap spend.
        max_cost_usd: Optional[float] = None,
        max_credits: Optional[int] = None,
        secrets: Optional[dict[str, dict[str, str]]] = None,
        idempotency_key: Optional[str] = None,
        secret_ids: Optional[List[str]] = None,
        save_secrets: Optional[bool] = None,
        **extra: Any,
    ) -> Job:
        """POST /v1/sessions/:id/messages: queue a follow-up task on the
        session's browser. Returns the accepted Job of the new turn, with
        ``session_id`` and ``turn`` (1-based) set; wait on it with
        wait_for_job(job.id), or use run_message().

        The agent continues on the page where the last turn ended and is
        given the previous task and its result. Model fields left out reuse
        the previous turn's model, but a BYOK ``llm_api_key`` must be sent
        again on every message (keys are deleted when a task ends), or use
        a hosted tier (llm="browsa", "browsa-fast" or "browsa-smart"). A
        follow-up on a kept burner pays no browser, only the task's base and
        step credits. reasoning ("low", "medium" or "high") applies to this
        turn; see create_task().

        Raises APIError with code BROWSER_EXPIRED (409) when the browser is
        gone (start a new session), SESSION_BUSY (409) while a turn is still
        queued or running, and NotFoundError for an unknown id.
        idempotency_key dedupes retries for 24h, like the other create calls.

        secret_ids: workspace secrets (names or ids) this turn may type, as
        ``secrets.NAME`` in the task text; save_secrets=False: do not save a
        login this turn creates. See create_task().
        """
        body: dict = {"task": task}
        for k, v in {
            "llm": llm,
            "llm_api_key": llm_api_key,
            "llm_base_url": llm_base_url,
            "llm_key_id": llm_key_id,
            "max_steps": max_steps,
            "reasoning": reasoning,
            "max_cost_usd": max_cost_usd,
            "max_credits": max_credits,
            "secrets": secrets,
            "secret_ids": list(secret_ids) if secret_ids is not None else None,
            "save_secrets": save_secrets,
        }.items():
            if v is not None:
                body[k] = v
        body.update(extra)
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return Job.from_response(self._t.request(
            "POST", f"/v1/sessions/{session_id}/messages", body=body, extra_headers=headers))

    def run_message(
        self,
        session_id: str,
        task: str,
        *,
        timeout: Optional[float] = 600,
        on_progress: Optional[Any] = None,
        **kwargs: Any,
    ) -> Job:
        """send_message() + wait_for_job(): returns the turn's terminal Job,
        with ``session_id`` and ``turn`` kept from the accepted turn (GET
        /v1/jobs/:id does not return ``turn``)."""
        job = self.send_message(session_id, task, **kwargs)
        done = self.wait_for_job(job.id, timeout=timeout, on_progress=on_progress)
        if done.turn is None:
            done.turn = job.turn
        if done.session_id is None:
            done.session_id = job.session_id or session_id
        return done

    def get_session(self, session_id: str) -> Session:
        """GET /v1/sessions/:id: the session's turns in order and its
        browser. Any task job id works: a task run without keep_browser
        comes back as a closed one-turn session (closed_reason
        "single_task")."""
        return Session.from_response(self._t.request("GET", f"/v1/sessions/{session_id}"))

    def stop_session(self, session_id: str) -> Session:
        """POST /v1/sessions/:id/stop: cancel a turn still in progress (it
        keeps its browser charge, like any cancel) and stop the browser (a
        burner is destroyed; an identity session is closed and its cookies
        saved). Idempotent. Returns the session after the stop."""
        return Session.from_response(self._t.request("POST", f"/v1/sessions/{session_id}/stop"))

    # ── Job files ────────────────────────────────────────────────────────

    def list_job_files(self, job_id: str) -> list[JobFile]:
        """GET /v1/jobs/:id/files — output files the agent wrote (metadata)."""
        body = self._t.request("GET", f"/v1/jobs/{job_id}/files") or {}
        return [JobFile.from_response(f) for f in body.get("files", [])]

    def download_job_file(self, job_id: str, name: str) -> bytes:
        """GET /v1/jobs/:id/files/:name — download one output file's bytes."""
        path = f"/v1/jobs/{job_id}/files/{urllib.parse.quote(name)}"
        return self._t.request("GET", path, raw=True)

    # ── Scheduled tasks ──────────────────────────────────────────────────

    def create_schedule(
        self,
        *,
        interval_seconds: int,
        task: str,
        llm: Optional[str] = None,
        name: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        llm_key_id: Optional[str] = None,
        framework: str = "browser-use",
        llm_base_url: Optional[str] = None,
        max_steps: Optional[int] = None,
        reasoning: Optional[str] = None,
        initial_url: Optional[str] = None,
        country: Optional[str] = None,
        os_type: Optional[str] = None,
        proxy: Optional[Proxy] = None,
        proxy_id: Optional[str] = None,
        secret_ids: Optional[List[str]] = None,
        save_secrets: Optional[bool] = None,
        **extra: Any,
    ) -> Schedule:
        """POST /v1/schedules — create a recurring task (interval 3600–2592000s).

        LLM key: pass llm_key_id to run every run with a saved key (the
        schedule stores only the id, and a rotated key is picked up by the
        next run), or omit llm_api_key and llm_key_id to use the workspace's
        default saved key, or pass a hosted tier (llm="browsa",
        "browsa-fast" or "browsa-smart"). Same precedence as create_task().
        reasoning ("low", "medium" or "high") applies to every run.

        proxy / proxy_id: as on create_task(), used for every run.

        secret_ids: workspace secrets (names or ids) every run may type,
        resolved when the schedule is saved; each run reads the current
        value. save_secrets=False: runs do not save logins they create. See
        create_task().
        """
        body: dict = {"task": task, "framework": framework,
                      "interval_seconds": interval_seconds}
        for k, v in {
            "llm": llm, "name": name, "llm_api_key": llm_api_key,
            "llm_key_id": llm_key_id, "llm_base_url": llm_base_url,
            "max_steps": max_steps, "reasoning": reasoning,
            "initial_url": initial_url, "country": country,
            "os_type": os_type, "proxy": proxy, "proxy_id": proxy_id,
            "secret_ids": list(secret_ids) if secret_ids is not None else None,
            "save_secrets": save_secrets, **extra,
        }.items():
            if v is not None:
                body[k] = v
        return Schedule.from_response(self._t.request("POST", "/v1/schedules", body=body))

    def list_schedules(self) -> list[Schedule]:
        """GET /v1/schedules — this workspace's schedules (secrets redacted)."""
        body = self._t.request("GET", "/v1/schedules") or {}
        return [Schedule.from_response(s) for s in body.get("schedules", [])]

    def get_schedule(self, schedule_id: str) -> Schedule:
        """GET /v1/schedules/:id."""
        return Schedule.from_response(self._t.request("GET", f"/v1/schedules/{schedule_id}"))

    def set_schedule_enabled(self, schedule_id: str, enabled: bool) -> Schedule:
        """PATCH /v1/schedules/:id — pause (False) or resume (True)."""
        return Schedule.from_response(
            self._t.request("PATCH", f"/v1/schedules/{schedule_id}", body={"enabled": enabled}))

    def delete_schedule(self, schedule_id: str) -> None:
        """DELETE /v1/schedules/:id."""
        self._t.request("DELETE", f"/v1/schedules/{schedule_id}")

    # ── Recipes (replays) ────────────────────────────────────────────────

    def create_recipe(
        self,
        *,
        from_job_id: Optional[str] = None,
        recipe: Optional[dict] = None,
        name: Optional[str] = None,
        params: Optional[dict] = None,
        output: Optional[dict] = None,
        repair_mode: Optional[str] = None,
    ) -> Recipe:
        """POST /v1/recipes: a recipe from a task run made with
        ``record_recipe=True`` (``from_job_id``) or from a recipe JSON
        (``recipe``). ``params``/``output`` replace the recorded JSON Schemas.
        ``repair_mode``: "auto" (default), "review" or "off". Version 1 is active."""
        body = {k: v for k, v in {
            "from_job_id": from_job_id, "recipe": recipe, "name": name,
            "params": params, "output": output, "repair_mode": repair_mode,
        }.items() if v is not None}
        return Recipe.from_response(self._t.request("POST", "/v1/recipes", body=body))

    def list_recipes(self, *, limit: Optional[int] = None) -> list[Recipe]:
        """GET /v1/recipes: this workspace's recipes, newest first."""
        body = self._t.request("GET", "/v1/recipes", query={"limit": limit}) or {}
        return [Recipe.from_response(r) for r in body.get("recipes") or []]

    def get_recipe(self, recipe_id: str) -> Recipe:
        """GET /v1/recipes/:id, with the body of the current version."""
        return Recipe.from_response(self._t.request("GET", f"/v1/recipes/{_q(recipe_id)}"))

    def update_recipe(self, recipe_id: str, *, name: Optional[str] = None,
                      repair_mode: Optional[str] = None) -> Recipe:
        """PATCH /v1/recipes/:id: rename, or change repair_mode."""
        body = {k: v for k, v in {"name": name, "repair_mode": repair_mode}.items() if v is not None}
        return Recipe.from_response(self._t.request("PATCH", f"/v1/recipes/{_q(recipe_id)}", body=body))

    def list_recipe_versions(self, recipe_id: str, *, include_recipe: bool = False) -> list[RecipeVersion]:
        """GET /v1/recipes/:id/versions, newest first."""
        body = self._t.request("GET", f"/v1/recipes/{_q(recipe_id)}/versions",
                               query={"include": "recipe"} if include_recipe else None) or {}
        return [RecipeVersion.from_response(v) for v in body.get("versions") or []]

    def promote_recipe_version(self, recipe_id: str, version: int) -> Recipe:
        """POST /v1/recipes/:id/versions/:version/promote: make a verified
        version the one runs use (409 VERSION_NOT_VERIFIED otherwise)."""
        return Recipe.from_response(self._t.request(
            "POST", f"/v1/recipes/{_q(recipe_id)}/versions/{int(version)}/promote"))

    def rollback_recipe(self, recipe_id: str, *, version: Optional[int] = None) -> Recipe:
        """POST /v1/recipes/:id/rollback: back to the previous active
        version, or to ``version``."""
        body = {"version": version} if version is not None else {}
        return Recipe.from_response(self._t.request("POST", f"/v1/recipes/{_q(recipe_id)}/rollback", body=body))

    def delete_recipe(self, recipe_id: str) -> None:
        """DELETE /v1/recipes/:id. Its runs stay readable."""
        self._t.request("DELETE", f"/v1/recipes/{_q(recipe_id)}")

    def run_recipe(
        self,
        recipe_id: str,
        *,
        params: Optional[dict] = None,
        wait: Optional[float] = None,
        webhook_url: Optional[str] = None,
        proxy: Optional[dict] = None,
        profile_id: Optional[str] = None,
        allow_mutations: bool = False,
        secret_ids: Optional[List[str]] = None,
    ) -> RecipeRun:
        """POST /v1/recipes/:id/run. ``params`` are checked against the
        recipe's params schema (400 PARAMS_INVALID). With ``wait`` (seconds,
        up to 60) the call returns the finished run when it ends in time;
        otherwise the queued run (see get_recipe_run). ``proxy`` is
        ``{"network": "auto" | "datacenter" | "residential" | "default",
        "country": "us"}``; the recipe's exit when omitted. A successful run
        costs the recipe's price_credits; failed runs cost nothing.

        ``secret_ids``: the workspace secrets (names or ids) the recipe's
        ``{{secret:NAME}}`` steps may type. A recipe never attaches a secret
        itself: a step whose secret is not listed is 400 SECRET_NOT_ATTACHED."""
        body: dict = {"params": params or {}}
        if secret_ids is not None:
            body["secret_ids"] = list(secret_ids)
        if wait is not None:
            body["wait"] = wait
        if webhook_url is not None:
            body["webhook_url"] = webhook_url
        if proxy is not None:
            body["proxy"] = proxy
        if profile_id is not None:
            body["profile_id"] = profile_id
        if allow_mutations:
            body["allow_mutations"] = True
        w = min(max(float(wait or 0), 0.0), 60.0)
        return RecipeRun.from_response(self._t.request(
            "POST", f"/v1/recipes/{_q(recipe_id)}/run", body=body,
            timeout=(w + 10) if w > 0 else None))

    def get_recipe_run(self, run_id: str, *, wait: Optional[float] = None) -> RecipeRun:
        """GET /v1/recipe-runs/:id. ``wait`` (seconds, up to 60) holds the
        answer until the run ends."""
        w = min(max(float(wait or 0), 0.0), 60.0)
        return RecipeRun.from_response(self._t.request(
            "GET", f"/v1/recipe-runs/{_q(run_id)}",
            query={"wait": int(w) if w == int(w) else w} if w > 0 else None,
            timeout=(w + 10) if w > 0 else None))

    def cancel_recipe_run(self, run_id: str) -> RecipeRun:
        """POST /v1/recipe-runs/:id/cancel (the job cancel path)."""
        return RecipeRun.from_response(self._t.request("POST", f"/v1/recipe-runs/{_q(run_id)}/cancel"))

    # ── Webhooks ─────────────────────────────────────────────────────────

    def list_webhooks(self) -> list[Webhook]:
        body = self._t.request("GET", "/v1/webhooks")
        return [Webhook.from_response(w) for w in (body.get("webhooks") or [])]

    def create_webhook(self, *, url: str, events: Optional[Iterable[str]] = None) -> Webhook:
        body = {"url": url}
        if events is not None:
            body["events"] = list(events)
        return Webhook.from_response(self._t.request("POST", "/v1/webhooks", body=body))

    def delete_webhook(self, webhook_id: str) -> None:
        self._t.request("DELETE", f"/v1/webhooks/{webhook_id}")

    def test_webhook(self, webhook_id: str) -> dict:
        """POST /v1/webhooks/:id/test — fires a synthetic delivery so you
        can verify the receiver before depending on real lifecycle traffic."""
        return self._t.request("POST", f"/v1/webhooks/{webhook_id}/test")

    def list_webhook_deliveries(self, webhook_id: str, *, limit: Optional[int] = None) -> list[dict]:
        """GET /v1/webhooks/:id/deliveries: the latest delivery attempts,
        newest first (limit 1 to 200, default 50). Each row: id, event_id,
        event_type, status_code, delivered_at, duration_ms, error, attempt,
        response_body. Use it to see why a receiver missed an event."""
        body = self._t.request("GET", f"/v1/webhooks/{webhook_id}/deliveries",
                               query={"limit": limit} if limit is not None else None) or {}
        return body.get("deliveries") or []

    def get_signing_secret(self) -> str:
        body = self._t.request("GET", "/v1/webhooks/signing-secret")
        return body.get("secret") if isinstance(body, dict) else ""

    # ── Saved LLM keys ───────────────────────────────────────────────────
    # The API never returns a saved secret: responses carry only `masked`
    # (prefix + last 4). The api_key argument is sent once, in the request
    # body, and is never logged or kept on the client.

    def create_llm_key(
        self,
        provider: str,
        api_key: str,
        *,
        name: Optional[str] = None,
        base_url: Optional[str] = None,
        default: Optional[bool] = None,
    ) -> LLMKey:
        """POST /v1/llm-keys: save an LLM provider key for this workspace.

        provider: ``anthropic`` | ``openai`` | ``google`` |
        ``openai_compatible`` (needs ``base_url``, a public http(s) URL).
        The key is checked first with a free model-list call; if the
        provider says it is invalid this raises APIError with code
        ``LLM_KEY_INVALID`` (status 422) and nothing is saved.

        default: True makes it the default for its provider (the previous
        default is unset). Omitted, it becomes the default only if it is the
        first key of that provider. Up to 20 keys per workspace
        (409 ``LLM_KEY_LIMIT``).
        """
        body: dict = {"provider": provider, "api_key": api_key}
        for k, v in {"name": name, "base_url": base_url, "default": default}.items():
            if v is not None:
                body[k] = v
        return LLMKey.from_response(self._t.request("POST", "/v1/llm-keys", body=body))

    def list_llm_keys(self) -> list[LLMKey]:
        """GET /v1/llm-keys: this workspace's saved LLM keys, newest first."""
        body = self._t.request("GET", "/v1/llm-keys") or {}
        return [LLMKey.from_response(k) for k in body.get("llm_keys") or []]

    def get_llm_key(self, llm_key_id: str) -> LLMKey:
        """GET /v1/llm-keys/:id."""
        return LLMKey.from_response(self._t.request("GET", _llm_key_path(llm_key_id)))

    def validate_llm_key(self, llm_key_id: str) -> LLMKey:
        """POST /v1/llm-keys/:id/validate: check the saved key with the
        provider again; returns the key with its fresh status."""
        return LLMKey.from_response(
            self._t.request("POST", _llm_key_path(llm_key_id) + "/validate"))

    def rotate_llm_key(self, llm_key_id: str, api_key: str, *,
                       base_url: Optional[str] = None) -> LLMKey:
        """POST /v1/llm-keys/:id/rotate: replace the secret, keeping the id.

        The new key is validated first; on 422 ``LLM_KEY_INVALID`` the old
        secret stays. Queued and scheduled runs pick up the new secret.
        """
        body: dict = {"api_key": api_key}
        if base_url is not None:
            body["base_url"] = base_url
        return LLMKey.from_response(
            self._t.request("POST", _llm_key_path(llm_key_id) + "/rotate", body=body))

    def update_llm_key(self, llm_key_id: str, *, name: Optional[str] = None,
                       default: Optional[bool] = None) -> LLMKey:
        """POST /v1/llm-keys/:id: rename it, or set (True) or remove (False)
        its default flag. The secret can only change via rotate_llm_key()."""
        body: dict = {}
        if name is not None:
            body["name"] = name
        if default is not None:
            body["default"] = default
        if not body:
            raise ValueError("update_llm_key needs name or default")
        return LLMKey.from_response(
            self._t.request("POST", _llm_key_path(llm_key_id), body=body))

    def delete_llm_key(self, llm_key_id: str) -> None:
        """DELETE /v1/llm-keys/:id: delete the key and its encrypted value.
        Queued or scheduled runs that use it fail with LLM_KEY_MISSING."""
        self._t.request("DELETE", _llm_key_path(llm_key_id))

    # ── Models ───────────────────────────────────────────────────────────

    def models(self) -> Models:
        """GET /v1/models: the hosted tiers and the own-key providers.
        Read-only and free.

        ``.hosted`` is one HostedModel per tier (``id`` is what you pass as
        ``llm``: "browsa", "browsa-fast", "browsa-smart"), with the model it
        runs on, its fallback models, its default reasoning level and
        ``credits_per_task``. ``.own_key`` has the providers you can bring a
        key for and each one's default model. The models and credit numbers
        are server settings and can change, so read them here instead of
        hardcoding them.
        """
        return Models.from_response(self._t.request("GET", "/v1/models"))

    # ── Keys / Credits / Team ────────────────────────────────────────────

    def list_keys(self) -> list[dict]:
        body = self._t.request("GET", "/v1/keys")
        return body.get("keys") if isinstance(body, dict) else []

    def credits(self) -> dict:
        return self._t.request("GET", "/v1/credits")

    def proxy_network(self) -> ProxyNetwork:
        """GET /v1/proxy-network: the built-in proxy network of this server.

        ``enabled`` says whether ``proxy={"network": ...}`` can be used at
        all; ``tiers`` lists each network with its ``countries`` and its
        price (``credits_per_gb``, ``mb_per_credit``). An API that does not
        have the endpoint yet (404) reads as not enabled.
        """
        try:
            return ProxyNetwork.from_response(self._t.request("GET", "/v1/proxy-network"))
        except errors.NotFoundError:
            return ProxyNetwork()

    def list_ledger(self, *, limit: int = 50) -> dict:
        """GET /v1/credits/ledger?limit=N — per-job credit-ledger entries.

        Returns `{balance, count, entries: [{id, delta, balance, reason,
        agent_id, created_at}, ...]}`. Every job-completion writes one
        debit row tagged with the linked job id; signup bonuses, refunds,
        and Stripe top-ups write positive rows. Use this to bill your own
        clients from Browsa usage data.
        """
        return self._t.request("GET", "/v1/credits/ledger", query={"limit": limit})

    # ── Quick endpoints (sync or async=true) ──────────────────────────────
    # These don't need an LLM — they're server-side scrape primitives the
    # platform runs in a fresh burner and returns the result directly.
    # Pass async_=True for fire-and-poll (returns a Job envelope you can
    # wait_for_job() on). Without async_, the call blocks server-side
    # until the scrape finishes (~5-30s typical).

    def scrape(self, url: str, *, async_: bool = False,
               idempotency_key: Optional[str] = None, **opts: Any) -> dict:
        """POST /v1/quick/scrape — fetch a URL and return rendered HTML +
        readable text + metadata. No LLM involved. ~5s typical.

        Args:
            url: Target URL.
            async_: True = return a Job envelope immediately; False = block
                    until complete (default).
            idempotency_key: Optional. If provided, the platform dedupes
                    requests with the same (workspace, key) within 24h —
                    a retry returns the cached response without
                    re-provisioning a burner. Use a UUID per logical
                    request to make retries billing-safe.
            **opts: country, wait_for, screenshot, etc. — see API docs.
        """
        body = {"url": url}
        body.update(opts)
        path = "/v1/quick/scrape" + ("?async=true" if async_ else "")
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._t.request("POST", path, body=body, timeout=120.0, extra_headers=headers)

    def extract(self, url: str, *, schema: Any = None, prompt: Optional[str] = None,
                async_: bool = False, idempotency_key: Optional[str] = None,
                **opts: Any) -> dict:
        """POST /v1/quick/extract — LLM-driven structured extraction. Returns
        JSON matching `schema` (or per `prompt`). Pass exactly one of
        `schema` or `prompt`; `schema` wins if both are supplied.

        idempotency_key (Stripe-compatible) dedupes retries for 24h.
        """
        body: dict = {"url": url}
        if schema is not None: body["schema"] = schema
        if prompt is not None: body["prompt"] = prompt
        body.update(opts)
        path = "/v1/quick/extract" + ("?async=true" if async_ else "")
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._t.request("POST", path, body=body, timeout=180.0, extra_headers=headers)

    def screenshot(self, url: str, *, full_page: bool = True, async_: bool = False,
                   idempotency_key: Optional[str] = None, **opts: Any) -> dict:
        """POST /v1/quick/screenshot — capture a screenshot (base64 PNG by
        default). No LLM. ~3-10s typical. idempotency_key dedupes retries.
        """
        body: dict = {"url": url, "full_page": full_page}
        body.update(opts)
        path = "/v1/quick/screenshot" + ("?async=true" if async_ else "")
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._t.request("POST", path, body=body, timeout=60.0, extra_headers=headers)

    def batch(self, urls: Iterable[str], *, mode: str = "scrape",
              async_: bool = True, **opts: Any) -> dict:
        """POST /v1/quick/batch: scrape up to 100 URLs (4 at a time) as one
        job. Always asynchronous, whatever async_ says: returns the 202 job
        envelope (``job_id``); wait with wait_for_job(job_id).

        Batch only scrapes: mode must be "scrape" (for extract or screenshot,
        call extract()/screenshot() per URL). Takes the scrape options
        (formats, max_chars, wait_ms, country, block).
        """
        if mode != "scrape":
            raise ValueError(f"batch only scrapes (got mode={mode!r}); call {mode}() per URL instead")
        body: dict = {"urls": list(urls)}
        body.update(opts)
        return self._t.request("POST", "/v1/quick/batch", body=body, timeout=300.0)

    def crawl(self, start_url: str, *, max_pages: int = 25,
              async_: bool = True, **opts: Any) -> dict:
        """POST /v1/quick/crawl — BFS crawl starting from `start_url`, capped at
        `max_pages`. Async by default."""
        body: dict = {"start_url": start_url, "max_pages": max_pages}
        body.update(opts)
        path = "/v1/quick/crawl" + ("?async=true" if async_ else "")
        return self._t.request("POST", path, body=body, timeout=300.0)

    # ── Agents (burner + persistent) ──────────────────────────────────────

    def create_agent(self, *, ttl: Optional[str] = None, country: Optional[str] = None,
                     persona: Optional[str] = None, os_type: Optional[str] = None,
                     ja3_profile: Optional[str] = None,
                     screen_resolution: Optional[str] = None,
                     webrtc_mode: Optional[str] = None,
                     geolocation_mode: Optional[str] = None,
                     geolocation_data: Optional[str] = None,
                     media_devices_mode: Optional[str] = None,
                     port_scan_protection: Optional[str] = None,
                     proxy: Optional[Proxy] = None,
                     proxy_id: Optional[str] = None,
                     **opts: Any) -> dict:
        """POST /v1/agents — provision an agent.

        Mode auto-detection:
          - if `persona` set + no `ttl` → persistent (vault-synced, monthly)
          - else → burner (ephemeral, pay-per-call)

        Fingerprint overrides (power-user — leave empty for platform defaults):
          - screen_resolution: "1366x768" | "1920x1080" | "2560x1440" |
                               "3840x2160" | "mobile-iphone" |
                               "mobile-android-pixel" | "WxH" custom
          - webrtc_mode:        "masked" | "real" | "disabled"
          - geolocation_mode:   "prompt" | "allow" | "block"
          - geolocation_data:   "lat,lng" (when geolocation_mode="allow")
          - media_devices_mode: "masked" | "real"
          - port_scan_protection: "masked" | "real"

        Mismatched combinations (e.g. mobile resolution + os_type=MACOS)
        will return a non-fatal `warnings` array in the fingerprint
        preview AND may lower the agent's trust score.

        proxy: your own proxy (``{"type", "host", "port", ...}``) or a tier
        of Browsa's built-in network (``{"network": "datacenter",
        "country": "us"}``, nothing else next to network; only when
        proxy_network() reports enabled). proxy_id: a saved proxy instead.

        Returns the agent envelope incl. `id`, `cdp_http`, `cdp_url`, `expires_at`.
        With the built-in network it also has `proxy_network`, `proxy_bytes`
        and `proxy_credits`.
        """
        body: dict = {}
        for k, v in {
            "ttl": ttl, "country": country, "persona": persona,
            "os_type": os_type, "ja3_profile": ja3_profile,
            "screen_resolution": screen_resolution,
            "webrtc_mode": webrtc_mode,
            "geolocation_mode": geolocation_mode,
            "geolocation_data": geolocation_data,
            "media_devices_mode": media_devices_mode,
            "port_scan_protection": port_scan_protection,
            "proxy": proxy, "proxy_id": proxy_id,
        }.items():
            if v is not None: body[k] = v
        body.update(opts)
        return self._t.request("POST", "/v1/agents", body=body)

    def get_agent(self, agent_id: str) -> dict:
        return self._t.request("GET", f"/v1/agents/{agent_id}")

    def destroy_agent(self, agent_id: str) -> None:
        self._t.request("DELETE", f"/v1/agents/{agent_id}")

    def get_cdp_url(self, agent_id: str) -> str:
        """GET /v1/agents/:id/cdp — returns `cdp_url`, the page-level CDP
        WebSocket of a running agent (it needs auth). Note: this endpoint
        (and get_agent) give it with a placeholder page id
        (".../ws/page/..."); only create_agent() returns the real page URL.
        To attach Playwright or Puppeteer, use the agent's `cdp_http` with
        an X-API-Key header:
        `p.chromium.connect_over_cdp(agent["cdp_http"], headers={"X-API-Key": API_KEY})`."""
        r = self._t.request("GET", f"/v1/agents/{agent_id}/cdp")
        return r.get("cdp_url") if isinstance(r, dict) else ""

    def open_session(self, agent_id: str, *, ttl: Optional[str] = None) -> dict:
        """POST /v1/agents/:id/sessions — open a new session on a
        persistent agent (returns `cdp_http` bound to a fresh session).
        Burner agents already have an implicit session; use their `cdp_http`
        (from create_agent or get_agent) for those."""
        body: dict = {}
        if ttl is not None: body["ttl"] = ttl
        return self._t.request("POST", f"/v1/agents/{agent_id}/sessions", body=body)

    def fingerprint(self, agent_id: str) -> dict:
        """GET /v1/agents/:id/fingerprint — return the wire-level fingerprint
        preview (navigator, screen, webgl, timezone, canvas, audio, tls).
        Lets you pin an identity and validate it against your own
        anti-fingerprint test suite before running tasks. Competitor parity-plus:
        browser-use cloud profiles don't expose this at all."""
        return self._t.request("GET", f"/v1/agents/{agent_id}/fingerprint")

    def trust_breakdown(self, agent_id: str) -> dict:
        """GET /v1/agents/:id/trust — return the per-factor breakdown of the
        agent's trust_score (baseline + mode + os + warmup + age + sessions +
        harness signal). Tells you WHY the identity scored what it did and
        which knob to turn to raise it (e.g. add a warmup_recipe, or
        promote burner → persistent)."""
        return self._t.request("GET", f"/v1/agents/{agent_id}/trust")

    def detection_signal(self, agent_id: str) -> dict:
        """GET /v1/agents/:id/detection-signal — return the most-recent
        detection-harness verdict for this identity's fingerprint shape.
        Returns {signal: null} when no recent harness run is on file
        (trust score falls back to the static formula). When populated,
        includes sites_tested + sites_passed + per-site verdicts.
        The empirical proof behind the trust score number."""
        return self._t.request("GET", f"/v1/agents/{agent_id}/detection-signal")

    # ── Downloads and Phantom Live ───────────────────────────────────────

    def list_downloads(self, agent_id: str) -> list[dict]:
        """GET /v1/agents/:id/downloads: the files a running browser has
        downloaded, newest first. Each row: name, size (bytes), modified_at.
        With Playwright a file's name is the last part of
        `await download.path()`. The folder is removed when the browser
        stops, so fetch files first. Free."""
        body = self._t.request("GET", f"/v1/agents/{agent_id}/downloads") or {}
        return list(body.get("files") or [])

    def download_file(self, agent_id: str, name: str) -> bytes:
        """GET /v1/agents/:id/downloads/:name: one downloaded file's bytes.
        `name` comes from list_downloads(). Free."""
        path = f"/v1/agents/{agent_id}/downloads/{urllib.parse.quote(name, safe='')}"
        return self._t.request("GET", path, raw=True, timeout=max(self._t.timeout, 120.0))

    def create_live_link(self, agent_id: str, *, scope: Optional[str] = None,
                         ttl_seconds: Optional[int] = None, job_id: Optional[str] = None) -> dict:
        """POST /v1/agents/:id/live: a Phantom Live link to a running
        browser. scope is "view" (watch only, the default) or "control"
        (click and type). ttl_seconds is 60 to 86400. job_id ties the link
        to one task on that browser and shows its steps.

        Returns {live_url, expires_at, scope, agent_id, job_id?}. A link
        opens once: make one per person or tab, and call this again for
        another. Free."""
        body: dict = {}
        if scope is not None:
            body["scope"] = scope
        if ttl_seconds is not None:
            body["ttl_seconds"] = ttl_seconds
        if job_id is not None:
            body["job_id"] = job_id
        return self._t.request("POST", f"/v1/agents/{agent_id}/live", body=body)

    # ── Page view: observe and act without CDP ───────────────────────────

    def _page_session(self, agent_id: str, tab: Optional[str], session: Optional[str]) -> Optional[str]:
        if session is not None:
            return session or None
        seen = self._page_sessions.get(agent_id)
        if not seen:
            return None
        return seen["tabs"].get(tab or seen["last"])

    def _remember_page(self, agent_id: str, r: Any) -> Any:
        if isinstance(r, dict) and r.get("tab") and r.get("session"):
            seen = self._page_sessions.setdefault(agent_id, {"last": "", "tabs": {}})
            seen["last"] = r["tab"]
            seen["tabs"][r["tab"]] = r["session"]
        return r

    def observe(
        self,
        agent_id: str,
        *,
        scope: Optional[str] = None,
        budget: Optional[int] = None,
        expand: Optional[int] = None,
        tab: Optional[str] = None,
        json: bool = False,
        session: Optional[str] = None,
    ) -> dict:
        """POST /v1/agents/:id/observe — the page of a running browser as
        compact text for a model: one line per element, ``[id] role "name"
        state``, inside a token budget. Use the ids with act(). Free.

        scope: ``"viewport"`` (default) lists what is in the viewport and
        counts the rest; ``"page"`` lists the whole page.
        budget: approximate tokens (characters / 4), default 2000, -1 for none.
        expand: id of a container, table, list or select to list in full.
        tab: a tab id from the answer's ``tabs``; default the tab used last.
        json: also return the view as a structure under ``view``.

        Returns a dict: ``text``, ``state`` (``ok``, ``challenge`` on a
        full-page bot check, ``dialog`` with a JavaScript dialog open),
        ``url``, ``title``, ``tabs``, ``session``, ``ids_reset`` and sizes.

        Ids are valid while the server keeps its view session (``session``).
        ``ids_reset`` true means this call started a new one: ids from
        earlier answers are not valid. The client sends the last ``session``
        it saw for you; pass ``session=""`` to send none.
        """
        body: dict = {}
        for k, v in {"scope": scope, "budget": budget, "expand": expand, "tab": tab}.items():
            if v is not None: body[k] = v
        if json: body["json"] = True
        sess = self._page_session(agent_id, tab, session)
        if sess: body["session"] = sess
        r = self._t.request("POST", f"/v1/agents/{agent_id}/observe", body=body, timeout=90.0)
        return self._remember_page(agent_id, r)

    def act(
        self,
        agent_id: str,
        action: Union[str, dict],
        *,
        tab: Optional[str] = None,
        json: bool = False,
        session: Optional[str] = None,
        **fields: Any,
    ) -> dict:
        """POST /v1/agents/:id/act — one action in a running browser, with
        real input events; returns what changed instead of the whole page.
        Free.

        action: ``click``, ``type``, ``press``, ``select``, ``check``,
        ``uncheck``, ``hover``, ``scroll``, ``navigate``, ``back``,
        ``forward``, ``reload``, ``wait``, ``upload`` or ``dialog``, with
        its fields as keyword arguments, or the whole action as a dict::

            c.act(agent_id, "type", id=14, text="10115", clear=True)
            c.act(agent_id, "click", role="button", name="Continue")
            c.act(agent_id, {"action": "navigate", "url": "https://example.com"})

        Fields: ``id`` | ``role`` + ``name`` | ``x`` + ``y`` (click);
        ``text``, ``clear``, ``submit`` (type); ``keys`` (press); ``option``
        (select); ``dy`` | ``to`` (scroll); ``url`` (navigate); ``ms`` |
        ``for_`` + ``text`` / ``id``, ``timeout`` (wait, at most 30000 ms);
        ``files`` (upload); ``accept``, ``text`` (dialog). ``for_`` is sent
        as ``for``.

        ``secret`` instead of ``text`` on ``type`` types a workspace secret
        by reference: ``c.act(agent_id, "type", id=14,
        secret="GITHUB_LOGIN:password")`` (``NAME``, ``NAME:username``,
        ``NAME:password`` or ``TOTP:NAME``). The value never reaches you; it
        is typed only when the page's origin is one of the secret's origins
        (status ``secret_origin`` and nothing typed otherwise).

        Returns a dict: ``text`` (the diff, how the page settled, a new view
        after a navigation), ``status``, ``reason``, ``url``, ``session``,
        ``ids_reset``. ``status`` is ``ok``, ``failed``, ``blocked``,
        ``challenge`` or ``stale``; none of them raises. ``stale``: the id
        is from a view the server no longer has; nothing was done and
        ``text`` carries a new view to pick from.
        """
        body: dict = dict(action) if isinstance(action, dict) else {"action": action}
        for k, v in fields.items():
            if v is not None: body["for" if k == "for_" else k] = v
        if tab is not None: body["tab"] = tab
        if json: body["json"] = True
        sess = self._page_session(agent_id, body.get("tab"), session if session is not None else body.get("session"))
        body.pop("session", None)
        if sess: body["session"] = sess
        r = self._t.request("POST", f"/v1/agents/{agent_id}/act", body=body, timeout=90.0)
        return self._remember_page(agent_id, r)

    def auto(self, task: str, *, llm: Optional[str] = None,
             llm_api_key: Optional[str] = None, llm_base_url: Optional[str] = None,
             max_steps: Optional[int] = None,
             # Accepted and ignored by the API; use max_credits to cap spend.
             max_cost_usd: Optional[float] = None,
             max_credits: Optional[int] = None,
             country: Optional[str] = None, llm_key_id: Optional[str] = None,
             secret_ids: Optional[List[str]] = None,
             save_secrets: Optional[bool] = None,
             **opts: Any) -> dict:
        """POST /v1/auto — smart-router. Same body as create_task but the
        platform inspects the task wording:
        - fetch-only ("go to URL, return text/h1/json", no clicks/types)
          short-circuits to /v1/quick/scrape → ~5s response.
        - interactive (clicks, form submits, login flows) falls through
          to the regular task path (job_id + poll).

        Other task fields (e.g. ``reasoning``) pass through as keyword
        arguments.

        Response carries `routed_via: "scrape" | "task"` so you can
        branch your client code accordingly.

        secret_ids / save_secrets: as on create_task(). A task that names a
        secret always runs as an agent task, never the plain fetch.
        """
        body: dict = {"task": task}
        if llm is not None: body["llm"] = llm
        if llm_api_key is not None: body["llm_api_key"] = llm_api_key
        if llm_key_id is not None: body["llm_key_id"] = llm_key_id
        if llm_base_url is not None: body["llm_base_url"] = llm_base_url
        if max_steps is not None: body["max_steps"] = max_steps
        if max_cost_usd is not None: body["max_cost_usd"] = max_cost_usd
        if max_credits is not None: body["max_credits"] = max_credits
        if country is not None: body["country"] = country
        if secret_ids is not None: body["secret_ids"] = list(secret_ids)
        if save_secrets is not None: body["save_secrets"] = save_secrets
        body.update(opts)
        return self._t.request("POST", "/v1/auto", body=body, timeout=120.0)

    def connect(self, agent_id: str, *, framework: str = "playwright_py") -> dict:
        """Convenience helper: returns a ready-to-paste connect snippet
        for the given client framework. No round-trip if the agent's
        cdp_url is already in scope — we just format the boilerplate.

        framework choices: 'playwright_py', 'playwright_ts', 'puppeteer_js',
        'curl'. Returns {framework, cdp_http, cdp_url, snippet}.

        Competitor-audit 2026-06-09 P0: browser-use cloud forces devs to
        hand-write the connect boilerplate every time. We surface it as
        one SDK call.
        """
        agent = self.get_agent(agent_id)
        profile_id = agent.get("profile_id") or ""
        cdp_ws_base = "wss://" + DEFAULT_CDP_BASE_URL.split("://", 1)[1]
        cdp_http = agent.get("cdp_http") or (
            f"{DEFAULT_CDP_BASE_URL}/api/v1/cdp/{profile_id}" if profile_id else ""
        )
        cdp_url = agent.get("cdp_url") or (
            f"{cdp_ws_base}/api/v1/cdp/{profile_id}/ws/page/..." if profile_id else ""
        )
        if not cdp_http:
            raise RuntimeError(
                f"agent {agent_id} has no CDP URL — is it status=running? "
                f"current status: {agent.get('status', 'unknown')}"
            )
        snippets = {
            "playwright_py": (
                "import asyncio\n"
                "import os\n"
                "from playwright.async_api import async_playwright\n\n"
                f'CDP_URL = "{cdp_http}"\n'
                'API_KEY = os.environ["BROWSA_API_KEY"]\n\n'
                "async def main():\n"
                "    async with async_playwright() as p:\n"
                '        browser = await p.chromium.connect_over_cdp(CDP_URL, headers={"X-API-Key": API_KEY})\n'
                "        context = browser.contexts[0]\n"
                "        page = context.pages[0] if context.pages else await context.new_page()\n"
                '        await page.goto("https://example.com")\n'
                "        print(await page.title())\n"
                "        await browser.close()\n\n"
                "asyncio.run(main())\n"
            ),
            "playwright_ts": (
                'import { chromium } from "playwright";\n\n'
                f'const CDP_URL = "{cdp_http}";\n'
                "const API_KEY = process.env.BROWSA_API_KEY!;\n\n"
                'const browser = await chromium.connectOverCDP(CDP_URL, { headers: { "X-API-Key": API_KEY } });\n'
                "const context = browser.contexts()[0];\n"
                "const page = context.pages()[0] ?? await context.newPage();\n"
                'await page.goto("https://example.com");\n'
                "console.log(await page.title());\n"
                "await browser.close();\n"
            ),
            "puppeteer_js": (
                'import puppeteer from "puppeteer";\n\n'
                f'const CDP_URL = "{cdp_http}";\n'
                "const API_KEY = process.env.BROWSA_API_KEY;\n\n"
                'const browser = await puppeteer.connect({ browserURL: CDP_URL, headers: { "X-API-Key": API_KEY } });\n'
                "const page = await browser.newPage();\n"
                'await page.goto("https://example.com");\n'
                "console.log(await page.title());\n"
                "await browser.disconnect();\n"
            ),
            "curl": (
                "# CDP HTTP endpoint (Playwright/Puppeteer call this for /json/version):\n"
                f'curl -H "X-API-Key: {self._t.api_key[:14]}..." {cdp_http}/json/version\n\n'
                "# Page-level CDP WebSocket (needs auth; for raw CDP clients, not Playwright/Puppeteer):\n"
                f"# {cdp_url}\n"
            ),
        }
        if framework not in snippets:
            raise ValueError(
                f"unknown framework {framework!r} — "
                f"choose from {list(snippets.keys())}"
            )
        return {
            "framework": framework,
            "cdp_http": cdp_http,
            "cdp_url": cdp_url,
            "snippet": snippets[framework],
        }

    # ── API keys ──────────────────────────────────────────────────────────

    def mint_key(self, *, name: str) -> dict:
        """POST /v1/keys — mint a new API key.

        IMPORTANT: The full secret is returned EXACTLY ONCE in the `secret`
        field. The dashboard surface only ever has the prefix after this
        call. Copy + store it immediately.
        """
        return self._t.request("POST", "/v1/keys", body={"name": name})

    def revoke_key(self, key_id: str) -> None:
        """DELETE /v1/keys/:id — revoke. Idempotent; revoked keys cannot
        be unrevoked."""
        self._t.request("DELETE", f"/v1/keys/{key_id}")

    def set_key_budget(self, key_id: str, monthly_budget_credits: Optional[int]) -> dict:
        """PUT /v1/keys/:id/budget — set this key's monthly spending limit in
        credits (1 to 1000000), or None to remove it. Once the key's spend
        this UTC month plus a new action's cost would go over it, new
        browsers, sessions and tasks started with the key get 402
        KEY_BUDGET_REACHED; work already running may finish. Returns
        {id, monthly_budget_credits, spent_this_month, resets_at}.
        list_keys() rows carry monthly_budget_credits and spent_this_month."""
        return self._t.request("PUT", f"/v1/keys/{key_id}/budget",
                               body={"monthly_budget_credits": monthly_budget_credits})

    def list_team(self) -> dict:
        return self._t.request("GET", "/v1/team/members")

    # ── Persistent identities ────────────────────────────────────────────

    def list_identities(self) -> list[dict]:
        body = self._t.request("GET", "/v1/agents")
        return body.get("agents") if isinstance(body, dict) else []

    def __repr__(self) -> str:
        return f"<browsa.Client base_url={self._t.base_url!r}>"


# ─── Async client ────────────────────────────────────────────────────────


class AsyncClient:
    """Asyncio-friendly wrapper.

    Backed by `asyncio.to_thread` over the sync client — keeps the codebase
    small. If we ever need true high-concurrency streaming, swap in aiohttp
    behind the same surface.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._sync = Client(api_key, base_url=base_url, timeout=timeout)
        #: Same methods as Client.robots, awaitable.
        self.robots: Any = _AsyncWrap(self._sync.robots)
        #: Same methods as Client.robot_runs, awaitable.
        self.robot_runs: Any = _AsyncWrap(self._sync.robot_runs)
        #: Same methods as Client.secrets, awaitable.
        self.secrets: Any = _AsyncWrap(self._sync.secrets)

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def create_task(self, **kw: Any) -> Job:
        return await asyncio.to_thread(self._sync.create_task, **kw)

    async def get_job(self, job_id: str, *, wait: int = 0) -> Job:
        return await asyncio.to_thread(self._sync.get_job, job_id, wait=wait)

    async def get_job_status(self, job_id: str) -> str:
        return await asyncio.to_thread(self._sync.get_job_status, job_id)

    async def cancel_job(self, job_id: str) -> None:
        await asyncio.to_thread(self._sync.cancel_job, job_id)

    async def respond_to_job(self, job_id: str, response: str) -> Job:
        return await asyncio.to_thread(self._sync.respond_to_job, job_id, response)

    async def wait_for_job(self, job_id: str, *, poll: float = DEFAULT_POLL_INTERVAL,
                           timeout: Optional[float] = None, on_progress: Optional[Any] = None) -> Job:
        return await asyncio.to_thread(self._sync.wait_for_job, job_id,
                                        poll=poll, timeout=timeout, on_progress=on_progress)

    async def stream_job_events(self, job_id: str, *, after: int = 0,
                                wait: int = 25) -> AsyncIterator[dict]:
        """Async version of Client.stream_job_events: ``async for ev in ...``.
        Each long-poll request runs in a worker thread."""
        it = self._sync.stream_job_events(job_id, after=after, wait=wait)
        done = object()
        while True:
            ev = await asyncio.to_thread(next, it, done)
            if ev is done:
                return
            yield ev

    async def run_task(self, **kw: Any) -> Job:
        return await asyncio.to_thread(self._sync.run_task, **kw)

    # Sessions
    async def create_session(self, task: str, **kw: Any) -> Job:
        return await asyncio.to_thread(lambda: self._sync.create_session(task, **kw))

    async def send_message(self, session_id: str, task: str, **kw: Any) -> Job:
        return await asyncio.to_thread(lambda: self._sync.send_message(session_id, task, **kw))

    async def run_message(self, session_id: str, task: str, **kw: Any) -> Job:
        return await asyncio.to_thread(lambda: self._sync.run_message(session_id, task, **kw))

    async def get_session(self, session_id: str) -> Session:
        return await asyncio.to_thread(self._sync.get_session, session_id)

    async def stop_session(self, session_id: str) -> Session:
        return await asyncio.to_thread(self._sync.stop_session, session_id)

    async def list_job_files(self, job_id: str) -> list[JobFile]:
        return await asyncio.to_thread(self._sync.list_job_files, job_id)

    async def download_job_file(self, job_id: str, name: str) -> bytes:
        return await asyncio.to_thread(self._sync.download_job_file, job_id, name)

    async def create_schedule(self, **kw: Any) -> Schedule:
        return await asyncio.to_thread(lambda: self._sync.create_schedule(**kw))

    async def list_schedules(self) -> list[Schedule]:
        return await asyncio.to_thread(self._sync.list_schedules)

    async def get_schedule(self, schedule_id: str) -> Schedule:
        return await asyncio.to_thread(self._sync.get_schedule, schedule_id)

    async def set_schedule_enabled(self, schedule_id: str, enabled: bool) -> Schedule:
        return await asyncio.to_thread(self._sync.set_schedule_enabled, schedule_id, enabled)

    async def delete_schedule(self, schedule_id: str) -> None:
        await asyncio.to_thread(self._sync.delete_schedule, schedule_id)

    # Recipes (replays)
    async def create_recipe(self, **kw: Any) -> Recipe:
        return await asyncio.to_thread(self._sync.create_recipe, **kw)

    async def list_recipes(self, **kw: Any) -> list[Recipe]:
        return await asyncio.to_thread(self._sync.list_recipes, **kw)

    async def get_recipe(self, recipe_id: str) -> Recipe:
        return await asyncio.to_thread(self._sync.get_recipe, recipe_id)

    async def update_recipe(self, recipe_id: str, **kw: Any) -> Recipe:
        return await asyncio.to_thread(self._sync.update_recipe, recipe_id, **kw)

    async def list_recipe_versions(self, recipe_id: str, **kw: Any) -> list[RecipeVersion]:
        return await asyncio.to_thread(self._sync.list_recipe_versions, recipe_id, **kw)

    async def promote_recipe_version(self, recipe_id: str, version: int) -> Recipe:
        return await asyncio.to_thread(self._sync.promote_recipe_version, recipe_id, version)

    async def rollback_recipe(self, recipe_id: str, **kw: Any) -> Recipe:
        return await asyncio.to_thread(self._sync.rollback_recipe, recipe_id, **kw)

    async def delete_recipe(self, recipe_id: str) -> None:
        await asyncio.to_thread(self._sync.delete_recipe, recipe_id)

    async def run_recipe(self, recipe_id: str, **kw: Any) -> RecipeRun:
        return await asyncio.to_thread(self._sync.run_recipe, recipe_id, **kw)

    async def get_recipe_run(self, run_id: str, **kw: Any) -> RecipeRun:
        return await asyncio.to_thread(self._sync.get_recipe_run, run_id, **kw)

    async def cancel_recipe_run(self, run_id: str) -> RecipeRun:
        return await asyncio.to_thread(self._sync.cancel_recipe_run, run_id)

    async def list_webhooks(self) -> list[Webhook]:
        return await asyncio.to_thread(self._sync.list_webhooks)

    async def create_webhook(self, **kw: Any) -> Webhook:
        return await asyncio.to_thread(self._sync.create_webhook, **kw)

    async def delete_webhook(self, webhook_id: str) -> None:
        await asyncio.to_thread(self._sync.delete_webhook, webhook_id)

    async def test_webhook(self, webhook_id: str) -> dict:
        return await asyncio.to_thread(self._sync.test_webhook, webhook_id)

    async def list_webhook_deliveries(self, webhook_id: str, **kw: Any) -> list[dict]:
        return await asyncio.to_thread(self._sync.list_webhook_deliveries, webhook_id, **kw)

    async def get_signing_secret(self) -> str:
        return await asyncio.to_thread(self._sync.get_signing_secret)

    # Saved LLM keys
    async def create_llm_key(self, provider: str, api_key: str, **kw: Any) -> LLMKey:
        return await asyncio.to_thread(self._sync.create_llm_key, provider, api_key, **kw)

    async def list_llm_keys(self) -> list[LLMKey]:
        return await asyncio.to_thread(self._sync.list_llm_keys)

    async def get_llm_key(self, llm_key_id: str) -> LLMKey:
        return await asyncio.to_thread(self._sync.get_llm_key, llm_key_id)

    async def validate_llm_key(self, llm_key_id: str) -> LLMKey:
        return await asyncio.to_thread(self._sync.validate_llm_key, llm_key_id)

    async def rotate_llm_key(self, llm_key_id: str, api_key: str, **kw: Any) -> LLMKey:
        return await asyncio.to_thread(self._sync.rotate_llm_key, llm_key_id, api_key, **kw)

    async def update_llm_key(self, llm_key_id: str, **kw: Any) -> LLMKey:
        return await asyncio.to_thread(self._sync.update_llm_key, llm_key_id, **kw)

    async def delete_llm_key(self, llm_key_id: str) -> None:
        await asyncio.to_thread(self._sync.delete_llm_key, llm_key_id)

    async def models(self) -> Models:
        return await asyncio.to_thread(self._sync.models)

    async def list_keys(self) -> list[dict]:
        return await asyncio.to_thread(self._sync.list_keys)

    async def set_key_budget(self, key_id: str, monthly_budget_credits: Optional[int]) -> dict:
        return await asyncio.to_thread(self._sync.set_key_budget, key_id, monthly_budget_credits)

    async def credits(self) -> dict:
        return await asyncio.to_thread(self._sync.credits)

    async def proxy_network(self) -> ProxyNetwork:
        return await asyncio.to_thread(self._sync.proxy_network)

    async def list_ledger(self, *, limit: int = 50) -> dict:
        return await asyncio.to_thread(self._sync.list_ledger, limit=limit)

    # Quick endpoints
    async def scrape(self, url: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.scrape, url, **kw)

    async def extract(self, url: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.extract, url, **kw)

    async def screenshot(self, url: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.screenshot, url, **kw)

    async def batch(self, urls: Iterable[str], **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.batch, urls, **kw)

    async def crawl(self, start_url: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.crawl, start_url, **kw)

    # Agents
    async def create_agent(self, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.create_agent, **kw)

    async def get_agent(self, agent_id: str) -> dict:
        return await asyncio.to_thread(self._sync.get_agent, agent_id)

    async def destroy_agent(self, agent_id: str) -> None:
        await asyncio.to_thread(self._sync.destroy_agent, agent_id)

    async def get_cdp_url(self, agent_id: str) -> str:
        return await asyncio.to_thread(self._sync.get_cdp_url, agent_id)

    async def open_session(self, agent_id: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.open_session, agent_id, **kw)

    async def fingerprint(self, agent_id: str) -> dict:
        return await asyncio.to_thread(self._sync.fingerprint, agent_id)

    async def trust_breakdown(self, agent_id: str) -> dict:
        return await asyncio.to_thread(self._sync.trust_breakdown, agent_id)

    async def detection_signal(self, agent_id: str) -> dict:
        return await asyncio.to_thread(self._sync.detection_signal, agent_id)

    async def list_downloads(self, agent_id: str) -> list[dict]:
        return await asyncio.to_thread(self._sync.list_downloads, agent_id)

    async def download_file(self, agent_id: str, name: str) -> bytes:
        return await asyncio.to_thread(self._sync.download_file, agent_id, name)

    async def create_live_link(self, agent_id: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.create_live_link, agent_id, **kw)

    async def observe(self, agent_id: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.observe, agent_id, **kw)

    async def act(self, agent_id: str, action: Union[str, dict], **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.act, agent_id, action, **kw)

    async def connect(self, agent_id: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.connect, agent_id, **kw)

    async def auto(self, task: str, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.auto, task, **kw)

    # Keys
    async def mint_key(self, **kw: Any) -> dict:
        return await asyncio.to_thread(self._sync.mint_key, **kw)

    async def revoke_key(self, key_id: str) -> None:
        await asyncio.to_thread(self._sync.revoke_key, key_id)

    async def list_team(self) -> dict:
        return await asyncio.to_thread(self._sync.list_team)

    async def list_identities(self) -> list[dict]:
        return await asyncio.to_thread(self._sync.list_identities)
