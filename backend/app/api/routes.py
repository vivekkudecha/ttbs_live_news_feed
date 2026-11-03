"""HTTP routes, /api/v1. Handlers are thin: validate input → call a service inside one unit of
work → serialise. Sync handlers run in FastAPI's threadpool (SQLAlchemy is sync)."""

from typing import Any, Literal

import redis
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from sqlalchemy import case, func, select, text

from app.api import read_models as rm
from app.api import schemas as sch
from app.api.deps import current_actor
from app.core import cache
from app.core.config import get_settings
from app.core.errors import PayloadTooLarge, ValidationFailed
from app.db.models import (
    NOTE_PENDING,
    RES_PENDING,
    RES_RUNNING,
    RUN_ACTIVE,
    AuditLog,
    Company,
    DatasetCompany,
    ImportBatch,
    Notification,
    ResearchResult,
    Run,
)
from app.db.session import unit_of_work
from app.research import providers
from app.services import audit, imports, llm_config, notifications, runs, schedules

router = APIRouter(prefix="/api/v1")


def _page(page: int = Query(0, ge=0), page_size: int = Query(50, ge=1, alias="pageSize")) -> tuple[int, int]:
    return page, min(page_size, get_settings().max_page_size)


# --- Health ------------------------------------------------------------------------------------


@router.get("/health")
def health() -> dict[str, Any]:
    out: dict[str, Any] = {"status": "ok"}
    try:
        with unit_of_work() as uow:
            uow.session.execute(text("SELECT 1"))
        out["db"] = "ok"
    except Exception as e:  # noqa: BLE001 - health must report, not raise
        out["db"], out["status"] = f"error: {type(e).__name__}", "degraded"
    try:
        cache.get_redis().ping()
        out["redis"] = "ok"
    except redis.RedisError as e:
        out["redis"], out["status"] = f"error: {type(e).__name__}", "degraded"
    out["provider"] = get_settings().llm_provider
    try:
        with unit_of_work() as uow:
            row = llm_config.get_active_row(uow)
        out["activeAi"] = row.provider if row else None
        out["model"] = row.model if row else None
    except Exception:  # noqa: BLE001
        out["activeAi"] = out["model"] = None
    return out


# --- Datasets (uploaded Excel files) ------------------------------------------------------------
# Upload → 201 immediately with status "queued"; rows are saved by a background job in resumable
# chunks. Poll GET /imports/{id} for progress. Row edits/deletes change master company/PAM data.


@router.post("/imports", status_code=201)
async def upload_dataset(file: UploadFile = File(...), label: str | None = Form(None), actor: str = Depends(current_actor)) -> dict[str, Any]:
    limit = get_settings().import_max_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise PayloadTooLarge(f"File is larger than {limit // (1024 * 1024)} MB")
    name = (file.filename or "upload").replace("\\", "/").rsplit("/", 1)[-1]

    def work():
        with unit_of_work() as uow:
            batch = imports.create(uow, name, data, label, actor)
            uow.after_commit(lambda: cache.bump("imports"))
            return sch.dataset_out(batch, companies=0, with_issues=True)

    from starlette.concurrency import run_in_threadpool

    return await run_in_threadpool(work)


@router.get("/imports")
def list_datasets() -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        batches = list(uow.session.scalars(select(ImportBatch).order_by(ImportBatch.id.desc()).limit(200)))
        counts = dict(uow.session.execute(
            select(DatasetCompany.import_id, func.count(DatasetCompany.id))
            .where(DatasetCompany.import_id.in_([b.id for b in batches])).group_by(DatasetCompany.import_id)
        ).all()) if batches else {}
        return [sch.dataset_out(b, companies=counts.get(b.id, 0)) for b in batches]


