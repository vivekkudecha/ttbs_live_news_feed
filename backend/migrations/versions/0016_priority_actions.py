"""PRIORITY ACTIONS: pam_priorities, a priority model per AI provider, priority rules on prompt versions

- pam_priorities: one row per run x PAM with the AI's ranked "Why now? / Action:" list.
- llm_provider_configs.priority_model(_provider): a cheaper model for it (None = the research model).
- research_prompt_versions.priority_rules / priority_limit: editable, versioned rules and actions per PAM;
  research_version: the version whose research text a version uses (the result-cache key), so editing
  only the priority rules keeps cached research answers. Existing versions use their own number.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-16 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0016'
down_revision: str | None = '0015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BIG_ID = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        'pam_priorities',
        sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
        sa.Column('run_id', sa.BigInteger(), nullable=False),
        sa.Column('pam_id', sa.BigInteger(), nullable=False),
        sa.Column('status', sa.String(10), nullable=False),
        sa.Column('signals_key', sa.String(64), nullable=False),
        sa.Column('actions', JSON, nullable=False),
        sa.Column('provider', sa.String(40), nullable=True),
        sa.Column('model', sa.String(200), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('created_at', TS, server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', TS, server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id', name='pk_pam_priorities'),
        sa.UniqueConstraint('run_id', 'pam_id', name='uq_pam_priorities_run_pam'),
    )
    op.create_index('ix_pam_priorities_status_updated', 'pam_priorities', ['status', 'updated_at'])
    with op.batch_alter_table('llm_provider_configs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('priority_model', sa.String(200), nullable=True))
        batch_op.add_column(sa.Column('priority_model_provider', sa.String(60), nullable=True))
    with op.batch_alter_table('research_prompt_versions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('priority_rules', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('priority_limit', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('research_version', sa.Integer(), nullable=True))
    op.execute("UPDATE research_prompt_versions SET research_version = version WHERE research_version IS NULL")


def downgrade() -> None:
    with op.batch_alter_table('research_prompt_versions', schema=None) as batch_op:
        batch_op.drop_column('research_version')
        batch_op.drop_column('priority_limit')
        batch_op.drop_column('priority_rules')
    with op.batch_alter_table('llm_provider_configs', schema=None) as batch_op:
        batch_op.drop_column('priority_model_provider')
        batch_op.drop_column('priority_model')
    op.drop_index('ix_pam_priorities_status_updated', table_name='pam_priorities')
    op.drop_table('pam_priorities')
