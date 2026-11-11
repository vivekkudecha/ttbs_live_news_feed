"""Routes backing the UI pages (dashboard, signals, companies, PAMs, digest, live grid, FinOps,
templates, channels). Reads use read_models; writes go through services + audit."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field

from app.api import read_models as rm
from app.api import schemas as sch
from app.api import scope
from app.api.deps import Principal, current_actor, current_principal
from app.api.listing import listing
from app.core import cache
from app.core.config import get_settings
from app.core.timeutil import as_utc
from app.db.models import RUN_ACTIVE
from app.db.session import unit_of_work
from app.services import accounts, finops, notifications

router = APIRouter(prefix="/api/v1")


# --- Request bodies (camelCase on the wire) ------------------------------------------------------


class SortIn(sch.In):
    id: str = "name"
    desc: bool = False


class CompanyQueryIn(sch.In):
    page: int = Field(0, ge=0)
    page_size: int = Field(50, ge=1, le=200)
    search: str | None = None
    pam_ids: list[str] | None = None
    latest: list[str] | None = None
    sort: SortIn | None = None
    scope_pam_id: str | None = None


class PamQueryIn(sch.In):
    page: int = Field(0, ge=0)
    page_size: int = Field(50, ge=1, le=200)
    search: str | None = None
    status: list[Literal["active", "inactive"]] | None = None
    sort: SortIn | None = None


class ReassignIn(sch.In):
    company_ids: list[str] = Field(min_length=1, max_length=10_000)
    to_pam_id: str


def _dump(m: sch.In) -> dict[str, Any]:
    return m.model_dump(by_alias=True, exclude_none=True)


# --- Dashboard, runs, signals, digest --------------------------------------------------------------


def _live_ttl(active: bool) -> int:
    s = get_settings()
    return s.cache_ttl_job_running if active else s.cache_ttl_lists


@router.get("/dashboard")
def dashboard(pam_id: str | None = Query(None, alias="pamId"), principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """Shared dashboard dataset (all PAMs, cached once for every user), narrowed to `pamId` and the
    user's scope at request time."""
    def load():
        with unit_of_work() as uow:
            return rm.dashboard_base(uow)

    def ttl(v: dict[str, Any]) -> int:
        latest = v.get("latestRun") or {}
        return _live_ttl(latest.get("status") in RUN_ACTIVE or any(r["status"] in RUN_ACTIVE for r in v["recentRuns"]))

    base = cache.shared("runs", f"dashboard:i{cache.version('imports')}:a{cache.version('accounts')}", ttl, load)
    if base.get("latestRun") is not None:
        base = base | {"signalRows": scope.rows(principal, "signals", base["signalRows"]),
                       "jobs": scope.rows(principal, "pam_jobs", base["jobs"])}
    return rm.dashboard_view(base, pam_id)


@router.get("/run-summaries")
def run_summaries() -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return rm.list_runs(uow)


@router.get("/run-summaries/{run_id}")
def run_summary(run_id: str) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.get_run(uow, run_id)


