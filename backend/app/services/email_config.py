"""Email delivery settings (Microsoft Graph, app-to-app), managed from the UI.

Rules (same as the research AI settings in llm_config.py):
- One row (id=1). The client secret is AES-GCM encrypted at rest and never leaves the server
  (responses carry only a hint); every change is audited without it.
- Saving proves the credentials first (token from Entra ID + Mail.Send role in it), outside any
  transaction, so a typo never reaches the database.
- No row at all = development mode: the console adapter logs emails instead of sending them.
  A saved but switched-off config holds emails in the outbox (nothing is lost or sent).
- Limits, retry policy and delivery policy are stored here so operators can tune them live.
"""

import logging
import random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from email_validator import EmailNotValidError, validate_email

from app.core import cache, secrets
from app.core.errors import AppError, NotFound, ServiceUnavailable, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import EmailConfig
from app.db.session import UnitOfWork, unit_of_work
from app.notify import graph
from app.services import audit

log = logging.getLogger(__name__)

CONFIG_ID = 1
_CTX = "email:graph:client_secret"  # AEAD associated data: the ciphertext only decrypts as this field

# Exchange Online sending limits (per mailbox) used when nothing is saved yet.
DEFAULT_LIMITS = {"per_minute": 30, "per_hour": 3600, "per_day": 10000, "safety_margin_pct": 5}
DEFAULT_POLICY = {"max_attempts": 6, "backoff_base_s": 60, "backoff_cap_s": 3600, "send_when_no_signals": False}

_GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_DOMAIN = re.compile(r"^(?=.{4,253}$)([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}$")


@dataclass(frozen=True)
class Limits:
    """Effective limits (configured limit minus the safety margin)."""

    minute: int
    hour: int
    day: int
    configured: dict[str, int]

    @property
    def spacing_s(self) -> float:
        """Seconds between two sends so the per-minute limit holds over any rolling 60 s."""
        return 60.0 / max(1, self.minute)


@dataclass(frozen=True)
class Policy:
    max_attempts: int
    backoff_base_s: int
    backoff_cap_s: int
    send_when_no_signals: bool


# --- Reads ----------------------------------------------------------------------------------------


def get_row(uow: UnitOfWork) -> EmailConfig | None:
    return uow.session.get(EmailConfig, CONFIG_ID)


def credentials(row: EmailConfig) -> graph.GraphCredentials:
    try:
        secret = secrets.decrypt(row.client_secret_enc, context=_CTX)
    except secrets.SecretUnreadable as e:
        raise graph.GraphError(f"Saved client secret cannot be read ({e}); enter it again under Providers & channels",
                               error_code="secret_unreadable") from e
    return graph.GraphCredentials(
        tenant_id=row.tenant_id, client_id=row.client_id, client_secret=secret, sender=row.sender_address,
        sender_name=row.sender_name, reply_to=row.reply_to, save_to_sent=row.save_to_sent,
    )


def limits(row: EmailConfig | None) -> Limits:
    src = {k: getattr(row, k) for k in DEFAULT_LIMITS} if row else dict(DEFAULT_LIMITS)
    keep = (100 - max(0, min(50, src["safety_margin_pct"]))) / 100

    def eff(v: int) -> int:
        return max(1, int(v * keep))

    return Limits(minute=eff(src["per_minute"]), hour=eff(src["per_hour"]), day=eff(src["per_day"]), configured=src)


def policy(row: EmailConfig | None) -> Policy:
    src = {k: getattr(row, k) for k in DEFAULT_POLICY} if row else dict(DEFAULT_POLICY)
    return Policy(**src)


def backoff(p: Policy, attempt: int, retry_after: float | None = None) -> float:
    """Exponential backoff with jitter; never sooner than the provider's Retry-After."""
    delay = min(p.backoff_cap_s, p.backoff_base_s * 2 ** max(0, attempt - 1))
    if retry_after:
        delay = max(delay, float(retry_after))
    return delay + random.uniform(0, min(30.0, delay * 0.1))


