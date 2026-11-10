"""Read models for the UI pages (dashboard, signals, companies, PAMs, digest, live grid, FinOps).

Each function returns exactly the JSON shape in frontend/src/api/types.ts, computed from the
database. Lists are filtered, sorted and paged server-side; per-row aggregates are fetched in
bulk (no N+1 queries).
"""

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, or_, select

from app.api import schemas as sch
from app.core.config import get_settings
from app.core.errors import NotFound
from app.core.timeutil import utcnow
from app.db.models import (
    RES_FAILED,
    RES_SIGNAL,
    RES_TERMINAL,
    RUN_COMPLETED,
    RUN_PARTIAL,
    RUN_RUNNING,
    Company,
    CompanyAssignment,
    DatasetCompany,
    Notification,
    Pam,
    ResearchResult,
    Run,
)
from app.db.session import UnitOfWork
from app.research.prompts import PROMPT_VERSION
from app.services import accounts, runs
from app.services import finops as finops_svc

# Which signal to act on first (same weights the UI used).
CAT_WEIGHT = {"Contract": 6, "Funding": 5, "Cybersecurity": 5, "Expansion": 4, "Leadership": 3, "Digital": 3}
CODE = {"pending": 0, "running": 0, "signal": 1, "no_signal": 2, "failed": 3}
PROVIDER_LABEL = {"perplexity": "Perplexity", "gemini": "Google Gemini", "fake": "Offline (fake)"}
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_PAREN_URL = re.compile(r"\(\s*https?://[^)]*\)")
_URL = re.compile(r"https?://\S+")


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _aware(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; everything is stored in UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _tokens(q: str | None) -> list[str]:
    return [t for t in (q or "").lower().split() if t]


def _ui_status(s: str) -> str:
    return "pending" if s in ("pending", "running") else s


def plain(text: str | None, limit: int = 240) -> str:
    """Markdown-free one-liner for previews: no URLs, no bold markers."""
    if not text:
        return ""
    t = _URL.sub("", _PAREN_URL.sub("", text)).replace("**", "")
    t = re.sub(r"\s+", " ", t).strip(" .;-")
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"


def offerings(text: str | None) -> list[str]:
    out: list[str] = []
    for m in _BOLD.findall(text or ""):
        m = m.strip()
        if m and len(m) <= 40 and m not in out:
            out.append(m)
    return out[:4]


def result_ui(r: ResearchResult) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "runId": str(r.run_id),
        "companyId": str(r.company_id),
        "pamId": str(r.pam_id) if r.pam_id else "",
        "status": _ui_status(r.status),
        "category": r.category,
        "keySignals": r.key_signals,
        "opportunity": r.opportunity,
        "outreach": r.outreach,
        "sources": r.sources or [],
        "offerings": offerings(r.opportunity),
        "tokensIn": r.tokens_in,
        "tokensOut": r.tokens_out,
        "cost": round(r.cost or 0, 4),
        "latencyMs": r.latency_ms,
        "cached": r.cached,
        "error": r.error,
    }


def _page(rows: list[Any], page: int, size: int) -> dict[str, Any]:
    page, size = max(page, 0), max(1, min(size, get_settings().max_page_size))
    return {"rows": rows[page * size: (page + 1) * size], "total": len(rows), "page": page, "pageSize": size}


# --- Runs -------------------------------------------------------------------------------------


@dataclass
class Agg:
    total: int = 0
    done: int = 0
    signal: int = 0
    failed: int = 0


def _run_months(uow: UnitOfWork, run_ids: list[int]) -> list[int]:
    """The monthly partitions these runs' jobs live in (lets MySQL prune every other month)."""
    return sorted(set(uow.session.scalars(select(Run.part_month).where(Run.id.in_(run_ids)))))


def in_run(run: Run, model: Any = ResearchResult) -> tuple:
    """Conditions selecting one run's rows of a run-partitioned table: a single partition."""
    return (model.run_id == run.id, model.part_month == run.part_month)


def _aggs(uow: UnitOfWork, run_ids: list[int]) -> dict[int, dict[int, Agg]]:
    out: dict[int, dict[int, Agg]] = defaultdict(lambda: defaultdict(Agg))
    if not run_ids:
        return out
    q = (select(ResearchResult.run_id, ResearchResult.pam_id, ResearchResult.status, func.count(ResearchResult.id))
         .where(ResearchResult.run_id.in_(run_ids), ResearchResult.part_month.in_(_run_months(uow, run_ids)),
                ResearchResult.pam_id.is_not(None))
         .group_by(ResearchResult.run_id, ResearchResult.pam_id, ResearchResult.status))
    for run_id, pam_id, status, n in uow.session.execute(q):
        a = out[run_id][pam_id]
        a.total += n
        if status in RES_TERMINAL:
            a.done += n
        if status == RES_SIGNAL:
            a.signal += n
        if status == RES_FAILED:
            a.failed += n
    return out


def _notes(uow: UnitOfWork, run_ids: list[int]) -> dict[int, dict[tuple[int, str], str]]:
    out: dict[int, dict[tuple[int, str], str]] = defaultdict(dict)
    if run_ids:
        for run_id, pam_id, channel, status in uow.session.execute(
            select(Notification.run_id, Notification.pam_id, Notification.channel, Notification.status)
            .where(Notification.run_id.in_(run_ids), Notification.part_month.in_(_run_months(uow, run_ids)))
        ):
            out[run_id][(pam_id, channel)] = status
    return out


def _delivery(run: Run, pam_id: int, channel: str, notes: dict[tuple[int, str], str]) -> str:
    if channel not in (run.channels or []):
        return "skipped"
    st = notes.get((pam_id, channel))
    return {"sent": "sent", "failed": "failed", "skipped": "skipped"}.get(st or "", "pending")


