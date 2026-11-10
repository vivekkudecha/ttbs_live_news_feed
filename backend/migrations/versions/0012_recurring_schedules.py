"""recurring schedules: repeat rule (interval | weekly | monthly), end date, last outcome; schedules_deleted

Schedules were retired in 0006 (rows disabled, kept for history). They return as a feature: a
schedule fires an ordinary run of a fixed upload, or of the latest upload, on a repeat rule.
Existing rows stay disabled and read as every-N-days schedules.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-10 10:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0012'
down_revision: Union[str, None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIG_ID = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')
TS = sa.DateTime(timezone=True)

NEW_COLUMNS = (
    ("frequency", sa.String(10), "'interval'"),
    ("weekdays", JSON, None),
    ("month_day", sa.Integer(), None),
    ("ends_on", sa.Date(), None),
    ("last_outcome", sa.String(10), None),
    ("last_error", sa.String(500), None),
    ("last_run_id", sa.BigInteger(), None),
)


def upgrade() -> None:
    with op.batch_alter_table('schedules', schema=None) as batch_op:
        for name, type_, default in NEW_COLUMNS:
            batch_op.add_column(sa.Column(name, type_, nullable=True, server_default=sa.text(default) if default else None))
    op.execute("UPDATE schedules SET frequency = 'interval' WHERE frequency IS NULL")
    with op.batch_alter_table('schedules', schema=None) as batch_op:
        batch_op.alter_column('frequency', existing_type=sa.String(10), nullable=False, server_default=None)

    # Archive for deleted schedules (services/soft_delete.py): the live columns + who/when/why.
    bind = op.get_bind()
    src = sa.Table('schedules', sa.MetaData(), autoload_with=bind)
    cols = [sa.Column('archive_id', BIG_ID, autoincrement=True, nullable=False)]
    cols += [sa.Column(c.name, c.type, nullable=True) for c in src.columns]
    cols += [sa.Column('deleted_at', TS, nullable=False), sa.Column('deleted_by', sa.String(100), nullable=False),
             sa.Column('delete_reason', sa.String(300), nullable=True)]
    kw = {"mysql_row_format": "COMPRESSED"} if bind.dialect.name == "mysql" else {}
    op.create_table('schedules_deleted', *cols, sa.PrimaryKeyConstraint('archive_id', name='pk_schedules_deleted'), **kw)
    op.create_index('ix_schedules_deleted_id', 'schedules_deleted', ['id'])
    op.create_index('ix_schedules_deleted_deleted_at', 'schedules_deleted', ['deleted_at'])


def downgrade() -> None:
    op.drop_table('schedules_deleted')
    with op.batch_alter_table('schedules', schema=None) as batch_op:
        for name, _, _ in reversed(NEW_COLUMNS):
            batch_op.drop_column(name)