def paused(row: EmailConfig | None, now: datetime) -> bool:
    return bool(row and row.paused_until and as_utc(row.paused_until) > now)


# --- Validation -----------------------------------------------------------------------------------


def _email(value: str | None, field: str, *, required: bool) -> str | None:
    v = (value or "").strip()
    if not v:
        if required:
            raise ValidationFailed("Enter an email address", details={"field": field}, code="email_required")
        return None
    try:
        return validate_email(v, check_deliverability=False).normalized.lower()
    except EmailNotValidError as e:
        raise ValidationFailed(f"Not a valid email address: {e}", details={"field": field}, code="invalid_email") from e


def _tenant(value: str) -> str:
    v = (value or "").strip()
    if not (_GUID.match(v) or _DOMAIN.match(v)):
        raise ValidationFailed("Tenant ID must be a GUID or a verified domain (e.g. contoso.onmicrosoft.com)",
                               details={"field": "tenantId"}, code="invalid_tenant")
    return v.lower()


def _client_id(value: str) -> str:
    v = (value or "").strip()
    if not _GUID.match(v):
        raise ValidationFailed("Client (application) ID must be a GUID", details={"field": "clientId"}, code="invalid_client_id")
    return v.lower()


def _secret(value: str | None) -> str | None:
    v = (value or "").strip()
    if not v:
        return None
    if len(v) < 8 or len(v) > 512 or any(ch.isspace() for ch in v):
        raise ValidationFailed("That does not look like a client secret value (copy the Value, not the Secret ID)",
                               details={"field": "clientSecret"}, code="invalid_secret")
    return v


def _map_graph_error(e: Exception) -> AppError:
    if isinstance(e, graph.GraphRetryableError):
        return ServiceUnavailable(f"Microsoft is not reachable right now: {e}", code="graph_unavailable")
    field = "clientSecret" if isinstance(e, graph.GraphAuthError) else None
    return ValidationFailed(str(e), details={"field": field} if field else None, code=getattr(e, "error_code", None) or "graph_error")


def _verify(creds: graph.GraphCredentials) -> int:
    try:
        return graph.verify(creds)["latency_ms"]
    except graph.ProviderError as e:
        raise _map_graph_error(e) from e