def _job(run: Run, pam_id: int, a: Agg, notes: dict[tuple[int, str], str]) -> dict[str, Any]:
    if a.done >= a.total:
        status = "partial" if a.failed else "completed"
    elif run.status in ("cancelled", "failed"):
        status = run.status
    elif a.done:
        status = "running"
    else:
        status = "scheduled" if run.status == "scheduled" else "queued"
    return {"pamId": str(pam_id), "status": status, "total": a.total, "done": a.done, "withSignal": a.signal,
            "email": _delivery(run, pam_id, "email", notes), "whatsapp": _delivery(run, pam_id, "whatsapp", notes)}


def _window(run: Run) -> tuple[str, str]:
    if run.window_start and run.window_end:
        return run.window_start.isoformat(), run.window_end.isoformat()
    s = get_settings()
    end = run.scheduled_for.astimezone(ZoneInfo(s.timezone)).date()
    return (end - timedelta(days=s.research_window_days)).isoformat(), end.isoformat()


def _rate(uow: UnitOfWork, run: Run) -> float | None:
    if run.status != RUN_RUNNING:
        return None
    since = utcnow() - timedelta(seconds=30)
    n = uow.session.scalar(select(func.count(ResearchResult.id)).where(*in_run(run), ResearchResult.finished_at >= since)) or 0
    return round(n / 30, 1)


def run_summaries(uow: UnitOfWork, run_list: list[Run]) -> list[dict[str, Any]]:
    ids = [r.id for r in run_list]
    aggs, notes = _aggs(uow, ids), _notes(uow, ids)
    out = []
    for r in run_list:
        jobs = [_job(r, pid, a, notes[r.id]) for pid, a in aggs[r.id].items()]
        ws, we = _window(r)
        out.append({
            "id": str(r.id),
            "label": r.label,
            "trigger": r.trigger,  # upload | rerun | (historical) scheduled | adhoc | import
            "scheduleId": str(r.schedule_id) if r.schedule_id else None,
            "importId": str(r.import_id) if r.import_id else None,
            "templateId": r.template_id,
            "templateVersion": r.prompt_version or PROMPT_VERSION,
            "provider": PROVIDER_LABEL.get(r.provider, r.provider),
            "model": r.model,
            "windowStart": ws,
            "windowEnd": we,
            "startedAt": sch.iso(r.started_at or r.scheduled_for),
            "finishedAt": sch.iso(r.finished_at),
            "status": r.status,
            "triggeredBy": r.triggered_by,
            "companies": r.total,
            "done": r.done,
            "withSignal": r.with_signal,
            "failed": r.failed,
            "cacheHits": r.cache_hits,
            "cost": round(r.cost or 0, 2),
            "estimatedCost": round(r.total * runs.EST_COST_PER_COMPANY, 2),
            "pamJobsTotal": len(jobs),
            "pamJobsDone": sum(j["done"] >= j["total"] for j in jobs),
            "emailSent": sum(j["email"] == "sent" for j in jobs),
            "emailFailed": sum(j["email"] == "failed" for j in jobs),
            "whatsappSent": sum(j["whatsapp"] == "sent" for j in jobs),
            "whatsappEligible": sum(j["whatsapp"] != "skipped" for j in jobs),
            "ratePerSec": _rate(uow, r),
        })
    return out


def list_runs(uow: UnitOfWork, limit: int = 100) -> list[dict[str, Any]]:
    return run_summaries(uow, list(uow.session.scalars(select(Run).order_by(Run.id.desc()).limit(limit))))


def _get_run(uow: UnitOfWork, run_id: str | int) -> Run:
    run = uow.session.get(Run, _int(run_id) or 0)
    if run is None:
        raise NotFound(f"Run {run_id} not found")
    return run


def get_run(uow: UnitOfWork, run_id: str) -> dict[str, Any]:
    return run_summaries(uow, [_get_run(uow, run_id)])[0]


def _jobs_with_names(uow: UnitOfWork, run: Run) -> list[dict[str, Any]]:
    aggs, notes = _aggs(uow, [run.id]), _notes(uow, [run.id])
    pams = {p.id: p for p in uow.session.scalars(select(Pam).where(Pam.id.in_(list(aggs[run.id]))))}
    rows = []
    for pid, a in aggs[run.id].items():
        p = pams.get(pid)
        rows.append(_job(run, pid, a, notes[run.id]) | {"pamName": p.name if p else "Unknown", "_hay": f"{p.name} {p.email}".lower() if p else ""})
    return rows


def _attention(j: dict[str, Any]) -> bool:
    return j["email"] == "failed" or j["whatsapp"] == "failed" or j["status"] == "partial"


# Per-PAM rows are aggregated in Python, so their sort / column filters are applied here too (same
# rules as api/listing.py: whitelisted columns, text = contains, enum = any of, range = min/max).
_PAM_JOB_COLS = {"pamName": "text", "status": "enum", "email": "enum", "whatsapp": "enum", "total": "range", "done": "range",
                 "withSignal": "range"}


def _match_pam_job(j: dict[str, Any], filters: dict[str, Any]) -> bool:
    from app.core.errors import ValidationFailed

    for col, val in filters.items():
        kind = _PAM_JOB_COLS.get(col)
        if kind is None:
            raise ValidationFailed(f"Cannot filter by '{col}'")
        v = j.get(col)
        if kind == "text" and str(val).lower() not in str(v or "").lower():
            return False
        if kind == "enum" and str(v) not in [str(x) for x in (val if isinstance(val, list) else [val])]:
            return False
        if kind == "range" and isinstance(val, dict):
            if val.get("min") not in (None, "") and (v or 0) < float(val["min"]):
                return False
            if val.get("max") not in (None, "") and (v or 0) > float(val["max"]):
                return False
    return True


