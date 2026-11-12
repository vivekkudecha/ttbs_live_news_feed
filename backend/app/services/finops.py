"""FinOps: the cost ledger (writes) and the cost-analysis report (reads). All amounts are USD.

Writes happen in the same transaction as the work they price (a research result, a sent
message), so the ledger can never disagree with the results. Reads are GROUP BYs over the ledger
for a date range, cut by run, upload, PAM, logo, provider/model and channel.
"""

import csv
import io
from calendar import monthrange
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select

from app.core import metrics
from app.core.config import get_settings
from app.core.errors import ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db import partitions
from app.db.models import (
    COST_LLM,
    COST_MESSAGING,
    RES_FAILED,
    RES_SIGNAL,
    Company,
    CostEntry,
    ImportBatch,
    Pam,
    ResearchResult,
    Run,
)
from app.db.session import UnitOfWork

# --- Writes -----------------------------------------------------------------------------------


def avg_paid_cost(uow: UnitOfWork, provider: str, model: str) -> float:
    """Average cost of a real (non-cached) call for this model over the last 30 days: the
    estimate of what a cache hit saved. Falls back to the run-planning estimate."""
    from app.services.runs import EST_COST_PER_COMPANY

    v = uow.session.scalar(
        select(func.avg(CostEntry.cost)).where(
            CostEntry.category == COST_LLM, CostEntry.provider == provider, CostEntry.model == model,
            CostEntry.cached.is_(False), CostEntry.cost > 0, *_in_range(utcnow() - timedelta(days=30), None),
        )
    )
    return float(v) if v else EST_COST_PER_COMPANY


def _usage_cols(u: Any) -> dict[str, Any]:
    """Ledger columns for the provider's usage breakdown (providers.Usage, or its dict form)."""
    if u is None:
        return {}
    g = u.get if isinstance(u, dict) else lambda k, d=None: getattr(u, k, d)
    rid = g("response_id")
    return {
        "cache_read_tokens": int(g("cache_read") or 0), "cache_write_tokens": int(g("cache_write") or 0),
        "reasoning_tokens": int(g("reasoning") or 0), "tool_calls": int(g("tool_calls") or 0),
        "input_cost": float(g("input_cost") or 0), "output_cost": float(g("output_cost") or 0),
        "cache_cost": float(g("cache_cost") or 0), "tool_cost": float(g("tool_cost") or 0),
        "cost_source": g("source") or "estimate", "response_id": str(rid)[:120] if rid else None, "usage_raw": g("raw"),
    }


def record_research(uow: UnitOfWork, res: ResearchResult, run: Run, values: dict[str, Any], usage: Any = None) -> None:
    cached = bool(values.get("cached"))
    cost = float(values.get("cost") or 0.0)
    tokens_in, tokens_out = int(values.get("tokens_in") or 0), int(values.get("tokens_out") or 0)
    if not cached and cost == 0 and tokens_in == 0 and tokens_out == 0:
        return  # nothing was billed (e.g. failed before any call was made)
    saved = avg_paid_cost(uow, run.provider, run.model) if cached else 0.0
    uow.session.add(CostEntry(
        ts=utcnow(), category=COST_LLM, provider=run.provider, model=run.model, run_id=run.id,
        import_id=run.import_id, pam_id=res.pam_id, company_id=res.company_id, result_id=res.id, units=1,
        tokens_in=0 if cached else tokens_in, tokens_out=0 if cached else tokens_out, cost=cost, cached=cached,
        saved=saved, outcome=values.get("status"), **({} if cached else _usage_cols(usage)),
    ))
    metrics.COST_USD.labels(COST_LLM, run.provider).inc(cost)
    if cached:
        metrics.CACHE_SAVED_USD.inc(saved)
    else:
        metrics.RESEARCH_TOKENS.labels(run.provider, run.model, "in").inc(tokens_in)
        metrics.RESEARCH_TOKENS.labels(run.provider, run.model, "out").inc(tokens_out)


def message_price(channel: str) -> float:
    s = get_settings()
    return {"email": s.notify_price_email_usd, "whatsapp": s.notify_price_whatsapp_usd}.get(channel, 0.0)


def record_message(uow: UnitOfWork, *, notification_id: int, run: Run, pam_id: int, channel: str, adapter: str) -> None:
    price = message_price(channel)
    uow.session.add(CostEntry(
        ts=utcnow(), category=COST_MESSAGING, provider=channel, model=adapter, channel=channel, run_id=run.id,
        import_id=run.import_id, pam_id=pam_id, notification_id=notification_id, units=1, cost=price, outcome="sent",
    ))
    metrics.COST_USD.labels(COST_MESSAGING, channel).inc(price)


