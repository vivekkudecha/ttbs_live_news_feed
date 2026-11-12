"""cost_ledger: the provider's usage breakdown per LLM call

Each research / AI-summary call now keeps the provider's usage report as billed: cache read/write
tokens, reasoning tokens, tool calls (web searches), the cost split (input, output, cache, tools),
whether the cost came from the provider or from our price settings, the provider's response id and
the raw usage object. Older rows keep zeros and a NULL cost_source ("not captured").

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-12 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0014'
down_revision: str | None = '0013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')
COLUMNS = (
    ("cache_read_tokens", sa.Integer(), "0"),
    ("cache_write_tokens", sa.Integer(), "0"),
    ("reasoning_tokens", sa.Integer(), "0"),
    ("tool_calls", sa.Integer(), "0"),
    ("input_cost", sa.Float(), "0"),
    ("output_cost", sa.Float(), "0"),
    ("cache_cost", sa.Float(), "0"),
    ("tool_cost", sa.Float(), "0"),
    ("cost_source", sa.String(12), None),
    ("response_id", sa.String(120), None),
    ("usage_raw", JSON, None),
)


def upgrade() -> None:
    with op.batch_alter_table('cost_ledger', schema=None) as batch_op:
        for name, type_, default in COLUMNS:
            batch_op.add_column(sa.Column(name, type_, nullable=default is None,
                                          server_default=sa.text(default) if default else None))


def downgrade() -> None:
    with op.batch_alter_table('cost_ledger', schema=None) as batch_op:
        for name, _, _ in reversed(COLUMNS):
            batch_op.drop_column(name)