def pam_jobs(uow: UnitOfWork, run_id: str, page: int, size: int, search: str | None, flt: str | None, lst: Any = None) -> dict[str, Any]:
    return pam_jobs_view(_jobs_with_names(uow, _get_run(uow, run_id)), page, size, search, flt, lst)


def pam_jobs_view(jobs: list[dict[str, Any]], page: int, size: int, search: str | None, flt: str | None, lst: Any = None) -> dict[str, Any]:
    """Filter/sort/page a run's per-PAM jobs (the shared, cached list; never mutated here)."""
    toks = _tokens(search)
    rows = []
    for j in jobs:
        if toks and not all(t in j["_hay"] for t in toks):
            continue
        finished = j["done"] >= j["total"]
        if (flt == "attention" and not _attention(j)) or (flt == "done" and not finished) or (flt == "in_progress" and finished):
            continue
        rows.append({k: v for k, v in j.items() if k != "_hay"})
    if lst is not None and lst.filters:
        rows = [j for j in rows if _match_pam_job(j, lst.filters)]
    if lst is not None and lst.sort:
        if lst.sort not in _PAM_JOB_COLS:
            from app.core.errors import ValidationFailed

            raise ValidationFailed(f"Cannot sort by '{lst.sort}'")
        rows.sort(key=lambda j: (str(j[lst.sort]).lower() if isinstance(j[lst.sort], str) else (j[lst.sort] or 0), j["pamName"].lower()),
                  reverse=lst.desc)
    else:
        rows.sort(key=lambda j: (j["email"] != "failed", j["pamName"].lower()))
    return _page(rows, page, size)


# --- Signals & digest ----------------------------------------------------------------------------


def _ranks(uow: UnitOfWork, run: Run) -> dict[int, int]:
    """Priority rank of each signal within its PAM (1 = act first): category weight, then name."""
    by_pam: dict[int, list[tuple[int, str, int]]] = defaultdict(list)
    for rid, pam_id, cat, name in uow.session.execute(
        select(ResearchResult.id, ResearchResult.pam_id, ResearchResult.category, Company.name)
        .join(Company, Company.id == ResearchResult.company_id)
        .where(*in_run(run), ResearchResult.status == RES_SIGNAL)
    ):
        by_pam[pam_id or 0].append((-CAT_WEIGHT.get(cat or "", 0), name.lower(), rid))
    ranks = {}
    for items in by_pam.values():
        for i, (_, _, rid) in enumerate(sorted(items), start=1):
            ranks[rid] = i
    return ranks


def _signal_row(r: ResearchResult, company: Company, pam_name: str | None, rank: int | None) -> dict[str, Any]:
    row = result_ui(r) | {"companyName": company.name, "industry": company.industry or "", "pamName": pam_name or "Unassigned"}
    row["priority"] = {"rank": rank, "whyNow": plain(r.key_signals), "action": plain(r.outreach)} if rank else None
    return row


def _weight_expr():
    return case((ResearchResult.status != RES_SIGNAL, 0), else_=case(CAT_WEIGHT, value=ResearchResult.category, else_=0))


def query_signals(uow: UnitOfWork, q: dict[str, Any]) -> dict[str, Any]:
    counts = {"signal": 0, "no_signal": 0, "failed": 0, "pending": 0, "all": 0}
    run = uow.session.get(Run, _int(q.get("runId")) or 0)
    page, size = int(q.get("page") or 0), int(q.get("pageSize") or 50)
    if run is None:
        return {"rows": [], "total": 0, "page": page, "pageSize": size, "counts": counts}
    conds = [*in_run(run)]
    if q.get("pamId"):
        conds.append(ResearchResult.pam_id == (_int(q["pamId"]) or 0))
    for t in _tokens(q.get("search")):
        conds.append(or_(Company.name.ilike(f"%{t}%"), Company.industry.ilike(f"%{t}%")))
    if q.get("category") and q["category"] != "all":
        conds += [ResearchResult.status == RES_SIGNAL, ResearchResult.category == q["category"]]

    for status, n in uow.session.execute(
        select(ResearchResult.status, func.count(ResearchResult.id))
        .join(Company, Company.id == ResearchResult.company_id).where(*conds).group_by(ResearchResult.status)
    ):
        counts[_ui_status(status)] += n
        counts["all"] += n
    st = q.get("status")
    if st and st != "all":
        conds.append(ResearchResult.status.in_(["pending", "running"] if st == "pending" else [st]))
    total = sum(v for k, v in counts.items() if k != "all") if not st or st == "all" else counts.get(st, 0)

    rows = uow.session.execute(
        select(ResearchResult, Company, Pam.name)
        .join(Company, Company.id == ResearchResult.company_id)
        .outerjoin(Pam, Pam.id == ResearchResult.pam_id)
        .where(*conds)
        .order_by(_weight_expr().desc(), Company.name, ResearchResult.id)
        .limit(size).offset(page * size)
    ).all()
    ranks = _ranks(uow, run) if any(r.status == RES_SIGNAL for r, _, _ in rows) else {}
    return {"rows": [_signal_row(r, c, pn, ranks.get(r.id)) for r, c, pn in rows], "total": total, "page": page, "pageSize": size, "counts": counts}


def digest(uow: UnitOfWork, run_id: str, pam_id: str) -> dict[str, Any] | None:
    run = uow.session.get(Run, _int(run_id) or 0)
    pam = uow.session.get(Pam, _int(pam_id) or 0)
    if run is None or pam is None:
        return None
    ranks = _ranks(uow, run)
    rows = [
        _signal_row(r, c, pam.name, ranks.get(r.id))
        for r, c in uow.session.execute(
            select(ResearchResult, Company).join(Company, Company.id == ResearchResult.company_id)
            .where(*in_run(run), ResearchResult.pam_id == pam.id)
        )
    ]
    rows.sort(key=lambda x: ((x["priority"] or {}).get("rank") or 999, x["companyName"].lower()))
    aggs, notes = _aggs(uow, [run.id]), _notes(uow, [run.id])
    a = aggs[run.id].get(pam.id)
    return {"run": run_summaries(uow, [run])[0], "pam": pam_options(uow, [pam])[0], "rows": rows,
            "job": _job(run, pam.id, a, notes[run.id]) if a else None}


