"""Shims for the client libraries that cannot be pointed at another server as they are.

- 2Captcha (``2captcha-python``) speaks 2Captcha's own ``in.php`` / ``res.php`` protocol.
  ``TwoCaptcha`` here has the same constructor and the same ``normal``, ``recaptcha``,
  ``turnstile`` and ``balance`` methods, returning ``{"captchaId", "code"}``; change the import.
- Anti-Captcha (``anticaptchaofficial``) has its host written in the code.
  ``use_with_anticaptcha()`` sends its requests to Browsa instead; the rest of your code stays.

CapSolver (``capsolver.api_base``) and CapMonster (``ClientOptions(service_url=...)``) take a
base URL and need nothing from here.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Mapping, Optional

from ._client import USER_AGENT, CaptchaClient, CaptchaError, CaptchaTimeoutError
from .tasks import normalize_task, recaptcha_v2, recaptcha_v3, turnstile as turnstile_task, image_to_text

# ── 2Captcha ─────────────────────────────────────────────────────────────

ApiException = CaptchaError              # 2captcha-python's names, so `except` clauses keep working
TimeoutException = CaptchaTimeoutError


class ValidationException(CaptchaError):
    """A required argument is missing (2captcha-python raises this name too)."""


def _twocaptcha_proxy(proxy: Any) -> Optional[str]:
    """2Captcha's ``{"type": "HTTPS", "uri": "login:password@1.2.3.4:3128"}`` -> ``https://login:...``."""
    if not proxy:
        return None
    if isinstance(proxy, str):
        return proxy if "://" in proxy else "http://" + proxy
    typ = str(proxy.get("type") or "http").lower()
    return f"{typ}://{proxy['uri']}"


class TwoCaptcha:
    """Drop-in for ``twocaptcha.TwoCaptcha`` on the task types Browsa solves.

        # before: from twocaptcha import TwoCaptcha
        from browsa.captcha.compat import TwoCaptcha
        solver = TwoCaptcha("agt_live_...")
        result = solver.recaptcha(sitekey="6Le-...", url="https://example.com/login")
        token = result["code"]

    ``softId``, ``callback`` and ``server`` (unless it is a Browsa URL) are accepted and ignored.
    """

    def __init__(self, apiKey: str, softId: Optional[int] = None, callback: Optional[str] = None,
                 defaultTimeout: int = 120, recaptchaTimeout: int = 600, pollingInterval: int = 10,
                 server: Optional[str] = None, extendedResponse: Optional[bool] = None,
                 *, base_url: Optional[str] = None, client: Optional[CaptchaClient] = None) -> None:
        if server and "browsa" in server:
            base_url = base_url or (server if "://" in server else "https://" + server)
        self.API_KEY = apiKey
        self.default_timeout = defaultTimeout
        self.recaptcha_timeout = recaptchaTimeout
        self.polling_interval = pollingInterval
        self.extended_response = bool(extendedResponse)
        self._client = client or CaptchaClient(apiKey, base_url=base_url, poll_interval=min(pollingInterval, 5))

    def _run(self, task: Mapping[str, Any], timeout: float, pick: Callable[[Mapping[str, Any]], Any]) -> Dict[str, Any]:
        sol = self._client.solve(task, timeout=timeout)
        out: Dict[str, Any] = {"captchaId": sol.task_id, "code": pick(sol)}
        if self.extended_response:
            out["solution"] = dict(sol)
        return out

    def normal(self, file: Any, **kwargs: Any) -> Dict[str, Any]:
        """Image text. ``file``: a path, a base64 string, or bytes."""
        if isinstance(file, (bytes, bytearray)):
            body: Any = bytes(file)
        elif isinstance(file, str) and os.path.isfile(file):
            with open(file, "rb") as f:
                body = f.read()
        elif isinstance(file, str) and file:
            body = file
        else:
            raise ValidationException("file must be a path, a base64 string or bytes", code="ERROR_INVALID_TASK_DATA")
        sol_text = lambda s: s.get("text") if "text" in s else ",".join(s.get("answers") or [])  # noqa: E731
        return self._run(image_to_text(body), kwargs.get("timeout", self.default_timeout), sol_text)

    def recaptcha(self, sitekey: str, url: str, version: str = "v2", enterprise: int = 0, **kwargs: Any) -> Dict[str, Any]:
        """reCAPTCHA v2 or v3 (``version="v3"``, ``action``, ``score``), ``invisible=1``, ``enterprise=1``."""
        if not sitekey or not url:
            raise ValidationException("sitekey and url are required", code="ERROR_INVALID_TASK_DATA")
        proxy = _twocaptcha_proxy(kwargs.get("proxy"))
        if str(version).lower() == "v3":
            task = recaptcha_v3(url, sitekey, page_action=kwargs.get("action"), enterprise=bool(enterprise),
                                min_score=kwargs.get("score") or kwargs.get("min_score"), proxy=proxy)
        else:
            task = recaptcha_v2(url, sitekey, invisible=bool(int(kwargs.get("invisible") or 0)),
                                enterprise=bool(enterprise), api_domain=kwargs.get("domain"), proxy=proxy)
        return self._run(task, kwargs.get("timeout", self.recaptcha_timeout), lambda s: s.get("gRecaptchaResponse"))

    def turnstile(self, sitekey: str, url: str, **kwargs: Any) -> Dict[str, Any]:
        """Cloudflare Turnstile (``action``, ``data`` = cData)."""
        if not sitekey or not url:
            raise ValidationException("sitekey and url are required", code="ERROR_INVALID_TASK_DATA")
        task = turnstile_task(url, sitekey, action=kwargs.get("action"), cdata=kwargs.get("data"),
                              proxy=_twocaptcha_proxy(kwargs.get("proxy")))
        return self._run(task, kwargs.get("timeout", self.default_timeout), lambda s: s.get("token"))

    def balance(self) -> float:
        return self._client.get_balance()

    def report(self, id_: str, correct: bool) -> Dict[str, Any]:
        """Tell Browsa whether the site took the answer (same call as the library's ``report``).
        One report per task, within 15 minutes of the solve; reports are recorded and used to improve solving."""
        return self._client.report(id_, bool(correct))


