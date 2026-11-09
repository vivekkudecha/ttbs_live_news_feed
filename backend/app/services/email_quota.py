"""Email sending quota: time buckets + a dispatcher that fills them from the pending outbox.

Exchange Online limits a mailbox to 30 messages/minute, 3,600/hour and 10,000 recipients per
24 hours (values are editable in the UI, minus a safety margin). Sending more blocks the mailbox, so
email never goes straight to a worker. Instead:

1. Buckets. Every email sent (or about to be sent) is counted in `email_send_buckets` under its UTC
   minute. The per-minute, per-hour and per-day usage are the sums over the last 1, 60 and 1,440
   minute buckets: rolling windows, the way Exchange counts. A fixed "reset at midnight" would let
   9,500 go out at 23:00 and 9,500 more at 00:00, which Exchange would see as 19,000 in 24 hours.
2. Dispatcher (`dispatch`, every EMAIL_DISPATCH_INTERVAL_S via beat, and kicked whenever emails are
   queued). Under a lock, it computes the free capacity, takes that many pending emails, oldest
   first (`next_attempt_at, id`, so retries go back in line by due time), counts them in the
   current bucket, and hands each to a worker at an evenly spaced time slot (60 / per-minute
   seconds apart), so the minute limit also holds over any rolling 60 seconds.
3. When a bucket is full, nothing is taken: the emails stay pending and the next turn resumes with
   the oldest pending one. Any backlog (25,000, 100,000...) drains by itself, at the limit, over
   as many windows as it needs. `status()` reports usage, backlog and the ETA.
4. An email the provider did not accept is refunded to the bucket it was counted in. A 429 pauses
   the dispatcher for Retry-After.
"""

import logging
import math
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from app.core import cache
from app.core.timeutil import as_utc, utcnow
from app.db.models import NOTE_PENDING, NOTE_SENDING, EmailSendBucket, Notification
from app.db.session import UnitOfWork, unit_of_work
from app.services import email_config, telemetry

log = logging.getLogger(__name__)

LOCK_EMAIL_DISPATCH = 7_100_003
MINUTE, HOUR, DAY = 1, 60, 1440
KEEP_MINUTES = 2 * DAY  # bucket rows kept for the status page; older rows are pruned
FORECAST_HORIZON_MIN = 60 * DAY  # ETA simulation cap (60 days)
_SLOT_KEY = "email:next_slot"


def minute_key(dt: datetime) -> int:
    return int(as_utc(dt).timestamp()) // 60


def key_start(key: int) -> datetime:
    return datetime.fromtimestamp(key * 60, UTC)


# --- Buckets --------------------------------------------------------------------------------------


def _buckets(uow: UnitOfWork, now_key: int) -> dict[int, int]:
    rows = uow.session.execute(
        select(EmailSendBucket.minute_key, EmailSendBucket.used).where(EmailSendBucket.minute_key > now_key - DAY)
    ).all()
    return {k: u for k, u in rows if u}


def usage(buckets: dict[int, int], now_key: int) -> dict[str, int]:
    return {
        "minute": buckets.get(now_key, 0),
        "hour": sum(u for k, u in buckets.items() if k > now_key - HOUR),
        "day": sum(u for k, u in buckets.items() if k > now_key - DAY),
    }


def capacity(lim: email_config.Limits, used: dict[str, int]) -> int:
    return max(0, min(lim.minute - used["minute"], lim.hour - used["hour"], lim.day - used["day"]))


def _add(uow: UnitOfWork, key: int, n: int) -> None:
    s = uow.session
    if s.execute(update(EmailSendBucket).where(EmailSendBucket.minute_key == key).values(used=EmailSendBucket.used + n)).rowcount:
        return
    try:
        with s.begin_nested():
            s.add(EmailSendBucket(minute_key=key, used=n))
            s.flush()
    except IntegrityError:  # created concurrently (a refund/test send): add to it
        s.execute(update(EmailSendBucket).where(EmailSendBucket.minute_key == key).values(used=EmailSendBucket.used + n))


def refund(uow: UnitOfWork, key: int | None, n: int = 1) -> None:
    if key is None:
        return
    uow.session.execute(
        update(EmailSendBucket).where(EmailSendBucket.minute_key == key, EmailSendBucket.used >= n).values(used=EmailSendBucket.used - n)
    )


def refund_key(key: int) -> None:
    with unit_of_work() as uow:
        refund(uow, key)


def reserve_one(now: datetime | None = None) -> int | None:
    """Count one ad-hoc email (test send) if there is room. Returns its bucket key or None."""
    now = now or utcnow()
    k = minute_key(now)
    with unit_of_work() as uow:
        uow.advisory_lock(LOCK_EMAIL_DISPATCH)
        lim = email_config.limits(email_config.get_row(uow))
        if capacity(lim, usage(_buckets(uow, k), k)) < 1:
            return None
        _add(uow, k, 1)
    return k


