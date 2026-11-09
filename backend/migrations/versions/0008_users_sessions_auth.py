"""users, sessions and password history (real authentication)

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-08 19:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0008'
down_revision: Union[str, None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIG_ID = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table('users',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('email', sa.String(length=320), nullable=True),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('permissions', JSON, nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('password_changed_at', TS, nullable=False),
    sa.Column('must_change_password', sa.Boolean(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('failed_login_count', sa.Integer(), nullable=False),
    sa.Column('locked_until', TS, nullable=True),
    sa.Column('last_login_at', TS, nullable=True),
    sa.Column('created_by', sa.String(length=100), nullable=False),
    sa.Column('created_at', TS, server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('updated_at', TS, server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('username', name=op.f('uq_users_username')),
    )
    op.create_table('user_sessions',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('csrf_token', sa.String(length=64), nullable=False),
    sa.Column('user_id', BIG_ID, nullable=False),
    sa.Column('created_at', TS, nullable=False),
    sa.Column('last_seen_at', TS, nullable=False),
    sa.Column('expires_at', TS, nullable=False),
    sa.Column('revoked_at', TS, nullable=True),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('user_agent', sa.String(length=300), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_user_sessions_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_sessions')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_user_sessions_token_hash')),
    )
    with op.batch_alter_table('user_sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_user_sessions_user_id'), ['user_id'], unique=False)

    op.create_table('password_history',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('user_id', BIG_ID, nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('created_at', TS, nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_password_history_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_password_history')),
    )
    with op.batch_alter_table('password_history', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_password_history_user_id'), ['user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('password_history', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_password_history_user_id'))
    op.drop_table('password_history')
    with op.batch_alter_table('user_sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_user_sessions_user_id'))
    op.drop_table('user_sessions')
    op.drop_table('users')