def record_email_ai(uow: UnitOfWork, *, notification_id: int, run: Run, pam_id: int, meta: dict[str, Any]) -> None:
    """The AI summary written for one email digest (LLM cost, attributed to the run and PAM)."""
    cost = float(meta.get("cost") or 0.0)
    uow.session.add(CostEntry(
        ts=utcnow(), category=COST_LLM, provider=meta.get("provider") or "unknown", model=meta.get("model"), channel="email",
        run_id=run.id, import_id=run.import_id, pam_id=pam_id, notification_id=notification_id, units=1,
        tokens_in=int(meta.get("tokensIn") or 0), tokens_out=int(meta.get("tokensOut") or 0), cost=cost, outcome="email_ai",
        **_usage_cols(meta.get("usage")),
    ))
    metrics.COST_USD.labels(COST_LLM, meta.get("provider") or "unknown").inc(cost)


# --- Budget -----------------------------------------------------------------------------------


def month_start(now: datetime) -> datetime:
    tz = ZoneInfo(get_settings().timezone)
    local = now.astimezone(tz)
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _in_range(lo: datetime | None, hi: datetime | None) -> list[Any]:
    """[lo, hi) on the ledger timestamp, plus the matching monthly partitions (pruning)."""
    conds = partitions.range_months(CostEntry.part_month, lo, hi)
    if lo is not None:
        conds.append(CostEntry.ts >= lo)
    if hi is not None:
        conds.append(CostEntry.ts < hi)
    return conds


def month_spend(uow: UnitOfWork) -> float:
    start = month_start(utcnow()).astimezone(UTC)  # bounds are compared in UTC (SQLite keeps no zone)
    return float(uow.session.scalar(select(func.coalesce(func.sum(CostEntry.cost), 0.0)).where(*_in_range(start, None))) or 0.0)


def check_budget(uow: UnitOfWork, estimate: float) -> dict[str, Any]:
    """Raise when the monthly hard cap is reached; otherwise report how this run lands."""
    s = get_settings()
    spent = month_spend(uow)
    budget = s.monthly_budget_usd
    if s.budget_hard_cap and budget > 0 and spent >= budget:
        raise ValidationFailed(
            "The monthly research budget has been reached (see Costs). Raise MONTHLY_BUDGET_USD to run more research this month.",
            code="budget_exceeded", details={"spent": round(spent, 2), "budget": budget},
        )
    after = spent + estimate
    return {
        "spent": round(spent, 2), "budget": budget, "estimate": round(estimate, 2),
        "softLimitReached": budget > 0 and after >= budget * s.budget_soft_limit_pct / 100,
        "wouldExceed": budget > 0 and after > budget,
    }


# --- Report -----------------------------------------------------------------------------------


def parse_range(start: str | None, end: str | None) -> tuple[datetime, datetime, date, date]:
    """Inclusive local dates (IST) → [from, to) UTC datetimes. Default: this month to date."""
    tz = ZoneInfo(get_settings().timezone)
    today = utcnow().astimezone(tz).date()
    try:
        d1 = date.fromisoformat(start) if start else today.replace(day=1)
        d2 = date.fromisoformat(end) if end else today
    except ValueError as e:
        raise ValidationFailed("Dates must be YYYY-MM-DD") from e
    if d2 < d1:
        raise ValidationFailed("'to' is before 'from'")
    if (d2 - d1).days > 366:
        raise ValidationFailed("Range is limited to one year")
    lo = datetime.combine(d1, datetime.min.time(), tz).astimezone(UTC)
    hi = datetime.combine(d2 + timedelta(days=1), datetime.min.time(), tz).astimezone(UTC)
    return lo, hi, d1, d2