def _snapshot(row: EmailConfig | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {k: getattr(row, k) for k in ("enabled", "tenant_id", "client_id", "secret_hint", "sender_address", "sender_name",
                                         "reply_to", "save_to_sent")}


def _changed(uow: UnitOfWork) -> None:
    uow.after_commit(lambda: cache.bump("email", "channels"))


# --- Commands -------------------------------------------------------------------------------------


def save(data: dict[str, Any], actor: str) -> EmailConfig:
    """Verify, then store the connection settings. `client_secret` may be omitted to keep the saved one."""
    tenant = _tenant(data.get("tenant_id", ""))
    client_id = _client_id(data.get("client_id", ""))
    sender = _email(data.get("sender_address"), "senderAddress", required=True)
    reply_to = _email(data.get("reply_to"), "replyTo", required=False)
    sender_name = (data.get("sender_name") or "").strip()[:200] or None
    new_secret = _secret(data.get("client_secret"))
    with unit_of_work() as uow:
        row = get_row(uow)
        if new_secret is None:
            if row is None:
                raise ValidationFailed("Enter the client secret", details={"field": "clientSecret"}, code="secret_required")
            if (row.tenant_id, row.client_id) != (tenant, client_id):
                raise ValidationFailed("Enter the client secret for the new tenant / application",
                                       details={"field": "clientSecret"}, code="secret_required")
            secret = credentials(row).client_secret
        else:
            secret = new_secret
    creds = graph.GraphCredentials(tenant, client_id, secret, sender, sender_name, reply_to, bool(data.get("save_to_sent")))
    latency = _verify(creds)

    enc = secrets.encrypt(secret, context=_CTX) if new_secret else None
    with unit_of_work() as uow:
        row = get_row(uow)
        before = _snapshot(row)
        if row is None:
            row = EmailConfig(id=CONFIG_ID, enabled=data.get("enabled") is not False, **DEFAULT_LIMITS, **DEFAULT_POLICY)
            uow.session.add(row)
        elif "enabled" in data and data["enabled"] is not None:
            row.enabled = bool(data["enabled"])
        if enc:
            row.client_secret_enc, row.secret_hint = enc, secrets.hint(secret)
        row.tenant_id, row.client_id, row.sender_address, row.sender_name, row.reply_to = tenant, client_id, sender, sender_name, reply_to
        row.save_to_sent = bool(data.get("save_to_sent"))
        row.verified_at, row.last_check_ok, row.last_check_error, row.last_check_latency_ms = utcnow(), True, None, latency
        row.updated_by = actor
        uow.session.flush()
        audit.record(uow, "email.config.save", "email_config", row.id,
                     {"before": before, "after": _snapshot(row), "secret_changed": bool(enc), "latency_ms": latency}, actor=actor)
        _changed(uow)
    log.info("email config saved", extra={"sender": sender, "secret_changed": bool(enc)})
    return row


def test_connection(actor: str) -> tuple[EmailConfig, str | None]:
    """Re-verify the saved credentials. Records the outcome; a Microsoft failure is returned, not raised."""
    with unit_of_work() as uow:
        row = _require(uow)
        try:
            creds = credentials(row)
        except graph.GraphError as e:
            creds, early = None, str(e)
        else:
            early = None
    error, latency = early, None
    if creds is not None:
        try:
            latency = graph.verify(creds)["latency_ms"]
        except graph.ProviderError as e:
            error = _map_graph_error(e).message
    with unit_of_work() as uow:
        row = _require(uow)
        row.last_check_ok, row.last_check_error, row.last_check_latency_ms = error is None, error, latency
        if error is None:
            row.verified_at = utcnow()
        audit.record(uow, "email.config.test", "email_config", row.id, {"ok": error is None, "error": error, "latency_ms": latency}, actor=actor)
        _changed(uow)
    return row, error


def send_test(to: str, actor: str) -> dict[str, Any]:
    """Send a real test email through Graph. It counts against the quota like any other email."""
    from app.services import email_quota

    to_addr = _email(to, "to", required=True)
    with unit_of_work() as uow:
        row = _require(uow)
        try:
            creds = credentials(row)
        except graph.GraphError as e:
            raise _map_graph_error(e) from e
    key = email_quota.reserve_one()
    if key is None:
        raise ValidationFailed("The sending quota is used up right now; try again shortly", code="quota_exhausted")
    body = graph.build_message(creds, to_addr, "TTBS Signals: test email",
                               "<p>This is a test email from <strong>TTBS Live News Feed</strong>.</p>"
                               "<p>Microsoft Graph delivery is configured correctly.</p>", None,
                               {"X-TTBS-Test": "1"})
    error: str | None = None
    rid: str | None = None
    try:
        rid = graph.send_mail(creds, body)
    except graph.ProviderError as e:
        error = str(e)
        email_quota.refund_key(key)
    with unit_of_work() as uow:
        audit.record(uow, "email.test_send", "email_config", CONFIG_ID, {"to": to_addr, "ok": error is None, "error": error, "request_id": rid},
                     actor=actor)
    if error:
        raise ValidationFailed(f"Test email was not accepted: {error}", code="test_send_failed")
    return {"ok": True, "to": to_addr, "requestId": rid}


def _require(uow: UnitOfWork) -> EmailConfig:
    row = get_row(uow)
    if row is None:
        raise NotFound("Email (Microsoft Graph) is not configured yet", code="email_not_configured")
    return row


def _bounded(data: dict[str, Any], key: str, lo: int, hi: int) -> int:
    try:
        v = int(data[key])
    except (KeyError, TypeError, ValueError) as e:
        raise ValidationFailed(f"{key} is required", details={"field": key}) from e
    if not lo <= v <= hi:
        raise ValidationFailed(f"{key} must be between {lo} and {hi}", details={"field": key}, code="out_of_range")
    return v


def update_limits(data: dict[str, Any], actor: str) -> EmailConfig:
    vals = {
        "per_minute": _bounded(data, "per_minute", 1, 10_000),
        "per_hour": _bounded(data, "per_hour", 1, 1_000_000),
        "per_day": _bounded(data, "per_day", 1, 10_000_000),
        "safety_margin_pct": _bounded(data, "safety_margin_pct", 0, 50),
    }
    if vals["per_minute"] > vals["per_hour"] or vals["per_hour"] > vals["per_day"]:
        raise ValidationFailed("Limits must satisfy per minute ≤ per hour ≤ per day", code="limits_inconsistent")
    return _update(vals, "email.config.limits", actor)


def update_policy(data: dict[str, Any], actor: str) -> EmailConfig:
    vals = {
        "max_attempts": _bounded(data, "max_attempts", 1, 20),
        "backoff_base_s": _bounded(data, "backoff_base_s", 5, 3600),
        "backoff_cap_s": _bounded(data, "backoff_cap_s", 30, 86_400),
        "send_when_no_signals": bool(data.get("send_when_no_signals")),
    }
    if vals["backoff_cap_s"] < vals["backoff_base_s"]:
        raise ValidationFailed("Maximum backoff must be at least the first backoff", code="backoff_inconsistent")
    return _update(vals, "email.config.policy", actor)


def set_enabled(enabled: bool, actor: str) -> EmailConfig:
    row = _update({"enabled": bool(enabled)}, "email.config.enable" if enabled else "email.config.disable", actor)
    if enabled:
        _kick()
    return row


def pause(minutes: int, reason: str | None, actor: str) -> EmailConfig:
    minutes = max(1, min(int(minutes), 7 * 24 * 60))
    return _update({"paused_until": utcnow() + timedelta(minutes=minutes), "pause_reason": (reason or "Paused by operator")[:300]},
                   "email.pause", actor)


def resume(actor: str) -> EmailConfig:
    row = _update({"paused_until": None, "pause_reason": None}, "email.resume", actor)
    _kick()
    return row


def pause_for_throttle(uow: UnitOfWork, seconds: float, reason: str) -> None:
    """Graph said 429: stop dispatching for Retry-After so the mailbox is not blocked."""
    row = get_row(uow)
    if row is None:
        return
    until = utcnow() + timedelta(seconds=max(5.0, min(seconds, 3600.0)))
    if row.paused_until is None or as_utc(row.paused_until) < until:
        row.paused_until, row.pause_reason = until, reason[:300]
        _changed(uow)


def _update(vals: dict[str, Any], action: str, actor: str) -> EmailConfig:
    with unit_of_work() as uow:
        row = _require(uow)
        before = {k: _jsonable(getattr(row, k)) for k in vals}
        for k, v in vals.items():
            setattr(row, k, v)
        row.updated_by = actor
        uow.session.flush()
        audit.record(uow, action, "email_config", row.id, {"before": before, "after": {k: _jsonable(v) for k, v in vals.items()}}, actor=actor)
        _changed(uow)
    return row


def _jsonable(v: Any) -> Any:
    return as_utc(v).isoformat() if isinstance(v, datetime) else v


def remove(actor: str) -> None:
    with unit_of_work() as uow:
        row = get_row(uow)
        if row is None:
            return
        audit.record(uow, "email.config.remove", "email_config", row.id, {"before": _snapshot(row)}, actor=actor)
        uow.session.delete(row)
        _changed(uow)
    graph.clear_token_cache()


def _kick() -> None:
    from app.worker.tasks import dispatch_email

    try:
        dispatch_email.apply_async()
    except Exception:  # noqa: BLE001 - the beat schedule dispatches anyway
        log.warning("could not kick the email dispatcher", exc_info=True)
