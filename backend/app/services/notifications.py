"""Deliver outbox rows with bounded, backed-off retries, an attempts trail and a dead-letter queue.

Email rows are handed out by the quota dispatcher (services/email_quota.py), never directly: a
worker only sends an email the dispatcher reserved a bucket slot for. Other channels are sent as
soon as they are queued.

Flow per attempt: claim (pending → sending) → render (email: template + optional AI summary, once,
then frozen on the row) → send outside any transaction → record:
  sent      → sent_at, cost ledger
  retryable → back to pending with backoff (email: the dispatcher picks it up when due)
  permanent or out of attempts → failed + a dead_letters row (requeue or discard from the UI)
Every attempt writes a notification_attempts row, an audit entry and a telemetry event.
"""

import logging
import random
import time
from datetime import timedelta
from typing import Any

from jinja2 import TemplateError
from sqlalchemy import func, select, update

from app.core import cache, metrics
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ProviderError, RetryableProviderError, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import (
    DLQ_DISCARDED,
    DLQ_OPEN,
    DLQ_REQUEUED,
    NOTE_FAILED,
    NOTE_PENDING,
    NOTE_SENDING,
    NOTE_SENT,
    NOTE_SKIPPED,
    DeadLetter,
    Notification,
    NotificationAttempt,
    Pam,
    Run,
)
from app.db.session import UnitOfWork, unit_of_work
from app.notify.adapters import get_adapter
from app.services import audit, email_config, email_quota, finops, telemetry

log = logging.getLogger(__name__)


def backoff_seconds(attempt: int, cap: int = 900) -> float:
    return min(cap, 30 * 2 ** (attempt - 1)) + random.uniform(0, 5)


class _Hold(RetryableProviderError):
    """Not sent on purpose (e.g. AI summary unavailable and the template says hold)."""


