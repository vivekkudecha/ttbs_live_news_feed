"""HTTP routes, /api/v1. Handlers are thin: validate input → call a service inside one unit of
work → serialise. Sync handlers run in FastAPI's threadpool (SQLAlchemy is sync)."""

import hashlib
import re
import uuid
from pathlib import Path
from typing import Any, Literal

import redis
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import case, func, select, text

from app.api import read_models as rm
from app.api import schemas as sch
from app.api import table_specs as spec
from app.api.deps import current_actor
from app.api.listing import Listing, conditions, listing, ordering
from app.core import cache
from app.core.config import get_settings
from app.core.errors import PayloadTooLarge, ValidationFailed
from app.db.models import (
    IMPORT_UNSAVED,
    NOTE_PENDING,
    RES_PENDING,
    RES_RUNNING,
    RUN_ACTIVE,
    AuditLog,
    Company,
    DatasetCompany,
    ImportBatch,
    Notification,
    Pam,
    ProcessEvent,
    ResearchResult,
    Run,
)
from app.db.session import unit_of_work
from app.research import providers
from app.services import audit, finops, imports, llm_config, notifications, runs, telemetry

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


STREAM_CHUNK = 1024 * 1024  # 1 MB


async def _stream_to_disk(file: UploadFile) -> tuple[str, Path, int, str]:
    """Copy the upload to UPLOAD_DIR 1 MB at a time (never whole in memory), hashing as it goes.
    Returns (original name, temp path, size, sha256). Over the limit → 413 and nothing is kept."""
    limit = get_settings().import_max_bytes
    folder = get_settings().upload_path
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f".incoming-{uuid.uuid4().hex}.part"
    sha, size = hashlib.sha256(), 0
    try:
        with open(tmp, "wb") as out:
            while chunk := await file.read(STREAM_CHUNK):
                size += len(chunk)
                if size > limit:
                    raise PayloadTooLarge(f"File is larger than {limit // (1024 * 1024):,} MB")
                sha.update(chunk)
                out.write(chunk)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise ValidationFailed("The file is empty")
    return (file.filename or "upload").replace("\\", "/").rsplit("/", 1)[-1], tmp, size, sha.hexdigest()


async def _stage(file: UploadFile, actor: str, label: str | None) -> dict[str, Any]:
    from starlette.concurrency import run_in_threadpool

    name, tmp, size, digest = await _stream_to_disk(file)

    def work():
        try:
            with unit_of_work() as uow:
                b = imports.stage(uow, file_name=name, temp_path=tmp, size=size, sha256=digest, actor=actor, label=label)
                uow.after_commit(lambda: cache.bump("imports"))
                return sch.dataset_out(b, companies=0, with_issues=True)
        finally:
            tmp.unlink(missing_ok=True)  # moved into place on success; cleaned up on any error

    return await run_in_threadpool(work)


@router.post("/imports/stage", status_code=201)
async def stage_upload(file: UploadFile = File(...), actor: str = Depends(current_actor)) -> dict[str, Any]:
    """Step 1 (files up to 1 GB): stream the file to the server; type and header are checked now,
    every row in the background. Poll GET /imports/{id} for progress, then GET /imports/{id}/preview."""
    return await _stage(file, actor, None)


@router.post("/imports", status_code=201)
async def upload_dataset(file: UploadFile = File(...), label: str | None = Form(None), actor: str = Depends(current_actor)) -> dict[str, Any]:
    """One step: stage + save under `label` (required) as soon as the background check passes."""
    if not (label or "").strip():
        raise ValidationFailed("Give the upload a name to save it under", details={"field": "label"})
    return await _stage(file, actor, label)


@router.get("/imports/{import_id}/preview")
def upload_preview(import_id: int) -> dict[str, Any]:
    """What the checked file contains and what saving it would change (counts over every row,
    the first 200 valid rows, up to 500 problems)."""
    with unit_of_work() as uow:
        return imports.preview_of(imports.get_dataset(uow, import_id))


