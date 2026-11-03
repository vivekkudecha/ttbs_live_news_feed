"""Domain error hierarchy. API handlers map these to one uniform error envelope:

    {"error": {"code": "...", "message": "...", "details": ..., "request_id": "..."}}

Stack traces never leave the server; the request_id ties a client report to the logs.
"""

from typing import Any


class AppError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, details: Any = None, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.details = details
        if code:
            self.code = code


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_failed"


class PayloadTooLarge(AppError):
    status_code = 413
    code = "payload_too_large"


class UnsupportedMedia(AppError):
    status_code = 415
    code = "unsupported_media_type"


class ServiceUnavailable(AppError):
    status_code = 503
    code = "service_unavailable"


# --- Provider errors (research / notification adapters) ---------------------------------


class ProviderError(Exception):
    """Permanent failure: retrying will not help (bad request, auth, malformed response)."""


class RetryableProviderError(ProviderError):
    """Transient failure: 429, 5xx, timeouts, connection errors."""

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after
