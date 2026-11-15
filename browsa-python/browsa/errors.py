"""Canonical error envelope from browsa.io:

    { "code": "INVALID_ID", "error": "...", "request_id": "uuid" }

Every error response from the API is wrapped in this shape. The SDK
parses it and raises the most specific subclass of BrowsaError that
matches the HTTP status + envelope code.
"""
from __future__ import annotations
from typing import Any, Optional


class BrowsaError(Exception):
    """Base class for all SDK errors. Always carries the canonical envelope
    fields (code, error, request_id) plus the raw HTTP status so the caller
    can branch on either."""

    def __init__(
        self,
        message: str,
        *,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        status: Optional[int] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.request_id = request_id
        self.status = status
        self.body = body

    def __str__(self) -> str:
        bits = [super().__str__()]
        if self.code:
            bits.append(f"code={self.code}")
        if self.status:
            bits.append(f"status={self.status}")
        if self.request_id:
            bits.append(f"request_id={self.request_id}")
        return " | ".join(bits)


class APIError(BrowsaError):
    """Any non-2xx response that doesn't match a more specific subclass."""


class AuthError(BrowsaError):
    """401 / 403 — invalid or revoked API key."""


class RateLimitError(BrowsaError):
    """429 — slow down. The server may set Retry-After; check `retry_after`."""

    def __init__(self, *args: Any, retry_after: Optional[float] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.retry_after = retry_after


class InvalidIDError(BrowsaError):
    """400 INVALID_ID — caller passed a non-UUID job/webhook/key id."""


class NotFoundError(BrowsaError):
    """404 — the resource doesn't exist, was deleted, or belongs to a different workspace."""


class TimeoutError(BrowsaError):  # noqa: A001 — shadows builtin intentionally
    """Local: the SDK timed out waiting on a long-poll or socket read."""


def from_response(status: int, body: Any) -> BrowsaError:
    """Build the most-specific subclass given a raw response."""
    code = None
    error = None
    request_id = None
    if isinstance(body, dict):
        code = body.get("code")
        error = body.get("error") or body.get("message")
        request_id = body.get("request_id")
    message = error or f"HTTP {status}"

    if status == 401 or code in ("UNAUTHORIZED", "INVALID_API_KEY"):
        cls = AuthError
    elif status == 429 or code == "RATE_LIMIT":
        cls = RateLimitError
    elif status == 400 and code == "INVALID_ID":
        cls = InvalidIDError
    elif status == 404 or code == "NOT_FOUND":
        cls = NotFoundError
    else:
        cls = APIError

    return cls(message, code=code, request_id=request_id, status=status, body=body)
