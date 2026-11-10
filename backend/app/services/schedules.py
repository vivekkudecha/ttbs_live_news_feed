"""Recurring research schedules.

A schedule is a repeat rule plus what to run. When it is due, the dispatcher (maintenance.tick,
every `dispatcher_interval_s`) creates an ordinary run through `runs.create_run`, so budget caps,
provider checks, partitions, audit and live progress work exactly as for a run started by hand.

Rules of the road:
- Fire at most once per due time. If the dispatcher was down, missed times are skipped, not
  replayed: the schedule resumes at its next future time.
- Never overlap: if the run created last time is still active, this firing is skipped.
- A firing that cannot start (budget reached, no AI provider, upload gone) is recorded on the
  schedule (`last_outcome` / `last_error`) and in telemetry; the schedule keeps its cadence.
- One-time "run at" jobs are not schedules: they are runs in status `scheduled` (runs.create_run).
"""

from __future__ import annotations

import calendar
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select, update

from app.core import cache
from app.core.errors import AppError, NotFound, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import RUN_ACTIVE, ImportBatch, Run, Schedule
from app.db.session import UnitOfWork, unit_of_work
from app.services import audit, runs, soft_delete, telemetry

log = logging.getLogger(__name__)

FREQUENCIES = ("interval", "weekly", "monthly")
LATEST = "latest"  # scope_key: the newest saved upload at firing time
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
BATCH = 100


# --- Repeat rule ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    frequency: str = "interval"
    interval_days: int = 10
    weekdays: tuple[int, ...] = field(default_factory=tuple)
    month_day: int | None = None
    run_at_time: str = "06:00"
    timezone: str = "Asia/Kolkata"
    ends_on: date | None = None

    @classmethod
    def of(cls, s: Schedule) -> Rule:
        return cls(s.frequency or "interval", s.interval_days, tuple(s.weekdays or ()), s.month_day,
                   s.run_at_time, s.timezone, s.ends_on)

    def validate(self) -> Rule:
        if self.frequency not in FREQUENCIES:
            raise ValidationFailed(f"Repeat must be one of: {', '.join(FREQUENCIES)}")
        if self.frequency == "interval" and not 1 <= self.interval_days <= 365:
            raise ValidationFailed("Repeat every 1 to 365 days")
        if self.frequency == "weekly" and (not self.weekdays or any(not 0 <= d <= 6 for d in self.weekdays)):
            raise ValidationFailed("Pick at least one day of the week")
        if self.frequency == "monthly" and not (self.month_day and 1 <= self.month_day <= 31):
            raise ValidationFailed("Pick a day of the month (1–31)")
        try:
            hh, mm = (int(x) for x in self.run_at_time.split(":"))
            time(hh, mm)
        except (ValueError, TypeError):
            raise ValidationFailed("Time must be HH:MM (24-hour)") from None
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValidationFailed(f"Unknown time zone '{self.timezone}'") from None
        return self

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    def _at(self, day: date) -> datetime:
        hh, mm = (int(x) for x in self.run_at_time.split(":"))
        return datetime.combine(day, time(hh, mm), self.tz)

    def next_after(self, after: datetime, prev: datetime | None = None) -> datetime | None:
        """First fire time strictly after `after` (UTC), or None once past `ends_on`.
        `prev` (the time it last fired for) keeps every-N-days on its own cadence."""
        after = as_utc(after)
        today = after.astimezone(self.tz).date()
        if self.frequency == "interval":
            if prev is not None:
                day = as_utc(prev).astimezone(self.tz).date()
                step = timedelta(days=self.interval_days)
                day += step
                while self._at(day) <= after:  # missed while down: skip ahead, never replay
                    day += step
            else:
                day = today if self._at(today) > after else today + timedelta(days=1)
            found = self._at(day)
        elif self.frequency == "weekly":
            day = today
            while day.weekday() not in self.weekdays or self._at(day) <= after:
                day += timedelta(days=1)
            found = self._at(day)
        else:  # monthly
            y, m = today.year, today.month
            while True:
                d = date(y, m, min(self.month_day or 1, calendar.monthrange(y, m)[1]))
                if self._at(d) > after:
                    found = self._at(d)
                    break
                y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        if self.ends_on and found.date() > self.ends_on:
            return None
        return found.astimezone(ZoneInfo("UTC"))

    def upcoming(self, n: int = 5, after: datetime | None = None) -> list[datetime]:
        out: list[datetime] = []
        t = self.next_after(after or utcnow())
        while t and len(out) < n:
            out.append(t)
            t = self.next_after(t, prev=t)
        return out

    def describe(self) -> str:
        """'Every 10 days at 06:00', 'Weekly on Mon, Thu at 09:30', 'Monthly on day 1 at 06:00'."""
        if self.frequency == "interval":
            what = "Every day" if self.interval_days == 1 else f"Every {self.interval_days} days"
        elif self.frequency == "weekly":
            what = "Weekly on " + ", ".join(DAY_NAMES[d] for d in sorted(self.weekdays))
        else:
            what = "Monthly on the last day" if self.month_day == 31 else f"Monthly on day {self.month_day}"
        until = f", until {self.ends_on:%d %b %Y}" if self.ends_on else ""
        return f"{what} at {self.run_at_time}{until}"


