"""Run results board: one table for a run's results, PAM groups, digests and per-logo timelines.

Every view filters the same rows, the run's research results (one per logo). The filters are the
top-bar search, the column filters (listing.py syntax, column ids as the UI names them) and the PAM
picker. A view can then be shown three ways:

- `groups`: one row per PAM with counts over the matching logos, its digest delivery, and whether
  the digest is out of date (built before a retry changed the PAM's signals);
- `logos`: the matching logos, flat or for one PAM (the sub-rows of an expanded group);
- `facets`: counts for the top-bar filters (status, category, PAM, digest). Each facet ignores its
  own filter, so its options keep their counts while it is applied.

Writes: retry selected failed logos (by logo or by PAM) and resend selected PAMs' digests (rebuilt
from the current results first; see runs.refresh_payload).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import String, case, cast, func, select, update

from app.api.listing import Col, Listing, Spec, conditions
from app.core import cache
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import (
    NOTE_PENDING,
    NOTE_SENDING,
    NOTE_SKIPPED,
    RES_FAILED,
    RES_NO_SIGNAL,
    RES_PENDING,
    RES_RUNNING,
    RES_SIGNAL,
    RUN_QUEUED,
    RUN_RUNNING,
    RUN_SCHEDULED,
    Company,
    Notification,
    Pam,
    ProcessEvent,
    ResearchResult,
    Run,
)
from app.db.session import UnitOfWork
from app.services import audit, telemetry

MAX_BULK = 1000
STATUS_ORDER = case((ResearchResult.status == RES_SIGNAL, 0), (ResearchResult.status == RES_FAILED, 1),
                    (ResearchResult.status == RES_NO_SIGNAL, 2), else_=3)


def _iso(v: Any) -> str | None:
    return as_utc(v).isoformat() if v else None


def get_run(uow: UnitOfWork, run_id: int) -> Run:
    run = uow.session.get(Run, run_id)
    if run is None:
        raise NotFound(f"Run {run_id} not found")
    return run


def _in_run(run: Run) -> tuple:
    return (ResearchResult.run_id == run.id, ResearchResult.part_month == run.part_month)  # one partition


def _email_status(run: Run) -> Any:
    """The PAM's email digest status for this run ('none' before it is queued), per result row."""
    sub = (select(Notification.status)
           .where(Notification.run_id == run.id, Notification.part_month == run.part_month,
                  Notification.pam_id == ResearchResult.pam_id, Notification.channel == "email")
           .correlate(ResearchResult).limit(1).scalar_subquery())
    return func.coalesce(sub, "none")


def spec(run: Run) -> Spec:
    """Filterable / sortable logo columns (UI column ids)."""
    return {
        "account": Col(Company.name, "text"),
        "pamName": Col(Pam.name, "text"),
        "pam": Col(cast(func.coalesce(ResearchResult.pam_id, 0), String), "enum"),  # ids arrive as strings
        "status": Col(ResearchResult.status, "enum"),
        "category": Col(func.coalesce(ResearchResult.category, "none"), "enum"),
        "findings": Col(ResearchResult.key_signals, "text", sortable=False),
        "digest": Col(_email_status(run), "enum", sortable=False),
        "attempts": Col(ResearchResult.attempts, "range"),
        "cached": Col(ResearchResult.cached, "bool"),
        "industry": Col(Company.industry, "text"),
        "finishedAt": Col(ResearchResult.finished_at, "date"),
    }


def _search(q: str | None) -> list[Any]:
    """Top-bar search: every word must appear in the company or the PAM name."""
    out = []
    for word in (q or "").lower().split()[:6]:
        pat = "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")[:60] + "%"
        out.append(func.lower(Company.name).like(pat, escape="\\") | func.lower(func.coalesce(Pam.name, "")).like(pat, escape="\\"))
    return out


def _where(run: Run, q: str | None, lst: Listing, *, skip: str | None = None) -> list[Any]:
    lst = _normalised(lst)
    return [*_in_run(run), *_search(q), *conditions(spec(run), lst, skip=skip)]


def _normalised(lst: Listing) -> Listing:
    """'pending' in the status filter also covers logos being researched right now."""
    st = lst.filters.get("status")
    if isinstance(st, list) and RES_PENDING in st and RES_RUNNING not in st:
        return Listing(lst.sort, lst.desc, {**lst.filters, "status": [*st, RES_RUNNING]})
    return lst


