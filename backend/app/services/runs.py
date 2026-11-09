"""Run lifecycle: create (now or later) → start (materialise one result row per company) →
research each company → finalise. Every state change is a conditional UPDATE, so duplicate or
re-delivered queue messages are harmless (at-least-once delivery, exactly-once effect).

Every run researches exactly one upload: the logos in that Excel/CSV, delivered to the PAMs the
upload mapped them to. Re-running an older upload uses that upload's own logo → PAM mapping.
Each step writes an audit row (compliance), a process event (telemetry) and, where money is
spent, a cost-ledger row (FinOps), all in the step's own transaction.
"""

import logging
from datetime import timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased

from app.core import cache, metrics
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ProviderError, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import (
    CHANNELS,
    IMPORT_COMPLETED,
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
    Company,
    DatasetCompany,
    ImportBatch,
    Notification,
    Pam,
    ResearchResult,
    Run,
)
from app.db.session import UnitOfWork
from app.services import audit, finops, research_prompts, telemetry

log = logging.getLogger(__name__)
EST_COST_PER_COMPANY = 0.0125
SAVED_STATUSES = (IMPORT_COMPLETED, "committed")  # "committed": uploads from before datasets existed

# --- Scopes ---------------------------------------------------------------------------------
# A run's scope is always "import:<id>". Older keys ("all", "segment:…", "pam:…") only appear
# on historical runs and are kept for their labels.


def import_id_of(scope_key: str | None) -> int:
    kind, _, value = (scope_key or "").partition(":")
    if kind != "import" or not value.isdigit():
        raise ValidationFailed(
            "Every research run starts from an uploaded Excel/CSV file. Upload a file, or pick an earlier upload to re-run.",
            code="upload_required", details={"scope": scope_key},
        )
    return int(value)


def _members(import_id: int):
    """(company_id, pam_id, uploaded_pam_id) for an upload. pam_id is the upload's own PAM while
    that PAM is active; if the PAM has left (deactivated, logos rebalanced) it is the logo's
    current owner, so results still reach someone."""
    up_pam = aliased(Pam)
    pam = case((up_pam.active.is_(True), DatasetCompany.pam_id), else_=Company.pam_id)
    return (
        select(DatasetCompany.company_id, pam.label("pam_id"), DatasetCompany.pam_id.label("uploaded_pam_id"))
        .join(Company, Company.id == DatasetCompany.company_id)
        .outerjoin(up_pam, up_pam.id == DatasetCompany.pam_id)
        .where(DatasetCompany.import_id == import_id, Company.active.is_(True))
    )


def dataset_label(b: ImportBatch) -> str:
    """'Nov logos · 03 Nov 2026, 14:20' (IST)."""
    ts = as_utc(b.created_at).astimezone(ZoneInfo(get_settings().timezone))
    return f"{b.label or b.file_name} · {ts:%d %b %Y, %H:%M}"


def scope_count(uow: UnitOfWork, scope_key: str) -> int:
    members = _members(import_id_of(scope_key)).subquery()
    return uow.session.scalar(select(func.count()).select_from(members).where(members.c.pam_id.is_not(None))) or 0


def scope_label(uow: UnitOfWork, scope_key: str) -> str:
    """Display label for any scope key, including the retired ones on historical runs."""
    if scope_key == "all":
        return "All active companies"
    kind, _, value = scope_key.partition(":")
    if kind == "segment":
        return f"Segment = {value}"
    if kind == "pam":
        p = uow.session.get(Pam, int(value)) if value.isdigit() else None
        return f"PAM = {p.name if p else value}"
    if kind == "import":
        b = uow.session.get(ImportBatch, int(value)) if value.isdigit() else None
        return dataset_label(b) if b else f"Upload {value}"
    return scope_key