# --- Target ---------------------------------------------------------------------------------------


def _latest_upload_id(uow: UnitOfWork) -> int | None:
    return uow.session.scalar(
        select(ImportBatch.id).where(ImportBatch.status.in_(runs.SAVED_STATUSES)).order_by(ImportBatch.id.desc()).limit(1)
    )


def _check_target(uow: UnitOfWork, scope_key: str) -> str:
    if scope_key == LATEST:
        return scope_key
    batch = uow.session.get(ImportBatch, runs.import_id_of(scope_key))
    if batch is None or batch.status not in runs.SAVED_STATUSES:
        raise ValidationFailed("Pick a saved upload, or 'latest upload'", code="upload_required")
    return f"import:{batch.id}"


def target_label(uow: UnitOfWork, scope_key: str) -> str:
    if scope_key == LATEST:
        return "Latest upload"
    if not scope_key.startswith("import:"):
        return "—"  # schedules from before every run started from an upload
    batch = uow.session.get(ImportBatch, runs.import_id_of(scope_key))
    return runs.dataset_label(batch) if batch else "Upload removed"


# --- CRUD -----------------------------------------------------------------------------------------

EDITABLE = ("name", "frequency", "interval_days", "weekdays", "month_day", "run_at_time", "timezone", "ends_on",
            "scope_key", "channels", "enabled")
RULE_FIELDS = {"frequency", "interval_days", "weekdays", "month_day", "run_at_time", "timezone", "ends_on"}


def _first_fire(rule: Rule) -> datetime:
    first = rule.next_after(utcnow())
    if first is None:
        raise ValidationFailed("The end date is before the first run")
    return first


def _clean_channels(channels: list[str]) -> list[str]:
    channels = list(dict.fromkeys(channels))
    bad = [c for c in channels if c not in runs.CHANNELS]
    if bad:
        raise ValidationFailed(f"Unknown channel(s): {', '.join(bad)}")
    return channels


def create(uow: UnitOfWork, data: dict[str, Any], actor: str) -> Schedule:
    rule = Rule(**{k: data[k] for k in RULE_FIELDS if k in data}).validate()
    s = Schedule(
        name=data["name"].strip()[:200], frequency=rule.frequency, interval_days=rule.interval_days,
        weekdays=sorted(set(rule.weekdays)), month_day=rule.month_day, run_at_time=rule.run_at_time,
        timezone=rule.timezone, ends_on=rule.ends_on, scope_key=_check_target(uow, data["scope_key"]),
        channels=_clean_channels(data.get("channels", list(runs.CHANNELS))), enabled=data.get("enabled", True),
        next_run_at=_first_fire(rule), created_by=actor,
    )
    uow.session.add(s)
    uow.session.flush()
    audit.record(uow, "schedule.create", "schedule", s.id, out(uow, s), actor=actor)
    return s


def update_schedule(uow: UnitOfWork, schedule_id: int, data: dict[str, Any], actor: str) -> Schedule:
    s = get(uow, schedule_id)
    before = out(uow, s)
    changes = {k: v for k, v in data.items() if k in EDITABLE}
    if "scope_key" in changes:
        changes["scope_key"] = _check_target(uow, changes["scope_key"])
    if "channels" in changes:
        changes["channels"] = _clean_channels(changes["channels"])
    if "weekdays" in changes:
        changes["weekdays"] = sorted(set(changes["weekdays"]))
    if "name" in changes:
        changes["name"] = changes["name"].strip()[:200]
    for k, v in changes.items():
        setattr(s, k, v)
    resumed = changes.get("enabled") is True and not before["enabled"]
    if RULE_FIELDS & changes.keys() or resumed:  # new rule, or back from a pause: count from now
        rule = Rule.of(s).validate()
        if s.enabled:
            s.next_run_at = _first_fire(rule)
    audit.record(uow, "schedule.update", "schedule", s.id, {"before": before, "changes": sorted(changes)}, actor=actor)
    return s