def _base(stmt: Any) -> Any:
    return stmt.join(Company, Company.id == ResearchResult.company_id).outerjoin(Pam, Pam.id == ResearchResult.pam_id)


# --- Logos ------------------------------------------------------------------------------------------

_LOGO_SORT = {
    "account": Company.name,
    "pamName": Pam.name,
    "status": STATUS_ORDER,
    "category": ResearchResult.category,
    "attempts": ResearchResult.attempts,
    "finishedAt": ResearchResult.finished_at,
}


def logo_out(r: ResearchResult, pam_name: str | None, digest: str) -> dict[str, Any]:
    c = r.company
    return {
        "kind": "logo",
        "id": str(r.id),
        "companyId": str(r.company_id),
        "companyName": c.name,
        "industry": c.industry,
        "segment": c.segment,
        "pamId": str(r.pam_id) if r.pam_id else None,
        "pamName": pam_name,
        "status": r.status,
        "category": r.category,
        "keySignals": r.key_signals,
        "opportunity": r.opportunity,
        "outreach": r.outreach,
        "sources": [s for s in (r.sources or []) if isinstance(s, dict)][:8],
        "attempts": r.attempts,
        "cached": r.cached,
        "error": r.error,
        "finishedAt": _iso(r.finished_at),
        "digest": digest,
    }


def logos(uow: UnitOfWork, run: Run, *, q: str | None, lst: Listing, page: int, size: int, pam_id: int | None = None) -> dict[str, Any]:
    conds = _where(run, q, lst)
    if pam_id is not None:
        conds.append(func.coalesce(ResearchResult.pam_id, 0) == pam_id)
    if lst.sort:
        e = _LOGO_SORT.get(lst.sort)
        if e is None:
            raise ValidationFailed(f"Cannot sort by '{lst.sort}'", details={"field": "sort", "column": lst.sort})
        order = [e.desc() if lst.desc else e.asc(), Company.name.asc(), ResearchResult.id.asc()]
    else:
        order = [STATUS_ORDER, Company.name, ResearchResult.id]
    s = uow.session
    rows = s.execute(_base(select(ResearchResult, Pam.name, _email_status(run))).where(*conds).order_by(*order)
                     .limit(size).offset(page * size)).all()
    total = s.scalar(_base(select(func.count(ResearchResult.id))).where(*conds)) or 0
    return {"rows": [logo_out(r, pn, d) for r, pn, d in rows], "total": total, "page": page, "pageSize": size}


# --- PAM groups ---------------------------------------------------------------------------------------

_n = lambda st: func.sum(case((ResearchResult.status.in_(st), 1), else_=0))  # noqa: E731
_GROUP_COLS = {
    "logos": func.count(ResearchResult.id),
    "signal": _n([RES_SIGNAL]),
    "noSignal": _n([RES_NO_SIGNAL]),
    "failed": _n([RES_FAILED]),
    "pending": _n([RES_PENDING, RES_RUNNING]),
    "finishedAt": func.max(ResearchResult.finished_at),
}
_GROUP_SORT = {
    "account": func.coalesce(func.max(Pam.name), ""),
    "status": _GROUP_COLS["pending"],
    "findings": _GROUP_COLS["signal"],
    "attempts": _GROUP_COLS["failed"],
    "logos": _GROUP_COLS["logos"],
    "finishedAt": _GROUP_COLS["finishedAt"],
}


