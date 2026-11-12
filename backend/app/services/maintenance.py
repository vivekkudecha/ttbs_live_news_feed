"""Dispatcher + sweeper, run every `dispatcher_interval_s` by Celery beat.

1. Promote 'scheduled' runs (an upload set to run at a later time) whose time has come, and fire
   recurring schedules that are due (services/schedules.py: each firing creates a normal run).
2. Recover lost work: queue messages can be lost (Redis restart, worker crash). The database is
   the source of truth, so anything that should be moving but is not gets re-enqueued. Every
   task is idempotent, so a duplicate is harmless. Each recovery is a telemetry event.
"""

import logging
from datetime import timedelta

from sqlalchemy import select, update

from app.core import cache, metrics
from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.db.models import (
    NOTE_PENDING,
    NOTE_SENDING,
    RES_FAILED,
    RES_PENDING,
    RES_RUNNING,
    RUN_FAILED,
    RUN_PARTIAL,
    RUN_QUEUED,
    RUN_RUNNING,
    RUN_SCHEDULED,
    Notification,
    ResearchResult,
    Run,
)
from app.db.session import UnitOfWork, unit_of_work
from app.services import runs, schedules, telemetry

log = logging.getLogger(__name__)
BATCH = 500


def _skip_locked(stmt, uow: UnitOfWork):
    return stmt.with_for_update(skip_locked=True) if uow.supports_skip_locked else stmt


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
                telemetry.event(uow, "run.queued", run_id=rid, actor="scheduler", message="Scheduled time reached")
            uow.after_commit(lambda: cache.bump("runs"))
    return ids


def recover_stuck() -> dict[str, int]:
    s_ = get_settings()
    now = utcnow()
    stale = now - timedelta(minutes=s_.stuck_after_minutes)
    stats = {"runs": 0, "results_running": 0, "results_pending": 0, "notifications": 0, "imports": 0, "file_checks": 0,
             "previews_discarded": 0}
    with unit_of_work() as uow:
        s = uow.session
        # Dataset uploads whose worker died or whose queue message was lost: resume from the cursor.
        from app.services import imports

        stuck_imports = imports.stalled(uow)
        if stuck_imports:
            from app.worker.tasks import process_import

            uow.after_commit(lambda: [process_import.apply_async((i,)) for i in stuck_imports])
            stats["imports"] = len(stuck_imports)
        # File checks whose worker vanished restart from the top (a check writes nothing but its result).
        stuck_checks = imports.stalled_checks(uow)
        if stuck_checks:
            from app.worker.tasks import analyze_import

            uow.after_commit(lambda: [analyze_import.apply_async((i,)) for i in stuck_checks])
            stats["file_checks"] = len(stuck_checks)
        # Checked files nobody saved: drop them (and their files) after IMPORT_PREVIEW_TTL_HOURS.
        stats["previews_discarded"] = imports.discard_stale_previews(uow)

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

        # Pending results whose queue message was lost: only in runs that stopped making progress. A
        # rate-limited run drains its queue slowly but steadily (its updated_at moves with every logo).
        pending = list(s.scalars(
            select(ResearchResult.id).join(Run, Run.id == ResearchResult.run_id)
            .where(Run.status == RUN_RUNNING, Run.updated_at <= stale, ResearchResult.status == RES_PENDING,
                   ResearchResult.enqueued_at <= stale).limit(BATCH)
        ))
        if pending:
            s.execute(update(ResearchResult).where(ResearchResult.id.in_(pending)).values(enqueued_at=now))
            runs._enqueue_research(uow, pending)
            stats["results_pending"] = len(pending)

        # Notifications: stuck in 'sending', or pending and due (covers lost messages and backoff retries).
        # A stuck email also loses its quota reservation, so the dispatcher hands it out again.
        s.execute(update(Notification).where(Notification.status == NOTE_SENDING, Notification.updated_at <= stale)
                  .values(status=NOTE_PENDING, next_attempt_at=now, reserved_at=None, quota_key=None))
        due = list(s.scalars(
            select(Notification.id)
            .where(Notification.channel != "email", Notification.status == NOTE_PENDING,
                   Notification.next_attempt_at <= now - timedelta(seconds=30))
            .limit(BATCH)
        ))
        if due:
            from app.worker.tasks import send_notification

            uow.after_commit(lambda: [send_notification.apply_async((nid,)) for nid in due])
        # Email is owned by the quota dispatcher: release reservations whose worker never ran, then kick it.
        from app.services import email_quota

        lapsed = email_quota.release_lapsed(uow, now)
        stats["notifications"] = len(due) + lapsed
        email_due = s.scalar(select(Notification.id).where(*email_quota.due_filter(now)).limit(1))
        if lapsed or email_due:
            from app.worker.tasks import dispatch_email

            uow.after_commit(lambda: dispatch_email.apply_async())
        email_quota.prune(uow, now)
    if any(stats.values()):
        log.warning("sweeper re-enqueued work", extra=stats)
        for what, n in stats.items():
            if n:
                metrics.SWEEPER_RECOVERED.labels(what).inc(n)
        telemetry.event_now("sweeper.recovered", telemetry.RETRY, actor="system",
                            message=", ".join(f"{n} {k.replace('_', ' ')}" for k, n in stats.items() if n), **stats)
    return stats


def recover_failed_runs() -> list[int]:
    """Runs whose automatic recovery round is due (runs._plan_recovery): re-research the logos that
    failed only because their retries ran out. Each round is one more chance; the run re-finishes and
    plans the next round itself while rounds remain."""
    from app.services import run_board

    done: list[int] = []
    with unit_of_work() as uow:
        s = uow.session
        due = _skip_locked(select(Run).where(Run.recover_at.is_not(None), Run.recover_at <= utcnow()).limit(BATCH), uow)
        for run in s.scalars(due):
            run.recover_at = None
            if run.status not in (RUN_PARTIAL, RUN_FAILED):
                continue  # retried by hand meanwhile, or cancelled
            ids = [str(i) for i in s.scalars(select(ResearchResult.id).where(
                ResearchResult.run_id == run.id, ResearchResult.part_month == run.part_month,
                ResearchResult.status == RES_FAILED, ResearchResult.error.like(f"{runs.RETRY_EXHAUSTED}%")))]
            if ids:
                run.recovery_round += 1
                s.flush()
                run_board.retry(uow, run.id, "system", result_ids=ids)
                done.append(run.id)
    return done


def tick() -> dict:
    return {
        "runs_promoted": promote_scheduled_runs(),
        "schedules_fired": schedules.fire_due(),
        "recovered": recover_stuck(),
        "runs_auto_retried": recover_failed_runs(),
    }
