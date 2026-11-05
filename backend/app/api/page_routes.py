"""Routes backing the UI pages (dashboard, signals, companies, PAMs, digest, live grid, FinOps,
templates, channels, session). Reads use read_models; writes go through services + audit."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field

from app.api import read_models as rm
from app.api import schemas as sch
from app.api.deps import current_actor
from app.core.errors import ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.session import unit_of_work
from app.services import accounts, audit, finops, notifications

router = APIRouter(prefix="/api/v1")


# --- Request bodies (camelCase on the wire) ------------------------------------------------------


class SortIn(sch.In):
    id: str = "name"
    desc: bool = False


class CompanyQueryIn(sch.In):
    page: int = Field(0, ge=0)
    page_size: int = Field(50, ge=1, le=200)
    search: str | None = None
    segments: list[str] | None = None
    pam_ids: list[str] | None = None
    latest: list[str] | None = None
    sort: SortIn | None = None
    scope_pam_id: str | None = None


class PamQueryIn(sch.In):
    page: int = Field(0, ge=0)
    page_size: int = Field(50, ge=1, le=200)
    search: str | None = None
    segments: list[str] | None = None
    status: list[Literal["active", "inactive"]] | None = None
    sort: SortIn | None = None


class SignalQueryIn(sch.In):
    run_id: str
    page: int = Field(0, ge=0)
    page_size: int = Field(50, ge=1, le=200)
    status: str | None = None
    category: str | None = None
    pam_id: str | None = None
    search: str | None = None


class ReassignIn(sch.In):
    company_ids: list[str] = Field(min_length=1, max_length=10_000)
    to_pam_id: str


class SessionIn(sch.In):
    username: str = Field(min_length=1, max_length=100)


def _dump(m: sch.In) -> dict[str, Any]:
    return m.model_dump(by_alias=True, exclude_none=True)


# --- Session (demo login until real auth lands) ---------------------------------------------------


@router.post("/session")
def create_session(body: SessionIn) -> dict[str, Any]:
    """Sign-in by name (no roles, no passwords yet). The name becomes the audit actor."""
    username = body.username.strip()
    if not username:
        raise ValidationFailed("Enter your name", details={"field": "username"})
    with unit_of_work() as uow:
        audit.record(uow, "auth.login", "user", username[:64], {}, actor=username)
    return {"id": username, "username": username, "name": username, "lastLoginAt": sch.iso(utcnow())}


# --- Dashboard, runs, signals, digest --------------------------------------------------------------


@router.get("/dashboard")
def dashboard(pam_id: str | None = Query(None, alias="pamId")) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.dashboard(uow, pam_id)


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
) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.pam_jobs(uow, run_id, page, page_size, search, filter)


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


@router.post("/signals/query")
def query_signals(body: SignalQueryIn) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.query_signals(uow, _dump(body))


@router.get("/digest")
def digest(run_id: str = Query(alias="runId"), pam_id: str = Query(alias="pamId")) -> dict[str, Any] | None:
    with unit_of_work() as uow:
        return rm.digest(uow, run_id, pam_id)


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
def query_companies(body: CompanyQueryIn) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.query_companies(uow, _dump(body))


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
def query_pams(body: PamQueryIn) -> dict[str, Any]:
    with unit_of_work() as uow:
        return rm.query_pams(uow, _dump(body))


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