def groups(uow: UnitOfWork, run: Run, *, q: str | None, lst: Listing, page: int, size: int) -> dict[str, Any]:
    s = uow.session
    conds = _where(run, q, lst)
    pid = func.coalesce(ResearchResult.pam_id, 0).label("pid")
    if lst.sort:
        e = _GROUP_SORT.get(lst.sort)
        if e is None:
            raise ValidationFailed(f"Cannot sort PAMs by '{lst.sort}'", details={"field": "sort", "column": lst.sort})
        order = [e.desc() if lst.desc else e.asc(), pid]
    else:  # PAMs with failures first (they need action), then the most signals, then by name
        order = [(_GROUP_COLS["failed"] > 0).desc(), _GROUP_COLS["signal"].desc(), func.coalesce(func.max(Pam.name), ""), pid]
    stmt = _base(select(pid, *[c.label(k) for k, c in _GROUP_COLS.items()])).where(*conds).group_by(pid)
    rows = s.execute(stmt.order_by(*order).limit(size).offset(page * size)).all()
    total = s.scalar(select(func.count()).select_from(_base(select(pid)).where(*conds).group_by(pid).subquery())) or 0
    ids = [r.pid for r in rows]
    pams = {p.id: p for p in s.scalars(select(Pam).where(Pam.id.in_(ids)))} if ids else {}
    # The PAM's whole share of the run (not just the filtered logos): progress and the digest's freshness.
    whole = {pid_: (n, done, sig) for pid_, n, done, sig in s.execute(
        select(func.coalesce(ResearchResult.pam_id, 0), func.count(ResearchResult.id),
               _n([RES_SIGNAL, RES_NO_SIGNAL, RES_FAILED]), _n([RES_SIGNAL]))
        .where(*_in_run(run), func.coalesce(ResearchResult.pam_id, 0).in_(ids)).group_by(func.coalesce(ResearchResult.pam_id, 0)))}
    notes: dict[int, dict[str, Notification]] = {}
    if ids:
        for n in s.scalars(select(Notification).where(Notification.run_id == run.id, Notification.part_month == run.part_month,
                                                       Notification.pam_id.in_(ids))):
            notes.setdefault(n.pam_id, {})[n.channel] = n
    out = []
    for r in rows:
        p = pams.get(r.pid)
        n_all, done, sig_all = whole.get(r.pid, (0, 0, 0))
        mine = notes.get(r.pid, {})
        out.append({
            "kind": "pam",
            "id": f"pam-{r.pid}",
            "pamId": str(r.pid) if r.pid else None,
            "pamName": p.name if p else "Unassigned",
            "pamEmail": p.email if p else None,
            "logos": r.logos, "signal": int(r.signal or 0), "noSignal": int(r.noSignal or 0), "failed": int(r.failed or 0),
            "pending": int(r.pending or 0), "finishedAt": _iso(r.finishedAt),
            "totalAll": n_all, "doneAll": int(done or 0), "signalAll": int(sig_all or 0),
            "digests": {ch: _digest_out(note, int(sig_all or 0)) for ch, note in mine.items()},
        })
    return {"rows": out, "total": total, "page": page, "pageSize": size}


def _digest_out(n: Notification, signals_now: int) -> dict[str, Any]:
    p = n.payload or {}
    return {"id": str(n.id), "status": n.status, "recipient": n.recipient, "attempts": n.attempts, "lastError": n.last_error,
            "sentAt": _iso(n.sent_at), "signals": p.get("signals"),
            # Built from results that a retry has since changed (e.g. 0 signals while 3 are found now).
            "outdated": p.get("signals") is not None and p.get("signals") != signals_now and n.status not in (NOTE_PENDING, NOTE_SENDING)}


# --- Facets -------------------------------------------------------------------------------------------


def facets(uow: UnitOfWork, run: Run, *, q: str | None, lst: Listing) -> dict[str, Any]:
    s = uow.session
    status = dict(s.execute(_base(select(ResearchResult.status, func.count())).where(*_where(run, q, lst, skip="status"))
                            .group_by(ResearchResult.status)).all())
    status[RES_PENDING] = status.get(RES_PENDING, 0) + status.pop(RES_RUNNING, 0)
    cat = func.coalesce(ResearchResult.category, "none")
    categories = [{"value": c, "count": n} for c, n in s.execute(
        _base(select(cat, func.count())).where(*_where(run, q, lst, skip="category")).group_by(cat).order_by(func.count().desc()))]
    pid = func.coalesce(ResearchResult.pam_id, 0)
    pams = [{"value": str(p), "label": name or "Unassigned", "count": n} for p, name, n in s.execute(
        _base(select(pid, func.max(Pam.name), func.count())).where(*_where(run, q, lst, skip="pam")).group_by(pid)
        .order_by(func.coalesce(func.max(Pam.name), "")))]
    # PAMs per email digest status (counted in Python: MySQL cannot group by the correlated status).
    pids = set(s.scalars(_base(select(pid)).where(*_where(run, q, lst, skip="digest")).group_by(pid)))
    by_pam = dict(s.execute(select(Notification.pam_id, Notification.status).where(
        Notification.run_id == run.id, Notification.part_month == run.part_month, Notification.channel == "email")).all())
    counts: dict[str, int] = {}
    for p in pids:
        st = by_pam.get(p, "none")
        counts[st] = counts.get(st, 0) + 1
    digest = [{"value": d, "count": n} for d, n in sorted(counts.items())]
    return {"status": status, "all": sum(status.values()), "categories": categories, "pams": pams, "digest": digest}


