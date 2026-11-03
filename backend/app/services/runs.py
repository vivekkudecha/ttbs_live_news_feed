"""Run lifecycle: create (now or later) → start (materialise one result row per company) →
research each company → finalise. Every state change is a conditional UPDATE, so duplicate or
re-delivered queue messages are harmless (at-least-once delivery, exactly-once effect)."""

import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, select, update
from sqlalchemy.exc import IntegrityError

from app.core import cache
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ProviderError, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import (
    CHANNELS,
    NOTE_PENDING,
    NOTE_SKIPPED,
    RES_FAILED,
    RES_NO_SIGNAL,
    RES_PENDING,
    RES_RUNNING,
    RES_SIGNAL,
    RES_TERMINAL,
    RUN_ACTIVE,
    RUN_CANCELLED,
    RUN_COMPLETED,
    RUN_FAILED,
    RUN_PARTIAL,
    RUN_QUEUED,
    RUN_RUNNING,
    RUN_SCHEDULED,
    SEGMENTS,
    Company,
    DatasetCompany,
    ImportBatch,
    Notification,
    Pam,
    ResearchResult,
    Run,
)
from app.db.session import UnitOfWork
from app.services import audit

log = logging.getLogger(__name__)
EST_COST_PER_COMPANY = 0.0125

# --- Scopes ---------------------------------------------------------------------------------


def _scope_filter(scope_key: str):
    base = and_(Company.active.is_(True), Company.pam_id.is_not(None))
    if scope_key == "all":
        return base
    kind, _, value = scope_key.partition(":")
    if kind == "segment" and value in SEGMENTS:
        return and_(base, Company.segment == value)
    if kind == "pam" and value.isdigit():
        return and_(base, Company.pam_id == int(value))
    if kind == "import" and value.isdigit():  # an uploaded dataset: its member companies
        return and_(base, Company.id.in_(select(DatasetCompany.company_id).where(DatasetCompany.import_id == int(value))))
    raise ValidationFailed(f"Unknown scope '{scope_key}'", details={"scope": scope_key})


def dataset_label(b: ImportBatch) -> str:
    """'Nov logos · 03 Nov 2026, 14:20' (IST)."""
    from zoneinfo import ZoneInfo

    from app.core.config import get_settings
    from app.core.timeutil import as_utc

    ts = as_utc(b.created_at).astimezone(ZoneInfo(get_settings().timezone))
    return f"{b.label or b.file_name} · {ts:%d %b %Y, %H:%M}"


def scope_count(uow: UnitOfWork, scope_key: str) -> int:
    return uow.session.scalar(select(func.count(Company.id)).where(_scope_filter(scope_key))) or 0


def scope_label(uow: UnitOfWork, scope_key: str) -> str:
    if scope_key == "all":
        return "All active companies"
    kind, _, value = scope_key.partition(":")
    if kind == "segment":
        return f"Segment = {value}"
    if kind == "pam":
        p = uow.session.get(Pam, int(value))
        return f"PAM = {p.name if p else value}"
    if kind == "import":
        b = uow.session.get(ImportBatch, int(value))
        return dataset_label(b) if b else f"Dataset {value}"
    return scope_key


def scope_options(uow: UnitOfWork) -> list[dict[str, Any]]:
    """What a run or schedule can cover: every company, or one saved dataset (newest first)."""
    s = uow.session
    opts = [{"key": "all", "label": "All active companies", "count": scope_count(uow, "all")}]
    for b in s.scalars(select(ImportBatch).where(ImportBatch.status.in_(["completed", "committed"])).order_by(ImportBatch.id.desc()).limit(100)):
        opts.append({"key": f"import:{b.id}", "label": dataset_label(b), "count": scope_count(uow, f"import:{b.id}")})
    return opts


# --- Create ---------------------------------------------------------------------------------


