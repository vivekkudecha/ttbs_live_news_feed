"""Per-company research roll-up (`company_signal_summary`): how many signals a company has had and
the window end of the newest one. Updated in the same transaction as each completed result, so
company lists sorted by signals read one small table instead of aggregating every partition of
research_results."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date

from sqlalchemy import case, func, select, update
from sqlalchemy.exc import IntegrityError

from app.db.models import RES_SIGNAL, CompanySignalSummary, ResearchResult, Run
from app.db.session import UnitOfWork


def record_signal(uow: UnitOfWork, company_id: int, window_end: date | None) -> None:
    """One more signal for this company (atomic increment; inserts the row on first signal)."""
    s = uow.session
    t = CompanySignalSummary
    newest = case((t.last_signal_date.is_(None), window_end), (t.last_signal_date < window_end, window_end),
                  else_=t.last_signal_date) if window_end is not None else t.last_signal_date
    stmt = update(t).where(t.company_id == company_id).values(signals=t.signals + 1, last_signal_date=newest)
    if s.execute(stmt).rowcount:
        return
    try:
        with s.begin_nested():
            s.add(CompanySignalSummary(company_id=company_id, signals=1, last_signal_date=window_end))
            s.flush()
    except IntegrityError:  # another transaction inserted it first: increment instead
        s.execute(stmt)


def stats(uow: UnitOfWork, company_ids: Iterable[int] | None = None) -> dict[int, tuple[int, date | None]]:
    q = select(CompanySignalSummary.company_id, CompanySignalSummary.signals, CompanySignalSummary.last_signal_date)
    if company_ids is not None:
        ids = list(company_ids)
        if not ids:
            return {}
        q = q.where(CompanySignalSummary.company_id.in_(ids))
    return {cid: (n, last) for cid, n, last in uow.session.execute(q) if n}


def rebuild(uow: UnitOfWork, company_ids: Iterable[int]) -> None:
    """Recompute from research_results (after results were archived)."""
    ids = sorted(set(company_ids))
    if not ids:
        return
    s = uow.session
    fresh = {cid: (n, last) for cid, n, last in s.execute(
        select(ResearchResult.company_id, func.count(ResearchResult.id), func.max(Run.window_end))
        .join(Run, Run.id == ResearchResult.run_id)
        .where(ResearchResult.status == RES_SIGNAL, ResearchResult.company_id.in_(ids)).group_by(ResearchResult.company_id)
    )}
    for cid in ids:
        n, last = fresh.get(cid, (0, None))
        row = s.get(CompanySignalSummary, cid)
        if row is None:
            if n:
                s.add(CompanySignalSummary(company_id=cid, signals=n, last_signal_date=last))
        else:
            row.signals, row.last_signal_date = n, last
    s.flush()
