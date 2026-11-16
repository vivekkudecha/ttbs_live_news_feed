"""data fix: manual reassignments made before they reached uploads

Runs take each logo's PAM from its upload's mapping (dataset_companies.pam_id). Until now a manual
reassign only changed the logo's owner, so re-running an older upload still delivered to the PAM in the
file. Reassign now also updates the uploads; this applies the same to reassignments made earlier:
a logo whose current owner came from a manual reassign made after an upload was saved gets that
owner in that upload. Uploads saved after the reassign (their own mapping) are left alone.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-16 14:00:00.000000
"""
from collections import defaultdict
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0017'
down_revision: str | None = '0016'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_md = sa.MetaData()
_dc = sa.Table('dataset_companies', _md, sa.Column('id'), sa.Column('import_id'), sa.Column('company_id'), sa.Column('pam_id'))
_co = sa.Table('companies', _md, sa.Column('id'), sa.Column('pam_id'))
_ib = sa.Table('import_batches', _md, sa.Column('id'), sa.Column('created_at'))
_ca = sa.Table('company_assignments', _md, sa.Column('company_id'), sa.Column('reason'), sa.Column('valid_from'), sa.Column('valid_to'))


def sync(bind) -> int:
    """Point upload rows at the owner a later manual reassign chose. Returns the rows changed."""
    rows = bind.execute(
        sa.select(_dc.c.id, _co.c.pam_id)
        .select_from(_dc.join(_co, _co.c.id == _dc.c.company_id).join(_ib, _ib.c.id == _dc.c.import_id)
                     .join(_ca, sa.and_(_ca.c.company_id == _co.c.id, _ca.c.valid_to.is_(None))))
        .where(_ca.c.reason == 'manual', _ca.c.valid_from > _ib.c.created_at, _co.c.pam_id.is_not(None),
               sa.or_(_dc.c.pam_id.is_(None), _dc.c.pam_id != _co.c.pam_id))
    ).all()
    by_pam: dict[int, list[int]] = defaultdict(list)
    for row_id, pam_id in rows:
        by_pam[pam_id].append(row_id)
    for pam_id, ids in by_pam.items():
        for i in range(0, len(ids), 1000):
            bind.execute(sa.update(_dc).where(_dc.c.id.in_(ids[i:i + 1000])).values(pam_id=pam_id))
    return len(rows)


def upgrade() -> None:
    sync(op.get_bind())


def downgrade() -> None:
    pass  # a data fix: the earlier mapping is not kept