def create_run(
    uow: UnitOfWork,
    *,
    scope_key: str,
    actor: str,
    trigger: str = "adhoc",
    label: str | None = None,
    run_at: datetime | None = None,
    channels: list[str] | None = None,
    template_id: str = "t1",
    budget_cap: float | None = None,
    schedule_id: int | None = None,
    import_id: int | None = None,
) -> Run:
    from app.research.providers import get_provider  # avoid import cycle at module load

    channels = list(dict.fromkeys(channels if channels is not None else CHANNELS))
    bad = [c for c in channels if c not in CHANNELS]
    if bad:
        raise ValidationFailed(f"Unknown channel(s): {', '.join(bad)}")
    count = scope_count(uow, scope_key)
    if count == 0:
        raise ValidationFailed("No active companies with a PAM in this scope", details={"scope": scope_key})
    now = utcnow()
    run_at = as_utc(run_at) or now
    if run_at < now - timedelta(minutes=1):
        raise ValidationFailed("Run time is in the past")
    try:
        provider = get_provider(uow)
    except ProviderError as e:  # no key/model saved: refuse up front instead of failing every company
        raise ValidationFailed(str(e), code="provider_not_configured") from e
    run = Run(
        label=(label or f"{trigger.capitalize()}: {scope_label(uow, scope_key)}")[:300],
        trigger=trigger,
        schedule_id=schedule_id,
        import_id=import_id,
        scope_key=scope_key,
        template_id=template_id,
        channels=channels,
        budget_cap=budget_cap,
        status=RUN_QUEUED if run_at <= now + timedelta(seconds=5) else RUN_SCHEDULED,
        scheduled_for=run_at,
        queued_at=now if run_at <= now + timedelta(seconds=5) else None,
        provider=provider.key,
        model=provider.model,
        triggered_by=actor,
        total=count,  # estimate; fixed when the run starts
    )
    uow.session.add(run)
    uow.session.flush()
    audit.record(
        uow, "run.schedule" if run.status == RUN_SCHEDULED else "run.queue", "run", run.id,
        {"label": run.label, "scope": scope_key, "companies": count, "scheduled_for": run_at.isoformat(), "channels": channels,
         "provider": provider.key, "estimated_cost": round(count * EST_COST_PER_COMPANY, 2)},
        actor=actor,
    )
    uow.after_commit(lambda: cache.bump("runs"))
    if run.status == RUN_QUEUED:
        _enqueue_start(uow, run.id)
    log.info("run created", extra={"run_id": run.id, "status": run.status, "companies": count})
    return run


def _enqueue_start(uow: UnitOfWork, run_id: int) -> None:
    from app.worker.tasks import start_run

    uow.after_commit(lambda: start_run.apply_async((run_id,), task_id=f"start-run-{run_id}-{int(utcnow().timestamp())}"))


def _enqueue_research(uow: UnitOfWork, result_ids: list[int], countdown: float = 0) -> None:
    from app.worker.tasks import research_company

    def go() -> None:
        for rid in result_ids:
            research_company.apply_async((rid,), countdown=countdown)

    uow.after_commit(go)


# --- Start ----------------------------------------------------------------------------------


def start(uow: UnitOfWork, run_id: int) -> bool:
    """Materialise result rows and fan out research tasks. Idempotent: only one caller wins."""
    s = uow.session
    now = utcnow()
    won = s.execute(
        update(Run).where(Run.id == run_id, Run.status == RUN_QUEUED).values(status=RUN_RUNNING, started_at=now)
    ).rowcount
    if not won:
        log.info("start_run: run not in queued state; skipping", extra={"run_id": run_id})
        return False
    run = s.get(Run, run_id)
    settings = get_settings()
    tz = ZoneInfo(settings.timezone)
    run.window_end = now.astimezone(tz).date()
    run.window_start = run.window_end - timedelta(days=settings.research_window_days)

    company_rows = s.execute(select(Company.id, Company.pam_id).where(_scope_filter(run.scope_key))).all()
    s.bulk_insert_mappings(
        ResearchResult,
        [{"run_id": run_id, "company_id": cid, "pam_id": pid, "status": RES_PENDING, "enqueued_at": now, "sources": []}
         for cid, pid in company_rows],
    )
    run.total = len(company_rows)
    if run.total == 0:
        run.status, run.finished_at, run.error = RUN_COMPLETED, now, "Scope was empty when the run started"
    s.flush()
    audit.record(uow, "run.start", "run", run_id, {"companies": run.total, "window": f"{run.window_start}..{run.window_end}"}, actor="system")
    ids = list(s.scalars(select(ResearchResult.id).where(ResearchResult.run_id == run_id)))
    _enqueue_research(uow, ids)
    uow.after_commit(lambda: cache.bump("runs"))
    return True


# --- Research one company -------------------------------------------------------------------