def scope_options(uow: UnitOfWork) -> list[dict[str, Any]]:
    """Uploads a run can use (saved ones, newest first) with how often each has been run."""
    s = uow.session
    batches = list(s.scalars(select(ImportBatch).where(ImportBatch.status.in_(SAVED_STATUSES)).order_by(ImportBatch.id.desc()).limit(100)))
    if not batches:
        return []
    stats = {
        iid: (n, last) for iid, n, last in s.execute(
            select(Run.import_id, func.count(Run.id), func.max(Run.created_at))
            .where(Run.import_id.in_([b.id for b in batches])).group_by(Run.import_id)
        )
    }
    out = []
    for b in batches:
        n, last = stats.get(b.id, (0, None))
        out.append({"key": f"import:{b.id}", "label": dataset_label(b), "count": scope_count(uow, f"import:{b.id}"),
                    "runs": n, "lastRunAt": as_utc(last).isoformat() if last else None})
    return out


# --- Create ---------------------------------------------------------------------------------


def create_run(
    uow: UnitOfWork,
    *,
    scope_key: str | None = None,
    actor: str,
    trigger: str = "adhoc",
    label: str | None = None,
    run_at=None,
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
    import_id = import_id or import_id_of(scope_key)
    scope_key = f"import:{import_id}"
    batch = uow.session.get(ImportBatch, import_id)
    if batch is None:
        raise ValidationFailed(f"Upload {import_id} not found", code="upload_required")
    if batch.status not in SAVED_STATUSES:
        raise Conflict(f"Upload '{batch.label}' is still being saved ({batch.status}). Start the run once it is saved.")
    count = scope_count(uow, scope_key)
    if count == 0:
        raise ValidationFailed("This upload has no active logos with a PAM", details={"scope": scope_key})
    now = utcnow()
    run_at = as_utc(run_at) or now
    if run_at < now - timedelta(minutes=1):
        raise ValidationFailed("Run time is in the past")
    estimate = round(count * EST_COST_PER_COMPANY, 2)
    budget = finops.check_budget(uow, estimate)  # raises at the monthly hard cap
    try:
        provider = get_provider(uow)
    except ProviderError as e:  # no key/model saved: refuse up front instead of failing every company
        raise ValidationFailed(str(e), code="provider_not_configured") from e
    previous = uow.session.scalar(select(func.count(Run.id)).where(Run.import_id == import_id)) or 0
    if trigger == "adhoc":
        trigger = "rerun" if previous else "upload"
    starts_now = run_at <= now + timedelta(seconds=5)
    run = Run(
        label=(label or f"{batch.label or batch.file_name} · run {previous + 1}")[:300],
        trigger=trigger,
        schedule_id=schedule_id,
        import_id=import_id,
        scope_key=scope_key,
        template_id=template_id,
        channels=channels,
        budget_cap=budget_cap,
        status=RUN_QUEUED if starts_now else RUN_SCHEDULED,
        scheduled_for=run_at,
        queued_at=now if starts_now else None,
        provider=provider.key,
        model=provider.model,
        triggered_by=actor,
        total=count,  # estimate; fixed when the run starts
    )
    uow.session.add(run)
    uow.session.flush()
    audit.record(
        uow, "run.queue" if starts_now else "run.schedule", "run", run.id,
        {"label": run.label, "upload_id": import_id, "upload": batch.label, "trigger": trigger, "companies": count,
         "scheduled_for": run_at.isoformat(), "channels": channels, "provider": provider.key, "model": provider.model,
         "estimated_cost": estimate, "month_spend": budget["spent"], "monthly_budget": budget["budget"]},
        actor=actor,
    )
    telemetry.event(
        uow, "run.queued" if starts_now else "run.scheduled", run_id=run.id, import_id=import_id, actor=actor,
        provider=provider.key, model=provider.model, cost=estimate,
        message=f"{count} logos from '{batch.label}'" + ("" if starts_now else f", starts {run_at.isoformat()}"),
        trigger=trigger, companies=count, budget=budget,
    )
    uow.after_commit(lambda: cache.bump("runs", "imports"))
    if starts_now:
        _enqueue_start(uow, run.id)
    log.info("run created", extra={"run_id": run.id, "status": run.status, "companies": count, "import_id": import_id})
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
    # Pin the active research prompt: editing it mid-run never mixes two prompts in one run.
    prompt = research_prompts.spec_for(uow, None)
    run.prompt_version = prompt.version
    run.window_end = now.astimezone(ZoneInfo(settings.timezone)).date()
    run.window_start = run.window_end - timedelta(days=prompt.window_days)

    import_id = run.import_id or import_id_of(run.scope_key)
    members = [(cid, pid, up) for cid, pid, up in s.execute(_members(import_id)) if pid is not None]
    s.bulk_insert_mappings(
        ResearchResult,
        [{"run_id": run_id, "company_id": cid, "pam_id": pid, "status": RES_PENDING, "enqueued_at": now, "sources": []}
         for cid, pid, _ in members],
    )
    run.total = len(members)
    pams = len({pid for _, pid, _ in members})
    rerouted = sum(1 for _, pid, up in members if up is not None and pid != up)
    if run.total == 0:
        run.status, run.finished_at, run.error = RUN_COMPLETED, now, "The upload had no active logos when the run started"
    s.flush()
    audit.record(uow, "run.start", "run", run_id,
                 {"companies": run.total, "pams": pams, "window": f"{run.window_start}..{run.window_end}", "promptVersion": run.prompt_version,
                  "rerouted_to_current_owner": rerouted}, actor="system")
    telemetry.event(
        uow, "run.start", run_id=run_id, import_id=import_id, actor="system", provider=run.provider, model=run.model,
        message=f"{run.total} logos across {pams} PAMs, window {run.window_start} to {run.window_end}"
        + (f"; {rerouted} logos go to their current owner (uploaded PAM is inactive)" if rerouted else ""),
        companies=run.total, pams=pams, rerouted=rerouted,
    )
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


def complete_result(uow: UnitOfWork, result_id: int, values: dict[str, Any], *, event_status: str | None = None) -> None:
    """Persist a terminal result, bump run counters atomically, then fire per-PAM / run completion.
    The cost-ledger row and the telemetry event commit in this same transaction."""
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
    run = s.get(Run, res.run_id)
    finops.record_research(uow, res, run, values)
    ev_status = event_status or (telemetry.ERROR if status == RES_FAILED else telemetry.OK)
    cached = bool(values.get("cached"))  # a cache hit spends no tokens (values carry the original answer's usage)
    telemetry.event(
        uow, "research.attempt", ev_status, run_id=res.run_id, import_id=run.import_id, company_id=res.company_id,
        pam_id=res.pam_id, attempt=res.attempts, duration_ms=values.get("latency_ms"), provider=run.provider,
        model=run.model, tokens_in=None if cached else values.get("tokens_in"),
        tokens_out=None if cached else values.get("tokens_out"), cost=values.get("cost"),
        message=values.get("error") if status == RES_FAILED else None, outcome=status,
        cached=True if values.get("cached") else None, category=values.get("category"),
    )
    metrics.RESEARCH_ATTEMPTS.labels(run.provider, run.model, "cached" if values.get("cached") else ev_status).inc()
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
    if not won:
        return
    uow.session.refresh(run)
    audit.record(
        uow, "run.finish", "run", run.id,
        {"status": final, "companies": run.total, "signals": run.with_signal, "failed": run.failed,
         "cache_hits": run.cache_hits, "cost": round(run.cost, 4)},
        actor="system",
    )
    took = (as_utc(run.finished_at) - as_utc(run.started_at)).total_seconds() if run.started_at and run.finished_at else None
    telemetry.event(
        uow, "run.finish",
        telemetry.OK if final == RUN_COMPLETED else telemetry.ERROR if final == RUN_FAILED else telemetry.INFO,
        run_id=run.id, import_id=run.import_id, actor="system", provider=run.provider, model=run.model,
        cost=round(run.cost, 4), duration_ms=int(took * 1000) if took is not None else None,
        # Spend stays in the event's `cost` field (FinOps); the message shown in the UI carries no amounts.
        message=f"{final}: {run.with_signal} signals, {run.failed} failed, {run.cache_hits} from cache",
        final=final, signals=run.with_signal, failed=run.failed, cache_hits=run.cache_hits,
    )
    metrics.RUNS_FINISHED.labels(final).inc()
    if took is not None:
        metrics.RUN_DURATION.observe(took)
    log.info("run finished", extra={"run_id": run.id, "status": final})


# --- Notifications (outbox) -----------------------------------------------------------------


def maybe_queue_pam_digest(uow: UnitOfWork, run: Run, pam_id: int) -> list[int]:
    """When a PAM's last company in this run is done, write one outbox row per channel.
    Every row (queued or skipped) is audited and recorded as a telemetry event."""
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
    from app.services import email_config  # delivery policy is set in the UI

    email_policy = email_config.policy(email_config.get_row(uow))
    created: list[int] = []
    email_ids: list[int] = []
    for channel in run.channels or []:
        recipient, reason = _recipient(pam, channel)
        status = NOTE_PENDING
        if reason:
            status = NOTE_SKIPPED
        elif not signals and not (channel == "email" and email_policy.send_when_no_signals):
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
            if channel == "email":
                email_ids.append(note.id)
        else:
            audit.record(uow, "notify.skipped", "notification", note.id,
                         {"pam_id": pam_id, "channel": channel, "reason": reason}, actor="system", run_id=run.id)
        telemetry.event(
            uow, "notify.queued" if status == NOTE_PENDING else "notify.skipped",
            telemetry.OK if status == NOTE_PENDING else telemetry.SKIPPED,
            run_id=run.id, import_id=run.import_id, pam_id=pam_id, notification_id=note.id, actor="system",
            message=reason, channel=channel, signals=len(signals), total=total,
        )
    if created:
        audit.record(uow, "notify.queue", "run", run.id, {"pam_id": pam_id, "notifications": created}, actor="system")
        from app.worker.tasks import dispatch_email, send_notification

        # Email waits for the quota dispatcher (sending limits); other channels go straight out.
        direct = [nid for nid in created if nid not in email_ids]
        uow.after_commit(lambda: [send_notification.apply_async((nid,)) for nid in direct])
        if email_ids:
            uow.after_commit(lambda: dispatch_email.apply_async())
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
        # Structured snapshot for email templates (rendered at send time from this, not from live rows).
        "pam": {"id": pam.id if pam else None, "name": name, "email": pam.email if pam else None},
        "run": {"id": run.id, "label": run.label, "window_start": str(run.window_start), "window_end": str(run.window_end)},
        "items": [
            {"company": r.company.name, "category": r.category, "key_signals": r.key_signals, "opportunity": r.opportunity,
             "outreach": r.outreach, "sources": [s for s in (r.sources or []) if isinstance(s, dict)][:5]}
            for r in signals
        ],
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
    telemetry.event(uow, "run.cancel", telemetry.INFO, run_id=run_id, import_id=run.import_id, actor=actor,
                    message=f"Cancelled at {run.done}/{run.total} logos")
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
    telemetry.event(uow, "run.retry_failed", telemetry.INFO, run_id=run_id, import_id=run.import_id, actor=actor,
                    message=f"Re-queued {len(failed_ids)} failed logos")
    _enqueue_research(uow, failed_ids)
    uow.after_commit(lambda: cache.bump("runs", f"run:{run_id}"))
    return len(failed_ids)


__all__ = [
    "RES_NO_SIGNAL", "RES_FAILED", "RES_SIGNAL", "create_run", "start", "claim_result", "complete_result",
    "release_for_retry", "cancel", "retry_failed", "scope_options", "scope_label", "import_id_of", "get_run",
]