def _sums():
    llm = CostEntry.category == COST_LLM
    return (
        func.coalesce(func.sum(case((llm, CostEntry.cost), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((CostEntry.category == COST_MESSAGING, CostEntry.cost), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((llm & CostEntry.cached.is_(False), 1), else_=0)), 0),
        func.coalesce(func.sum(case((llm & CostEntry.cached.is_(True), 1), else_=0)), 0),
        func.coalesce(func.sum(CostEntry.saved), 0.0),
        func.coalesce(func.sum(CostEntry.tokens_in), 0),
        func.coalesce(func.sum(CostEntry.tokens_out), 0),
        func.coalesce(func.sum(case((llm & (CostEntry.outcome == RES_SIGNAL), 1), else_=0)), 0),
        func.coalesce(func.sum(case((CostEntry.category == COST_MESSAGING, 1), else_=0)), 0),
    )


def _row(llm, msg, calls, hits, saved, tin, tout, signals, messages) -> dict[str, Any]:
    # MySQL returns SUMs as Decimal (SQLite as int/float): normalise once so the maths below is plain float/int.
    llm, msg, saved = float(llm or 0), float(msg or 0), float(saved or 0)
    calls, hits, tin, tout, signals, messages = (int(x or 0) for x in (calls, hits, tin, tout, signals, messages))
    researched = calls + hits
    total = llm + msg
    return {
        "llm": round(llm, 4), "messaging": round(msg, 4), "total": round(total, 4),
        "calls": calls, "cacheHits": hits, "saved": round(saved, 4),
        "tokensIn": tin, "tokensOut": tout, "signals": signals, "messages": messages,
        "costPerCompany": round(total / researched, 4) if researched else None,
        "costPerSignal": round(total / signals, 4) if signals else None,
        "cacheRate": round(hits * 100 / researched, 1) if researched else 0,
    }


def _breakdown(uow: UnitOfWork, lo: datetime, hi: datetime, key, limit: int = 50) -> list[tuple[Any, dict[str, Any]]]:
    total_cost = func.sum(CostEntry.cost)
    rows = uow.session.execute(
        select(key, *_sums()).where(*_in_range(lo, hi), key.is_not(None))
        .group_by(key).order_by(total_cost.desc()).limit(limit)
    ).all()
    return [(r[0], _row(*r[1:])) for r in rows]


_U_SUMS = ("tokensIn", "cacheRead", "cacheWrite", "tokensOut", "reasoning", "toolCalls",
           "inputCost", "outputCost", "cacheCost", "toolCost", "cost")
_U_COLS = (CostEntry.tokens_in, CostEntry.cache_read_tokens, CostEntry.cache_write_tokens, CostEntry.tokens_out,
           CostEntry.reasoning_tokens, CostEntry.tool_calls, CostEntry.input_cost, CostEntry.output_cost,
           CostEntry.cache_cost, CostEntry.tool_cost, CostEntry.cost)
_SOURCE_KEY = {"provider": "providerCost", "estimate": "estimatedCost"}


def _usage_acc() -> dict[str, Any]:
    return {"calls": 0, **dict.fromkeys(_U_SUMS, 0), "providerCost": 0.0, "estimatedCost": 0.0,
            "untrackedCost": 0.0, "untrackedCalls": 0}


def _usage_add(acc: dict[str, Any], vals: tuple, source: str | None) -> None:
    acc["calls"] += 1
    for k, v in zip(_U_SUMS, vals, strict=True):
        acc[k] += v or 0
    acc[_SOURCE_KEY.get(source or "", "untrackedCost")] += vals[-1] or 0
    acc["untrackedCalls"] += source is None


def _usage_out(acc: dict[str, Any]) -> dict[str, Any]:
    out = {k: round(float(v), 6) if isinstance(v, float) else int(v) for k, v in acc.items()}
    out["totalTokens"] = out["tokensIn"] + out["tokensOut"]
    # Whatever the provider billed beyond the itemised parts (and calls recorded before the breakdown existed).
    parts = acc["inputCost"] + acc["outputCost"] + acc["cacheCost"] + acc["toolCost"]
    out["otherCost"] = round(max(acc["cost"] - acc["untrackedCost"] - parts, 0.0), 6)
    return out


def usage_breakdown(uow: UnitOfWork, lo: datetime, hi: datetime, tz: ZoneInfo) -> dict[str, Any]:
    """Paid LLM calls (cache hits spend nothing) as the provider billed them: totals plus one row per
    day x provider x model, by IST day and by UTC day (provider consoles use UTC)."""
    total = _usage_acc()
    daily: dict[str, dict[tuple, dict[str, Any]]] = {"ist": defaultdict(_usage_acc), "utc": defaultdict(_usage_acc)}
    rows = uow.session.execute(
        select(CostEntry.ts, CostEntry.provider, CostEntry.model, CostEntry.cost_source, *_U_COLS)
        .where(*_in_range(lo, hi), CostEntry.category == COST_LLM, CostEntry.cached.is_(False))
    )
    for ts, provider, model, source, *vals in rows:
        ts = as_utc(ts)
        _usage_add(total, vals, source)
        for zone, day in (("ist", ts.astimezone(tz).date()), ("utc", ts.date())):
            _usage_add(daily[zone][(day.isoformat(), provider, model)], vals, source)
    return {
        "totals": _usage_out(total),
        "daily": {zone: [{"date": d, "provider": p, "model": m, **_usage_out(acc)} for (d, p, m), acc in sorted(rows_.items())]
                  for zone, rows_ in daily.items()},
    }


def report(uow: UnitOfWork, start: str | None, end: str | None) -> dict[str, Any]:
    s = get_settings()
    lo, hi, d1, d2 = parse_range(start, end)
    sess = uow.session
    totals = _row(*sess.execute(select(*_sums()).where(*_in_range(lo, hi))).one())

    # Failed research: what it cost and how many logos it hit (wasted spend).
    failed_cost, failed_n = sess.execute(
        select(func.coalesce(func.sum(CostEntry.cost), 0.0), func.count(CostEntry.id))
        .where(*_in_range(lo, hi), CostEntry.category == COST_LLM, CostEntry.outcome == RES_FAILED)
    ).one()
    totals["failedCost"], totals["failedCalls"] = round(float(failed_cost or 0), 4), int(failed_n or 0)

    # Daily series (local dates).
    tz = ZoneInfo(s.timezone)
    daily: dict[str, dict[str, float]] = defaultdict(lambda: {"llm": 0.0, "messaging": 0.0, "saved": 0.0})
    for ts, cat, cost, saved in sess.execute(
        select(CostEntry.ts, CostEntry.category, CostEntry.cost, CostEntry.saved).where(*_in_range(lo, hi))
    ):
        d = daily[as_utc(ts).astimezone(tz).date().isoformat()]
        d["llm" if cat == COST_LLM else "messaging"] += cost or 0
        d["saved"] += saved or 0
    series, cur = [], d1
    while cur <= d2:
        v = daily.get(cur.isoformat(), {"llm": 0.0, "messaging": 0.0, "saved": 0.0})
        series.append({"date": cur.isoformat(), **{k: round(x, 4) for k, x in v.items()}})
        cur += timedelta(days=1)

    # Breakdowns, labelled.
    by_run = _breakdown(uow, lo, hi, CostEntry.run_id, 100)
    runs = {r.id: r for r in sess.scalars(select(Run).where(Run.id.in_([k for k, _ in by_run])))} if by_run else {}
    by_import = _breakdown(uow, lo, hi, CostEntry.import_id, 100)
    imps = {b.id: b for b in sess.scalars(select(ImportBatch).where(ImportBatch.id.in_([k for k, _ in by_import])))} if by_import else {}
    by_pam = _breakdown(uow, lo, hi, CostEntry.pam_id, 100)
    pams = {p.id: p for p in sess.scalars(select(Pam).where(Pam.id.in_([k for k, _ in by_pam])))} if by_pam else {}
    by_company = _breakdown(uow, lo, hi, CostEntry.company_id, 25)
    cos = {c.id: c for c in sess.scalars(select(Company).where(Company.id.in_([k for k, _ in by_company])))} if by_company else {}

    model_rows = sess.execute(
        select(CostEntry.category, CostEntry.provider, CostEntry.model, *_sums())
        .where(*_in_range(lo, hi))
        .group_by(CostEntry.category, CostEntry.provider, CostEntry.model).order_by(func.sum(CostEntry.cost).desc())
    ).all()

    budget = s.monthly_budget_usd
    m_spend = month_spend(uow)
    now = utcnow()
    ms = month_start(now)
    days_in_month = monthrange(ms.year, ms.month)[1]
    elapsed_days = max((now - ms).total_seconds() / 86400, 1)
    return {
        "currency": "USD",
        "from": d1.isoformat(), "to": d2.isoformat(),
        "totals": totals,
        "budget": {
            "monthly": budget, "monthSpend": round(m_spend, 2), "forecast": round(m_spend / elapsed_days * days_in_month, 2),
            "softLimitPct": s.budget_soft_limit_pct, "hardCap": s.budget_hard_cap,
            "usedPct": round(m_spend * 100 / budget, 1) if budget else 0,
        },
        "prices": {"emailPerMessage": s.notify_price_email_usd, "whatsappPerMessage": s.notify_price_whatsapp_usd},
        "series": series,
        "byRun": [
            {"id": str(k), "label": runs[k].label if k in runs else f"Run {k}", "status": runs[k].status if k in runs else None,
             "importId": str(runs[k].import_id) if k in runs and runs[k].import_id else None,
             "startedAt": as_utc(runs[k].started_at).isoformat() if k in runs and runs[k].started_at else None,
             "companies": runs[k].total if k in runs else None, **v}
            for k, v in by_run
        ],
        "byUpload": [{"id": str(k), "label": imps[k].label if k in imps else f"Upload {k}", "fileName": imps[k].file_name if k in imps else None, **v}
                     for k, v in by_import],
        "byPam": [{"id": str(k), "name": pams[k].name if k in pams else f"PAM {k}", "email": pams[k].email if k in pams else None, **v}
                  for k, v in by_pam],
        "topCompanies": [{"id": str(k), "name": cos[k].name if k in cos else f"Company {k}", **v} for k, v in by_company],
        "byModel": [{"category": cat, "provider": p, "model": m, **_row(*rest)} for cat, p, m, *rest in model_rows],
        "usage": usage_breakdown(uow, lo, hi, tz),
    }


LEDGER_COLUMNS = ["ts", "category", "provider", "model", "channel", "run_id", "run_label", "upload_id", "upload_label",
                  "pam_id", "pam_name", "company_id", "company_name", "units", "tokens_in", "tokens_out", "cost_usd",
                  "cached", "saved_usd", "outcome", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "tool_calls",
                  "input_cost_usd", "output_cost_usd", "cache_cost_usd", "tool_cost_usd", "cost_source", "response_id"]


def _safe(v: Any) -> Any:
    """CSV/Excel formula-injection guard for text cells (=, +, -, @ at the start)."""
    return f"'{v}" if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v


def ledger_csv(uow: UnitOfWork, start: str | None, end: str | None) -> str:
    lo, hi, _, _ = parse_range(start, end)
    sess = uow.session
    q = (
        select(CostEntry, Run.label, ImportBatch.label, Pam.name, Company.name)
        .outerjoin(Run, Run.id == CostEntry.run_id).outerjoin(ImportBatch, ImportBatch.id == CostEntry.import_id)
        .outerjoin(Pam, Pam.id == CostEntry.pam_id).outerjoin(Company, Company.id == CostEntry.company_id)
        .where(*_in_range(lo, hi)).order_by(CostEntry.id)
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(LEDGER_COLUMNS)
    for e, run_label, imp_label, pam_name, co_name in sess.execute(q):
        w.writerow([_safe(x) for x in (
            as_utc(e.ts).isoformat(), e.category, e.provider, e.model, e.channel, e.run_id, run_label, e.import_id, imp_label,
            e.pam_id, pam_name, e.company_id, co_name, e.units, e.tokens_in, e.tokens_out, f"{e.cost:.6f}",
            "yes" if e.cached else "no", f"{e.saved:.6f}", e.outcome, e.cache_read_tokens, e.cache_write_tokens,
            e.reasoning_tokens, e.tool_calls, f"{e.input_cost:.6f}", f"{e.output_cost:.6f}", f"{e.cache_cost:.6f}",
            f"{e.tool_cost:.6f}", e.cost_source or "not captured", e.response_id,
        )])
    return buf.getvalue()


def run_costs(uow: UnitOfWork, run_id: int, run_started: datetime | None = None) -> dict[str, Any]:
    """Per-run cost card: totals plus the split by PAM for this run."""
    sess = uow.session
    in_run = [CostEntry.run_id == run_id]
    if run_started is not None:  # nothing is billed to a run before it existed: skip older partitions
        in_run.append(partitions.since_month(CostEntry.part_month, run_started))
    totals = _row(*sess.execute(select(*_sums()).where(*in_run)).one())
    rows = sess.execute(
        select(CostEntry.pam_id, *_sums()).where(*in_run, CostEntry.pam_id.is_not(None))
        .group_by(CostEntry.pam_id).order_by(func.sum(CostEntry.cost).desc()).limit(200)
    ).all()
    pams = {p.id: p.name for p in sess.scalars(select(Pam).where(Pam.id.in_([r[0] for r in rows])))} if rows else {}
    return {"totals": totals, "byPam": [{"id": str(r[0]), "name": pams.get(r[0], f"PAM {r[0]}"), **_row(*r[1:])} for r in rows]}