def claim_result(uow: UnitOfWork, result_id: int) -> ResearchResult | None:
    """pending → running. Returns None if another worker has it, it is done, or the run stopped."""
    s = uow.session
    res = s.get(ResearchResult, result_id)
    if res is None:
        return None
    run = s.get(Run, res.run_id)
    if run is None or run.status != RUN_RUNNING:
        return None
    won = s.execute(
        update(ResearchResult)
        .where(ResearchResult.id == result_id, ResearchResult.status == RES_PENDING)
        .values(status=RES_RUNNING, started_at=utcnow(), attempts=ResearchResult.attempts + 1)
    ).rowcount
    if not won:
        return None
    s.refresh(res)
    return res


def complete_result(uow: UnitOfWork, result_id: int, values: dict[str, Any]) -> None:
    """Persist a terminal result, bump run counters atomically, then fire per-PAM / run completion."""
    s = uow.session
    status = values["status"]
    assert status in RES_TERMINAL
    updated = s.execute(
        update(ResearchResult)
        .where(ResearchResult.id == result_id, ResearchResult.status == RES_RUNNING)
        .values(**values, finished_at=utcnow())
    ).rowcount
    if not updated:
        return
    res = s.get(ResearchResult, result_id)
    # Row lock on the run serialises concurrent completions, so the counts below are exact.
    s.execute(
        update(Run)
        .where(Run.id == res.run_id)
        .values(
            done=Run.done + 1,
            with_signal=Run.with_signal + (1 if status == RES_SIGNAL else 0),
            failed=Run.failed + (1 if status == RES_FAILED else 0),
            cache_hits=Run.cache_hits + (1 if values.get("cached") else 0),
            cost=Run.cost + float(values.get("cost") or 0.0),
        )
    )
    run = s.get(Run, res.run_id)
    s.refresh(run)
    if res.pam_id is not None:
        maybe_queue_pam_digest(uow, run, res.pam_id)
    if run.done >= run.total:
        finalize(uow, run)
    uow.after_commit(lambda: cache.bump("runs", f"run:{run.id}"))


def release_for_retry(uow: UnitOfWork, result_id: int, error: str) -> None:
    uow.session.execute(
        update(ResearchResult)
        .where(ResearchResult.id == result_id, ResearchResult.status == RES_RUNNING)
        .values(status=RES_PENDING, error=error[:1000], enqueued_at=utcnow())
    )


def finalize(uow: UnitOfWork, run: Run) -> None:
    if run.failed == 0:
        final = RUN_COMPLETED
    elif run.failed >= run.total:
        final = RUN_FAILED
    else:
        final = RUN_PARTIAL
    won = uow.session.execute(
        update(Run).where(Run.id == run.id, Run.status == RUN_RUNNING).values(status=final, finished_at=utcnow())
    ).rowcount
    if won:
        uow.session.refresh(run)
        audit.record(
            uow, "run.finish", "run", run.id,
            {"status": final, "companies": run.total, "signals": run.with_signal, "failed": run.failed,
             "cache_hits": run.cache_hits, "cost": round(run.cost, 4)},
            actor="system",
        )
        log.info("run finished", extra={"run_id": run.id, "status": final})


# --- Notifications (outbox) -----------------------------------------------------------------


def maybe_queue_pam_digest(uow: UnitOfWork, run: Run, pam_id: int) -> list[int]:
    """When a PAM's last company in this run is done, write one outbox row per channel."""
    s = uow.session
    open_count = s.scalar(
        select(func.count(ResearchResult.id)).where(
            ResearchResult.run_id == run.id, ResearchResult.pam_id == pam_id, ResearchResult.status.not_in(RES_TERMINAL)
        )
    )
    if open_count:
        return []
    pam = s.get(Pam, pam_id)
    signals = s.scalars(
        select(ResearchResult).where(
            ResearchResult.run_id == run.id, ResearchResult.pam_id == pam_id, ResearchResult.status == RES_SIGNAL
        ).order_by(ResearchResult.id)
    ).all()
    total = s.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.run_id == run.id, ResearchResult.pam_id == pam_id))
    payload = build_digest(run, pam, signals, total or 0)
    created: list[int] = []
    for channel in run.channels or []:
        recipient, reason = _recipient(pam, channel)
        status = NOTE_PENDING
        if reason:
            status = NOTE_SKIPPED
        elif not signals:
            status, reason = NOTE_SKIPPED, "no signals for this PAM in this run"
        note = Notification(
            run_id=run.id, pam_id=pam_id, channel=channel, recipient=recipient, status=status,
            last_error=reason, payload=payload, next_attempt_at=utcnow() if status == NOTE_PENDING else None,
        )
        try:
            with s.begin_nested():  # unique (run, pam, channel): a duplicate trigger is a no-op
                s.add(note)
                s.flush()
        except IntegrityError:
            continue
        if status == NOTE_PENDING:
            created.append(note.id)
    if created:
        audit.record(uow, "notify.queue", "run", run.id, {"pam_id": pam_id, "notifications": created}, actor="system")
        from app.worker.tasks import send_notification

        ids = list(created)
        uow.after_commit(lambda: [send_notification.apply_async((nid,)) for nid in ids])
    return created