def prune(uow: UnitOfWork, now: datetime) -> int:
    return uow.session.execute(delete(EmailSendBucket).where(EmailSendBucket.minute_key < minute_key(now) - KEEP_MINUTES)).rowcount or 0


# --- Dispatcher -----------------------------------------------------------------------------------


def _next_slot(now: datetime) -> float:
    try:
        v = cache.get_redis().get(cache._k(_SLOT_KEY))
        return max(now.timestamp(), float(v)) if v else now.timestamp()
    except Exception:  # noqa: BLE001 - Redis down: the bucket limits still hold
        return now.timestamp()


def _set_next_slot(ts: float) -> None:
    try:
        cache.get_redis().set(cache._k(_SLOT_KEY), str(ts), ex=3600)
    except Exception:  # noqa: BLE001
        pass


def due_filter(now: datetime):
    return (Notification.channel == "email", Notification.status == NOTE_PENDING, Notification.reserved_at.is_(None),
            Notification.next_attempt_at <= now)


def dispatch(now: datetime | None = None, *, horizon_s: float | None = None) -> dict[str, Any]:
    """One turn: fill the free bucket capacity with the oldest due emails and schedule them."""
    from app.core.config import get_settings

    now = now or utcnow()
    horizon = horizon_s if horizon_s is not None else float(get_settings().email_dispatch_interval_s)
    k = minute_key(now)
    with unit_of_work() as uow:
        uow.advisory_lock(LOCK_EMAIL_DISPATCH)
        row = email_config.get_row(uow)
        if row is not None and not row.enabled:
            return {"dispatched": 0, "reason": "disabled"}
        if email_config.paused(row, now):
            return {"dispatched": 0, "reason": "paused", "until": as_utc(row.paused_until).isoformat()}
        lim = email_config.limits(row)
        used = usage(_buckets(uow, k), k)
        free = capacity(lim, used)
        if free == 0:
            return {"dispatched": 0, "reason": "quota", "used": used}
        # Time slots: evenly spaced, continuing where the previous turn stopped, within this turn's horizon.
        spacing = lim.spacing_s
        start = _next_slot(now)
        slots = max(0, math.floor((now.timestamp() + max(horizon, spacing) - start) / spacing))
        n = min(free, slots)
        if n == 0:
            return {"dispatched": 0, "reason": "spacing"}
        q = select(Notification.id).where(*due_filter(now)).order_by(Notification.next_attempt_at, Notification.id).limit(n)
        if uow.supports_skip_locked:
            q = q.with_for_update(skip_locked=True)
        ids = list(uow.session.scalars(q))
        if not ids:
            return {"dispatched": 0, "reason": "empty"}
        plan = [(nid, start - now.timestamp() + i * spacing) for i, nid in enumerate(ids)]
        for nid, delay in plan:
            uow.session.execute(
                update(Notification).where(Notification.id == nid, Notification.status == NOTE_PENDING, Notification.reserved_at.is_(None))
                .values(reserved_at=now, quota_key=k, next_attempt_at=now + timedelta(seconds=delay))
            )
        _add(uow, k, len(ids))
        _set_next_slot(start + len(ids) * spacing)
        telemetry.event(uow, "email.dispatch", telemetry.INFO, actor="system", message=f"Dispatched {len(ids)} emails",
                        dispatched=len(ids), free=free, used_minute=used["minute"] + len(ids), used_hour=used["hour"] + len(ids),
                        used_day=used["day"] + len(ids))
        from app.worker.tasks import send_notification

        uow.after_commit(lambda: [send_notification.apply_async((nid,), countdown=max(0.0, round(d, 2))) for nid, d in plan])
    return {"dispatched": len(ids), "reason": "ok"}


def release_lapsed(uow: UnitOfWork, now: datetime, grace: timedelta = timedelta(minutes=2)) -> int:
    """Reservations whose worker never ran (lost queue message): give them back to the queue."""
    ids = list(uow.session.scalars(
        select(Notification.id).where(Notification.channel == "email", Notification.status == NOTE_PENDING,
                                      Notification.reserved_at.is_not(None), Notification.next_attempt_at <= now - grace).limit(500)
    ))
    if ids:
        uow.session.execute(update(Notification).where(Notification.id.in_(ids)).values(reserved_at=None, quota_key=None, next_attempt_at=now))
    return len(ids)


# --- Status & forecast ----------------------------------------------------------------------------


