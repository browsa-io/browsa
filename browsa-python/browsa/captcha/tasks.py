"""Typed builders for captcha tasks, and the task-type aliases of other services.

Each builder returns the task object that goes in ``createTask``'s ``task`` field, in the
format CapSolver, Anti-Captcha, CapMonster and 2Captcha's v2 API share:

    from browsa.captcha import tasks
    task = tasks.recaptcha_v3("https://example.com/login", "6Lc...", page_action="login")

``normalize_task`` maps the type names other services use (``RecaptchaV2TaskProxyless``,
``TurnstileTask``, ``NoCaptchaTaskProxyless``...) to Browsa's, so a task copied from code
written for another service works as it is.
"""
from __future__ import annotations

import base64
from typing import Any, Dict, List, Mapping, Optional, Sequence, TypedDict, Union

Task = Dict[str, Any]
Image = Union[bytes, bytearray, str]
ProxyArg = Union[str, Mapping[str, Any], None]

# ── Type names ───────────────────────────────────────────────────────────

IMAGE_TO_TEXT = "ImageToTextTask"
RECAPTCHA_V2_CLASSIFICATION = "ReCaptchaV2Classification"
AWS_WAF_CLASSIFICATION = "AwsWafClassification"
VISION_ENGINE = "VisionEngine"

RECOGNITION_TYPES = (IMAGE_TO_TEXT, RECAPTCHA_V2_CLASSIFICATION, AWS_WAF_CLASSIFICATION, VISION_ENGINE)
TOKEN_TYPES = (
    "ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task",
    "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask",
    "ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task",
    "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask",
    "AntiTurnstileTaskProxyLess", "AntiTurnstileTask",
)
TASK_TYPES = RECOGNITION_TYPES + TOKEN_TYPES

# lower-cased name used by any of the services -> (Browsa type without a proxy, with a proxy)
_ALIASES: Dict[str, tuple] = {}


def _alias(names: Sequence[str], proxyless: str, with_proxy: Optional[str] = None) -> None:
    for n in names:
        _ALIASES[n.lower()] = (proxyless, with_proxy or proxyless)


_alias(["ImageToTextTask"], IMAGE_TO_TEXT)
_alias(["ReCaptchaV2Classification"], RECAPTCHA_V2_CLASSIFICATION)
_alias(["AwsWafClassification"], AWS_WAF_CLASSIFICATION)
_alias(["VisionEngine"], VISION_ENGINE)
# Already proxyless names stay proxyless
_alias(["ReCaptchaV2TaskProxyLess", "NoCaptchaTaskProxyless"], "ReCaptchaV2TaskProxyLess")
_alias(["ReCaptchaV2EnterpriseTaskProxyLess"], "ReCaptchaV2EnterpriseTaskProxyLess")
_alias(["ReCaptchaV3TaskProxyLess"], "ReCaptchaV3TaskProxyLess")
_alias(["ReCaptchaV3EnterpriseTaskProxyLess"], "ReCaptchaV3EnterpriseTaskProxyLess")
_alias(["AntiTurnstileTaskProxyLess", "TurnstileTaskProxyless"], "AntiTurnstileTaskProxyLess")
# Names that take a proxy: CapMonster sends them without one to mean "proxyless"
_alias(["ReCaptchaV2Task", "NoCaptchaTask"], "ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task")
_alias(["ReCaptchaV2EnterpriseTask"], "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask")
_alias(["ReCaptchaV3Task"], "ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task")
_alias(["ReCaptchaV3EnterpriseTask"], "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask")
_alias(["AntiTurnstileTask", "TurnstileTask"], "AntiTurnstileTaskProxyLess", "AntiTurnstileTask")


def _has_proxy(task: Mapping[str, Any]) -> bool:
    return bool(task.get("proxy") or task.get("proxyAddress"))