def delete(uow: UnitOfWork, schedule_id: int, actor: str) -> None:
    """Archive the schedule (nothing is hard-deleted). Its past runs stay, detached from it."""
    s = get(uow, schedule_id)
    detail = out(uow, s)
    uow.session.execute(update(Run).where(Run.schedule_id == s.id).values(schedule_id=None))
    soft_delete.archive(uow, Schedule, Schedule.id == s.id, actor=actor, reason="schedule deleted", record_audit=False)
    audit.record(uow, "schedule.delete", "schedule", schedule_id, detail, actor=actor)
    uow.after_commit(lambda: cache.bump("runs"))


def get(uow: UnitOfWork, schedule_id: int) -> Schedule:
    s = uow.session.get(Schedule, schedule_id)
    if s is None:
        raise NotFound(f"Schedule {schedule_id} not found")
    return s


# --- Firing ---------------------------------------------------------------------------------------


def _start(uow: UnitOfWork, s: Schedule, actor: str) -> Run:
    """Create this schedule's run now. Raises AppError (before writing anything) if it cannot start."""
    import_id = _latest_upload_id(uow) if s.scope_key == LATEST else runs.import_id_of(s.scope_key)
    if not import_id:
        raise ValidationFailed("No saved upload to research", code="upload_required")
    when = utcnow().astimezone(ZoneInfo(s.timezone))
    return runs.create_run(
        uow, import_id=import_id, actor=actor, trigger="scheduled", schedule_id=s.id,
        label=f"{s.name} · {when:%d %b %Y}", channels=list(s.channels or []), template_id=s.template_id,
        budget_cap=s.budget_cap,
    )


def run_now(uow: UnitOfWork, schedule_id: int, actor: str) -> Run:
    """Start the schedule's job immediately, by hand. Its regular cadence is unchanged."""
    s = get(uow, schedule_id)
    run = _start(uow, s, actor)
    s.last_run_at, s.last_run_id, s.last_outcome, s.last_error = utcnow(), run.id, "started", None
    return run


def _fire(uow: UnitOfWork, s: Schedule, now: datetime) -> str:
    due = as_utc(s.next_run_at)
    last = uow.session.get(Run, s.last_run_id) if s.last_run_id else None
    try:
        if last is not None and last.status in RUN_ACTIVE:
            outcome, error = "skipped", f"Run #{last.id} from the previous time is still {last.status}"
        else:
            run = _start(uow, s, actor="scheduler")
            s.last_run_id, outcome, error = run.id, "started", None
    except AppError as e:  # nothing was written for the run; record why and keep the cadence
        outcome, error = "failed", str(e)
    s.last_run_at, s.last_outcome, s.last_error = now, outcome, (error or None) and error[:500]
    nxt = Rule.of(s).next_after(now, prev=due)
    if nxt is None:  # past its end date
        s.enabled = False
    else:
        s.next_run_at = nxt
    status = {"started": telemetry.OK, "skipped": telemetry.SKIPPED, "failed": telemetry.ERROR}[outcome]
    telemetry.event(uow, f"schedule.{outcome}", status, error or f"Started run #{s.last_run_id}", actor="scheduler",
                    schedule_id=s.id, run_id=s.last_run_id if outcome == "started" else None)
    if outcome != "started":
        audit.record(uow, f"schedule.{outcome}", "schedule", s.id, {"name": s.name, "reason": error}, actor="scheduler")
    return outcome


def fire_due() -> dict[str, int]:
    """Called by the dispatcher tick. One transaction per schedule, so one failure never blocks others."""
    now = utcnow()
    with unit_of_work() as uow:
        ids = list(uow.session.scalars(
            select(Schedule.id).where(Schedule.enabled.is_(True), Schedule.next_run_at <= now).order_by(Schedule.next_run_at).limit(BATCH)
        ))
    counts = {"started": 0, "skipped": 0, "failed": 0}
    for sid in ids:
        with unit_of_work() as uow:
            stmt = select(Schedule).where(Schedule.id == sid, Schedule.enabled.is_(True), Schedule.next_run_at <= now)
            s = uow.session.scalar(stmt.with_for_update(skip_locked=True) if uow.supports_skip_locked else stmt)
            if s is None:  # another dispatcher took it, or it was paused meanwhile
                continue
            counts[_fire(uow, s, now)] += 1
    if ids:
        log.info("schedules fired", extra=counts)
    return counts