@router.get("/imports/{import_id}")
def get_dataset(import_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        b = imports.get_dataset(uow, import_id)
        return sch.dataset_out(b, companies=imports.member_count(uow, b.id), with_issues=True)


@router.patch("/imports/{import_id}")
def rename_dataset(import_id: int, body: sch.DatasetPatch, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        b = imports.rename(uow, import_id, body.label, actor)
        uow.after_commit(lambda: cache.bump("imports", "runs"))
        return sch.dataset_out(b, companies=imports.member_count(uow, b.id))


@router.post("/imports/{import_id}/resume")
def resume_dataset(import_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        b = imports.resume(uow, import_id, actor)
        return sch.dataset_out(b, companies=imports.member_count(uow, b.id))


@router.get("/imports/{import_id}/rows")
def dataset_rows(
    import_id: int, pg: tuple[int, int] = Depends(_page), q: str | None = None, segment: str | None = None,
    pam_id: str | None = Query(None, alias="pamId"), sort: str = "company", desc: bool = False,
) -> dict[str, Any]:
    page, size = pg
    with unit_of_work() as uow:
        imports.get_dataset(uow, import_id)
        return rm.dataset_rows(uow, import_id, page, size, q, segment, pam_id, sort, desc)


@router.patch("/imports/{import_id}/rows/{company_id}")
def update_dataset_row(import_id: int, company_id: int, body: sch.RowPatch, actor: str = Depends(current_actor)) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationFailed("Nothing to update")
    with unit_of_work() as uow:
        c = imports.update_row(uow, import_id, company_id, patch, actor)
        uow.session.flush()
        return rm.dataset_row(uow, import_id, c.id)


@router.post("/imports/{import_id}/rows/delete")
def delete_dataset_rows(import_id: int, body: sch.RowsDelete, actor: str = Depends(current_actor)) -> dict[str, int]:
    ids = [int(x) for x in body.company_ids if str(x).isdigit()]
    if not ids:
        raise ValidationFailed("No valid company ids")
    with unit_of_work() as uow:
        return imports.delete_rows(uow, import_id, ids, actor)


# --- Scopes & runs -----------------------------------------------------------------------------


@router.get("/scopes")
def scopes() -> list[dict[str, Any]]:
    def load():
        with unit_of_work() as uow:
            return runs.scope_options(uow)

    return cache.cached("runs", "scopes", get_settings().cache_ttl_lists, load)


def _note_counts(uow, run_ids: list[int]) -> dict[int, dict[str, int]]:
    out: dict[int, dict[str, int]] = {}
    if not run_ids:
        return out
    for rid, status, n in uow.session.execute(
        select(Notification.run_id, Notification.status, func.count()).where(Notification.run_id.in_(run_ids))
        .group_by(Notification.run_id, Notification.status)
    ):
        out.setdefault(rid, {})[status] = n
    return out


@router.post("/runs", status_code=201)
def create_run(body: sch.RunCreate, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        run = runs.create_run(
            uow, scope_key=body.scope_key, actor=actor, label=body.label, run_at=body.run_at,
            channels=list(body.channels), template_id=body.template_id, budget_cap=body.budget_cap,
        )
        return sch.run_out(run)


# Status groups for the runs list tabs ("status" also accepts a single raw status).
RUN_GROUPS: dict[str, tuple[str, ...]] = {
    "active": RUN_ACTIVE,
    "finished": ("completed", "partial", "failed", "cancelled"),
    "attention": ("partial", "failed"),
}


@router.get("/runs")
def list_runs(pg: tuple[int, int] = Depends(_page), status: str | None = None, q: str | None = None) -> dict[str, Any]:
    """Runs, newest first. `status` = active | finished | attention | a raw status; `q` searches the
    label. `groups` carries the count per group (for tab badges) under the same search."""
    page, size = pg
    search = (q or "").strip()[:100]

    def load():
        with unit_of_work() as uow:
            conds = [Run.label.ilike(f"%{search}%")] if search else []
            statuses = RUN_GROUPS.get(status or "", (status,) if status else None)
            where = conds + ([Run.status.in_(statuses)] if statuses else [])
            rows = list(uow.session.scalars(select(Run).where(*where).order_by(Run.id.desc()).limit(size).offset(page * size)))
            notes = _note_counts(uow, [r.id for r in rows])
            by_status = dict(uow.session.execute(select(Run.status, func.count(Run.id)).where(*conds).group_by(Run.status)).all())
            groups = {"all": sum(by_status.values())} | {g: sum(by_status.get(s, 0) for s in sts) for g, sts in RUN_GROUPS.items()}
            total = uow.session.scalar(select(func.count(Run.id)).where(*where)) or 0
            return {"rows": [sch.run_out(r, notes.get(r.id)) for r in rows], "total": total, "page": page, "pageSize": size, "groups": groups}

    s = get_settings()
    ttl = lambda v: s.cache_ttl_job_running if any(r["status"] in RUN_ACTIVE for r in v["rows"]) or v["groups"]["active"] else s.cache_ttl_lists  # noqa: E731
    return cache.cached("runs", f"list:{status}:{search.lower()}:{page}:{size}", ttl, load)


@router.get("/runs/{run_id}")
def get_run(run_id: int) -> dict[str, Any]:
    def load():
        with unit_of_work() as uow:
            run = runs.get_run(uow, run_id)
            return sch.run_out(run, _note_counts(uow, [run.id]).get(run.id))

    s = get_settings()
    ttl = lambda v: s.cache_ttl_job_running if v["status"] in RUN_ACTIVE else s.cache_ttl_job_finished  # noqa: E731
    return cache.cached(f"run:{run_id}", "detail", ttl, load)


@router.get("/runs/{run_id}/results")
def run_results(run_id: int, pg: tuple[int, int] = Depends(_page), status: str | None = None, q: str | None = None) -> dict[str, Any]:
    """Results for a run: signals first, then by company name. `q` searches the company name;
    status `pending` also covers companies being researched right now."""
    page, size = pg
    with unit_of_work() as uow:
        runs.get_run(uow, run_id)
        conds = [ResearchResult.run_id == run_id]
        if status:
            conds.append(ResearchResult.status.in_([RES_PENDING, RES_RUNNING] if status == RES_PENDING else [status]))
        base = select(ResearchResult).join(Company, Company.id == ResearchResult.company_id)
        cq = select(func.count(ResearchResult.id)).join(Company, Company.id == ResearchResult.company_id)
        search = (q or "").strip()[:100]
        if search:
            conds.append(Company.name.ilike(f"%{search}%"))
        signal_first = case((ResearchResult.status == "signal", 0), (ResearchResult.status == "failed", 1), else_=2)
        rows = uow.session.scalars(base.where(*conds).order_by(signal_first, Company.name, ResearchResult.id).limit(size).offset(page * size))
        cq = cq.where(*conds)
        counts = dict(uow.session.execute(
            select(ResearchResult.status, func.count()).where(ResearchResult.run_id == run_id).group_by(ResearchResult.status)
        ).all())
        return {"rows": [sch.result_out(r) for r in rows], "total": uow.session.scalar(cq) or 0, "page": page,
                "pageSize": size, "counts": counts}


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return sch.run_out(runs.cancel(uow, run_id, actor))


@router.post("/runs/{run_id}/retry-failed")
def retry_failed(run_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return {"requeued": runs.retry_failed(uow, run_id, actor)}


# --- Notifications -----------------------------------------------------------------------------


@router.get("/runs/{run_id}/notifications")
def run_notifications(run_id: int, pg: tuple[int, int] = Depends(_page), status: str | None = None) -> list[dict[str, Any]]:
    page, size = pg
    with unit_of_work() as uow:
        runs.get_run(uow, run_id)
        return [sch.notification_out(n) for n in notifications.list_for_run(uow, run_id, status, size, page * size)]


@router.post("/notifications/{notification_id}/resend")
def resend(notification_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return sch.notification_out(notifications.resend(uow, notification_id, actor))


# --- Schedules ---------------------------------------------------------------------------------


def _schedule_rows(uow) -> list[dict[str, Any]]:
    out = []
    for s in schedules.list_all(uow):
        row = sch.schedule_out(s)
        row["scope"] = runs.scope_label(uow, s.scope_key)
        out.append(row)
    return out


@router.get("/schedules")
def list_schedules() -> list[dict[str, Any]]:
    def load():
        with unit_of_work() as uow:
            return _schedule_rows(uow)

    return cache.cached("schedules", "list", get_settings().cache_ttl_lists, load)


@router.post("/schedules", status_code=201)
def create_schedule(body: sch.ScheduleCreate, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        s = schedules.create(uow, body.model_dump(), actor)
        return sch.schedule_out(s) | {"scope": runs.scope_label(uow, s.scope_key)}


@router.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: sch.ScheduleUpdate, actor: str = Depends(current_actor)) -> dict[str, Any]:
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise ValidationFailed("Nothing to update")
    with unit_of_work() as uow:
        s = schedules.update(uow, schedule_id, data, actor)
        return sch.schedule_out(s) | {"scope": runs.scope_label(uow, s.scope_key)}


@router.post("/schedules/{schedule_id}/run", status_code=201)
def run_schedule_now(schedule_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        s = schedules.get(uow, schedule_id)
        run = runs.create_run(
            uow, scope_key=s.scope_key, actor=actor, label=f"{s.name} · manual", channels=s.channels,
            template_id=s.template_id, budget_cap=s.budget_cap, schedule_id=s.id,
        )
        return sch.run_out(run)


# --- Queues ------------------------------------------------------------------------------------


@router.get("/queues")
def queues() -> dict[str, Any]:
    """Broker depth per queue plus the database view of outstanding work."""
    depth: dict[str, int | None] = {}
    try:
        r = redis.Redis.from_url(get_settings().broker_url, socket_connect_timeout=1, socket_timeout=1)
        for q in ("research", "notify", "maintenance"):
            depth[q] = int(r.llen(q))
    except redis.RedisError:
        depth = {q: None for q in ("research", "notify", "maintenance")}
    with unit_of_work() as uow:
        s = uow.session
        db = {
            "runsActive": s.scalar(select(func.count(Run.id)).where(Run.status.in_(RUN_ACTIVE))) or 0,
            "researchPending": s.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.status == RES_PENDING)) or 0,
            "researchRunning": s.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.status == RES_RUNNING)) or 0,
            "notificationsPending": s.scalar(select(func.count(Notification.id)).where(Notification.status == NOTE_PENDING)) or 0,
        }
    return {"broker": depth, "db": db}


# --- Research AI settings (provider + key + model; one active at a time) -----------------------
# API keys are write-only: requests may carry them, responses never do (only a hint like "pplx-…a1b2").

AiProvider = Literal["perplexity", "gemini"]


def _llm_out() -> dict[str, Any]:
    labels = {k: s.label for k, s in providers.registry().items()}
    with unit_of_work() as uow:
        return sch.llm_settings_out(llm_config.list_rows(uow), labels, mode=get_settings().llm_provider)


@router.get("/settings/llm")
def get_llm_settings() -> dict[str, Any]:
    return _llm_out()


@router.post("/settings/llm/{provider}/models")
def list_llm_models(provider: AiProvider, body: sch.LlmModelsIn) -> dict[str, Any]:
    """Models available to the given key (or the saved one), grouped by the model's provider."""
    models = llm_config.list_models(provider, body.api_key)
    groups: dict[str, int] = {}
    for m in models:
        groups[m["provider"]] = groups.get(m["provider"], 0) + 1
    return {"models": models, "providers": [{"key": k, "count": n} for k, n in sorted(groups.items())]}


@router.put("/settings/llm/{provider}")
def save_llm_config(provider: AiProvider, body: sch.LlmConfigIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    """Verify + save, and make this provider the active AI (the others are switched off)."""
    llm_config.save(provider, body.api_key, body.model, actor)
    return _llm_out()


@router.post("/settings/llm/{provider}/activate")
def activate_llm_provider(provider: AiProvider, actor: str = Depends(current_actor)) -> dict[str, Any]:
    llm_config.activate(provider, actor)
    return _llm_out()


@router.post("/settings/llm/{provider}/test")
def test_llm_config(provider: AiProvider, actor: str = Depends(current_actor)) -> dict[str, Any]:
    _, error = llm_config.test(provider, actor)
    return _llm_out() | {"ok": error is None, "error": error}


@router.delete("/settings/llm/{provider}", status_code=204)
def remove_llm_config(provider: AiProvider, actor: str = Depends(current_actor)) -> None:
    llm_config.remove(provider, actor)


# --- Audit -------------------------------------------------------------------------------------


@router.get("/audit")
def list_audit(
    pg: tuple[int, int] = Depends(_page), action: str | None = None, entity_type: str | None = Query(None, alias="entityType"),
    entity_id: str | None = Query(None, alias="entityId"),
) -> dict[str, Any]:
    page, size = pg
    with unit_of_work() as uow:
        q = select(AuditLog)
        cq = select(func.count(AuditLog.id))
        for col, val in ((AuditLog.action, action), (AuditLog.entity_type, entity_type), (AuditLog.entity_id, entity_id)):
            if val:
                q, cq = q.where(col == val), cq.where(col == val)
        rows = uow.session.scalars(q.order_by(AuditLog.id.desc()).limit(size).offset(page * size))
        return {"rows": [sch.audit_out(a) for a in rows], "total": uow.session.scalar(cq) or 0, "page": page, "pageSize": size}


@router.get("/audit/verify")
def verify_audit() -> dict[str, Any]:
    with unit_of_work() as uow:
        return audit.verify_chain(uow)