# --- Dashboard ------------------------------------------------------------------------------------


def _latest_finished(uow: UnitOfWork) -> Run | None:
    return uow.session.scalars(
        select(Run).where(Run.status.in_([RUN_COMPLETED, RUN_PARTIAL])).order_by(Run.finished_at.desc(), Run.id.desc()).limit(1)
    ).first()


def _next_run(uow: UnitOfWork) -> dict[str, Any] | None:
    """The next upload scheduled to run at a later time (recurring schedules are retired)."""
    r = uow.session.scalars(select(Run).where(Run.status == "scheduled").order_by(Run.scheduled_for).limit(1)).first()
    if r is None:
        return None
    return {"id": str(r.id), "label": r.label, "scheduledFor": sch.iso(r.scheduled_for), "companies": r.total,
            "importId": str(r.import_id) if r.import_id else None}


def dashboard_base(uow: UnitOfWork) -> dict[str, Any]:
    """Everything the dashboard shows, for every PAM at once (JSON-shaped, cached once for all users);
    `dashboard_view` narrows it to one PAM at request time."""
    s = uow.session
    by_pam = {str(pid or 0): n for pid, n in s.execute(
        select(Company.pam_id, func.count(Company.id)).where(Company.active.is_(True)).group_by(Company.pam_id))}
    base: dict[str, Any] = {
        "logosAll": sum(by_pam.values()), "logosByPam": by_pam,
        "activePams": s.scalar(select(func.count(Pam.id)).where(Pam.active.is_(True))) or 0,
        "recentRuns": list_runs(uow, 4),
        "nextRun": _next_run(uow),
        "monthSpend": round(finops_svc.month_spend(uow), 2),
        "monthBudget": get_settings().monthly_budget_usd,
        "latestRun": None,
    }
    run = _latest_finished(uow) or s.scalars(select(Run).order_by(Run.id.desc()).limit(1)).first()
    if run is None:
        return base
    scoped: Counter[str] = Counter()
    signals = []
    for rid, pid, status, cat, why, act, cid, cname, pname in s.execute(
        select(ResearchResult.id, ResearchResult.pam_id, ResearchResult.status, ResearchResult.category, ResearchResult.key_signals,
               ResearchResult.outreach, Company.id, Company.name, Pam.name)
        .join(Company, Company.id == ResearchResult.company_id).outerjoin(Pam, Pam.id == ResearchResult.pam_id).where(*in_run(run))
    ):
        scoped[str(pid or 0)] += 1
        if status == RES_SIGNAL:
            signals.append({"id": rid, "pamId": pid, "category": cat, "whyNow": plain(why), "action": plain(act), "companyId": cid,
                            "companyName": cname, "pamName": pname})
    ranks = _ranks(uow, run) if signals else {}
    for x in signals:
        x["rank"] = ranks.get(x["id"])
    jobs = [{k: v for k, v in j.items() if k != "_hay"} for j in _jobs_with_names(uow, run)]
    return base | {"latestRun": run_summaries(uow, [run])[0], "runId": run.id, "scopedByPam": dict(scoped),
                   "scopedAll": sum(scoped.values()), "signalRows": signals, "jobs": jobs}


def dashboard_view(base: dict[str, Any], pam_id: str | None) -> dict[str, Any]:
    """Apply the PAM filter to the shared dashboard dataset (never mutates `base`)."""
    pid = _int(pam_id) if pam_id else None
    out = {k: base[k] for k in ("activePams", "recentRuns", "nextRun", "monthSpend", "monthBudget")}
    out["logos"] = base["logosByPam"].get(str(pid), 0) if pid else base["logosAll"]
    summary = base.get("latestRun")
    if summary is None:
        return out | {"latestRun": None, "scoped": 0, "signals": 0, "emailSent": 0, "emailTotal": 0, "whatsappSent": 0, "whatsappTotal": 0,
                      "topPriority": [], "byCategory": [], "deliveryAttention": []}
    signals = [x for x in base["signalRows"] if not pid or x["pamId"] == pid]
    candidates = signals if pid else [x for x in signals if x["rank"] == 1]
    if pid:
        candidates = sorted(candidates, key=lambda x: (x["rank"] or 999, x["companyName"].lower()))
    else:
        candidates = sorted(candidates, key=lambda x: (-CAT_WEIGHT.get(x["category"] or "", 0), x["companyName"].lower()))
    top = [{"runId": str(base["runId"]), "pamId": str(x["pamId"] or ""), "companyId": str(x["companyId"]), "rank": x["rank"] or 1,
            "whyNow": x["whyNow"], "action": x["action"], "companyName": x["companyName"], "category": x["category"],
            "pamName": x["pamName"] or "Unassigned"} for x in candidates[:6]]
    jobs = base["jobs"]
    if pid:
        mine = [j for j in jobs if j["pamId"] == str(pid)]
        attention = mine
        email = (sum(j["email"] == "sent" for j in mine), len(mine))
        wa = (sum(j["whatsapp"] == "sent" for j in mine), sum(j["whatsapp"] != "skipped" for j in mine))
    else:
        attention = sorted([j for j in jobs if _attention(j)], key=lambda j: (j["email"] != "failed", j["pamName"].lower()))[:6]
        email = (summary["emailSent"], summary["pamJobsTotal"])
        wa = (summary["whatsappSent"], summary["whatsappEligible"])
    return out | {
        "latestRun": summary,
        "scoped": base["scopedByPam"].get(str(pid), 0) if pid else base["scopedAll"],
        "signals": len(signals),
        "emailSent": email[0], "emailTotal": email[1], "whatsappSent": wa[0], "whatsappTotal": wa[1],
        "topPriority": top,
        "byCategory": [{"category": c, "count": n} for c, n in Counter(x["category"] or "Other" for x in signals).most_common()],
        "deliveryAttention": attention,
    }