@router.post("/imports/{import_id}/save")
def save_upload(import_id: int, body: sch.DatasetPatch, actor: str = Depends(current_actor)) -> dict[str, Any]:
    """Step 2: save a checked upload under the user's name; rows are saved in the background."""
    with unit_of_work() as uow:
        b = imports.save(uow, import_id, body.label, actor)
        return sch.dataset_out(b, companies=0)


@router.delete("/imports/{import_id}", status_code=204)
def discard_upload(import_id: int, actor: str = Depends(current_actor)) -> None:
    """Drop an upload that was never saved, and its file."""
    with unit_of_work() as uow:
        imports.discard(uow, import_id, actor)
        uow.after_commit(lambda: cache.bump("imports"))


@router.get("/imports")
def list_datasets(pg: tuple[int, int] = Depends(_page), lst: Listing = Depends(listing)) -> dict[str, Any]:
    """Saved uploads, newest first; sortable/filterable by column, paged."""
    page, size = pg
    with unit_of_work() as uow:
        where = [ImportBatch.status.not_in(IMPORT_UNSAVED), *conditions(spec.IMPORTS, lst)]
        batches = list(uow.session.scalars(
            select(ImportBatch).where(*where)
            .order_by(*ordering(spec.IMPORTS, lst, [], ImportBatch.id.desc() if not lst.sort else ImportBatch.id))
            .limit(size).offset(page * size)
        ))
        total = uow.session.scalar(select(func.count(ImportBatch.id)).where(*where)) or 0
        ids = [b.id for b in batches]
        counts = dict(uow.session.execute(
            select(DatasetCompany.import_id, func.count(DatasetCompany.id))
            .where(DatasetCompany.import_id.in_(ids)).group_by(DatasetCompany.import_id)
        ).all()) if batches else {}
        run_stats = {
            iid: (n, last, cost) for iid, n, last, cost in uow.session.execute(
                select(Run.import_id, func.count(Run.id), func.max(Run.created_at), func.coalesce(func.sum(Run.cost), 0.0))
                .where(Run.import_id.in_(ids)).group_by(Run.import_id)
            )
        } if batches else {}
        return {"rows": [sch.dataset_out(b, companies=counts.get(b.id, 0), runs=run_stats.get(b.id)) for b in batches],
                "total": total, "page": page, "pageSize": size}


@router.get("/imports/{import_id}")
def get_dataset(import_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        b = imports.get_dataset(uow, import_id)
        stats = uow.session.execute(
            select(func.count(Run.id), func.max(Run.created_at), func.coalesce(func.sum(Run.cost), 0.0)).where(Run.import_id == b.id)
        ).one()
        return sch.dataset_out(b, companies=imports.member_count(uow, b.id), with_issues=True, runs=tuple(stats))


@router.get("/imports/{import_id}/file")
def download_dataset_file(import_id: int) -> FileResponse:
    """The original file as uploaded, named "<name> · <upload time>"."""
    from zoneinfo import ZoneInfo

    from app.core.errors import NotFound
    from app.core.timeutil import as_utc

    with unit_of_work() as uow:
        b = imports.get_dataset(uow, import_id)
        label, created, original = b.label or "upload", b.created_at, b.file_name
        try:
            path = imports.stored_path(b)
        except NotFound:
            path = None
    if path is None or not path.is_file():
        raise NotFound("The original file was not kept for this upload (uploaded before files were stored)")
    stamp = as_utc(created).astimezone(ZoneInfo(get_settings().timezone)).strftime("%Y-%m-%d %H-%M")
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else "xlsx"
    safe = re.sub(r'[\\/:*?"<>|]+', " ", label).strip() or "upload"
    return FileResponse(path, filename=f"{safe} {stamp}.{ext}", headers={"Cache-Control": "no-store"})


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
    import_id: int, pg: tuple[int, int] = Depends(_page), q: str | None = None,
    pam_id: str | None = Query(None, alias="pamId"), sort: str = "company", desc: bool = False,
) -> dict[str, Any]:
    page, size = pg
    with unit_of_work() as uow:
        imports.get_dataset(uow, import_id)
        return rm.dataset_rows(uow, import_id, page, size, q, pam_id, sort, desc)


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


