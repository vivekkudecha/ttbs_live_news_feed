"""runs: automatic recovery rounds for logos whose retries ran out

A finished run with such logos (provider outage, 5xx) retries them on its own after 10, 30 and 90
minutes: `recovery_round` counts the rounds done, `recover_at` is when the next one is due.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-12 14:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0015'
down_revision: str | None = '0014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('runs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('recovery_round', sa.Integer(), nullable=False, server_default=sa.text('0')))
        batch_op.add_column(sa.Column('recover_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index('ix_runs_recover_at', ['recover_at'])


def downgrade() -> None:
    with op.batch_alter_table('runs', schema=None) as batch_op:
        batch_op.drop_index('ix_runs_recover_at')
        batch_op.drop_column('recover_at')
        batch_op.drop_column('recovery_round')
