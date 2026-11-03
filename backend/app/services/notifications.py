"""Deliver outbox rows with bounded, backed-off retries."""

import logging
import random
from datetime import timedelta

from sqlalchemy import select, update

from app.core import cache
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ProviderError, RetryableProviderError
from app.core.timeutil import utcnow
from app.db.models import NOTE_FAILED, NOTE_PENDING, NOTE_SENDING, NOTE_SENT, NOTE_SKIPPED, Notification
from app.db.session import UnitOfWork, unit_of_work
from app.notify.adapters import get_adapter
from app.services import audit

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

    error: str | None = None
    permanent = False
    try:
        get_adapter(channel).send(recipient or "", payload)
    except RetryableProviderError as e:
        error = str(e)
    except ProviderError as e:
        error, permanent = str(e), True
    except Exception as e:  # unknown adapter failure: treat as transient
        log.exception("notification adapter crashed", extra={"notification_id": notification_id})
        error = f"{type(e).__name__}: {e}"

    max_attempts = get_settings().notify_max_attempts
    with unit_of_work() as uow:
        s = uow.session
        if error is None:
            values = {"status": NOTE_SENT, "sent_at": utcnow(), "last_error": None, "next_attempt_at": None}
            action = "notify.sent"
        elif permanent or attempt >= max_attempts:
            values = {"status": NOTE_FAILED, "last_error": error[:1000], "next_attempt_at": None}
            action = "notify.failed"
        else:
            delay = backoff_seconds(attempt)
            values = {"status": NOTE_PENDING, "last_error": error[:1000], "next_attempt_at": utcnow() + timedelta(seconds=delay)}
            action = "notify.retry"
            from app.worker.tasks import send_notification

            uow.after_commit(lambda: send_notification.apply_async((notification_id,), countdown=delay))
        s.execute(update(Notification).where(Notification.id == notification_id, Notification.status == NOTE_SENDING).values(**values))
        audit.record(uow, action, "notification", notification_id,
                     {"run_id": run_id, "channel": channel, "attempt": attempt, "error": error}, actor="system")
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
    audit.record(uow, "notify.resend", "notification", note.id, {"run_id": note.run_id, "channel": note.channel}, actor=actor)
    from app.worker.tasks import send_notification

    uow.after_commit(lambda: send_notification.apply_async((notification_id,)))
    return note


def list_for_run(uow: UnitOfWork, run_id: int, status: str | None = None, limit: int = 200, offset: int = 0):
    q = select(Notification).where(Notification.run_id == run_id)
    if status:
        q = q.where(Notification.status == status)
    return list(uow.session.scalars(q.order_by(Notification.id).limit(limit).offset(offset)))
