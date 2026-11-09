"""Process telemetry: every pipeline step becomes a `process_events` row.

`event(uow, ...)` writes inside the caller's transaction, so a step and its event commit (or roll
back) together: the timeline never shows a step that did not happen. `event_now(...)` is for
steps outside a transaction (e.g. a retry decided after a failed call); it uses its own short
transaction and never raises, because telemetry must not break the pipeline it observes.
"""

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, case, func, select

from app.core.config import get_settings
from app.core.context import actor_var, request_id_var
from app.core.timeutil import as_utc, utcnow
from app.core.tracing import current_trace_id
from app.db.models import AuditLog, ProcessEvent
from app.db.session import UnitOfWork, unit_of_work

log = logging.getLogger(__name__)

OK, RETRY, ERROR, SKIPPED, INFO = "ok", "retry", "error", "skipped", "info"
_FIELDS = {
    "run_id", "import_id", "company_id", "pam_id", "notification_id", "attempt", "duration_ms",
    "provider", "model", "tokens_in", "tokens_out", "cost", "actor",
}


def _build(kind: str, status: str, message: str | None, fields: dict[str, Any]) -> ProcessEvent:
    cols = {k: v for k, v in fields.items() if k in _FIELDS and v is not None}
    attrs = {k: v for k, v in fields.items() if k not in _FIELDS and v is not None}
    return ProcessEvent(
        ts=utcnow(), kind=kind, status=status, message=(message or None) and message[:500],
        actor=cols.pop("actor", None) or actor_var.get(), request_id=request_id_var.get(),
        trace_id=current_trace_id(), attrs=attrs, **cols,
    )


def event(uow: UnitOfWork, kind: str, status: str = OK, message: str | None = None, **fields: Any) -> None:
    if not get_settings().telemetry_events:
        return
    uow.session.add(_build(kind, status, message, fields))


def event_now(kind: str, status: str = OK, message: str | None = None, **fields: Any) -> None:
    if not get_settings().telemetry_events:
        return
    try:
        with unit_of_work() as uow:
            uow.session.add(_build(kind, status, message, fields))
    except Exception:  # noqa: BLE001
        log.warning("telemetry event dropped", extra={"kind": kind}, exc_info=True)


# --- Reads ------------------------------------------------------------------------------------


def event_out(e: ProcessEvent) -> dict[str, Any]:
    return {
        "id": str(e.id), "ts": as_utc(e.ts).isoformat(), "kind": e.kind, "status": e.status, "message": e.message,
        "runId": _s(e.run_id), "importId": _s(e.import_id), "companyId": _s(e.company_id), "pamId": _s(e.pam_id),
        "notificationId": _s(e.notification_id), "attempt": e.attempt, "durationMs": e.duration_ms,
        "provider": e.provider, "model": e.model, "tokensIn": e.tokens_in, "tokensOut": e.tokens_out,
        "cost": e.cost, "actor": e.actor, "requestId": e.request_id, "traceId": e.trace_id, "attrs": e.attrs or {},
    }


def _s(v: int | None) -> str | None:
    return None if v is None else str(v)


def query(uow: UnitOfWork, *, page: int, size: int, kind: str | None = None, status: str | None = None,
          run_id: int | None = None, import_id: int | None = None, company_id: int | None = None,
          since: datetime | None = None, until: datetime | None = None, newest_first: bool = True,
          where: Any = (), order: Any = None) -> dict[str, Any]:
    """`where` / `order`: extra conditions and ORDER BY from a table request (api/listing.py)."""
    conds = list(where)
    if kind:
        conds.append(ProcessEvent.kind.like(f"{kind}%") if kind.endswith(".") else ProcessEvent.kind == kind)
    for col, val in ((ProcessEvent.status, status), (ProcessEvent.run_id, run_id), (ProcessEvent.import_id, import_id),
                     (ProcessEvent.company_id, company_id)):
        if val is not None and val != "":
            conds.append(col == val)
    if since:
        conds.append(ProcessEvent.ts >= since)
    if until:
        conds.append(ProcessEvent.ts < until)
    order = order or [ProcessEvent.id.desc() if newest_first else ProcessEvent.id.asc()]
    rows = uow.session.scalars(select(ProcessEvent).where(*conds).order_by(*order).limit(size).offset(page * size))
    total = uow.session.scalar(select(func.count(ProcessEvent.id)).where(*conds)) or 0
    return {"rows": [event_out(e) for e in rows], "total": total, "page": page, "pageSize": size}


# Steps shown on a run's timeline: lifecycle + per-PAM delivery + anything that went wrong.
# Successful per-company research rows are summarised (minute buckets), not listed one by one.
_TIMELINE_KINDS = ("dataset.", "run.", "notify.", "sweeper.")