@router.get("/run-summaries/{run_id}/pam-jobs")
def pam_jobs(
    run_id: str, page: int = Query(0, ge=0), page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    search: str | None = None, filter: Literal["all", "attention", "done", "in_progress"] | None = None,
    sort: str | None = Query(None, max_length=60), desc: bool = False, column_filter: str | None = Query(None, alias="columnFilter", max_length=4000),
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    lst = listing(sort=sort, desc=desc, filter=column_filter)
    rid = rm._int(run_id) or 0

    def load():
        with unit_of_work() as uow:
            run = rm._get_run(uow, rid)
            return {"status": run.status, "jobs": rm._jobs_with_names(uow, run)}

    s = get_settings()
    base = cache.shared(f"run:{rid}", "pam-jobs", lambda v: s.cache_ttl_job_running if v["status"] in RUN_ACTIVE else s.cache_ttl_job_finished,
                        load)
    return rm.pam_jobs_view(scope.rows(principal, "pam_jobs", base["jobs"]), page, page_size, search, filter, lst)


@router.post("/run-summaries/{run_id}/pams/{pam_id}/resend")
def resend_digest(run_id: str, pam_id: str, actor: str = Depends(current_actor)) -> dict[str, int]:
    """Re-queue this PAM's failed/skipped digests for the run (outbox; idempotent)."""
    from sqlalchemy import select

    from app.db.models import Notification

    with unit_of_work() as uow:
        ids = list(uow.session.scalars(select(Notification.id).where(
            Notification.run_id == (rm._int(run_id) or 0), Notification.pam_id == (rm._int(pam_id) or 0), Notification.status == "failed")))
        for nid in ids:
            notifications.resend(uow, nid, actor)
    return {"requeued": len(ids)}


@router.get("/run-summaries/{run_id}/live")
def live_snapshot(run_id: str) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.live_snapshot(uow, run_id)


@router.get("/run-summaries/{run_id}/live/changes")
def live_changes(run_id: str, since: datetime | None = None) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.live_changes(uow, run_id, as_utc(since) if since else None)


# --- Companies ---------------------------------------------------------------------------------------


@router.post("/companies/query")
def query_companies(body: CompanyQueryIn, principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """The company table: one shared dataset of every active company (cached once for all users);
    search, filters, facets, sort, paging and the user's scope are applied per request."""
    q = _dump(body)

    def load():
        with unit_of_work() as uow:
            return rm.company_base(uow)

    # "-v2": the cached row layout changed (segment removed); never read rows cached in the old layout.
    base = cache.shared("accounts", _accounts_key("companies-base-v2"), get_settings().cache_ttl_lists, load)

    def cycles(ids: list[int]):
        with unit_of_work() as uow:
            return rm._cycles(uow, ids)

    return rm.companies_view({"rows": scope.rows(principal, "companies", base["rows"])}, q, cycles)


@router.get("/companies/search")
def search_companies(q: str = "", limit: int = Query(20, ge=1, le=100)) -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return rm.search_companies(uow, q, limit)


@router.get("/companies/{company_id}")
def company_detail(company_id: str) -> dict[str, Any] | None:
    with unit_of_work() as uow:
        return rm.company_detail(uow, company_id)


@router.post("/companies/reassign")
def reassign(body: ReassignIn, actor: str = Depends(current_actor)) -> dict[str, int]:
    with unit_of_work() as uow:
        return {"moved": accounts.reassign(uow, body.company_ids, body.to_pam_id, actor)}


# --- PAMs ------------------------------------------------------------------------------------------


@router.post("/pams/query")
def query_pams(body: PamQueryIn, principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """The PAM table: one shared dataset of every PAM card; filtered per request."""
    q = _dump(body)

    def load():
        with unit_of_work() as uow:
            return rm.pam_base(uow)

    base = cache.shared("accounts", _accounts_key("pams-base"), get_settings().cache_ttl_lists, load)
    cards = scope.rows(principal, "pams", base["cards"])
    return rm.pams_view(base | {"cards": cards} if cards is not base["cards"] else base, q)


def _accounts_key(kind: str) -> str:
    """Company/PAM tables change with reassignments ("accounts"), uploads and row edits ("imports")
    and research ("runs"): the key embeds those namespace versions so any of them invalidates it.
    The key holds no query and no user: one dataset serves every request."""
    return f"{kind}:i{cache.version('imports')}:r{cache.version('runs')}"


@router.get("/pams/search")
def search_pams(
    q: str = "", limit: int = Query(20, ge=1, le=100), active_only: bool = Query(False, alias="activeOnly"),
    exclude_id: str | None = Query(None, alias="excludeId"),
) -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return rm.search_pams(uow, q, limit, active_only, exclude_id)


@router.get("/pams/by-ids")
def pams_by_ids(ids: str = "") -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return rm.get_pams(uow, [x for x in ids.split(",") if x])


@router.get("/pams/{pam_id}/rebalance-plan")
def rebalance_plan(pam_id: str) -> dict[str, Any]:
    with unit_of_work() as uow:
        return accounts.rebalance_plan(uow, pam_id)


@router.post("/pams/{pam_id}/deactivate")
def deactivate_pam(pam_id: str, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return accounts.deactivate_pam(uow, pam_id, actor)


# --- FinOps, templates, channels --------------------------------------------------------------------


@router.get("/finops")
def finops_report(start: str | None = Query(None, alias="from"), end: str | None = Query(None, alias="to")) -> dict[str, Any]:
    """Cost analysis for a date range (IST dates, inclusive; default: this month). USD."""
    with unit_of_work() as uow:
        return finops.report(uow, start, end)


@router.get("/finops/ledger.csv")
def finops_ledger_csv(start: str | None = Query(None, alias="from"), end: str | None = Query(None, alias="to")) -> Response:
    """Every ledger row in the range, labelled (run, upload, PAM, logo), for Excel."""
    with unit_of_work() as uow:
        body = finops.ledger_csv(uow, start, end)
    name = f"ttbs-cost-ledger-{start or 'month'}-{end or 'today'}.csv"
    return Response("﻿" + body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


@router.get("/templates")
def templates() -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return rm.templates(uow)


@router.get("/channels")
def channels() -> list[dict[str, Any]]:
    return rm.channels()