# ── Anti-Captcha ─────────────────────────────────────────────────────────


def use_with_anticaptcha(base_url: Optional[str] = None, *, opener: Optional[Callable[..., Any]] = None) -> Callable[[], None]:
    """Send ``anticaptchaofficial``'s requests to Browsa. Call once, before solving:

        from anticaptchaofficial.recaptchav2proxyless import recaptchaV2Proxyless
        from browsa.captcha.compat import use_with_anticaptcha
        use_with_anticaptcha()
        solver = recaptchaV2Proxyless()
        solver.set_key("agt_live_...")          # your Browsa key
        ...

    Task type names are mapped to Browsa's on the way. Returns a function that undoes it.
    """
    from anticaptchaofficial import antinetworking  # the caller's own dependency

    base = (base_url or os.environ.get("BROWSA_CAPTCHA_URL") or "https://captcha.browsa.io").rstrip("/")
    open_ = opener or urllib.request.urlopen
    cls = antinetworking.antiNetworking
    original = cls.make_request

    def make_request(self: Any, method: str, data: Dict[str, Any]) -> Any:
        self.log("making request to " + method)
        payload = dict(data)
        if method == "createTask" and isinstance(payload.get("task"), dict):
            payload["task"] = normalize_task({k: v for k, v in payload["task"].items() if v is not None})
        req = urllib.request.Request(f"{base}/{method}", method="POST", data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Accept": "application/json",
                                              "User-Agent": USER_AGENT})
        try:
            with open_(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read())
            except ValueError:
                self.err_string = f"http_error {e.code}"
                return 0
        except (urllib.error.URLError, OSError, ValueError) as e:
            self.err_string = f"Connection error: {e}"
            return 0

    cls.make_request = make_request

    def undo() -> None:
        cls.make_request = original

    return undo


__all__ = ["TwoCaptcha", "ApiException", "TimeoutException", "ValidationException", "use_with_anticaptcha"]