def normalize_task(task: Mapping[str, Any]) -> Task:
    """Return a copy of ``task`` in Browsa's names.

    - The type name of any of the four services, in any letter case, becomes Browsa's
      (``RecaptchaV2TaskProxyless`` -> ``ReCaptchaV2TaskProxyLess``, ``TurnstileTask`` ->
      ``AntiTurnstileTask`` or ``AntiTurnstileTaskProxyLess``).
    - A type that takes a proxy but has none becomes its proxyless form (CapMonster's meaning).
    - Turnstile's ``action`` / ``pageAction`` and ``cData`` / ``data`` move into ``metadata``.
    - An unknown type is left as it is, so the server answers ERROR_TASK_NOT_SUPPORTED.
    """
    out: Task = dict(task)
    typ = out.get("type")
    if not isinstance(typ, str):
        return out
    if out.get("cloudflareTaskType") in ("cf_clearance", "wait_room"):
        return out  # a Cloudflare clearance task, not a Turnstile token: not offered
    pair = _ALIASES.get(typ.lower())
    if pair:
        out["type"] = pair[1] if _has_proxy(out) else pair[0]
    if "Turnstile" in out["type"]:
        meta = dict(out.get("metadata") or {})
        action = out.pop("action", None) or out.pop("pageAction", None)
        cdata = out.pop("cData", None) or out.pop("data", None)
        if action and "action" not in meta:
            meta["action"] = action
        if cdata and "cdata" not in meta:
            meta["cdata"] = cdata
        if meta:
            out["metadata"] = meta
    return out


# ── Builders ─────────────────────────────────────────────────────────────


def _b64(image: Image) -> str:
    if isinstance(image, (bytes, bytearray)):
        return base64.b64encode(bytes(image)).decode("ascii")
    if isinstance(image, str):
        return image  # base64 or a data: URL
    raise TypeError("an image must be bytes or a base64 string")


def proxy_string(proxy: ProxyArg) -> Optional[str]:
    """``"http://user:pass@host:port"`` from a string (kept as it is) or a dict with
    ``type``/``host``/``port``/``username``/``password`` (Browsa's proxy object)."""
    if proxy is None or proxy == "":
        return None
    if isinstance(proxy, str):
        return proxy
    from urllib.parse import quote
    typ = str(proxy.get("type") or "http").lower()
    host, port = proxy.get("host") or proxy.get("server"), proxy.get("port")
    if not host or not port:
        raise ValueError("proxy needs a host and a port")
    auth = ""
    if proxy.get("username"):
        auth = f"{quote(str(proxy['username']), safe='')}:{quote(str(proxy.get('password') or ''), safe='')}@"
    return f"{typ}://{auth}{host}:{int(port)}"


def _token(base: str, website_url: str, website_key: str, proxy: ProxyArg, **fields: Any) -> Task:
    if not website_url or not website_key:
        raise ValueError("website_url and website_key are required")
    p = proxy_string(proxy)
    task: Task = {"type": base if p else base + "ProxyLess", "websiteURL": website_url, "websiteKey": website_key}
    if p:
        task["proxy"] = p
    task.update({k: v for k, v in fields.items() if v not in (None, False, "", {})})
    return task


def image_to_text(image: Union[Image, Sequence[Image]], *, module: Optional[str] = None,
                  website_url: Optional[str] = None) -> Task:
    """Read the characters in a text captcha. ``image``: bytes, base64, or a list of up to 9.
    Solution: ``{"text": ...}`` (one image) or ``{"answers": [...]}`` (several)."""
    task: Task = {"type": IMAGE_TO_TEXT}
    if isinstance(image, (list, tuple)):
        task["images"] = [_b64(i) for i in image]
    else:
        task["body"] = _b64(image)  # type: ignore[arg-type]
    if module:
        task["module"] = module
    if website_url:
        task["websiteURL"] = website_url
    return task