# Status groups for the runs list tabs ("status" also accepts a single raw status).
RUN_GROUPS: dict[str, tuple[str, ...]] = {
    "active": RUN_ACTIVE,
    "finished": ("completed", "partial", "failed", "cancelled"),
    "attention": ("partial", "failed"),
}


@router.get("/runs")
def list_runs(pg: tuple[int, int] = Depends(_page), status: str | None = None, q: str | None = None,
              schedule: str | None = None, lst: Listing = Depends(listing)) -> dict[str, Any]:
    """Runs, newest first. `status` = active | finished | attention | a raw status; `q` searches the
    label; `schedule` = a schedule id, or "none" for runs no schedule started. `groups` carries the
    count per group (for tab badges) under the same search and schedule."""
    page, size = pg
    search = (q or "").strip()[:100]
    by_schedule = [Run.schedule_id.is_(None)] if schedule == "none" else [Run.schedule_id == int(schedule)] if (schedule or "").isdigit() else []

    def load():
        with unit_of_work() as uow:
            conds = ([Run.label.ilike(f"%{search}%")] if search else []) + by_schedule + conditions(spec.RUNS, lst)
            statuses = RUN_GROUPS.get(status or "", (status,) if status else None)
            where = conds + ([Run.status.in_(statuses)] if statuses else [])
            order = ordering(spec.RUNS, lst, [], Run.id.desc() if not lst.sort else Run.id)
            rows = list(uow.session.scalars(select(Run).where(*where).order_by(*order).limit(size).offset(page * size)))
            notes = _note_counts(uow, [r.id for r in rows])
            by_status = dict(uow.session.execute(select(Run.status, func.count(Run.id)).where(*conds).group_by(Run.status)).all())
            groups = {"all": sum(by_status.values())} | {g: sum(by_status.get(s, 0) for s in sts) for g, sts in RUN_GROUPS.items()}
            total = uow.session.scalar(select(func.count(Run.id)).where(*where)) or 0
            return {"rows": [sch.run_out(r, notes.get(r.id)) for r in rows], "total": total, "page": page, "pageSize": size, "groups": groups}

    s = get_settings()
    ttl = lambda v: s.cache_ttl_job_running if any(r["status"] in RUN_ACTIVE for r in v["rows"]) or v["groups"]["active"] else s.cache_ttl_lists  # noqa: E731
    return cache.cached("runs", f"list:{status}:{schedule}:{search.lower()}:{page}:{size}:{lst.key()}", ttl, load)


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
def run_results(run_id: int, pg: tuple[int, int] = Depends(_page), status: str | None = None, q: str | None = None,
                lst: Listing = Depends(listing)) -> dict[str, Any]:
    """Results for a run: signals first, then by company name. `q` searches the company name;
    status `pending` also covers companies being researched right now."""
    page, size = pg
    with unit_of_work() as uow:
        run = runs.get_run(uow, run_id)
        conds = [ResearchResult.run_id == run_id, ResearchResult.part_month == run.part_month]  # one partition
        if status:
            conds.append(ResearchResult.status.in_([RES_PENDING, RES_RUNNING] if status == RES_PENDING else [status]))
        base = (select(ResearchResult, Pam.name).join(Company, Company.id == ResearchResult.company_id)
                .outerjoin(Pam, Pam.id == ResearchResult.pam_id))
        cq = (select(func.count(ResearchResult.id)).join(Company, Company.id == ResearchResult.company_id)
              .outerjoin(Pam, Pam.id == ResearchResult.pam_id))
        search = (q or "").strip()[:100]
        if search:
            conds.append(Company.name.ilike(f"%{search}%"))
        conds += conditions(spec.RESULTS, lst)
        signal_first = case((ResearchResult.status == "signal", 0), (ResearchResult.status == "failed", 1), else_=2)
        order = ordering(spec.RESULTS, lst, [signal_first, Company.name], ResearchResult.id)
        rows = uow.session.execute(base.where(*conds).order_by(*order).limit(size).offset(page * size)).all()
        cq = cq.where(*conds)
        counts = dict(uow.session.execute(
            select(ResearchResult.status, func.count())
            .where(ResearchResult.run_id == run_id, ResearchResult.part_month == run.part_month).group_by(ResearchResult.status)
        ).all())
        return {"rows": [sch.result_out(r, pam_name) for r, pam_name in rows], "total": uow.session.scalar(cq) or 0, "page": page,
                "pageSize": size, "counts": counts}


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return sch.run_out(runs.cancel(uow, run_id, actor))