def dashboard(uow: UnitOfWork, pam_id: str | None) -> dict[str, Any]:
    return dashboard_view(dashboard_base(uow), pam_id)


# --- Companies ------------------------------------------------------------------------------------


def pam_options(uow: UnitOfWork, pams: list[Pam]) -> list[dict[str, Any]]:
    loads, segments = accounts.pam_profiles(uow)
    cap = get_settings().pam_default_capacity
    return [{"id": str(p.id), "name": p.name, "email": p.email, "segment": segments.get(p.id), "active": p.active,
             "load": loads.get(p.id, 0), "capacity": cap} for p in pams]


def _signal_stats(uow: UnitOfWork, company_ids: list[int] | None = None) -> dict[int, tuple[int, date | None]]:
    """Signals per company and the newest signal's window end, from the incremental roll-up
    (company_signal_summary), never an aggregate over every partition of research_results."""
    from app.services import company_stats

    return company_stats.stats(uow, company_ids)


def _cycles(uow: UnitOfWork, company_ids: list[int]) -> dict[int, list[dict[str, str]]]:
    out: dict[int, list[dict[str, str]]] = defaultdict(list)
    if company_ids:
        for cid, run_id, status in uow.session.execute(
            select(ResearchResult.company_id, ResearchResult.run_id, ResearchResult.status)
            .where(ResearchResult.company_id.in_(company_ids), ResearchResult.status.in_(RES_TERMINAL)).order_by(ResearchResult.run_id)
        ):
            out[cid].append({"runId": str(run_id), "status": status})
    return out


def _latest_map(uow: UnitOfWork) -> dict[int, tuple[str, str | None]]:
    run = _latest_finished(uow)
    if run is None:
        return {}
    return {cid: (_ui_status(st), cat) for cid, st, cat in uow.session.execute(
        select(ResearchResult.company_id, ResearchResult.status, ResearchResult.category).where(*in_run(run)))}


def _company_rows(rows: list[tuple], latest: dict, stats: dict, cycles: dict) -> list[dict[str, Any]]:
    out = []
    for cid, name, industry, segment, pam_id, pam_name in rows:
        st, cat = latest.get(cid, ("none", None))
        n, last = stats.get(cid, (0, None))
        out.append({"id": str(cid), "name": name, "industry": industry or "", "segment": segment, "pamId": str(pam_id) if pam_id else None,
                    "pamName": pam_name or "Unassigned", "latestStatus": st, "latestCategory": cat if st == "signal" else None,
                    "signals": n, "lastSignal": last.isoformat() if last else None, "cycles": cycles.get(cid, [])})
    return out


# Base row layout (JSON list, shared by every user): see company_base().
_C_ID, _C_NAME, _C_IND, _C_SEG, _C_PAM, _C_PAMNAME, _C_PAMMAIL, _C_ST, _C_CAT, _C_N, _C_LAST = range(11)


def company_base(uow: UnitOfWork) -> dict[str, Any]:
    """Every active company with its PAM, latest status and signal roll-up (one row each, JSON-shaped).
    Cached once for all users; `companies_view` filters, sorts and pages it per request."""
    latest = _latest_map(uow)
    stats = _signal_stats(uow)
    rows = []
    for cid, name, industry, segment, pam_id, pam_name, pam_email in uow.session.execute(
        select(Company.id, Company.name, Company.industry, Company.segment, Company.pam_id, Pam.name, Pam.email)
        .outerjoin(Pam, Pam.id == Company.pam_id).where(Company.active.is_(True))
    ):
        st, cat = latest.get(cid, ("none", None))
        n, last = stats.get(cid, (0, None))
        rows.append([cid, name, industry, segment, pam_id, pam_name, pam_email, st, cat, n, last.isoformat() if last else None])
    return {"rows": rows}


def companies_view(base: dict[str, Any], q: dict[str, Any], cycles_for) -> dict[str, Any]:
    """Filters, facets, sort and page over the shared company dataset. `cycles_for(ids)` loads the
    research history of the returned page only. Never mutates `base`."""
    t0 = datetime.now(UTC)
    scope = _int(q["scopePamId"]) or 0 if q.get("scopePamId") else None
    pam_set = {_int(x) for x in q.get("pamIds") or []} or None
    segments = set(q.get("segments") or []) or None
    latest_set = set(q.get("latest") or []) or None
    toks = _tokens(q.get("search"))
    facets: dict[str, dict[str, int]] = {"segment": {}, "latest": {}}
    hits = []
    for r in base["rows"]:
        if scope is not None and r[_C_PAM] != scope:
            continue
        if toks:
            hay = f"{r[_C_NAME]} {r[_C_IND] or ''} {r[_C_PAMNAME] or ''} {r[_C_PAMMAIL] or ''}".lower()
            if not all(t in hay for t in toks):
                continue
        if pam_set and r[_C_PAM] not in pam_set:
            continue
        seg_key = r[_C_SEG] or "Unspecified"
        m_s = not segments or seg_key in segments
        m_l = not latest_set or r[_C_ST] in latest_set
        if m_l:
            facets["segment"][seg_key] = facets["segment"].get(seg_key, 0) + 1
        if m_s:
            facets["latest"][r[_C_ST]] = facets["latest"].get(r[_C_ST], 0) + 1
        if m_s and m_l:
            hits.append(r)

    sort = q.get("sort") or {"id": "name", "desc": False}
    desc = bool(sort.get("desc"))
    if sort.get("id") in ("signals", "lastSignal"):
        hits.sort(key=lambda h: h[_C_NAME].lower())
        if sort["id"] == "signals":
            hits.sort(key=lambda h: h[_C_N] or 0, reverse=desc)
        else:
            hits.sort(key=lambda h: h[_C_LAST] or "", reverse=desc)  # ISO dates sort as strings
    elif sort.get("id") == "pam":
        hits.sort(key=lambda h: ((h[_C_PAMNAME] or "~").lower(), h[_C_NAME].lower()), reverse=desc)
    elif sort.get("id") == "segment":
        hits.sort(key=lambda h: ((h[_C_SEG] or "~").lower(), h[_C_NAME].lower()), reverse=desc)
    else:
        hits.sort(key=lambda h: h[_C_NAME].lower(), reverse=desc)

    pg = _page(hits, int(q.get("page") or 0), int(q.get("pageSize") or 50))
    cycles = cycles_for([h[_C_ID] for h in pg["rows"]]) if pg["rows"] else {}
    pg["rows"] = [
        {"id": str(h[_C_ID]), "name": h[_C_NAME], "industry": h[_C_IND] or "", "segment": h[_C_SEG],
         "pamId": str(h[_C_PAM]) if h[_C_PAM] else None, "pamName": h[_C_PAMNAME] or "Unassigned", "latestStatus": h[_C_ST],
         "latestCategory": h[_C_CAT] if h[_C_ST] == "signal" else None, "signals": h[_C_N], "lastSignal": h[_C_LAST],
         "cycles": cycles.get(h[_C_ID], [])}
        for h in pg["rows"]
    ]
    took = (datetime.now(UTC) - t0).total_seconds() * 1000
    return pg | {"facets": facets, "tookMs": round(took, 1)}