# --- Read model -----------------------------------------------------------------------------------


def out(uow: UnitOfWork, s: Schedule, last_run: Run | None = None, runs_count: int | None = None) -> dict[str, Any]:
    rule = Rule.of(s)
    return {
        "id": str(s.id),
        "name": s.name,
        "frequency": rule.frequency,
        "intervalDays": s.interval_days,
        "weekdays": list(s.weekdays or []),
        "monthDay": s.month_day,
        "runAtTime": s.run_at_time,
        "timezone": s.timezone,
        "endsOn": s.ends_on.isoformat() if s.ends_on else None,
        "summary": rule.describe(),
        "target": "latest" if s.scope_key == LATEST else "upload",
        "importId": str(runs.import_id_of(s.scope_key)) if s.scope_key.startswith("import:") else None,
        "targetLabel": target_label(uow, s.scope_key),
        "channels": list(s.channels or []),
        "enabled": s.enabled,
        "nextRunAt": as_utc(s.next_run_at).isoformat() if s.enabled else None,
        "lastRunAt": as_utc(s.last_run_at).isoformat() if s.last_run_at else None,
        "lastOutcome": s.last_outcome,
        "lastError": s.last_error,
        "lastRun": {"id": str(last_run.id), "status": last_run.status} if last_run else None,
        "createdBy": s.created_by,
        "runs": runs_count if runs_count is not None else _run_counts(uow).get(s.id, 0),
    }


def _run_counts(uow: UnitOfWork) -> dict[int | None, int]:
    """Runs per schedule id (None = runs no schedule started)."""
    return dict(uow.session.execute(select(Run.schedule_id, func.count(Run.id)).group_by(Run.schedule_id)).all())


def listing(uow: UnitOfWork) -> dict[str, Any]:
    """Every schedule (with its run count and latest run), plus how many runs no schedule started."""
    rows = list(uow.session.scalars(select(Schedule).order_by(Schedule.enabled.desc(), Schedule.next_run_at)))
    last = {r.id: r for r in uow.session.scalars(select(Run).where(Run.id.in_([s.last_run_id for s in rows if s.last_run_id])))}
    counts = _run_counts(uow)
    return {"rows": [out(uow, s, last.get(s.last_run_id), counts.get(s.id, 0)) for s in rows], "unscheduled": counts.get(None, 0)}


def detail(uow: UnitOfWork, schedule_id: int) -> dict[str, Any]:
    s = get(uow, schedule_id)
    upcoming = [t.isoformat() for t in Rule.of(s).upcoming(5)] if s.enabled else []
    return out(uow, s, uow.session.get(Run, s.last_run_id) if s.last_run_id else None) | {"upcoming": upcoming}


RECENT = 20  # runs shown in the per-run chart


def stats(uow: UnitOfWork, schedule_id: int | None) -> dict[str, Any]:
    """The schedule page's dashboard: totals over all its runs, runs per status, and its latest
    runs (oldest first) for the chart. `schedule_id` None = runs no schedule started."""
    if schedule_id is not None:
        get(uow, schedule_id)
    mine = Run.schedule_id == schedule_id if schedule_id is not None else Run.schedule_id.is_(None)
    runs_, logos, signals, failed, cost, cached = uow.session.execute(
        select(func.count(Run.id), func.sum(Run.done), func.sum(Run.with_signal), func.sum(Run.failed), func.sum(Run.cost), func.sum(Run.cache_hits))
        .where(mine)
    ).one()
    by_status = dict(uow.session.execute(select(Run.status, func.count(Run.id)).where(mine).group_by(Run.status)).all())
    recent = list(uow.session.scalars(select(Run).where(mine).order_by(Run.id.desc()).limit(RECENT)))[::-1]
    took = [(as_utc(r.finished_at) - as_utc(r.started_at)).total_seconds() for r in recent if r.started_at and r.finished_at]
    return {
        "totals": {"runs": runs_ or 0, "logos": logos or 0, "signals": signals or 0, "failed": failed or 0,
                   "cost": round(cost or 0.0, 4), "cacheHits": cached or 0,
                   "avgDurationS": round(sum(took) / len(took)) if took else None},
        "byStatus": by_status,
        "recent": [{"id": str(r.id), "label": r.label, "status": r.status, "at": (as_utc(r.started_at or r.scheduled_for)).isoformat(),
                    "logos": r.total, "done": r.done, "signals": r.with_signal, "failed": r.failed, "cost": round(r.cost, 4)}
                   for r in recent],
    }