@router.post("/runs/{run_id}/retry-failed")
def retry_failed(run_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return {"requeued": runs.retry_failed(uow, run_id, actor)}


@router.get("/runs/{run_id}/timeline")
def run_timeline(run_id: int) -> dict[str, Any]:
    """The run end to end: its upload, lifecycle, every PAM digest, every problem (retries,
    failures, skips), and per-minute research throughput."""
    with unit_of_work() as uow:
        run = runs.get_run(uow, run_id)
        return telemetry.run_timeline(uow, run.id, run.import_id, run_started=run.created_at)


@router.get("/runs/{run_id}/events")
def run_events(
    run_id: int, pg: tuple[int, int] = Depends(_page), kind: str | None = None, status: str | None = None,
    company_id: int | None = Query(None, alias="companyId"), lst: Listing = Depends(listing),
) -> dict[str, Any]:
    """Every process event of a run (one per research attempt, delivery attempt, …), newest first."""
    page, size = pg
    with unit_of_work() as uow:
        run = runs.get_run(uow, run_id)
        return telemetry.query(uow, page=page, size=size, kind=kind, status=status, run_id=run_id, company_id=company_id,
                               run_started=run.created_at, where=conditions(spec.EVENTS, lst),
                               order=ordering(spec.EVENTS, lst, [], ProcessEvent.id) if lst.sort else None)


@router.get("/runs/{run_id}/audit")
def run_audit(run_id: int, pg: tuple[int, int] = Depends(_page), lst: Listing = Depends(listing)) -> dict[str, Any]:
    """The run's audit trail (hash-chained rows tagged with this run), oldest first."""
    page, size = pg
    with unit_of_work() as uow:
        run = runs.get_run(uow, run_id)
        return telemetry.run_audit(uow, run_id, page, size, where=conditions(spec.AUDIT, lst),
                                   order=ordering(spec.AUDIT, lst, [], AuditLog.id) if lst.sort else None, run_started=run.created_at)


@router.get("/runs/{run_id}/costs")
def run_costs(run_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        run = runs.get_run(uow, run_id)
        return finops.run_costs(uow, run_id, run_started=run.created_at)


# --- Telemetry ---------------------------------------------------------------------------------


@router.get("/telemetry/summary")
def telemetry_summary(hours: int = Query(24, ge=1, le=24 * 31)) -> dict[str, Any]:
    def load():
        with unit_of_work() as uow:
            return telemetry.summary(uow, hours)

    return cache.cached("telemetry", f"summary:{hours}", 10, load)


@router.get("/telemetry/partitions")
def telemetry_partitions() -> dict[str, Any]:
    """Monthly partitions of the high-volume tables (`nov__2026__job`, …) with approximate rows and
    size (information_schema estimates; no table scans). Empty off MySQL."""
    from app.db import partitions

    return {"partitions": partitions.overview()}


DEFAULT_EVENT_HOURS = 24 * 7


@router.get("/telemetry/events")
def telemetry_events(
    pg: tuple[int, int] = Depends(_page), kind: str | None = None, status: str | None = None,
    run_id: int | None = Query(None, alias="runId"), import_id: int | None = Query(None, alias="importId"),
    hours: int | None = Query(None, ge=1, le=24 * 366), lst: Listing = Depends(listing),
) -> dict[str, Any]:
    """Event stream with filters. `kind` ending in "." is a prefix ("research.")."""
    from datetime import timedelta

    from app.core.timeutil import utcnow

    page, size = pg
    if hours is None and run_id is None and import_id is None:
        hours = DEFAULT_EVENT_HOURS  # an unbounded scan over every month of logs is never what the page needs
    with unit_of_work() as uow:
        return telemetry.query(uow, page=page, size=size, kind=kind, status=status, run_id=run_id, import_id=import_id,
                               since=utcnow() - timedelta(hours=hours) if hours else None,
                               where=conditions(spec.EVENTS, lst),
                               order=ordering(spec.EVENTS, lst, [], ProcessEvent.id) if lst.sort else None)


# --- Notifications -----------------------------------------------------------------------------


@router.get("/runs/{run_id}/notifications")
def run_notifications(run_id: int, pg: tuple[int, int] = Depends(_page), status: str | None = None,
                      lst: Listing = Depends(listing)) -> dict[str, Any]:
    """The run's digests (one per PAM × channel), paged, sortable and filterable by column."""
    page, size = pg
    with unit_of_work() as uow:
        runs.get_run(uow, run_id)
        r = notifications.outbox(uow, page=page, size=size, status=status, run_id=run_id,
                                 where=conditions(spec.NOTIFICATIONS, lst),
                                 order=ordering(spec.NOTIFICATIONS, lst, [], Notification.id) if lst.sort else [Notification.id])
        return {"rows": [sch.notification_out(n) for n in r["rows"]], "total": r["total"], "counts": r["counts"],
                "page": page, "pageSize": size}


@router.post("/notifications/{notification_id}/resend")
def resend(notification_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return sch.notification_out(notifications.resend(uow, notification_id, actor))


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
    return {"broker": depth, "db": cache.shared("queues", "db", QUEUE_COUNTS_TTL_S, outstanding_work)}


QUEUE_COUNTS_TTL_S = 5


def outstanding_work() -> dict[str, int]:
    """Outstanding work from the database (index-only counts on (status, enqueued_at)); shared by
    /queues and the Prometheus gauges through the cache, so polling never multiplies the scans."""
    with unit_of_work() as uow:
        s = uow.session
        return {
            "runsActive": s.scalar(select(func.count(Run.id)).where(Run.status.in_(RUN_ACTIVE))) or 0,
            "researchPending": s.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.status == RES_PENDING)) or 0,
            "researchRunning": s.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.status == RES_RUNNING)) or 0,
            "notificationsPending": s.scalar(select(func.count(Notification.id)).where(Notification.status == NOTE_PENDING)) or 0,
        }


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
    entity_id: str | None = Query(None, alias="entityId"), lst: Listing = Depends(listing),
) -> dict[str, Any]:
    page, size = pg
    with unit_of_work() as uow:
        conds = list(conditions(spec.AUDIT, lst))
        for col, val in ((AuditLog.action, action), (AuditLog.entity_type, entity_type), (AuditLog.entity_id, entity_id)):
            if val:
                conds.append(col == val)
        rows = uow.session.scalars(select(AuditLog).where(*conds)
                                   .order_by(*ordering(spec.AUDIT, lst, [], AuditLog.id.desc() if not lst.sort else AuditLog.id))
                                   .limit(size).offset(page * size))
        total, capped = telemetry.capped_count(uow, AuditLog.id, conds)  # never a full count(*) over every month
        return {"rows": [sch.audit_out(a) for a in rows], "total": total, "totalCapped": capped, "page": page, "pageSize": size}


@router.get("/audit/verify")
def verify_audit() -> dict[str, Any]:
    with unit_of_work() as uow:
        return audit.verify_chain(uow)