def forecast(lim: email_config.Limits, buckets: dict[int, int], now_key: int, backlog: int) -> dict[str, Any]:
    """Simulate the drain minute by minute (rolling windows, no new arrivals).
    Returns the minute the next email can go out and when the backlog is done."""
    u = dict(buckets)
    hour = sum(v for k, v in u.items() if k > now_key - HOUR)
    day = sum(v for k, v in u.items() if k > now_key - DAY)
    left, first_free, done_at = backlog, None, (now_key if backlog <= 0 else None)
    for m in range(now_key, now_key + FORECAST_HORIZON_MIN):
        if m > now_key:  # slide the rolling windows forward one minute
            hour -= u.get(m - HOUR, 0)
            day -= u.get(m - DAY, 0)
        room = max(0, min(lim.minute - u.get(m, 0), lim.hour - hour, lim.day - day))
        if room and first_free is None:
            first_free = m
        take = min(room, left)
        if take:
            u[m] = u.get(m, 0) + take
            hour, day, left = hour + take, day + take, left - take
            if left == 0:
                done_at = m + 1
        if first_free is not None and done_at is not None:
            break
    return {"next_free": key_start(first_free) if first_free is not None else None,
            "eta": key_start(done_at) if done_at is not None else None,
            "unscheduled": max(0, left)}


def status(uow: UnitOfWork, now: datetime | None = None) -> dict[str, Any]:
    now = now or utcnow()
    k = minute_key(now)
    row = email_config.get_row(uow)
    lim = email_config.limits(row)
    buckets = _buckets(uow, k)
    used = usage(buckets, k)
    s = uow.session
    base = (Notification.channel == "email",)
    pending = s.scalar(select(func.count(Notification.id)).where(*base, Notification.status == NOTE_PENDING)) or 0
    due = s.scalar(select(func.count(Notification.id)).where(*due_filter(now))) or 0
    reserved = s.scalar(select(func.count(Notification.id)).where(*base, Notification.status == NOTE_PENDING,
                                                                  Notification.reserved_at.is_not(None))) or 0
    sending = s.scalar(select(func.count(Notification.id)).where(*base, Notification.status == NOTE_SENDING)) or 0
    oldest = s.scalar(select(func.min(Notification.created_at)).where(*base, Notification.status == NOTE_PENDING))
    fc = forecast(lim, buckets, k, pending - reserved)
    # Per-hour sends for the last 24 hours (chart on the settings page).
    hourly: dict[int, int] = {}
    for mk, v in buckets.items():
        hourly[(mk * 60) // 3600] = hourly.get((mk * 60) // 3600, 0) + v
    now_hour = int(now.timestamp()) // 3600
    series = [{"hour": datetime.fromtimestamp(h * 3600, UTC).isoformat(), "sent": hourly.get(h, 0)} for h in range(now_hour - 23, now_hour + 1)]
    mode = "console" if row is None else ("disabled" if not row.enabled else ("paused" if email_config.paused(row, now) else "active"))
    return {
        "mode": mode,
        "pausedUntil": as_utc(row.paused_until).isoformat() if row and row.paused_until else None,
        "pauseReason": row.pause_reason if row else None,
        "limits": {"configured": {"minute": lim.configured["per_minute"], "hour": lim.configured["per_hour"], "day": lim.configured["per_day"]},
                   "effective": {"minute": lim.minute, "hour": lim.hour, "day": lim.day},
                   "safetyMarginPct": lim.configured["safety_margin_pct"]},
        "used": used,
        "capacityNow": capacity(lim, used),
        "backlog": {"pending": pending, "due": due, "reserved": reserved, "sending": sending,
                    "oldestQueuedAt": as_utc(oldest).isoformat() if oldest else None},
        "nextFreeAt": fc["next_free"].isoformat() if fc["next_free"] else None,
        "drainEta": fc["eta"].isoformat() if fc["eta"] else None,
        "beyondHorizon": fc["unscheduled"],
        "hourly": series,
        "now": now.isoformat(),
    }


def estimate(uow: UnitOfWork, extra: int, now: datetime | None = None) -> dict[str, Any]:
    """How long `extra` more emails would take behind the current backlog (new-run dialog)."""
    now = now or utcnow()
    k = minute_key(now)
    lim = email_config.limits(email_config.get_row(uow))
    buckets = _buckets(uow, k)
    pending = uow.session.scalar(select(func.count(Notification.id)).where(
        Notification.channel == "email", Notification.status == NOTE_PENDING, Notification.reserved_at.is_(None))) or 0
    fc = forecast(lim, buckets, k, pending + extra)
    used = usage(buckets, k)
    return {"emails": extra, "queuedAhead": pending, "remainingToday": max(0, lim.day - used["day"]),
            "perDay": lim.day, "drainEta": fc["eta"].isoformat() if fc["eta"] else None}