def run_timeline(uow: UnitOfWork, run_id: int, import_id: int | None) -> dict[str, Any]:
    s = uow.session
    lifecycle_conds = [ProcessEvent.run_id == run_id]
    milestone = [ProcessEvent.kind.like(f"{k}%") for k in _TIMELINE_KINDS]
    problems = and_(ProcessEvent.kind.like("research.%"), ProcessEvent.status.in_((RETRY, ERROR, SKIPPED)))
    from sqlalchemy import or_

    q = select(ProcessEvent).where(*lifecycle_conds, or_(*milestone, problems)).order_by(ProcessEvent.ts, ProcessEvent.id).limit(2000)
    events = [event_out(e) for e in s.scalars(q)]
    if import_id is not None:  # the upload this run came from: its own steps lead the timeline
        up = s.scalars(
            select(ProcessEvent).where(ProcessEvent.import_id == import_id, ProcessEvent.run_id.is_(None),
                                       ProcessEvent.kind.in_(("dataset.upload", "dataset.saved", "dataset.failed", "dataset.resume")))
            .order_by(ProcessEvent.ts)
        )
        events = [event_out(e) for e in up] + events

    # Research throughput per minute (ok vs failed), for the timeline sparkline.
    buckets: dict[str, dict[str, int]] = defaultdict(lambda: {"ok": 0, "error": 0, "retry": 0, "cached": 0})
    for ts, status, cached in s.execute(
        select(ProcessEvent.ts, ProcessEvent.status, ProcessEvent.attrs["cached"])
        .where(ProcessEvent.run_id == run_id, ProcessEvent.kind == "research.attempt")
    ):
        b = buckets[as_utc(ts).strftime("%Y-%m-%dT%H:%M:00Z")]
        b[status if status in b else "ok"] += 1
        if cached in (True, 1, "true"):
            b["cached"] += 1
    series = [{"minute": k, **v} for k, v in sorted(buckets.items())]

    agg = s.execute(
        select(
            func.count(ProcessEvent.id),
            func.sum(case((ProcessEvent.status == RETRY, 1), else_=0)),
            func.sum(case((ProcessEvent.status == ERROR, 1), else_=0)),
            func.avg(case((ProcessEvent.status == OK, ProcessEvent.duration_ms))),
            func.max(ProcessEvent.duration_ms),
        ).where(ProcessEvent.run_id == run_id, ProcessEvent.kind == "research.attempt")
    ).one()
    return {
        "events": events,
        "throughput": series,
        "research": {"attempts": agg[0] or 0, "retries": int(agg[1] or 0), "errors": int(agg[2] or 0),
                     "avgLatencyMs": round(agg[3]) if agg[3] else None, "maxLatencyMs": agg[4]},
    }


def run_audit(uow: UnitOfWork, run_id: int, page: int, size: int, where: Any = (), order: Any = None) -> dict[str, Any]:
    from app.api.schemas import audit_out

    conds = [AuditLog.run_id == run_id, *where]
    rows = uow.session.scalars(select(AuditLog).where(*conds).order_by(*(order or [AuditLog.id])).limit(size).offset(page * size))
    total = uow.session.scalar(select(func.count(AuditLog.id)).where(*conds)) or 0
    return {"rows": [audit_out(a) for a in rows], "total": total, "page": page, "pageSize": size}


def summary(uow: UnitOfWork, hours: int) -> dict[str, Any]:
    """Telemetry page header: event volume, error rate, research latency percentiles, by kind."""
    since = utcnow() - timedelta(hours=hours)
    s = uow.session
    by_kind = [
        {"kind": k, "total": t, "ok": int(o or 0), "retry": int(r or 0), "error": int(e or 0), "skipped": int(sk or 0),
         "avgMs": round(a) if a else None}
        for k, t, o, r, e, sk, a in s.execute(
            select(
                ProcessEvent.kind, func.count(ProcessEvent.id),
                func.sum(case((ProcessEvent.status == OK, 1), else_=0)),
                func.sum(case((ProcessEvent.status == RETRY, 1), else_=0)),
                func.sum(case((ProcessEvent.status == ERROR, 1), else_=0)),
                func.sum(case((ProcessEvent.status == SKIPPED, 1), else_=0)),
                func.avg(ProcessEvent.duration_ms),
            ).where(ProcessEvent.ts >= since).group_by(ProcessEvent.kind).order_by(func.count(ProcessEvent.id).desc())
        )
    ]
    lat = sorted(d for (d,) in s.execute(
        select(ProcessEvent.duration_ms).where(
            ProcessEvent.ts >= since, ProcessEvent.kind == "research.attempt", ProcessEvent.status == OK,
            ProcessEvent.duration_ms.is_not(None), ProcessEvent.duration_ms > 0,
        ).order_by(ProcessEvent.id.desc()).limit(20000)
    ))

    def pct(p: float) -> int | None:
        return lat[min(len(lat) - 1, int(p * len(lat)))] if lat else None

    # Hourly volume for the chart.
    hourly: dict[str, dict[str, int]] = defaultdict(lambda: {"ok": 0, "problem": 0})
    for ts, status in s.execute(select(ProcessEvent.ts, ProcessEvent.status).where(ProcessEvent.ts >= since)):
        h = hourly[as_utc(ts).strftime("%Y-%m-%dT%H:00:00Z")]
        h["problem" if status in (RETRY, ERROR) else "ok"] += 1
    total = sum(k["total"] for k in by_kind)
    problems = sum(k["retry"] + k["error"] for k in by_kind)
    return {
        "hours": hours,
        "total": total,
        "errors": sum(k["error"] for k in by_kind),
        "retries": sum(k["retry"] for k in by_kind),
        "errorRate": round(problems * 100 / total, 2) if total else 0,
        "research": {"p50Ms": pct(0.5), "p95Ms": pct(0.95), "p99Ms": pct(0.99), "samples": len(lat)},
        "byKind": by_kind,
        "hourly": [{"hour": k, **v} for k, v in sorted(hourly.items())],
        "tracing": bool(get_settings().otel_exporter_otlp_endpoint),
    }
