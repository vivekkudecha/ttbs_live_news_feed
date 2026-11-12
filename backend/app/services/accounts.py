"""Account ownership: who owns each logo comes from the uploads (services/imports.py); the only
manual changes are reassigning selected logos and editing a PAM's details. A PAM's load is the
number of active logos they own.
"""
from typing import Any

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import func, select

from app.core import cache
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import Company, Pam
from app.db.session import UnitOfWork
from app.services import assignments, audit
from app.services.imports import normalize_whatsapp


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


def update_pam(uow: UnitOfWork, pam_id: str, patch: dict[str, Any], actor: str) -> Pam:
    """Edit a PAM's contact details and delivery opt-outs; only the fields sent change.
    Uploads match PAMs by email and refresh name and WhatsApp, so the next upload listing this PAM wins."""
    p = uow.session.get(Pam, _parse_id(pam_id, "PAM"))
    if p is None:
        raise NotFound(f"PAM {pam_id} not found")
    before = {"name": p.name, "email": p.email, "whatsapp": p.whatsapp, "notifyEmail": p.notify_email, "notifyWhatsapp": p.notify_whatsapp}
    if "name" in patch:
        if not (name := str(patch["name"] or "").strip()):
            raise ValidationFailed("Name is required", details={"field": "name"})
        p.name = name
    if "email" in patch:
        try:
            email = validate_email(str(patch["email"] or "").strip(), check_deliverability=False).normalized.lower()
        except EmailNotValidError as e:
            raise ValidationFailed(f"Invalid email: {e}", details={"field": "email"}) from e
        if email != p.email and uow.session.scalar(select(Pam.id).where(Pam.email == email, Pam.id != p.id)):
            raise Conflict(f"Another PAM already uses {email}", details={"field": "email"})
        p.email = email
    if "whatsapp" in patch:
        raw = str(patch["whatsapp"] or "").strip()
        wa = normalize_whatsapp(raw, get_settings().import_default_country_code) if raw else None
        if raw and not wa:
            raise ValidationFailed(f"'{raw}' is not a valid mobile number", details={"field": "whatsapp"})
        p.whatsapp = wa
    if "notify_email" in patch:
        p.notify_email = bool(patch["notify_email"])
    if "notify_whatsapp" in patch:
        p.notify_whatsapp = bool(patch["notify_whatsapp"])
    after = {"name": p.name, "email": p.email, "whatsapp": p.whatsapp, "notifyEmail": p.notify_email, "notifyWhatsapp": p.notify_whatsapp}
    changed = {k: {"before": before[k], "after": after[k]} for k in after if before[k] != after[k]}
    if changed:
        uow.session.flush()
        audit.record(uow, "pam.update", "pam", p.id, {"name": p.name, "changes": changed}, actor=actor)
        uow.after_commit(lambda: cache.bump("accounts"))
    return p
