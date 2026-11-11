"""Account ownership commands: manual reassignment and PAM deactivation with auto-rebalancing.

A PAM's load is the number of active companies they own.
"""

from typing import Any

from sqlalchemy import func, select

from app.core import cache
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import Company, Pam
from app.db.session import UnitOfWork
from app.services import assignments, audit


def pam_profiles(uow: UnitOfWork) -> dict[int, int]:
    """Load per PAM: how many active companies each owns."""
    rows = uow.session.execute(
        select(Company.pam_id, func.count(Company.id))
        .where(Company.active.is_(True), Company.pam_id.is_not(None))
        .group_by(Company.pam_id)
    )
    return {pam_id: n for pam_id, n in rows}


def _parse_id(value: str | int, what: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise NotFound(f"{what} {value} not found") from e


def rebalance_plan(uow: UnitOfWork, pam_id: str | int) -> dict[str, Any]:
    """Where each company of a leaving PAM would go: the least-loaded active PAM (by name on a tie),
    one company at a time, so the leaving PAM's companies spread out within capacity."""
    pid = _parse_id(pam_id, "PAM")
    leaving = uow.session.get(Pam, pid)
    if leaving is None:
        raise NotFound(f"PAM {pam_id} not found")
    capacity = get_settings().pam_default_capacity
    loads = pam_profiles(uow)
    others = list(uow.session.scalars(select(Pam).where(Pam.active.is_(True), Pam.id != pid)))
    companies = list(uow.session.scalars(select(Company).where(Company.pam_id == pid, Company.active.is_(True)).order_by(Company.name)))
    if companies and not others:
        raise Conflict("There is no other active PAM to take over these companies", code="no_target_pam")

    load = {p.id: loads.get(p.id, 0) for p in others}
    moves, names = [], {}
    for c in companies:
        best = min(others, key=lambda p: (load[p.id], p.name))
        reason = "Least-loaded active PAM" if load[best.id] < capacity else "Every PAM is at capacity; least-loaded"
        load[best.id] += 1
        moves.append({"companyId": str(c.id), "fromPamId": str(pid), "toPamId": str(best.id), "reason": reason})
        names[str(c.id)] = c.name
        names[str(best.id)] = best.name
    return {"pamId": str(pid), "moves": moves, "names": names}


def deactivate_pam(uow: UnitOfWork, pam_id: str | int, actor: str) -> dict[str, Any]:
    plan = rebalance_plan(uow, pam_id)
    pam = uow.session.get(Pam, int(plan["pamId"]))
    if not pam.active:
        raise Conflict(f"{pam.name} is already inactive")
    now = utcnow()
    pam.active = False
    companies = {c.id: c for c in uow.session.scalars(select(Company).where(Company.pam_id == pam.id))}
    for m in plan["moves"]:
        assignments.assign(uow, companies[int(m["companyId"])], int(m["toPamId"]), reason="rebalance", actor=actor, ts=now)
    audit.record(uow, "pam.deactivate", "pam", pam.id, {"pam": pam.name, "companies_moved": len(plan["moves"])}, actor=actor)
    uow.after_commit(lambda: cache.bump("accounts"))
    return {"pamId": plan["pamId"], "moves": plan["moves"]}


def reassign(uow: UnitOfWork, company_ids: list[str], to_pam_id: str, actor: str) -> int:
    if not company_ids:
        raise ValidationFailed("Choose at least one company")
    to = uow.session.get(Pam, _parse_id(to_pam_id, "PAM"))
    if to is None:
        raise NotFound(f"PAM {to_pam_id} not found")
    if not to.active:
        raise ValidationFailed(f"{to.name} is inactive")
    ids = [_parse_id(x, "Company") for x in company_ids]
    companies = list(uow.session.scalars(select(Company).where(Company.id.in_(ids))))
    if len(companies) != len(set(ids)):
        raise NotFound("Some companies were not found")
    now = utcnow()
    moved = sum(assignments.assign(uow, c, to.id, reason="manual", actor=actor, ts=now) for c in companies)
    audit.record(uow, "company.reassign", "pam", to.id, {"to": to.name, "companies": len(companies), "moved": moved}, actor=actor)
    uow.after_commit(lambda: cache.bump("accounts"))
    return moved
