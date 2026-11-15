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
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, AsyncIterator, Iterable, Iterator, Optional

from . import errors
from .types import Job, JobFile, JobStatus, LLMKey, Models, Proxy, ProxyNetwork, Schedule, Session, Webhook
from ._version import __version__

DEFAULT_BASE_URL = "https://browsa.io"
DEFAULT_TIMEOUT = 30.0
DEFAULT_POLL_INTERVAL = 2.0  # seconds between job-status polls
USER_AGENT = f"browsa-python/{__version__}"


def _llm_key_path(llm_key_id: str) -> str:
    return "/v1/llm-keys/" + urllib.parse.quote(str(llm_key_id), safe="")


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
            raise errors.BrowsaError(f"network error: {e}") from e


class Client:
    """Synchronous REST client.

    The simplest usage is `client.run_task(...)` which submits a task and
    blocks until it finishes. For fire-and-poll, call `create_task` +
    `get_job` directly.

    Args:
        api_key: An `agt_live_*` key minted from browsa.io → API Keys.
        base_url: Override for self-hosted / staging.
        timeout: Per-request HTTP timeout (seconds). Long-poll calls override
            this internally; this is the upper bound for one round trip.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if not api_key or not api_key.startswith("agt_"):
            raise ValueError(
                "api_key must start with 'agt_'. Mint one at https://app.browsa.io/dashboard/keys"
            )
        self._t = _Transport(api_key, base_url, timeout)

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
        **kwargs: Any,
    ) -> Job:
        """One-shot: submit + wait + return the terminal Job. The "hello world"
        entry point — five lines from `pip install` to a real-browser-driven
        AI agent.

        secrets: ``{"<domain>": {"<name>": "<value>"}}`` credentials the agent
        types by name; the model sees only the names. See create_task().

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
        """
        body: dict = {"task": task, "framework": framework,
                      "interval_seconds": interval_seconds}
        for k, v in {
            "llm": llm, "name": name, "llm_api_key": llm_api_key,
            "llm_key_id": llm_key_id, "llm_base_url": llm_base_url,
            "max_steps": max_steps, "reasoning": reasoning,
            "initial_url": initial_url, "country": country,
            "os_type": os_type, "proxy": proxy, "proxy_id": proxy_id, **extra,
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

    def auto(self, task: str, *, llm: Optional[str] = None,
             llm_api_key: Optional[str] = None, llm_base_url: Optional[str] = None,
             max_steps: Optional[int] = None,
             # Accepted and ignored by the API; use max_credits to cap spend.
             max_cost_usd: Optional[float] = None,
             max_credits: Optional[int] = None,
             country: Optional[str] = None, llm_key_id: Optional[str] = None,
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
        branch your client code accordingly. Competitor-parity feature
        2026-06-09: matches browser-use cloud's Computer Use v3 dispatch.
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
        cdp_http = agent.get("cdp_http") or (
            f"https://browsa.io/api/v1/cdp/{profile_id}" if profile_id else ""
        )
        cdp_url = agent.get("cdp_url") or (
            f"wss://browsa.io/api/v1/cdp/{profile_id}/ws/page/..." if profile_id else ""
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
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._sync = Client(api_key, base_url=base_url, timeout=timeout)

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