def query_companies(uow: UnitOfWork, q: dict[str, Any]) -> dict[str, Any]:
    return companies_view(company_base(uow), q, lambda ids: _cycles(uow, ids))


def search_companies(uow: UnitOfWork, q: str, limit: int) -> list[dict[str, Any]]:
    stmt = select(Company).where(Company.active.is_(True))
    for t in _tokens(q):
        stmt = stmt.where(or_(Company.name.ilike(f"%{t}%"), Company.industry.ilike(f"%{t}%")))
    return [{"id": str(c.id), "name": c.name, "industry": c.industry or ""} for c in uow.session.scalars(stmt.order_by(Company.name).limit(min(limit, 100)))]


def company_detail(uow: UnitOfWork, company_id: str) -> dict[str, Any] | None:
    c = uow.session.get(Company, _int(company_id) or 0)
    if c is None:
        return None
    pam = uow.session.get(Pam, c.pam_id) if c.pam_id else None
    row = _company_rows([(c.id, c.name, c.industry, c.segment, c.pam_id, pam.name if pam else None)],
                        _latest_map(uow), _signal_stats(uow, [c.id]), _cycles(uow, [c.id]))[0]
    cycles = [
        {"result": result_ui(r), "run": {"id": str(run.id), "windowStart": _window(run)[0], "windowEnd": _window(run)[1],
                                         "templateVersion": run.prompt_version or PROMPT_VERSION}}
        for r, run in uow.session.execute(
            select(ResearchResult, Run).join(Run, Run.id == ResearchResult.run_id)
            .where(ResearchResult.company_id == c.id, ResearchResult.status.in_(RES_TERMINAL)).order_by(Run.id.desc())
        )
    ]
    history = [
        {"id": str(a.id), "companyId": str(c.id), "pamId": str(a.pam_id), "validFrom": sch.iso(a.valid_from), "validTo": sch.iso(a.valid_to),
         "reason": a.reason, "actor": a.actor, "pamName": pname}
        for a, pname in uow.session.execute(
            select(CompanyAssignment, Pam.name).join(Pam, Pam.id == CompanyAssignment.pam_id)
            .where(CompanyAssignment.company_id == c.id).order_by(CompanyAssignment.valid_from, CompanyAssignment.id)
        )
    ]
    if not history and pam:  # owned since before history was recorded
        history = [{"id": f"a-{c.id}", "companyId": str(c.id), "pamId": str(pam.id), "validFrom": sch.iso(c.created_at), "validTo": None,
                    "reason": "import", "actor": "import", "pamName": pam.name}]
    return {"company": row, "pam": pam_options(uow, [pam])[0] if pam else None, "cycles": cycles, "assignments": history}


# --- PAMs -----------------------------------------------------------------------------------------


def _pam_card(p: Pam, loads: dict[int, int], segments: dict[int, str | None], cap: int) -> dict[str, Any]:
    return {"id": str(p.id), "name": p.name, "email": p.email, "whatsapp": p.whatsapp or "", "segment": segments.get(p.id), "active": p.active,
            "capacity": cap, "notifyEmail": p.notify_email, "notifyWhatsapp": p.notify_whatsapp, "load": loads.get(p.id, 0)}


def pam_base(uow: UnitOfWork) -> dict[str, Any]:
    """Every PAM as a card (JSON-shaped), cached once for all users; `pams_view` filters per request."""
    loads, segments = accounts.pam_profiles(uow)
    cap = get_settings().pam_default_capacity
    cards = [_pam_card(p, loads, segments, cap) for p in uow.session.scalars(select(Pam))]
    return {"cards": cards, "activeTotal": sum(1 for c in cards if c["active"])}


