"""Soft delete: nothing is hard-deleted. `archive()` moves rows into the table's `<table>_deleted`
sibling (same columns + deleted_at / deleted_by / delete_reason) and removes them from the live
table, in the caller's transaction, so the move is all-or-nothing.

For the monthly-partitioned tables the archive is partitioned the same way
(`nov__2026__job` -> `nov__2026__job_deleted`); after the commit the partition maintenance task
runs, so a month whose last live row was archived loses its (now empty) live partition.

The audit trail is never archived: removing audit rows would break the hash chain.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import delete, func, insert, literal, select

from app.core.errors import ValidationFailed
from app.core.timeutil import utcnow
from app.db import partitions
from app.db.models import ARCHIVE_TABLES, AuditLog, ResearchResult
from app.db.session import UnitOfWork
from app.services import audit

log = logging.getLogger(__name__)


def archive_table(model: Any):
    name = model.__table__.name
    table = ARCHIVE_TABLES.get(name)
    if table is None:
        raise ValidationFailed(f"'{name}' has no archive table and cannot be deleted")
    return table


def archive(uow: UnitOfWork, model: Any, *where: Any, actor: str, reason: str | None = None,
            record_audit: bool = True, entity_id: Any = None) -> int:
    """Move the rows of `model` matching `where` to `<table>_deleted`. Returns how many moved.

    `record_audit=False` when the caller already writes its own, more specific audit entry."""
    if model is AuditLog:
        raise ValidationFailed("Audit entries are append-only and are never deleted")
    if not where:
        raise ValidationFailed("Refusing to archive a whole table: give a condition")
    src = model.__table__
    dst = archive_table(model)
    cols = [c.name for c in src.columns]
    now = utcnow()
    s = uow.session
    s.flush()  # pending ORM changes to these rows must be in the copy
    companies = list(s.scalars(select(ResearchResult.company_id).where(*where).distinct())) if model is ResearchResult else []
    moved = s.execute(
        insert(dst).from_select(
            [*cols, "deleted_at", "deleted_by", "delete_reason"],
            select(*[src.c[c] for c in cols], literal(now, dst.c.deleted_at.type), literal(actor[:100]),
                   literal((reason or "")[:300] or None, dst.c.delete_reason.type)).where(*where),
        )
    ).rowcount or 0
    if not moved:
        return 0
    removed = s.execute(delete(model).where(*where).execution_options(synchronize_session="fetch")).rowcount or 0
    if removed != moved:  # a concurrent writer changed the set between the copy and the delete
        raise RuntimeError(f"archive of {src.name}: copied {moved} rows but removed {removed}; rolled back")
    if companies:  # the per-company signal roll-up must forget archived results
        from app.services import company_stats

        company_stats.rebuild(uow, companies)
    if record_audit:
        audit.record(uow, f"{src.name}.archive", src.name, entity_id, {"rows": moved, "reason": reason}, actor=actor)
    if src.name in partitions.PARTITIONED and not getattr(uow, "_partitions_maintenance_queued", False):
        uow._partitions_maintenance_queued = True  # once per transaction, however many tables were archived
        uow.after_commit(_maintain_partitions)
    log.info("rows archived", extra={"table": src.name, "rows": moved, "actor": actor})
    return moved


def count_archived(uow: UnitOfWork, model: Any, *where: Any) -> int:
    t = archive_table(model)
    return uow.session.scalar(select(func.count()).select_from(t).where(*where)) or 0


def _maintain_partitions() -> None:
    from app.worker.tasks import maintain_partitions

    maintain_partitions.apply_async()