def recaptcha_v2(website_url: str, website_key: str, *, invisible: bool = False, enterprise: bool = False,
                 api_domain: Optional[str] = None, enterprise_payload: Optional[Mapping[str, Any]] = None,
                 proxy: ProxyArg = None) -> Task:
    """A reCAPTCHA v2 token. Solution: ``{"gRecaptchaResponse", "userAgent", "createTime"}``."""
    base = "ReCaptchaV2EnterpriseTask" if enterprise else "ReCaptchaV2Task"
    return _token(base, website_url, website_key, proxy, isInvisible=invisible, apiDomain=api_domain,
                  enterprisePayload=dict(enterprise_payload) if enterprise_payload else None)


def recaptcha_v3(website_url: str, website_key: str, *, page_action: Optional[str] = None, enterprise: bool = False,
                 min_score: Optional[float] = None, api_domain: Optional[str] = None,
                 proxy: ProxyArg = None) -> Task:
    """A reCAPTCHA v3 token. ``min_score`` is accepted and not guaranteed.
    Solution: ``{"gRecaptchaResponse", "userAgent", "createTime"}``."""
    base = "ReCaptchaV3EnterpriseTask" if enterprise else "ReCaptchaV3Task"
    return _token(base, website_url, website_key, proxy, pageAction=page_action, minScore=min_score,
                  apiDomain=api_domain)


def turnstile(website_url: str, website_key: str, *, action: Optional[str] = None, cdata: Optional[str] = None,
              proxy: ProxyArg = None) -> Task:
    """A Cloudflare Turnstile token. Solution: ``{"token", "type": "turnstile", "userAgent"}``."""
    meta = {k: v for k, v in (("action", action), ("cdata", cdata)) if v}
    return _token("AntiTurnstileTask", website_url, website_key, proxy, metadata=meta or None)


def recaptcha_v2_classification(image: Image, question: str, *, size: Optional[int] = None,
                                website_url: Optional[str] = None) -> Task:
    """Which tiles of a reCAPTCHA v2 grid show ``question`` (a ``/m/...`` id or plain words).
    Solution: ``{"type": "multi", "objects": [0-based], "size"}`` or
    ``{"type": "single", "hasObject", "size": 1}``."""
    if size not in (None, 1, 3, 4):
        raise ValueError("size must be 1, 3 or 4")
    task: Task = {"type": RECAPTCHA_V2_CLASSIFICATION, "image": _b64(image), "question": question}
    if size:
        task["size"] = size
    if website_url:
        task["websiteURL"] = website_url
    return task


def aws_waf_classification(images: Sequence[Image], question: str) -> Task:
    """Which tiles of an AWS WAF grid show the object (``aws:grid:<object>``).
    Off on the API until a measured run passes. Solution: ``{"objects": [0-based]}``."""
    if not question.startswith("aws:grid:"):
        question = "aws:grid:" + question
    return {"type": AWS_WAF_CLASSIFICATION, "images": [_b64(i) for i in images], "question": question}


def slider(image_background: Image, image: Optional[Image] = None) -> Task:
    """The gap of a slider puzzle (``VisionEngine``, module ``slider_1``).
    Off on the API until a measured run passes. Solution: ``{"distance": px}``."""
    task: Task = {"type": VISION_ENGINE, "module": "slider_1", "imageBackground": _b64(image_background)}
    if image is not None:
        task["image"] = _b64(image)
    return task


# ── Solution shapes (for type checkers) ──────────────────────────────────


class TokenSolution(TypedDict, total=False):
    gRecaptchaResponse: str
    userAgent: str
    createTime: int


class TurnstileSolution(TypedDict, total=False):
    token: str
    type: str
    userAgent: str


class TextSolution(TypedDict, total=False):
    text: str
    answers: List[str]


class GridSolution(TypedDict, total=False):
    type: str
    objects: List[int]
    size: int
    hasObject: bool


__all__ = [
    "Task", "TASK_TYPES", "RECOGNITION_TYPES", "TOKEN_TYPES", "normalize_task", "proxy_string",
    "image_to_text", "recaptcha_v2", "recaptcha_v3", "turnstile", "recaptcha_v2_classification",
    "aws_waf_classification", "slider",
    "TokenSolution", "TurnstileSolution", "TextSolution", "GridSolution",
]