def _recipient(pam: Pam | None, channel: str) -> tuple[str | None, str | None]:
    if pam is None or not pam.active:
        return None, "PAM inactive"
    if channel == "email":
        return (pam.email, None) if pam.notify_email else (pam.email, "PAM opted out of email")
    if channel == "whatsapp":
        if not pam.whatsapp:
            return None, "no WhatsApp number"
        return (pam.whatsapp, None) if pam.notify_whatsapp else (pam.whatsapp, "PAM opted out of WhatsApp")
    return None, f"unknown channel {channel}"


def build_digest(run: Run, pam: Pam | None, signals: list[ResearchResult], total: int) -> dict[str, Any]:
    name = pam.name if pam else "PAM"
    lines = [f"Hi {name},", "", f"{len(signals)} of your {total} accounts have TTBS-relevant signals "
             f"({run.window_start} to {run.window_end}).", ""]
    for r in signals:
        lines += [f"■ {r.company.name}" + (f" [{r.category}]" if r.category else ""),
                  f"  Signals: {r.key_signals or '-'}",
                  f"  Opportunity: {r.opportunity or '-'}",
                  f"  Outreach: {r.outreach or '-'}", ""]
    return {
        "subject": f"TTBS signals: {len(signals)} accounts need attention ({run.window_end})",
        "body": "\n".join(lines),
        "signals": len(signals),
        "total": total,
    }


# --- Operator actions -----------------------------------------------------------------------


def get_run(uow: UnitOfWork, run_id: int) -> Run:
    run = uow.session.get(Run, run_id)
    if run is None:
        raise NotFound(f"Run {run_id} not found")
    return run


def cancel(uow: UnitOfWork, run_id: int, actor: str) -> Run:
    run = get_run(uow, run_id)
    if run.status not in RUN_ACTIVE:
        raise Conflict(f"Run {run_id} is already {run.status}")
    uow.session.execute(update(Run).where(Run.id == run_id).values(status=RUN_CANCELLED, finished_at=utcnow()))
    uow.session.refresh(run)
    audit.record(uow, "run.cancel", "run", run_id, {"done": run.done, "total": run.total}, actor=actor)
    uow.after_commit(lambda: cache.bump("runs", f"run:{run_id}"))
    return run


def retry_failed(uow: UnitOfWork, run_id: int, actor: str) -> int:
    s = uow.session
    run = get_run(uow, run_id)
    if run.status in (RUN_SCHEDULED, RUN_QUEUED, RUN_RUNNING):
        raise Conflict("Run is still in progress")
    failed_ids = list(s.scalars(select(ResearchResult.id).where(ResearchResult.run_id == run_id, ResearchResult.status == RES_FAILED)))
    if not failed_ids:
        raise Conflict("Run has no failed companies to retry")
    now = utcnow()
    s.execute(
        update(ResearchResult)
        .where(ResearchResult.id.in_(failed_ids))
        .values(status=RES_PENDING, attempts=0, error=None, enqueued_at=now, finished_at=None)
    )
    s.execute(
        update(Run).where(Run.id == run_id).values(
            status=RUN_RUNNING, finished_at=None, done=Run.done - len(failed_ids), failed=Run.failed - len(failed_ids)
        )
    )
    audit.record(uow, "run.retry_failed", "run", run_id, {"companies": len(failed_ids)}, actor=actor)
    _enqueue_research(uow, failed_ids)
    uow.after_commit(lambda: cache.bump("runs", f"run:{run_id}"))
    return len(failed_ids)


__all__ = [
    "RES_NO_SIGNAL", "RES_FAILED", "RES_SIGNAL", "create_run", "start", "claim_result", "complete_result",
    "release_for_retry", "cancel", "retry_failed", "scope_options", "get_run",
]
