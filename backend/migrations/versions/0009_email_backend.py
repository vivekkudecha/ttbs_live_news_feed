"""email backend: Microsoft Graph config, quota buckets, templates, attempts, dead-letter queue

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-09 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '0009'
down_revision: Union[str, None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIG_ID = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')
TS = sa.DateTime(timezone=True)
NOW = sa.text('(CURRENT_TIMESTAMP)')


def upgrade() -> None:
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.add_column(sa.Column('template_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('template_version', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('rendered', JSON, nullable=True))
        batch_op.add_column(sa.Column('reserved_at', TS, nullable=True))
        batch_op.add_column(sa.Column('quota_key', BIG_ID, nullable=True))

    op.create_table('notification_attempts',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('notification_id', BIG_ID, nullable=False),
    sa.Column('attempt', sa.Integer(), nullable=False),
    sa.Column('started_at', TS, nullable=False),
    sa.Column('duration_ms', sa.Integer(), nullable=False),
    sa.Column('outcome', sa.String(length=20), nullable=False),
    sa.Column('adapter', sa.String(length=40), nullable=True),
    sa.Column('http_status', sa.Integer(), nullable=True),
    sa.Column('error_code', sa.String(length=100), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('retryable', sa.Boolean(), nullable=True),
    sa.Column('provider_request_id', sa.String(length=100), nullable=True),
    sa.ForeignKeyConstraint(['notification_id'], ['notifications.id'], name=op.f('fk_notification_attempts_notification_id_notifications'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_notification_attempts')),
    )
    with op.batch_alter_table('notification_attempts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_notification_attempts_notification_id'), ['notification_id'], unique=False)

    op.create_table('dead_letters',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('notification_id', BIG_ID, nullable=False),
    sa.Column('run_id', sa.Integer(), nullable=True),
    sa.Column('pam_id', sa.Integer(), nullable=True),
    sa.Column('channel', sa.String(length=20), nullable=False),
    sa.Column('recipient', sa.String(length=320), nullable=True),
    sa.Column('subject', sa.String(length=500), nullable=True),
    sa.Column('reason', sa.String(length=20), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('snapshot', JSON, nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('created_at', TS, nullable=False),
    sa.Column('resolved_at', TS, nullable=True),
    sa.Column('resolved_by', sa.String(length=100), nullable=True),
    sa.Column('resolution_note', sa.String(length=1000), nullable=True),
    sa.ForeignKeyConstraint(['notification_id'], ['notifications.id'], name=op.f('fk_dead_letters_notification_id_notifications'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_dead_letters')),
    )
    with op.batch_alter_table('dead_letters', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_dead_letters_notification_id'), ['notification_id'], unique=False)
        batch_op.create_index('ix_dead_letters_status_created', ['status', 'created_at'], unique=False)

    op.create_table('email_config',
    sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('tenant_id', sa.String(length=100), nullable=False),
    sa.Column('client_id', sa.String(length=100), nullable=False),
    sa.Column('client_secret_enc', sa.Text(), nullable=False),
    sa.Column('secret_hint', sa.String(length=40), nullable=False),
    sa.Column('sender_address', sa.String(length=320), nullable=False),
    sa.Column('sender_name', sa.String(length=200), nullable=True),
    sa.Column('reply_to', sa.String(length=320), nullable=True),
    sa.Column('save_to_sent', sa.Boolean(), nullable=False),
    sa.Column('per_minute', sa.Integer(), nullable=False),
    sa.Column('per_hour', sa.Integer(), nullable=False),
    sa.Column('per_day', sa.Integer(), nullable=False),
    sa.Column('safety_margin_pct', sa.Integer(), nullable=False),
    sa.Column('max_attempts', sa.Integer(), nullable=False),
    sa.Column('backoff_base_s', sa.Integer(), nullable=False),
    sa.Column('backoff_cap_s', sa.Integer(), nullable=False),
    sa.Column('send_when_no_signals', sa.Boolean(), nullable=False),
    sa.Column('paused_until', TS, nullable=True),
    sa.Column('pause_reason', sa.String(length=300), nullable=True),
    sa.Column('verified_at', TS, nullable=True),
    sa.Column('last_check_ok', sa.Boolean(), nullable=False),
    sa.Column('last_check_error', sa.Text(), nullable=True),
    sa.Column('last_check_latency_ms', sa.Integer(), nullable=True),
    sa.Column('updated_by', sa.String(length=100), nullable=False),
    sa.Column('created_at', TS, server_default=NOW, nullable=False),
    sa.Column('updated_at', TS, server_default=NOW, nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_email_config')),
    )

    op.create_table('email_send_buckets',
    sa.Column('minute_key', sa.BigInteger(), autoincrement=False, nullable=False),
    sa.Column('used', sa.Integer(), nullable=False),
    sa.PrimaryKeyConstraint('minute_key', name=op.f('pk_email_send_buckets')),
    )

    op.create_table('email_templates',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('description', sa.String(length=1000), nullable=True),
    sa.Column('subject_tpl', sa.Text(), nullable=False),
    sa.Column('html_tpl', sa.Text(), nullable=False),
    sa.Column('text_tpl', sa.Text(), nullable=False),
    sa.Column('ai_enabled', sa.Boolean(), nullable=False),
    sa.Column('ai_prompt', sa.Text(), nullable=True),
    sa.Column('ai_max_words', sa.Integer(), nullable=False),
    sa.Column('ai_on_failure', sa.String(length=20), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('updated_by', sa.String(length=100), nullable=False),
    sa.Column('created_at', TS, server_default=NOW, nullable=False),
    sa.Column('updated_at', TS, server_default=NOW, nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_email_templates')),
    sa.UniqueConstraint('name', name=op.f('uq_email_templates_name')),
    )
    if op.get_bind().dialect.name == "mysql":
        # No partial indexes on MySQL: a functional index makes active=1 unique (NULLs are exempt).
        op.execute(sa.text("CREATE UNIQUE INDEX uq_email_templates_one_active ON email_templates ((CASE WHEN active = 1 THEN 1 ELSE NULL END))"))
    else:
        with op.batch_alter_table('email_templates', schema=None) as batch_op:
            batch_op.create_index('uq_email_templates_one_active', ['active'], unique=True, sqlite_where=sa.text('active'), postgresql_where=sa.text('active'))

    op.create_table('email_template_versions',
    sa.Column('id', BIG_ID, autoincrement=True, nullable=False),
    sa.Column('template_id', BIG_ID, nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('snapshot', JSON, nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', TS, nullable=False),
    sa.Column('created_by', sa.String(length=100), nullable=False),
    sa.ForeignKeyConstraint(['template_id'], ['email_templates.id'], name=op.f('fk_email_template_versions_template_id_email_templates'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_email_template_versions')),
    sa.UniqueConstraint('template_id', 'version', name='uq_email_template_versions_tpl_ver'),
    )
    with op.batch_alter_table('email_template_versions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_email_template_versions_template_id'), ['template_id'], unique=False)


def downgrade() -> None:
    op.drop_table('email_template_versions')
    if op.get_bind().dialect.name == "mysql":
        op.execute(sa.text("DROP INDEX uq_email_templates_one_active ON email_templates"))
    op.drop_table('email_templates')
    op.drop_table('email_send_buckets')
    op.drop_table('email_config')
    op.drop_table('dead_letters')
    op.drop_table('notification_attempts')
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_column('quota_key')
        batch_op.drop_column('reserved_at')
        batch_op.drop_column('rendered')
        batch_op.drop_column('template_version')
        batch_op.drop_column('template_id')
