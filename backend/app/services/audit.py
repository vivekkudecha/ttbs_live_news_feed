"""Audit trail. `record()` writes inside the caller's transaction, so the audit row commits or
rolls back together with the change it describes."""

import hashlib
import json
from typing import Any

from sqlalchemy import select

from app.core.context import actor_var, client_ip_var, request_id_var, user_agent_var
from app.core.timeutil import utcnow
from app.db.models import AuditLog
from app.db.session import LOCK_AUDIT_CHAIN, UnitOfWork

GENESIS = "0" * 64


def _digest(prev_hash: str, row: dict[str, Any]) -> str:
    body = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(f"{prev_hash}|{body}".encode()).hexdigest()


def _content(a: AuditLog) -> dict[str, Any]:
    return {
        "ts": a.ts.isoformat() if a.ts else None,
        "actor": a.actor,
        "action": a.action,
        "entity_type": a.entity_type,
        "entity_id": a.entity_id,
        "detail": a.detail,
    }


def record(
    uow: UnitOfWork,
    action: str,
    entity_type: str,
    entity_id: Any = None,
    detail: dict[str, Any] | None = None,
    *,
    actor: str | None = None,
) -> AuditLog:
    uow.advisory_lock(LOCK_AUDIT_CHAIN)  # serialise the chain across concurrent writers
    s = uow.session
    prev = s.execute(select(AuditLog.hash).order_by(AuditLog.id.desc()).limit(1)).scalar() or GENESIS
    entry = AuditLog(
        ts=utcnow().replace(microsecond=0),
        actor=actor or actor_var.get() or "system",
        action=action,
        entity_type=entity_type,
        entity_id=None if entity_id is None else str(entity_id),
        detail=detail or {},
        request_id=request_id_var.get(),
        ip=client_ip_var.get(),
        user_agent=(user_agent_var.get() or "")[:300] or None,
        prev_hash=prev,
    )
    entry.hash = _digest(prev, _content(entry))
    s.add(entry)
    s.flush()
    return entry


def verify_chain(uow: UnitOfWork, batch: int = 5000) -> dict[str, Any]:
    """Recompute the chain. Returns the first broken row id, if any."""
    from app.core.timeutil import as_utc

    prev, checked, last_id = GENESIS, 0, 0
    while True:
        rows = uow.session.scalars(
            select(AuditLog).where(AuditLog.id > last_id).order_by(AuditLog.id).limit(batch)
        ).all()
        if not rows:
            return {"ok": True, "checked": checked}
        for a in rows:
            a_ts = as_utc(a.ts)
            content = _content(a) | {"ts": a_ts.isoformat() if a_ts else None}
            if a.prev_hash != prev or a.hash != _digest(prev, content):
                return {"ok": False, "checked": checked, "broken_at_id": a.id}
            prev, checked, last_id = a.hash, checked + 1, a.id
