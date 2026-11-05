"""Deliver outbox rows with bounded, backed-off retries."""

import logging
import random
import time
from datetime import timedelta

from sqlalchemy import select, update

from app.core import cache, metrics
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ProviderError, RetryableProviderError
from app.core.timeutil import utcnow
from app.db.models import NOTE_FAILED, NOTE_PENDING, NOTE_SENDING, NOTE_SENT, NOTE_SKIPPED, Notification, Run
from app.db.session import UnitOfWork, unit_of_work
from app.notify.adapters import get_adapter
from app.services import audit, finops, telemetry

log = logging.getLogger(__name__)


def backoff_seconds(attempt: int, cap: int = 900) -> float:
    return min(cap, 30 * 2 ** (attempt - 1)) + random.uniform(0, 5)


def deliver(notification_id: int) -> str:
    """Returns the resulting status. Claim → send (outside any transaction) → record."""
    with unit_of_work() as uow:
        won = uow.session.execute(
            update(Notification)
            .where(Notification.id == notification_id, Notification.status == NOTE_PENDING)
            .values(status=NOTE_SENDING, attempts=Notification.attempts + 1)
        ).rowcount
        note = uow.session.get(Notification, notification_id)
        if not won or note is None:
            return note.status if note else "missing"
        channel, recipient, payload, attempt, run_id = note.channel, note.recipient, note.payload, note.attempts, note.run_id
        pam_id = note.pam_id

    error: str | None = None
    permanent = False
    adapter_key = "unknown"
    t0 = time.perf_counter()
    try:
        adapter = get_adapter(channel)  # inside the try: a misconfigured adapter fails this attempt, not the worker
        adapter_key = getattr(adapter, "key", type(adapter).__name__)
        adapter.send(recipient or "", payload)
    except RetryableProviderError as e:
        error = str(e)
    except ProviderError as e:
        error, permanent = str(e), True
    except Exception as e:  # unknown adapter failure: treat as transient
        log.exception("notification adapter crashed", extra={"notification_id": notification_id})
        error = f"{type(e).__name__}: {e}"

    duration_ms = int((time.perf_counter() - t0) * 1000)
    max_attempts = get_settings().notify_max_attempts
    with unit_of_work() as uow:
        s = uow.session
        delay = None
        if error is None:
            values = {"status": NOTE_SENT, "sent_at": utcnow(), "last_error": None, "next_attempt_at": None}
            action, ev = "notify.sent", telemetry.OK
        elif permanent or attempt >= max_attempts:
            values = {"status": NOTE_FAILED, "last_error": error[:1000], "next_attempt_at": None}
            action, ev = "notify.failed", telemetry.ERROR
        else:
            delay = backoff_seconds(attempt)
            values = {"status": NOTE_PENDING, "last_error": error[:1000], "next_attempt_at": utcnow() + timedelta(seconds=delay)}
            action, ev = "notify.retry", telemetry.RETRY
            from app.worker.tasks import send_notification

            uow.after_commit(lambda: send_notification.apply_async((notification_id,), countdown=delay))
        moved = s.execute(
            update(Notification).where(Notification.id == notification_id, Notification.status == NOTE_SENDING).values(**values)
        ).rowcount
        run = s.get(Run, run_id)
        if moved and error is None and run is not None:
            finops.record_message(uow, notification_id=notification_id, run=run, pam_id=pam_id, channel=channel, adapter=adapter_key)
        audit.record(uow, action, "notification", notification_id,
                     {"channel": channel, "pam_id": pam_id, "attempt": attempt, "error": error}, actor="system", run_id=run_id)
        telemetry.event(
            uow, "notify.attempt", ev, run_id=run_id, import_id=run.import_id if run else None, pam_id=pam_id,
            notification_id=notification_id, attempt=attempt, duration_ms=duration_ms, provider=channel, actor="system",
            cost=finops.message_price(channel) if error is None else None,
            message=error if error else f"sent via {adapter_key}", channel=channel, adapter=adapter_key,
            retry_in_s=round(delay, 1) if delay else None,
        )
        metrics.NOTIFY_ATTEMPTS.labels(channel, ev).inc()
        uow.after_commit(lambda: cache.bump(f"run:{run_id}", "runs"))
        return values["status"]


def resend(uow: UnitOfWork, notification_id: int, actor: str) -> Notification:
    note = uow.session.get(Notification, notification_id)
    if note is None:
        raise NotFound(f"Notification {notification_id} not found")
    if note.status in (NOTE_PENDING, NOTE_SENDING):
        raise Conflict("Notification is already queued")
    if note.status == NOTE_SKIPPED and not note.recipient:
        raise Conflict(f"Cannot resend: {note.last_error}")
    note.status, note.attempts, note.next_attempt_at, note.last_error = NOTE_PENDING, 0, utcnow(), None
    audit.record(uow, "notify.resend", "notification", note.id, {"channel": note.channel, "pam_id": note.pam_id},
                 actor=actor, run_id=note.run_id)
    telemetry.event(uow, "notify.resend", telemetry.INFO, run_id=note.run_id, pam_id=note.pam_id, notification_id=note.id,
                    actor=actor, channel=note.channel, message=f"Re-queued {note.channel} digest")
    from app.worker.tasks import send_notification

    uow.after_commit(lambda: send_notification.apply_async((notification_id,)))
    return note


def list_for_run(uow: UnitOfWork, run_id: int, status: str | None = None, limit: int = 200, offset: int = 0):
    q = select(Notification).where(Notification.run_id == run_id)
    if status:
        q = q.where(Notification.status == status)
    return list(uow.session.scalars(q.order_by(Notification.id).limit(limit).offset(offset)))
