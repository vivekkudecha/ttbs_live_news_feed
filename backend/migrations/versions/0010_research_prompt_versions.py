"""editable research prompt: research_prompt_versions + runs.prompt_version

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-09 16:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0010'
down_revision: Union[str, None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIG_ID = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table('research_prompt_versions',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('system_instruction', sa.Text(), nullable=False),
    sa.Column('research_prompt', sa.Text(), nullable=False),
    sa.Column('ttbs_context', sa.Text(), nullable=False),
    sa.Column('output_rules', sa.Text(), nullable=False),
    sa.Column('categories', JSON, nullable=False),
    sa.Column('window_days', sa.Integer(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', TS, nullable=False),
    sa.Column('created_by', sa.String(length=100), nullable=False),
    sa.Column('activated_at', TS, nullable=True),
    sa.Column('activated_by', sa.String(length=100), nullable=True),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_research_prompt_versions')),
    sa.UniqueConstraint('version', name=op.f('uq_research_prompt_versions_version')),
    )
    if op.get_bind().dialect.name == "mysql":
        # No partial indexes on MySQL: a functional index makes active=1 unique (NULLs are exempt).
        op.execute(sa.text("CREATE UNIQUE INDEX uq_research_prompt_versions_one_active ON research_prompt_versions "
                           "((CASE WHEN active = 1 THEN 1 ELSE NULL END))"))
    else:
        with op.batch_alter_table('research_prompt_versions', schema=None) as batch_op:
            batch_op.create_index('uq_research_prompt_versions_one_active', ['active'], unique=True,
                                  sqlite_where=sa.text('active'), postgresql_where=sa.text('active'))

    with op.batch_alter_table('runs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('prompt_version', sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('runs', schema=None) as batch_op:
        batch_op.drop_column('prompt_version')
    if op.get_bind().dialect.name == "mysql":
        op.execute(sa.text("DROP INDEX uq_research_prompt_versions_one_active ON research_prompt_versions"))
    op.drop_table('research_prompt_versions')
