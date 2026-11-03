"""Recurring schedules: every N days at HH:MM local time."""

import re
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select

from app.core import cache
from app.core.errors import NotFound, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import CHANNELS, Schedule
from app.db.session import UnitOfWork
from app.services import audit
from app.services.runs import scope_count

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValidationFailed(f"Unknown timezone '{name}'") from e


def first_run_at(run_at_time: str, tz_name: str, after: datetime | None = None) -> datetime:
    """Next HH:MM (local) strictly after `after`."""
    after = as_utc(after) or utcnow()
    tz = _tz(tz_name)
    hh, mm = map(int, run_at_time.split(":"))
    local = after.astimezone(tz)
    candidate = datetime.combine(local.date(), time(hh, mm), tzinfo=tz)
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate.astimezone(ZoneInfo("UTC"))


def advance(s: Schedule, now: datetime) -> datetime:
    """Move next_run_at forward by whole intervals until it is in the future (no catch-up storm
    after downtime: missed cycles collapse into one run)."""
    tz = _tz(s.timezone)
    hh, mm = map(int, s.run_at_time.split(":"))
    nxt = as_utc(s.next_run_at)
    while nxt <= now:
        local = nxt.astimezone(tz) + timedelta(days=s.interval_days)
        nxt = datetime.combine(local.date(), time(hh, mm), tzinfo=tz).astimezone(ZoneInfo("UTC"))
    return nxt


def validate(data: dict, uow: UnitOfWork) -> None:
    if "interval_days" in data and not 1 <= int(data["interval_days"]) <= 90:
        raise ValidationFailed("intervalDays must be between 1 and 90")
    if "run_at_time" in data and not _HHMM.match(data["run_at_time"]):
        raise ValidationFailed("runAtTime must be HH:MM (24h)")
    if "timezone" in data:
        _tz(data["timezone"])
    if "channels" in data:
        bad = [c for c in data["channels"] if c not in CHANNELS]
        if bad:
            raise ValidationFailed(f"Unknown channel(s): {', '.join(bad)}")
    if "scope_key" in data:
        scope_count(uow, data["scope_key"])  # raises on unknown scope
    if data.get("budget_cap") is not None and float(data["budget_cap"]) <= 0:
        raise ValidationFailed("budgetCap must be positive")


def create(uow: UnitOfWork, data: dict, actor: str) -> Schedule:
    validate(data, uow)
    s = Schedule(**data, created_by=actor)
    s.next_run_at = as_utc(data.get("next_run_at")) or first_run_at(s.run_at_time, s.timezone)
    uow.session.add(s)
    uow.session.flush()
    detail = {k: v for k, v in data.items() if k != "next_run_at"} | {"next_run_at": s.next_run_at.isoformat()}
    audit.record(uow, "schedule.create", "schedule", s.id, detail, actor=actor)
    uow.after_commit(lambda: cache.bump("schedules"))
    return s


def get(uow: UnitOfWork, schedule_id: int) -> Schedule:
    s = uow.session.get(Schedule, schedule_id)
    if s is None:
        raise NotFound(f"Schedule {schedule_id} not found")
    return s


def update(uow: UnitOfWork, schedule_id: int, data: dict, actor: str) -> Schedule:
    s = get(uow, schedule_id)
    validate(data, uow)
    before = {k: getattr(s, k) for k in data}
    for k, v in data.items():
        setattr(s, k, v)
    timing_changed = any(k in data for k in ("run_at_time", "timezone", "interval_days")) or data.get("enabled") is True
    if timing_changed:
        s.next_run_at = first_run_at(s.run_at_time, s.timezone)
    action = "schedule.update"
    if set(data) == {"enabled"}:
        action = "schedule.enable" if data["enabled"] else "schedule.disable"
    audit.record(uow, action, "schedule", s.id, {"before": before, "after": data}, actor=actor)
    uow.after_commit(lambda: cache.bump("schedules"))
    return s


def list_all(uow: UnitOfWork) -> list[Schedule]:
    return list(uow.session.scalars(select(Schedule).order_by(Schedule.id)))