def pams_view(base: dict[str, Any], q: dict[str, Any]) -> dict[str, Any]:
    t0 = datetime.now(UTC)
    toks = _tokens(q.get("search"))
    seg_f = set(q.get("segments") or []) or None
    st_f = set(q.get("status") or []) or None
    facets: dict[str, dict[str, int]] = {"segment": {}, "status": {}}
    hits = []
    for c in base["cards"]:
        st = "active" if c["active"] else "inactive"
        seg = c["segment"] or "Unspecified"
        if toks and not all(t in f"{c['name']} {c['email']} {seg}".lower() for t in toks):
            continue
        m_s, m_t = not seg_f or seg in seg_f, not st_f or st in st_f
        if m_t:
            facets["segment"][seg] = facets["segment"].get(seg, 0) + 1
        if m_s:
            facets["status"][st] = facets["status"].get(st, 0) + 1
        if m_s and m_t:
            hits.append(c)
    sort = q.get("sort") or {"id": "name", "desc": False}
    desc = bool(sort.get("desc"))
    hits.sort(key=lambda c: c["name"].lower())
    if sort.get("id") == "load":
        hits.sort(key=lambda c: c["load"], reverse=desc)
    elif sort.get("id") == "segment":
        hits.sort(key=lambda c: c["segment"] or "~", reverse=desc)
    elif sort.get("id") == "status":
        hits.sort(key=lambda c: not c["active"], reverse=desc)
    elif desc:
        hits.reverse()
    pg = _page(hits, int(q.get("page") or 0), int(q.get("pageSize") or 50))
    return pg | {"facets": facets, "activeTotal": base["activeTotal"], "tookMs": round((datetime.now(UTC) - t0).total_seconds() * 1000, 1)}


def query_pams(uow: UnitOfWork, q: dict[str, Any]) -> dict[str, Any]:
    return pams_view(pam_base(uow), q)


def search_pams(uow: UnitOfWork, q: str, limit: int, active_only: bool, exclude_id: str | None) -> list[dict[str, Any]]:
    stmt = select(Pam)
    if active_only:
        stmt = stmt.where(Pam.active.is_(True))
    if exclude_id and _int(exclude_id):
        stmt = stmt.where(Pam.id != _int(exclude_id))
    for t in _tokens(q):
        stmt = stmt.where(or_(Pam.name.ilike(f"%{t}%"), Pam.email.ilike(f"%{t}%")))
    return pam_options(uow, list(uow.session.scalars(stmt.order_by(Pam.name).limit(min(limit, 100)))))


def get_pams(uow: UnitOfWork, ids: list[str]) -> list[dict[str, Any]]:
    wanted = [i for i in (_int(x) for x in ids) if i]
    return pam_options(uow, list(uow.session.scalars(select(Pam).where(Pam.id.in_(wanted))))) if wanted else []


# --- Dataset rows (uploaded Excel, editable grid) -----------------------------------------------------


def _dataset_stmt(import_id: int):
    return (
        select(DatasetCompany.row_no, Company, Pam)
        .join(Company, Company.id == DatasetCompany.company_id)
        .outerjoin(Pam, Pam.id == Company.pam_id)
        .where(DatasetCompany.import_id == import_id)
    )


def _dataset_row(row_no: int, c: Company, p: Pam | None) -> dict[str, Any]:
    return {"companyId": str(c.id), "rowNo": row_no, "company": c.name, "industry": c.industry or "", "segment": c.segment,
            "active": c.active, "pamId": str(p.id) if p else None, "pamName": p.name if p else "", "pamEmail": p.email if p else "",
            "pamWhatsapp": (p.whatsapp or "") if p else ""}


def dataset_rows(uow: UnitOfWork, import_id: int, page: int, size: int, q: str | None, segment: str | None,
                 pam_id: str | None, sort: str, desc: bool) -> dict[str, Any]:
    """One page of a dataset's rows (current master data), with facets for the grid filters."""
    base = _dataset_stmt(import_id)
    conds = []
    for t in _tokens(q):
        conds.append(or_(Company.name.ilike(f"%{t}%"), Company.industry.ilike(f"%{t}%"), Pam.name.ilike(f"%{t}%"), Pam.email.ilike(f"%{t}%")))
    seg_cond = (Company.segment.is_(None) if segment == "none" else Company.segment == segment) if segment else None
    pam_cond = Company.pam_id == (_int(pam_id) or 0) if pam_id else None

    def counted(group_col, *extra):
        q_ = (select(group_col, func.count(DatasetCompany.id)).select_from(DatasetCompany)
              .join(Company, Company.id == DatasetCompany.company_id).outerjoin(Pam, Pam.id == Company.pam_id)
              .where(DatasetCompany.import_id == import_id, *conds, *[c for c in extra if c is not None]).group_by(group_col))
        return uow.session.execute(q_).all()

    seg_facet = {(s or "none"): n for s, n in counted(Company.segment, pam_cond)}
    pam_rows = (select(Pam.id, Pam.name, func.count(DatasetCompany.id)).select_from(DatasetCompany)
                .join(Company, Company.id == DatasetCompany.company_id).join(Pam, Pam.id == Company.pam_id)
                .where(DatasetCompany.import_id == import_id, *conds, *([seg_cond] if seg_cond is not None else []))
                .group_by(Pam.id, Pam.name).order_by(Pam.name))
    pam_facet = [{"id": str(i), "name": nm, "count": n} for i, nm, n in uow.session.execute(pam_rows)]

    where = conds + [c for c in (seg_cond, pam_cond) if c is not None]
    order = {"pam": Pam.name, "segment": Company.segment, "row": DatasetCompany.row_no, "industry": Company.industry}.get(sort, Company.name)
    total = uow.session.scalar(
        select(func.count(DatasetCompany.id)).select_from(DatasetCompany).join(Company, Company.id == DatasetCompany.company_id)
        .outerjoin(Pam, Pam.id == Company.pam_id).where(DatasetCompany.import_id == import_id, *where)
    ) or 0
    rows = uow.session.execute(
        base.where(*where).order_by(order.desc() if desc else order.asc(), Company.name, DatasetCompany.id).limit(size).offset(page * size)
    ).all()
    return {"rows": [_dataset_row(rn, c, p) for rn, c, p in rows], "total": total, "page": page, "pageSize": size,
            "facets": {"segment": seg_facet, "pams": pam_facet}}