# --- Timeline of one logo -------------------------------------------------------------------------------


def timeline(uow: UnitOfWork, run: Run, result_id: int) -> dict[str, Any]:
    s = uow.session
    row = s.execute(_base(select(ResearchResult, Pam.name, _email_status(run))).where(*_in_run(run), ResearchResult.id == result_id)).first()
    if row is None:
        raise NotFound(f"Result {result_id} not found in run {run.id}")
    r, pam_name, digest = row
    since = run.part_month  # events of this run are never older than the run's month
    ev = s.scalars(
        select(ProcessEvent).where(ProcessEvent.run_id == run.id, ProcessEvent.part_month >= since, ProcessEvent.company_id == r.company_id)
        .order_by(ProcessEvent.ts, ProcessEvent.id).limit(200)
    ).all()
    from app.services.telemetry import event_out

    events = [event_out(e) for e in ev]
    # The run-level steps that touched this logo: the start, manual retries, and its PAM's digest.
    wanted = ProcessEvent.kind.in_(("run.start", "run.retry_failed", "run.retry_selected", "run.finish"))
    if r.pam_id is not None:
        wanted = wanted | ((ProcessEvent.pam_id == r.pam_id) & ProcessEvent.kind.like("notify.%") & ProcessEvent.company_id.is_(None))
    around = s.scalars(
        select(ProcessEvent).where(ProcessEvent.run_id == run.id, ProcessEvent.part_month >= since, wanted)
        .order_by(ProcessEvent.ts, ProcessEvent.id).limit(200)
    ).all()
    events = sorted(events + [event_out(e) for e in around], key=lambda e: (e["ts"], int(e["id"])))

    notes = []
    for n in s.scalars(select(Notification).where(Notification.run_id == run.id, Notification.part_month == run.part_month,
                                                  Notification.pam_id == r.pam_id)) if r.pam_id is not None else []:
        items = [i.get("company") for i in (n.payload or {}).get("items") or []]
        notes.append({"id": str(n.id), "channel": n.channel, "status": n.status, "sentAt": _iso(n.sent_at), "recipient": n.recipient,
                      "lastError": n.last_error, "includesLogo": r.company.name in items, "signals": (n.payload or {}).get("signals")})

    history = [
        {"runId": str(run_id), "label": label, "windowEnd": we.isoformat() if we else None, "status": st, "category": cat,
         "finishedAt": _iso(fin)}
        for run_id, label, we, st, cat, fin in s.execute(
            select(ResearchResult.run_id, Run.label, Run.window_end, ResearchResult.status, ResearchResult.category, ResearchResult.finished_at)
            .join(Run, Run.id == ResearchResult.run_id)
            .where(ResearchResult.company_id == r.company_id, ResearchResult.run_id != run.id)
            .order_by(ResearchResult.run_id.desc()).limit(8)
        )
    ]
    return {
        "logo": logo_out(r, pam_name, digest) | {"enqueuedAt": _iso(r.enqueued_at), "startedAt": _iso(r.started_at),
                                                 "latencyMs": r.latency_ms or None},
        "run": {"id": str(run.id), "label": run.label, "status": run.status,
                "windowStart": run.window_start.isoformat() if run.window_start else None,
                "windowEnd": run.window_end.isoformat() if run.window_end else None},
        "events": events,
        "digests": notes,
        "history": history,
    }


def timeline_for_company(uow: UnitOfWork, run: Run, company_id: int) -> dict[str, Any]:
    """The same timeline, addressed by company (callers that know the logo but not its result row)."""
    rid = uow.session.scalar(select(ResearchResult.id).where(*_in_run(run), ResearchResult.company_id == company_id))
    if rid is None:
        raise NotFound(f"Company {company_id} is not in run {run.id}")
    return timeline(uow, run, rid)


# --- Bulk actions ---------------------------------------------------------------------------------------


def _ids(values: list[str] | None, what: str) -> list[int]:
    out = []
    for v in values or []:
        try:
            out.append(int(v))
        except (TypeError, ValueError) as e:
            raise ValidationFailed(f"Not a {what} id: {v!r}") from e
    if len(out) > MAX_BULK:
        raise ValidationFailed(f"At most {MAX_BULK} {what}s at a time")
    return out


