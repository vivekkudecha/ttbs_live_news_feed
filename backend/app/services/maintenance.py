"""Dispatcher + sweeper, run every `dispatcher_interval_s` by Celery beat.

1. Fire due schedules (create a run per schedule, advance next_run_at).
2. Promote 'scheduled' runs whose time has come to 'queued' and enqueue them.
3. Recover lost work: queue messages can be lost (Redis restart, worker crash). The database is
   the source of truth, so anything that should be moving but is not gets re-enqueued. Every
   task is idempotent, so a duplicate is harmless.
"""

import logging
from datetime import timedelta

from sqlalchemy import select, update

from app.core import cache
from app.core.config import get_settings
from app.core.errors import ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import (
    NOTE_PENDING,
    NOTE_SENDING,
    RES_PENDING,
    RES_RUNNING,
    RUN_QUEUED,
    RUN_RUNNING,
    RUN_SCHEDULED,
    Notification,
    ResearchResult,
    Run,
    Schedule,
)
from app.db.session import UnitOfWork, unit_of_work
from app.services import audit, runs, schedules

log = logging.getLogger(__name__)
BATCH = 500


def _skip_locked(stmt, uow: UnitOfWork):
    return stmt.with_for_update(skip_locked=True) if uow.is_postgres else stmt


def fire_due_schedules() -> list[int]:
    created: list[int] = []
    now = utcnow()
    with unit_of_work() as uow:
        due = uow.session.scalars(
            _skip_locked(select(Schedule).where(Schedule.enabled.is_(True), Schedule.next_run_at <= now).limit(50), uow)
        ).all()
        for sch in due:
            sch.last_run_at = now
            sch.next_run_at = schedules.advance(sch, now)
            try:
                with uow.session.begin_nested():
                    run = runs.create_run(
                        uow, scope_key=sch.scope_key, actor="scheduler", trigger="scheduled",
                        label=f"{sch.name} · {now:%d %b %Y}", channels=sch.channels, template_id=sch.template_id,
                        budget_cap=sch.budget_cap, schedule_id=sch.id,
                    )
                    created.append(run.id)
            except ValidationFailed as e:  # e.g. empty scope: record and move on to the next cycle
                audit.record(uow, "schedule.skip", "schedule", sch.id, {"reason": e.message}, actor="scheduler")
        if due:
            uow.after_commit(lambda: cache.bump("schedules"))
    return created


def promote_scheduled_runs() -> list[int]:
    now = utcnow()
    with unit_of_work() as uow:
        ids = list(uow.session.scalars(
            _skip_locked(select(Run.id).where(Run.status == RUN_SCHEDULED, Run.scheduled_for <= now).limit(BATCH), uow)
        ))
        if ids:
            uow.session.execute(update(Run).where(Run.id.in_(ids), Run.status == RUN_SCHEDULED).values(status=RUN_QUEUED, queued_at=now))
            for rid in ids:
                runs._enqueue_start(uow, rid)
            uow.after_commit(lambda: cache.bump("runs"))
    return ids


def recover_stuck() -> dict[str, int]:
    s_ = get_settings()
    now = utcnow()
    stale = now - timedelta(minutes=s_.stuck_after_minutes)
    stats = {"runs": 0, "results_running": 0, "results_pending": 0, "notifications": 0}
    with unit_of_work() as uow:
        s = uow.session
        # Queued runs nobody started.
        for rid in s.scalars(select(Run.id).where(Run.status == RUN_QUEUED, Run.queued_at <= now - timedelta(minutes=2)).limit(BATCH)):
            runs._enqueue_start(uow, rid)
            stats["runs"] += 1

        # Results a worker claimed but never finished (crash / killed mid-call).
        running = list(s.scalars(
            select(ResearchResult.id).join(Run, Run.id == ResearchResult.run_id)
            .where(Run.status == RUN_RUNNING, ResearchResult.status == RES_RUNNING, ResearchResult.started_at <= stale).limit(BATCH)
        ))
        if running:
            s.execute(update(ResearchResult).where(ResearchResult.id.in_(running), ResearchResult.status == RES_RUNNING)
                      .values(status=RES_PENDING, enqueued_at=now, error="recovered: worker did not finish"))
            runs._enqueue_research(uow, running)
            stats["results_running"] = len(running)

        # Pending results whose queue message was lost.
        pending = list(s.scalars(
            select(ResearchResult.id).join(Run, Run.id == ResearchResult.run_id)
            .where(Run.status == RUN_RUNNING, ResearchResult.status == RES_PENDING, ResearchResult.enqueued_at <= stale).limit(BATCH)
        ))
        if pending:
            s.execute(update(ResearchResult).where(ResearchResult.id.in_(pending)).values(enqueued_at=now))
            runs._enqueue_research(uow, pending)
            stats["results_pending"] = len(pending)

        # Notifications: stuck in 'sending', or pending and due (covers lost messages and backoff retries).
        s.execute(update(Notification).where(Notification.status == NOTE_SENDING, Notification.updated_at <= stale)
                  .values(status=NOTE_PENDING, next_attempt_at=now))
        due = list(s.scalars(
            select(Notification.id)
            .where(Notification.status == NOTE_PENDING, Notification.next_attempt_at <= now - timedelta(seconds=30))
            .limit(BATCH)
        ))
        if due:
            from app.worker.tasks import send_notification

            uow.after_commit(lambda: [send_notification.apply_async((nid,)) for nid in due])
            stats["notifications"] = len(due)
    if any(stats.values()):
        log.warning("sweeper re-enqueued work", extra=stats)
    return stats


def tick() -> dict:
    return {
        "schedules_fired": fire_due_schedules(),
        "runs_promoted": promote_scheduled_runs(),
        "recovered": recover_stuck(),
    }