def dataset_row(uow: UnitOfWork, import_id: int, company_id: int) -> dict[str, Any]:
    row = uow.session.execute(_dataset_stmt(import_id).where(Company.id == company_id)).first()
    if row is None:
        raise NotFound(f"Company {company_id} is not in dataset {import_id}")
    return _dataset_row(*row)


# --- Live run grid ----------------------------------------------------------------------------------


def live_snapshot(uow: UnitOfWork, run_id: str) -> dict[str, Any]:
    run = _get_run(uow, run_id)
    rows = uow.session.execute(
        select(ResearchResult.company_id, Company.name, Pam.name, ResearchResult.status)
        .join(Company, Company.id == ResearchResult.company_id).outerjoin(Pam, Pam.id == ResearchResult.pam_id)
        .where(*in_run(run)).order_by(Pam.name, Company.name, ResearchResult.id)
    ).all()
    statuses = [CODE.get(st, 0) for *_, st in rows]
    aggs = _aggs(uow, [run.id])[run.id]
    return {
        "runId": str(run.id), "companyIds": [str(r[0]) for r in rows], "names": [r[1] for r in rows], "pamNames": [r[2] or "Unassigned" for r in rows],
        "statuses": statuses, "total": len(rows), "done": sum(s != 0 for s in statuses), "signals": statuses.count(1), "failed": statuses.count(3),
        "pamsTotal": len(aggs), "pamsDone": sum(a.done >= a.total for a in aggs.values()),
        "startedAt": sch.iso(run.started_at or run.scheduled_for), "status": run.status, "serverTime": sch.iso(utcnow()),
    }


def live_changes(uow: UnitOfWork, run_id: str, since: datetime | None) -> dict[str, Any]:
    """Results finished since `since` (server clock) plus run counters. Clients pass back
    `serverTime` from the previous response, so client clock skew does not matter."""
    run = _get_run(uow, run_id)
    now = utcnow()
    since = since or now - timedelta(seconds=10)
    items = [
        {"companyId": str(cid), "s": CODE.get(st, 0), "category": cat if st == RES_SIGNAL else None, "at": int(_aware(fin).timestamp() * 1000)}
        for cid, st, cat, fin in uow.session.execute(
            select(ResearchResult.company_id, ResearchResult.status, ResearchResult.category, ResearchResult.finished_at)
            .where(*in_run(run), ResearchResult.finished_at > since - timedelta(seconds=2), ResearchResult.status.in_(RES_TERMINAL))
            .order_by(ResearchResult.finished_at)
        )
    ]
    aggs = _aggs(uow, [run.id])[run.id]
    return {"items": items, "done": run.done, "signals": run.with_signal, "failed": run.failed,
            "pamsDone": sum(a.done >= a.total for a in aggs.values()), "ratePerSec": _rate(uow, run) or 0, "status": run.status, "serverTime": sch.iso(now)}


# --- FinOps, templates, channels ---------------------------------------------------------------------


def templates(uow: UnitOfWork) -> list[dict[str, Any]]:
    """Read-only summary of the research prompt (the editor uses /research-prompt)."""
    from app.services import llm_config, research_prompts

    active = llm_config.get_active_row(uow)
    rows = research_prompts.list_versions(uow)
    cur = next((v for v in rows if v.active), rows[0])
    spec = research_prompts.to_spec(cur)

    def one(v: Any) -> dict[str, Any]:
        return {
            "version": v.version,
            "createdAt": sch.iso(v.created_at),
            "createdBy": v.created_by,
            "note": v.note or "",
            "windowDays": v.window_days,
            "model": active.model if active else "",
            "preset": "medium",
            "ttbsContext": v.ttbs_context,
            "researchPrompt": v.research_prompt,
            "relevanceRules": v.output_rules,
            "sections": [
                {"key": "category", "label": "Category", "instruction": "One of: " + ", ".join(v.categories or []) + "; or None"},
                {"key": "key_signals", "label": "Key signals", "instruction": "1-2 short lines; TTBS-relevant signals only"},
                {"key": "opportunity", "label": "Opportunity type", "instruction": "1-2 short lines; TTBS offering"},
                {"key": "outreach", "label": "Recommended outreach approach", "instruction": "1-2 short lines; sales action"},
            ],
            "priorityPrompt": v.system_instruction,
            "excelColumns": ["Company", "Category", "Key signals", "Opportunity type", "Recommended outreach approach", "Sources"],
        }

    return [{
        "id": "t1",
        "name": "TTBS account signals",
        "description": "Research prompt sent to the active AI for every company. Editable under Output templates → Research prompt.",
        "activeVersion": spec.version,
        "versions": [one(v) for v in rows],
    }]


def channels() -> list[dict[str, Any]]:
    from app.db.session import unit_of_work
    from app.services import email_config

    s = get_settings()

    def one(key: str, name: str, adapter: str) -> dict[str, Any]:
        console = adapter == "console"
        return {"key": key, "name": name, "type": key, "adapter": f"{adapter} adapter", "status": "connected", "enabled": True,
                "details": {"Delivery": "Logged to the worker console (not sent)" if console else adapter, "Max attempts": str(s.notify_max_attempts)}}

    with unit_of_work() as uow:
        row = email_config.get_row(uow)
        if row is None:
            email = one("email", "Email", s.notify_email_adapter)
        else:
            lim = email_config.limits(row)
            email = {"key": "email", "name": "Email", "type": "email", "adapter": "Microsoft Graph", "enabled": row.enabled,
                     "status": "connected" if row.last_check_ok else "error",
                     "details": {"Sender": row.sender_address, "Limits": f"{lim.minute}/min · {lim.hour}/h · {lim.day}/day",
                                 "Max attempts": str(row.max_attempts)}}
    return [email, one("whatsapp", "WhatsApp", s.notify_whatsapp_adapter)]
