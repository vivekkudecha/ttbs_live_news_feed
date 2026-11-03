"""Company → PAM ownership with history. Every ownership change goes through `assign` so the
current owner (companies.pam_id) and the history (company_assignments) never disagree."""

from datetime import datetime

from sqlalchemy import update

from app.db.models import Company, CompanyAssignment
from app.db.session import UnitOfWork


def assign(uow: UnitOfWork, company: Company, pam_id: int, *, reason: str, actor: str, ts: datetime) -> bool:
    """Make `pam_id` the owner from `ts`. Returns False when it already is (no history row)."""
    if company.pam_id == pam_id and company.id is not None:
        return False
    if company.id is None:
        uow.session.flush()
    uow.session.execute(
        update(CompanyAssignment)
        .where(CompanyAssignment.company_id == company.id, CompanyAssignment.valid_to.is_(None))
        .values(valid_to=ts)
    )
    uow.session.add(CompanyAssignment(company_id=company.id, pam_id=pam_id, valid_from=ts, valid_to=None, reason=reason, actor=actor))
    company.pam_id = pam_id
    return True