def _render(nid: int, payload: dict[str, Any], tpl: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """(rendered message, AI usage or None). Raises _Hold / ProviderError."""
    from app.services import email_ai, email_templates

    ai_text, ai_meta, ai_error = "", None, None
    if tpl.get("ai_enabled"):
        try:
            r = email_ai.summarize(tpl.get("ai_prompt"), int(tpl.get("ai_max_words") or 120), email_templates.context(payload))
            ai_text, ai_meta = r.text, (r.meta() if r.provider != "none" else None)
        except ProviderError as e:
            if tpl.get("ai_on_failure") == "hold":
                raise _Hold(f"AI summary unavailable, email held: {e}", retry_after=getattr(e, "retry_after", None)) from e
            ai_error = str(e)[:300]
            log.warning("AI summary failed; sending without it", extra={"notification_id": nid, "err": ai_error})
    try:
        out = email_templates.render(tpl, email_templates.context(payload, ai_text))
    except TemplateError as e:
        raise ProviderError(f"Template '{tpl.get('name')}' v{tpl.get('version')} failed to render: {e}") from e
    return out | {"ai_summary": ai_text, "ai_error": ai_error, "template": {"id": tpl.get("id"), "version": tpl.get("version")}}, ai_meta


def deliver(notification_id: int) -> str:
    """Returns the resulting status. Claim → render → send (outside any transaction) → record."""
    with unit_of_work() as uow:
        s = uow.session
        note = s.get(Notification, notification_id)
        if note is None:
            return "missing"
        is_email = note.channel == "email"
        if is_email and note.status == NOTE_PENDING and note.reserved_at is None:
            # Not handed out by the dispatcher (e.g. an old queue message): let the quota decide.
            uow.after_commit(_kick_dispatcher)
            return "unreserved"
        won = s.execute(
            update(Notification)
            .where(Notification.id == notification_id, Notification.status == NOTE_PENDING)
            .values(status=NOTE_SENDING, attempts=Notification.attempts + 1)
        ).rowcount
        if not won:
            return note.status
        s.refresh(note)
        channel, recipient, payload, attempt, run_id = note.channel, note.recipient, dict(note.payload or {}), note.attempts, note.run_id
        pam_id, rendered, quota_key = note.pam_id, note.rendered, note.quota_key
        cfg = email_config.get_row(uow) if is_email else None
        pol = email_config.policy(cfg)
        tpl = None
        if is_email and rendered is None:
            from app.services import email_templates

            tpl = email_templates.snapshot(email_templates.active(uow))

    error: str | None = None
    permanent = False
    sent_to_provider = False
    err_meta: dict[str, Any] = {}
    adapter_key = "unknown"
    ai_meta: dict[str, Any] | None = None
    newly_rendered = False
    provider_rid: str | None = None
    started = utcnow()
    t0 = time.perf_counter()
    try:
        if is_email and rendered is None:
            rendered, ai_meta = _render(notification_id, payload, tpl)
            newly_rendered = True
        adapter = get_adapter(channel)  # inside the try: a misconfigured adapter fails this attempt, not the worker
        adapter_key = getattr(adapter, "key", type(adapter).__name__)
        message = ({**rendered, "notification_id": notification_id} if is_email else payload)
        sent_to_provider = True
        provider_rid = adapter.send(recipient or "", message)
    except RetryableProviderError as e:
        error, err_meta = str(e), _meta(e)
    except ProviderError as e:
        error, permanent, err_meta = str(e), True, _meta(e)
    except Exception as e:  # unknown adapter failure: treat as transient
        log.exception("notification adapter crashed", extra={"notification_id": notification_id})
        error = f"{type(e).__name__}: {e}"
    duration_ms = int((time.perf_counter() - t0) * 1000)

    max_attempts = pol.max_attempts if is_email else get_settings().notify_max_attempts
    with unit_of_work() as uow:
        s = uow.session
        delay = None
        retry_after = err_meta.get("retry_after")
        if error is None:
            values: dict[str, Any] = {"status": NOTE_SENT, "sent_at": utcnow(), "last_error": None, "next_attempt_at": None}
            action, ev, outcome = "notify.sent", telemetry.OK, "sent"
        elif permanent or attempt >= max_attempts:
            values = {"status": NOTE_FAILED, "last_error": error[:1000], "next_attempt_at": None}
            action, ev, outcome = "notify.failed", telemetry.ERROR, "failed"
        else:
            delay = email_config.backoff(pol, attempt, retry_after) if is_email else backoff_seconds(attempt)
            values = {"status": NOTE_PENDING, "last_error": error[:1000], "next_attempt_at": utcnow() + timedelta(seconds=delay)}
            action, ev, outcome = "notify.retry", telemetry.RETRY, "retry"
            if not is_email:
                from app.worker.tasks import send_notification

                uow.after_commit(lambda: send_notification.apply_async((notification_id,), countdown=delay))
        if is_email:
            values |= {"reserved_at": None, "quota_key": None}
            if newly_rendered:
                values |= {"rendered": rendered, "template_id": (rendered or {}).get("template", {}).get("id"),
                           "template_version": (rendered or {}).get("template", {}).get("version")}
            # Not accepted by the provider: give the slot back (a timeout may have been accepted, so it stays counted).
            if error is not None and (not sent_to_provider or err_meta.get("http_status") is not None):
                email_quota.refund(uow, quota_key)
            if err_meta.get("http_status") == 429:
                email_config.pause_for_throttle(uow, float(retry_after or 60), f"Microsoft Graph throttled sending (429): {error}"[:300])
        moved = s.execute(
            update(Notification).where(Notification.id == notification_id, Notification.status == NOTE_SENDING).values(**values)
        ).rowcount
        s.add(NotificationAttempt(
            notification_id=notification_id, attempt=attempt, started_at=started, duration_ms=duration_ms, outcome=outcome,
            adapter=adapter_key, http_status=err_meta.get("http_status"), error_code=err_meta.get("error_code"),
            error=error[:2000] if error else None, retryable=None if error is None else not permanent,
            provider_request_id=(err_meta.get("request_id") or (provider_rid if error is None else None)),
        ))
        s.flush()  # the dead-letter snapshot below lists every attempt, including this one
        run = s.get(Run, run_id)
        if moved and error is None and run is not None:
            finops.record_message(uow, notification_id=notification_id, run=run, pam_id=pam_id, channel=channel, adapter=adapter_key)
        if newly_rendered and ai_meta and run is not None:
            finops.record_email_ai(uow, notification_id=notification_id, run=run, pam_id=pam_id, meta=ai_meta)
        if moved and outcome == "failed":
            _dead_letter(uow, notification_id, "permanent" if permanent else "exhausted", attempt, error, rendered, payload, run)
        audit.record(uow, action, "notification", notification_id,
                     {"channel": channel, "pam_id": pam_id, "attempt": attempt, "error": error,
                      "http_status": err_meta.get("http_status"), "error_code": err_meta.get("error_code")},
                     actor="system", run_id=run_id)
        telemetry.event(
            uow, "notify.attempt", ev, run_id=run_id, import_id=run.import_id if run else None, pam_id=pam_id,
            notification_id=notification_id, attempt=attempt, duration_ms=duration_ms, provider=channel, actor="system",
            cost=finops.message_price(channel) if error is None else None,
            message=error if error else f"sent via {adapter_key}", channel=channel, adapter=adapter_key,
            retry_in_s=round(delay, 1) if delay else None, http_status=err_meta.get("http_status"),
        )
        metrics.NOTIFY_ATTEMPTS.labels(channel, ev).inc()
        uow.after_commit(lambda: cache.bump(f"run:{run_id}", "runs", "outbox"))
        return values["status"]


def _meta(e: Exception) -> dict[str, Any]:
    return {k: getattr(e, k, None) for k in ("http_status", "error_code", "request_id", "retry_after")}


def _dead_letter(uow: UnitOfWork, nid: int, reason: str, attempts: int, error: str | None,
                 rendered: dict[str, Any] | None, payload: dict[str, Any], run: Run | None) -> None:
    note = uow.session.get(Notification, nid)
    subject = (rendered or {}).get("subject") or payload.get("subject")
    history = [
        {"attempt": a.attempt, "at": a.started_at.isoformat() if a.started_at else None, "outcome": a.outcome,
         "httpStatus": a.http_status, "errorCode": a.error_code, "error": (a.error or "")[:300]}
        for a in uow.session.scalars(select(NotificationAttempt).where(NotificationAttempt.notification_id == nid)
                                     .order_by(NotificationAttempt.id))
    ]
    dl = DeadLetter(
        notification_id=nid, run_id=note.run_id, pam_id=note.pam_id, channel=note.channel, recipient=note.recipient,
        subject=(subject or "")[:500] or None, reason=reason, attempts=attempts, last_error=(error or "")[:4000],
        snapshot={"subject": subject, "templateVersion": note.template_version, "attempts": history,
                  "signals": payload.get("signals"), "total": payload.get("total")},
        status=DLQ_OPEN, created_at=utcnow(),
    )
    uow.session.add(dl)
    uow.session.flush()
    audit.record(uow, "notify.dead_letter", "dead_letter", dl.id,
                 {"notification_id": nid, "channel": note.channel, "reason": reason, "attempts": attempts, "error": (error or "")[:300]},
                 actor="system", run_id=note.run_id)
    telemetry.event(uow, "notify.dead_letter", telemetry.ERROR, run_id=note.run_id, import_id=run.import_id if run else None,
                    pam_id=note.pam_id, notification_id=nid, actor="system", channel=note.channel,
                    message=f"Moved to dead-letter queue ({reason}): {(error or '')[:200]}")
    metrics.NOTIFY_ATTEMPTS.labels(note.channel, "dead_letter").inc()


def _kick_dispatcher() -> None:
    from app.worker.tasks import dispatch_email

    dispatch_email.apply_async()


def _requeue(uow: UnitOfWork, note: Notification) -> None:
    """Back to pending with a clean attempt counter. Email is re-rendered with the active template,
    so a fixed template (or a working AI) applies to the retry."""
    note.status, note.attempts, note.next_attempt_at, note.last_error = NOTE_PENDING, 0, utcnow(), None
    if note.channel == "email":
        note.reserved_at, note.quota_key, note.rendered = None, None, None
        uow.after_commit(_kick_dispatcher)
    else:
        from app.worker.tasks import send_notification

        nid = note.id
        uow.after_commit(lambda: send_notification.apply_async((nid,)))
    # Any open dead letter for this notification is now being retried.
    uow.session.execute(update(DeadLetter).where(DeadLetter.notification_id == note.id, DeadLetter.status == DLQ_OPEN)
                        .values(status=DLQ_REQUEUED, resolved_at=utcnow(), resolved_by="system"))


def resend(uow: UnitOfWork, notification_id: int, actor: str) -> Notification:
    note = uow.session.get(Notification, notification_id)
    if note is None:
        raise NotFound(f"Notification {notification_id} not found")
    if note.status in (NOTE_PENDING, NOTE_SENDING):
        raise Conflict("Notification is already queued")
    if note.status == NOTE_SKIPPED and not note.recipient:
        raise Conflict(f"Cannot resend: {note.last_error}")
    _requeue(uow, note)
    audit.record(uow, "notify.resend", "notification", note.id, {"channel": note.channel, "pam_id": note.pam_id},
                 actor=actor, run_id=note.run_id)
    telemetry.event(uow, "notify.resend", telemetry.INFO, run_id=note.run_id, pam_id=note.pam_id, notification_id=note.id,
                    actor=actor, channel=note.channel, message=f"Re-queued {note.channel} digest")
    uow.after_commit(lambda: cache.bump("outbox"))
    return note


def list_for_run(uow: UnitOfWork, run_id: int, status: str | None = None, limit: int = 200, offset: int = 0):
    q = select(Notification).where(Notification.run_id == run_id)
    if status:
        q = q.where(Notification.status == status)
    return list(uow.session.scalars(q.order_by(Notification.id).limit(limit).offset(offset)))


# --- Outbox & dead-letter queue (operators) ----------------------------------------------------------


def outbox(uow: UnitOfWork, *, page: int, size: int, status: str | None = None, channel: str | None = None,
           q: str | None = None, where: Any = (), order: Any = None, run_id: int | None = None) -> dict[str, Any]:
    """`where` / `order`: column filters and sort from a table request (api/listing.py)."""
    base = [*where]  # filters the status tabs share
    if run_id is not None:
        base.append(Notification.run_id == run_id)
    if channel:
        base.append(Notification.channel == channel)
    if q:
        base.append(Notification.recipient.ilike(f"%{q.strip()}%"))
    conds = base + ([Notification.status == status] if status else [])
    s = uow.session
    # Pam is outer-joined so the PAM name can be filtered/sorted on.
    q_rows = select(Notification).outerjoin(Pam, Pam.id == Notification.pam_id)
    q_count = select(func.count(Notification.id)).outerjoin(Pam, Pam.id == Notification.pam_id)
    rows = list(s.scalars(q_rows.where(*conds).order_by(*(order or [Notification.id.desc()])).limit(size).offset(page * size)))
    total = s.scalar(q_count.where(*conds)) or 0
    counts = dict(s.execute(select(Notification.status, func.count(Notification.id)).outerjoin(Pam, Pam.id == Notification.pam_id)
                            .where(*base).group_by(Notification.status)).all())
    return {"rows": rows, "total": total, "counts": counts}


def attempts(uow: UnitOfWork, notification_id: int) -> list[NotificationAttempt]:
    if uow.session.get(Notification, notification_id) is None:
        raise NotFound(f"Notification {notification_id} not found")
    return list(uow.session.scalars(select(NotificationAttempt).where(NotificationAttempt.notification_id == notification_id)
                                    .order_by(NotificationAttempt.id)))


def dead_letters(uow: UnitOfWork, *, page: int, size: int, status: str | None = DLQ_OPEN, channel: str | None = None,
                 where: Any = (), order: Any = None) -> dict[str, Any]:
    conds = [*where]
    if status:
        conds.append(DeadLetter.status == status)
    if channel:
        conds.append(DeadLetter.channel == channel)
    s = uow.session
    rows = list(s.scalars(select(DeadLetter).where(*conds).order_by(*(order or [DeadLetter.id.desc()])).limit(size).offset(page * size)))
    total = s.scalar(select(func.count(DeadLetter.id)).where(*conds)) or 0
    counts = dict(s.execute(select(DeadLetter.status, func.count(DeadLetter.id)).group_by(DeadLetter.status)).all())
    return {"rows": rows, "total": total, "counts": counts}


def requeue_dead_letters(uow: UnitOfWork, ids: list[int], actor: str) -> int:
    if not ids:
        raise ValidationFailed("Select at least one dead letter")
    if len(ids) > 1000:
        raise ValidationFailed("Requeue at most 1,000 at a time")
    letters = list(uow.session.scalars(select(DeadLetter).where(DeadLetter.id.in_(ids), DeadLetter.status == DLQ_OPEN)))
    n = 0
    for dl in letters:
        note = uow.session.get(Notification, dl.notification_id)
        if note is None or note.status in (NOTE_PENDING, NOTE_SENDING):
            continue
        _requeue(uow, note)
        dl.status, dl.resolved_at, dl.resolved_by = DLQ_REQUEUED, utcnow(), actor
        audit.record(uow, "notify.dead_letter.requeue", "dead_letter", dl.id, {"notification_id": note.id, "channel": note.channel},
                     actor=actor, run_id=note.run_id)
        n += 1
    if n:
        telemetry.event(uow, "notify.resend", telemetry.INFO, actor=actor, message=f"Requeued {n} dead letters")
        uow.after_commit(lambda: cache.bump("outbox", "runs"))
    return n


def discard_dead_letter(uow: UnitOfWork, dead_letter_id: int, note_text: str, actor: str) -> DeadLetter:
    dl = uow.session.get(DeadLetter, dead_letter_id)
    if dl is None:
        raise NotFound(f"Dead letter {dead_letter_id} not found")
    if dl.status != DLQ_OPEN:
        raise Conflict(f"Dead letter is already {dl.status}")
    text = (note_text or "").strip()
    if len(text) < 3:
        raise ValidationFailed("Add a short note explaining why this is discarded", details={"field": "note"})
    dl.status, dl.resolved_at, dl.resolved_by, dl.resolution_note = DLQ_DISCARDED, utcnow(), actor, text[:1000]
    audit.record(uow, "notify.dead_letter.discard", "dead_letter", dl.id,
                 {"notification_id": dl.notification_id, "note": text[:300]}, actor=actor, run_id=dl.run_id)
    uow.after_commit(lambda: cache.bump("outbox"))
    return dl