def retry(uow: UnitOfWork, run_id: int, actor: str, result_ids: list[str] | None = None, pam_ids: list[str] | None = None) -> dict[str, int]:
    """Re-research the failed logos among the selection (logos, and/or every logo of the given PAMs)."""
    from app.services import runs

    s = uow.session
    run = get_run(uow, run_id)
    if run.status in (RUN_SCHEDULED, RUN_QUEUED):
        raise Conflict("Run has not started yet")
    rids, pids = _ids(result_ids, "logo"), _ids(pam_ids, "PAM")
    if not rids and not pids:
        raise ValidationFailed("Select logos or PAMs to retry")
    sel = []
    if rids:
        sel.append(ResearchResult.id.in_(rids))
    if pids:
        sel.append(func.coalesce(ResearchResult.pam_id, 0).in_(pids))
    from sqlalchemy import or_

    failed = list(s.scalars(select(ResearchResult.id).where(*_in_run(run), ResearchResult.status == RES_FAILED, or_(*sel))))
    if not failed:
        return {"requeued": 0}
    s.execute(update(ResearchResult).where(ResearchResult.id.in_(failed), ResearchResult.part_month == run.part_month,
                                           ResearchResult.status == RES_FAILED)
              .values(status=RES_PENDING, attempts=0, error=None, enqueued_at=utcnow(), finished_at=None))
    s.execute(update(Run).where(Run.id == run.id).values(status=RUN_RUNNING, finished_at=None, done=Run.done - len(failed),
                                                         failed=Run.failed - len(failed)))
    audit.record(uow, "run.retry_selected", "run", run.id, {"companies": len(failed), "result_ids": failed[:200]}, actor=actor)
    telemetry.event(uow, "run.retry_selected", telemetry.INFO, run_id=run.id, import_id=run.import_id, actor=actor,
                    message=f"Re-queued {len(failed)} failed logos")
    runs._enqueue_research(uow, failed)
    uow.after_commit(lambda: cache.bump("runs", f"run:{run.id}"))
    return {"requeued": len(failed)}


def resend(uow: UnitOfWork, run_id: int, actor: str, pam_ids: list[str], channel: str | None = None) -> dict[str, int]:
    """Resend the selected PAMs' digests, rebuilt from the current results. Rows already queued or
    being sent, and rows without a recipient, are left as they are (counted in `skipped`)."""
    from app.services import notifications

    s = uow.session
    run = get_run(uow, run_id)
    pids = _ids(pam_ids, "PAM")
    if not pids:
        raise ValidationFailed("Select PAMs to resend")
    conds = [Notification.run_id == run.id, Notification.part_month == run.part_month, Notification.pam_id.in_(pids)]
    if channel:
        conds.append(Notification.channel == channel)
    sent = skipped = 0
    for note in list(s.scalars(select(Notification).where(*conds))):
        if note.status in (NOTE_PENDING, NOTE_SENDING) or (note.status == NOTE_SKIPPED and not note.recipient):
            skipped += 1
            continue
        notifications.resend(uow, note.id, actor)
        sent += 1
    return {"requeued": sent, "skipped": skipped}


def digest_preview(uow: UnitOfWork, run: Run, pam_id: int) -> dict[str, Any]:
    """The PAM's email digest: as sent when it went out, otherwise rendered now from the current results
    with the active template (the AI summary is written only when it is really sent)."""
    from app.services import email_templates, runs

    s = uow.session
    note = s.scalars(select(Notification).where(Notification.run_id == run.id, Notification.part_month == run.part_month,
                                                Notification.pam_id == pam_id, Notification.channel == "email")).first()
    if note is not None and note.rendered and note.status == "sent":
        r = note.rendered
        return {"subject": r.get("subject"), "html": r.get("html"), "text": r.get("text"), "asSent": True, "sentAt": _iso(note.sent_at),
                "status": note.status, "recipient": note.recipient}
    pam, signals, payload = runs.pam_digest(uow, run, pam_id)
    if pam is None:
        raise NotFound("PAM not found")
    tpl = email_templates.snapshot(email_templates.active(uow))
    ai = "[The AI summary is written when the email is sent.]" if tpl.get("ai_enabled") else ""
    out = email_templates.render(tpl, email_templates.context(payload, ai))
    return out | {"asSent": False, "sentAt": None, "status": note.status if note else "none",
                  "recipient": note.recipient if note else pam.email}
