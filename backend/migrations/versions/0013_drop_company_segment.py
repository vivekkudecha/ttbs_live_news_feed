"""drop companies.segment: segment is no longer part of the product

Uploads ignore a Segment column, PAMs are rebalanced by load alone, and no screen shows or filters
by segment. The stored values are dropped; a downgrade brings the column back empty.

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-11 10:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0013'
down_revision: str | None = '0012'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('companies', schema=None) as batch_op:
        batch_op.drop_column('segment')


def downgrade() -> None:
    with op.batch_alter_table('companies', schema=None) as batch_op:
        batch_op.add_column(sa.Column('segment', sa.String(length=40), nullable=True))
