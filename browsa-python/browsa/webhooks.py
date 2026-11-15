"""Webhook signature verification for inbound deliveries.

The agents service signs every outbound POST with HMAC-SHA256:

    X-Agents-Signature: t=<unix>, v1=<hex>

    where v1 = HMAC-SHA256(secret, "<unix>.<raw-request-body>")

This module exposes a single function `verify_signature` that returns
True iff the header matches the body AND the timestamp is within the
allowed skew (default 300s). Use it in your receiver BEFORE trusting
any payload field.

Example with FastAPI:

    from fastapi import Request, HTTPException
    from browsa import webhooks

    SECRET = bytes.fromhex(os.environ["BROWSA_WEBHOOK_SECRET"])

    @app.post("/webhooks/browsa")
    async def receive(req: Request):
        raw = await req.body()
        sig = req.headers.get("X-Agents-Signature", "")
        if not webhooks.verify_signature(raw, sig, SECRET):
            raise HTTPException(401, "bad signature")
        payload = json.loads(raw)
        ...
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Union

DEFAULT_SKEW_SECONDS = 300  # 5 minutes


def parse_signature_header(header: str) -> tuple[str, str]:
    """Parse `t=<unix>, v1=<hex>` into (t, v1). Returns ("", "") on parse fail."""
    if not header:
        return "", ""
    t = ""
    v1 = ""
    for part in header.split(","):
        kv = part.strip().split("=", 1)
        if len(kv) != 2:
            continue
        k, v = kv[0].strip(), kv[1].strip()
        if k == "t":
            t = v
        elif k == "v1":
            v1 = v
    return t, v1


def verify_signature(
    body: Union[bytes, str],
    header: str,
    secret: Union[bytes, str],
    *,
    skew_seconds: int = DEFAULT_SKEW_SECONDS,
) -> bool:
    """Verify an X-Agents-Signature header against the raw body.

    Args:
        body: Raw request body bytes (BEFORE any JSON parsing). Strings
              are utf-8 encoded.
        header: Value of the X-Agents-Signature header.
        secret: Workspace signing secret. Bytes or hex string (the dashboard
                shows it as hex; this function accepts either form).
        skew_seconds: Reject deliveries whose timestamp is more than this many
                seconds away from now. Default 300s. Set to None to disable.

    Returns:
        True iff signature and timestamp both verify. False otherwise.
        Never raises — always safe to call before parsing body.
    """
    t, v1 = parse_signature_header(header)
    if not t or not v1:
        return False
    try:
        unix = int(t)
    except ValueError:
        return False
    if skew_seconds is not None:
        now = int(time.time())
        if abs(now - unix) > skew_seconds:
            return False

    if isinstance(body, str):
        body = body.encode("utf-8")
    if isinstance(secret, str):
        try:
            secret = bytes.fromhex(secret)
        except ValueError:
            secret = secret.encode("utf-8")

    signed = f"{t}.".encode("utf-8") + body
    expected = hmac.new(secret, signed, hashlib.sha256).hexdigest()
    # Constant-time compare — never use ==
    return hmac.compare_digest(expected, v1)
