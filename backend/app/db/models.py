"""ORM models for the first backend slice: import → schedule → research → results → notify.

Region/zone is intentionally absent: TTBS does not organise accounts by zone.
"""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import partitions as part
from app.db.base import Base, BigId, TimestampMixin

# Monthly partition key (YYYYMM). Filled by context-sensitive defaults (app/db/partitions.py).
PART_DOC = "monthly partition key, YYYYMM (see app/db/partitions.py)"

# --- Status vocabularies (kept as strings: readable in SQL, no enum migrations) ------------
IMPORT_PREVIEWED, IMPORT_COMMITTED, IMPORT_FAILED = "previewed", "committed", "failed"  # previewed/committed: legacy
# Upload lifecycle (files up to 1 GB, streamed, never held in memory):
#   analyzing (background check of every row) → previewed (user reviews, names it) → [discarded]
#   → queued → processing (resumable, chunked) → completed | failed
IMPORT_QUEUED, IMPORT_PROCESSING, IMPORT_COMPLETED = "queued", "processing", "completed"
IMPORT_ANALYZING, IMPORT_DISCARDED = "analyzing", "discarded"
IMPORT_ACTIVE = (IMPORT_QUEUED, IMPORT_PROCESSING)
IMPORT_UNSAVED = (IMPORT_ANALYZING, IMPORT_PREVIEWED, IMPORT_DISCARDED)  # not a dataset yet: hidden from lists

RUN_SCHEDULED = "scheduled"  # waiting for scheduled_for
RUN_QUEUED = "queued"  # handed to the queue, start_run not yet picked up
RUN_RUNNING = "running"
RUN_COMPLETED = "completed"  # every company researched, none failed
RUN_PARTIAL = "partial"  # finished, some companies failed
RUN_FAILED = "failed"  # finished, all failed (or could not start)
RUN_CANCELLED = "cancelled"
RUN_ACTIVE = (RUN_SCHEDULED, RUN_QUEUED, RUN_RUNNING)

RES_PENDING, RES_RUNNING = "pending", "running"
RES_SIGNAL, RES_NO_SIGNAL, RES_FAILED = "signal", "no_signal", "failed"
RES_TERMINAL = (RES_SIGNAL, RES_NO_SIGNAL, RES_FAILED)

NOTE_PENDING, NOTE_SENDING, NOTE_SENT = "pending", "sending", "sent"
NOTE_FAILED, NOTE_SKIPPED = "failed", "skipped"

SEGMENTS = ("Enterprise", "Mid-market", "Emerging")
CHANNELS = ("email", "whatsapp")


class Pam(TimestampMixin, Base):
    __tablename__ = "pams"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), unique=True)  # stored lower-cased
    whatsapp: Mapped[str | None] = mapped_column(String(20))  # E.164, e.g. +919810011001
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_email: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_whatsapp: Mapped[bool] = mapped_column(Boolean, default=True)


class LlmProviderConfig(TimestampMixin, Base):
    """Credentials + model choice for a research provider, set from the UI. One row per provider;
    exactly one row may be `active` (the AI that research runs use), enforced by a partial unique
    index. The API key is AES-GCM encrypted (app/core/secrets.py) and never returned by the API."""

    __tablename__ = "llm_provider_configs"
    __table_args__ = (
        Index("uq_llm_provider_configs_one_active", "active", unique=True, sqlite_where=text("active"), postgresql_where=text("active")),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(40), unique=True)  # "perplexity" | "gemini"
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    api_key_enc: Mapped[str] = mapped_column(Text)
    key_hint: Mapped[str] = mapped_column(String(40))  # "pplx-…a1b2"
    model: Mapped[str] = mapped_column(String(200))  # "anthropic/claude-sonnet-5"
    model_provider: Mapped[str] = mapped_column(String(60))  # "anthropic" (owned_by)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_check_ok: Mapped[bool] = mapped_column(Boolean, default=True)
    last_check_error: Mapped[str | None] = mapped_column(Text)
    last_check_latency_ms: Mapped[int | None] = mapped_column(Integer)
    updated_by: Mapped[str] = mapped_column(String(100))


class Company(TimestampMixin, Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(300))
    # Upper-cased, punctuation-free form: "Pine Labs Pvt. Ltd" and "PINE LABS PVT LTD" are one logo.
    name_key: Mapped[str] = mapped_column(String(300), unique=True)
    industry: Mapped[str | None] = mapped_column(String(200))
    segment: Mapped[str | None] = mapped_column(String(40))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    pam_id: Mapped[int | None] = mapped_column(ForeignKey("pams.id"), index=True)
    last_import_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"), index=True)

    pam: Mapped[Pam | None] = relationship(lazy="joined")


class CompanyAssignment(Base):
    """Who owned a company when (SCD type 2): exactly one open row (valid_to IS NULL) per assigned
    company. Written by imports, manual reassignment and PAM deactivation rebalancing."""

    __tablename__ = "company_assignments"
    __table_args__ = (Index("ix_company_assignments_company_open", "company_id", "valid_to"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"))
    pam_id: Mapped[int] = mapped_column(ForeignKey("pams.id"), index=True)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    valid_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str] = mapped_column(String(20))  # import | manual | rebalance
    actor: Mapped[str] = mapped_column(String(100))


class ImportBatch(TimestampMixin, Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    file_name: Mapped[str] = mapped_column(String(255))
    file_sha256: Mapped[str] = mapped_column(String(64), index=True)
    uploaded_by: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default=IMPORT_PREVIEWED)
    rows_total: Mapped[int] = mapped_column(Integer, default=0)
    rows_valid: Mapped[int] = mapped_column(Integer, default=0)
    rows_error: Mapped[int] = mapped_column(Integer, default=0)
    # Normalised, validated rows kept between preview and commit (the file itself is not stored).
    rows: Mapped[list[Any]] = mapped_column(default=list)
    issues: Mapped[list[Any]] = mapped_column(default=list)
    summary: Mapped[dict[str, Any]] = mapped_column(default=dict)
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # finished saving
    error: Mapped[str | None] = mapped_column(Text)
    # Dataset fields: a user label, and a resumable cursor into `rows` (rows_done rows are saved;
    # each chunk advances it in the same transaction as the rows it saved).
    label: Mapped[str] = mapped_column(String(200), default="")
    rows_done: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_token: Mapped[str | None] = mapped_column(String(64))  # owner of the current processing lease
    failures: Mapped[int] = mapped_column(Integer, default=0)
    # The original file as uploaded, kept under UPLOAD_DIR as "<UTC timestamp>_<id>_<name>.<ext>".
    stored_file: Mapped[str | None] = mapped_column(String(300))


class DatasetCompany(Base):
    """Membership: which companies an uploaded dataset contains (a company can be in several)."""

    __tablename__ = "dataset_companies"
    __table_args__ = (UniqueConstraint("import_id", "company_id", name="uq_dataset_companies_import_company"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    import_id: Mapped[int] = mapped_column(ForeignKey("import_batches.id", ondelete="CASCADE"))
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    row_no: Mapped[int] = mapped_column(Integer, default=0)  # sheet row, for "row 12" references
    # The PAM this upload mapped the logo to. A run of this upload (including a re-run months
    # later) delivers to this PAM, even if a newer upload has since moved the logo elsewhere.
    pam_id: Mapped[int | None] = mapped_column(ForeignKey("pams.id"), index=True)


class Schedule(TimestampMixin, Base):
    """A recurring research job (services/schedules.py). Each firing creates an ordinary run.

    Repeat rule: `frequency` interval (every `interval_days`) | weekly (on `weekdays`, 0 = Mon) |
    monthly (on `month_day`, clamped to the month's last day), at `run_at_time` in `timezone`,
    until `ends_on` (inclusive) if set. Target (`scope_key`): "import:<id>" = always that upload;
    "latest" = the newest saved upload at firing time. `channels` [] = research only, no digests.
    """

    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200))
    frequency: Mapped[str] = mapped_column(String(10), default="interval")
    interval_days: Mapped[int] = mapped_column(Integer)
    weekdays: Mapped[list[Any] | None] = mapped_column(default=list)
    month_day: Mapped[int | None] = mapped_column(Integer)
    run_at_time: Mapped[str] = mapped_column(String(5))  # "HH:MM" in `timezone`
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    ends_on: Mapped[date | None] = mapped_column(Date)
    scope_key: Mapped[str] = mapped_column(String(100), default="all")
    template_id: Mapped[str] = mapped_column(String(50), default="t1")
    channels: Mapped[list[Any]] = mapped_column(default=lambda: ["email", "whatsapp"])
    budget_cap: Mapped[float | None] = mapped_column(Float)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Outcome of the latest firing: started | skipped | failed (+ why, and the run it created).
    last_outcome: Mapped[str | None] = mapped_column(String(10))
    last_error: Mapped[str | None] = mapped_column(String(500))
    last_run_id: Mapped[int | None] = mapped_column(BigInteger)  # no FK: runs already reference schedules
    created_by: Mapped[str] = mapped_column(String(100))


class Run(TimestampMixin, Base):
    """One research job over a scope of companies."""

    __tablename__ = "runs"
    __table_args__ = (Index("ix_runs_status_scheduled_for", "status", "scheduled_for"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(300))
    trigger: Mapped[str] = mapped_column(String(20))  # adhoc | scheduled | import
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("schedules.id"))
    import_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"))
    scope_key: Mapped[str] = mapped_column(String(100))
    template_id: Mapped[str] = mapped_column(String(50), default="t1")
    channels: Mapped[list[Any]] = mapped_column(default=list)
    budget_cap: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default=RUN_QUEUED)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    window_start: Mapped[date | None] = mapped_column(Date)
    window_end: Mapped[date | None] = mapped_column(Date)
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(100))
    prompt_version: Mapped[int | None] = mapped_column(Integer)  # research prompt version, pinned when the run starts
    triggered_by: Mapped[str] = mapped_column(String(100))
    total: Mapped[int] = mapped_column(Integer, default=0)
    done: Mapped[int] = mapped_column(Integer, default=0)
    with_signal: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    cache_hits: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str | None] = mapped_column(Text)
    # Month of `scheduled_for`: every job, notification and retry of this run lives in this month's partition.
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_for_run, doc=PART_DOC)


class ResearchResult(TimestampMixin, Base):
    __tablename__ = "research_results"
    # MySQL: RANGE-partitioned by part_month (`nov__2026__job`); every unique key carries part_month,
    # and foreign keys are not allowed on partitioned tables (integrity is kept by the services).
    __table_args__ = (
        UniqueConstraint("run_id", "company_id", "part_month", name="uq_research_results_run_company"),
        Index("ix_research_results_run_pam_status", "run_id", "pam_id", "status"),
        Index("ix_research_results_run_status_fin", "run_id", "status", "finished_at"),
        Index("ix_research_results_company_status", "company_id", "status"),
        Index("ix_research_results_status_enq", "status", "enqueued_at"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(BigId)
    company_id: Mapped[int] = mapped_column(BigId)
    pam_id: Mapped[int | None] = mapped_column(BigId)  # owner at run time
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_run, doc=PART_DOC)
    status: Mapped[str] = mapped_column(String(20), default=RES_PENDING)
    category: Mapped[str | None] = mapped_column(String(40))
    key_signals: Mapped[str | None] = mapped_column(Text)
    opportunity: Mapped[str | None] = mapped_column(Text)
    outreach: Mapped[str | None] = mapped_column(Text)
    raw_text: Mapped[str | None] = mapped_column(Text)
    sources: Mapped[list[Any]] = mapped_column(default=list)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    cached: Mapped[bool] = mapped_column(Boolean, default=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    enqueued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    company: Mapped[Company] = relationship(lazy="joined", primaryjoin="foreign(ResearchResult.company_id) == Company.id")


class Notification(TimestampMixin, Base):
    """Outbox row: one digest per (run, PAM, channel). The unique key makes enqueueing idempotent."""

    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("run_id", "pam_id", "channel", "part_month", name="uq_notifications_run_pam_channel"),
        Index("ix_notifications_status_next", "status", "next_attempt_at"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(BigId)  # leads the unique key, which serves run lookups
    pam_id: Mapped[int] = mapped_column(BigId)
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_run, doc=PART_DOC)
    channel: Mapped[str] = mapped_column(String(20))
    recipient: Mapped[str | None] = mapped_column(String(320))
    status: Mapped[str] = mapped_column(String(20), default=NOTE_PENDING)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Email only: the rendered message (subject/html/text/ai_summary), frozen at the first attempt so
    # retries resend exactly the same content and never pay for the AI summary twice.
    template_id: Mapped[int | None] = mapped_column(Integer)
    template_version: Mapped[int | None] = mapped_column(Integer)
    rendered: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)
    # Email only: set when the quota dispatcher hands the row to a worker; `quota_key` is the minute
    # bucket it was counted in, so a message the provider did not accept is refunded to that bucket.
    reserved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    quota_key: Mapped[int | None] = mapped_column(BigId)

    pam: Mapped[Pam] = relationship(lazy="joined", primaryjoin="foreign(Notification.pam_id) == Pam.id")


class NotificationAttempt(Base):
    """One row per delivery attempt (audit trail: what was tried, when, and what the provider said)."""

    __tablename__ = "notification_attempts"
    __table_args__ = (Index("ix_notification_attempts_note", "notification_id", "id"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    notification_id: Mapped[int] = mapped_column(BigId)
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_notification, doc=PART_DOC)
    attempt: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    outcome: Mapped[str] = mapped_column(String(20))  # sent | retry | failed
    adapter: Mapped[str | None] = mapped_column(String(40))
    http_status: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(100))
    error: Mapped[str | None] = mapped_column(Text)
    retryable: Mapped[bool | None] = mapped_column(Boolean)
    provider_request_id: Mapped[str | None] = mapped_column(String(100))


DLQ_OPEN, DLQ_REQUEUED, DLQ_DISCARDED = "open", "requeued", "discarded"


class DeadLetter(Base):
    """Dead-letter queue: a notification that failed permanently or ran out of attempts. Kept for
    audit with a snapshot of what was being sent; an operator can requeue it or discard it with a note."""

    __tablename__ = "dead_letters"
    __table_args__ = (
        Index("ix_dead_letters_status_created", "status", "created_at"),
        Index("ix_dead_letters_notification_id", "notification_id"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    notification_id: Mapped[int] = mapped_column(BigId)
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_notification, doc=PART_DOC)
    run_id: Mapped[int | None] = mapped_column(Integer)
    pam_id: Mapped[int | None] = mapped_column(Integer)
    channel: Mapped[str] = mapped_column(String(20))
    recipient: Mapped[str | None] = mapped_column(String(320))
    subject: Mapped[str | None] = mapped_column(String(500))
    reason: Mapped[str] = mapped_column(String(20))  # permanent | exhausted
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    snapshot: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(20), default=DLQ_OPEN)  # open | requeued | discarded
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[str | None] = mapped_column(String(100))
    resolution_note: Mapped[str | None] = mapped_column(String(1000))


# --- Email (Microsoft Graph) ----------------------------------------------------------------------


class EmailConfig(TimestampMixin, Base):
    """Microsoft Graph mail settings, managed from the UI (single row, id=1). App-to-app: the client
    secret (client-credentials flow) is AES-GCM encrypted and never returned by the API."""

    __tablename__ = "email_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    tenant_id: Mapped[str] = mapped_column(String(100))
    client_id: Mapped[str] = mapped_column(String(100))
    client_secret_enc: Mapped[str] = mapped_column(Text)
    secret_hint: Mapped[str] = mapped_column(String(40))
    sender_address: Mapped[str] = mapped_column(String(320))
    sender_name: Mapped[str | None] = mapped_column(String(200))
    reply_to: Mapped[str | None] = mapped_column(String(320))
    save_to_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    # Sending limits of the mailbox (Exchange Online defaults) and a safety margin kept below them.
    per_minute: Mapped[int] = mapped_column(Integer, default=30)
    per_hour: Mapped[int] = mapped_column(Integer, default=3600)
    per_day: Mapped[int] = mapped_column(Integer, default=10000)
    safety_margin_pct: Mapped[int] = mapped_column(Integer, default=5)
    # Retry policy
    max_attempts: Mapped[int] = mapped_column(Integer, default=6)
    backoff_base_s: Mapped[int] = mapped_column(Integer, default=60)
    backoff_cap_s: Mapped[int] = mapped_column(Integer, default=3600)
    # Delivery policy
    send_when_no_signals: Mapped[bool] = mapped_column(Boolean, default=False)
    paused_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pause_reason: Mapped[str | None] = mapped_column(String(300))
    # Last verification
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_check_ok: Mapped[bool] = mapped_column(Boolean, default=True)
    last_check_error: Mapped[str | None] = mapped_column(Text)
    last_check_latency_ms: Mapped[int | None] = mapped_column(Integer)
    updated_by: Mapped[str] = mapped_column(String(100))


class EmailSendBucket(Base):
    """Quota ledger: emails counted per UTC minute (key = epoch minute). The dispatcher sums the
    current minute, the last 60 minutes and the last 1,440 minutes to enforce the per-minute,
    per-hour and per-24-hour limits as rolling windows (how Exchange Online counts them)."""

    __tablename__ = "email_send_buckets"

    minute_key: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    used: Mapped[int] = mapped_column(Integer, default=0)


AI_ON_FAILURE = ("send_without", "hold")


class EmailTemplate(TimestampMixin, Base):
    """Jinja2 (sandboxed) email template for PAM digests. Exactly one is active; every save bumps
    `version` and stores a snapshot in email_template_versions (rollback + audit)."""

    __tablename__ = "email_templates"
    __table_args__ = (
        Index("uq_email_templates_one_active", "active", unique=True, sqlite_where=text("active"), postgresql_where=text("active")),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str | None] = mapped_column(String(1000))
    subject_tpl: Mapped[str] = mapped_column(Text)
    html_tpl: Mapped[str] = mapped_column(Text)
    text_tpl: Mapped[str] = mapped_column(Text)
    ai_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    ai_prompt: Mapped[str | None] = mapped_column(Text)
    ai_max_words: Mapped[int] = mapped_column(Integer, default=120)
    ai_on_failure: Mapped[str] = mapped_column(String(20), default="send_without")
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(100))


class EmailTemplateVersion(Base):
    __tablename__ = "email_template_versions"
    __table_args__ = (UniqueConstraint("template_id", "version", name="uq_email_template_versions_tpl_ver"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("email_templates.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict[str, Any]] = mapped_column(default=dict)
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(100))


class ResearchPromptVersion(Base):
    """One immutable version of the research prompt (edited from the UI). Exactly one is active;
    runs pin the active version when they start, and the version is part of the result-cache key."""

    __tablename__ = "research_prompt_versions"
    __table_args__ = (
        Index("uq_research_prompt_versions_one_active", "active", unique=True, sqlite_where=text("active"), postgresql_where=text("active")),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    version: Mapped[int] = mapped_column(Integer, unique=True)
    system_instruction: Mapped[str] = mapped_column(Text)
    research_prompt: Mapped[str] = mapped_column(Text)
    ttbs_context: Mapped[str] = mapped_column(Text)
    output_rules: Mapped[str] = mapped_column(Text)
    categories: Mapped[list[Any]] = mapped_column(default=list)
    window_days: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(100))
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    activated_by: Mapped[str | None] = mapped_column(String(100))


class AuditLog(Base):
    """Append-only, hash-chained: each row's hash covers its content and the previous row's hash,
    so any edit or deletion breaks the chain (`GET /audit/verify`)."""

    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_entity", "entity_type", "entity_id"),
        Index("ix_audit_log_action_id", "action", "id"),
        Index("ix_audit_log_run_id_id", "run_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    actor: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(80))
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict[str, Any]] = mapped_column(default=dict)
    # Correlation: every entry about a run or one of its notifications carries the run id, so a
    # run's complete audit trail is one indexed query. Covered by the hash when set.
    run_id: Mapped[int | None] = mapped_column(Integer)
    request_id: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    prev_hash: Mapped[str] = mapped_column(String(64))
    # Not unique-indexed: a 64-char random unique key is the costliest index on the busiest table, and
    # the chain itself (each hash covers the previous one) is the integrity check (`verify_chain`).
    hash: Mapped[str] = mapped_column(String(64))
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_ts, doc=PART_DOC)


class AuditChainHead(Base):
    """The newest audit row's id and hash (single row, id=1), read and moved under the audit chain
    lock. Appending never has to find the last row of a partitioned table."""

    __tablename__ = "audit_chain_head"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    last_id: Mapped[int] = mapped_column(BigInteger, default=0)
    last_hash: Mapped[str] = mapped_column(String(64))


class ProcessEvent(Base):
    """Telemetry: one row per pipeline step (upload chunk, run lifecycle, each research attempt,
    each delivery attempt, sweeper recoveries). Operational, high-volume and not hash-chained;
    the audit log stays the compliance record. Powers the run timeline and the Telemetry page."""

    __tablename__ = "process_events"
    __table_args__ = (
        Index("ix_process_events_run_ts", "run_id", "ts"),
        Index("ix_process_events_kind_ts_status", "kind", "ts", "status"),
        Index("ix_process_events_import_ts", "import_id", "ts"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # time ranges prune by part_month
    kind: Mapped[str] = mapped_column(String(60))  # "research.attempt", "notify.attempt", "run.start", …
    status: Mapped[str] = mapped_column(String(20), default="ok")  # ok | retry | error | skipped | info
    message: Mapped[str | None] = mapped_column(String(500))
    run_id: Mapped[int | None] = mapped_column(Integer)
    import_id: Mapped[int | None] = mapped_column(Integer)
    company_id: Mapped[int | None] = mapped_column(Integer)
    pam_id: Mapped[int | None] = mapped_column(Integer)
    notification_id: Mapped[int | None] = mapped_column(Integer)
    attempt: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    provider: Mapped[str | None] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(200))
    tokens_in: Mapped[int | None] = mapped_column(Integer)
    tokens_out: Mapped[int | None] = mapped_column(Integer)
    cost: Mapped[float | None] = mapped_column(Float)
    actor: Mapped[str | None] = mapped_column(String(100))
    request_id: Mapped[str | None] = mapped_column(String(64))
    trace_id: Mapped[str | None] = mapped_column(String(32))
    attrs: Mapped[dict[str, Any]] = mapped_column(default=dict)
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_ts, doc=PART_DOC)


COST_LLM, COST_MESSAGING = "llm", "messaging"


class CostEntry(Base):
    """FinOps ledger, append-only. One row per billable unit: each LLM research call (tokens and
    USD), each cache hit (USD 0, with the estimated saving) and each delivered message. Every row
    carries its run, upload, PAM and company, so any cost cut is a GROUP BY over this table."""

    __tablename__ = "cost_ledger"
    __table_args__ = (
        Index("ix_cost_ledger_ts_category", "ts", "category"),
        Index("ix_cost_ledger_run_pam", "run_id", "pam_id"),
        Index("ix_cost_ledger_import", "import_id"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    category: Mapped[str] = mapped_column(String(20))  # llm | messaging
    provider: Mapped[str] = mapped_column(String(40))  # perplexity | gemini | fake | email | whatsapp
    model: Mapped[str | None] = mapped_column(String(200))  # LLM model or delivery adapter
    channel: Mapped[str | None] = mapped_column(String(20))
    run_id: Mapped[int | None] = mapped_column(Integer)
    import_id: Mapped[int | None] = mapped_column(Integer)
    pam_id: Mapped[int | None] = mapped_column(Integer)
    company_id: Mapped[int | None] = mapped_column(Integer)
    result_id: Mapped[int | None] = mapped_column(Integer)
    notification_id: Mapped[int | None] = mapped_column(Integer)
    units: Mapped[int] = mapped_column(Integer, default=1)  # calls or messages
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)  # USD actually spent
    cached: Mapped[bool] = mapped_column(Boolean, default=False)
    saved: Mapped[float] = mapped_column(Float, default=0.0)  # USD avoided (cache hits)
    outcome: Mapped[str | None] = mapped_column(String(20))  # signal | no_signal | failed | sent
    part_month: Mapped[int] = mapped_column(Integer, default=part.default_by_ts, doc=PART_DOC)


class CompanySignalSummary(Base):
    """Per-company roll-up of research history, kept current as each result completes, so company
    lists sorted by signals never aggregate the (partitioned, ever-growing) results table."""

    __tablename__ = "company_signal_summary"

    company_id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=False)
    signals: Mapped[int] = mapped_column(Integer, default=0)
    last_signal_date: Mapped[date | None] = mapped_column(Date)  # window_end of the newest run with a signal


# --- Identity & access ------------------------------------------------------------------------
ROLE_ADMIN, ROLE_MEMBER = "admin", "member"
ROLES = (ROLE_ADMIN, ROLE_MEMBER)


class User(TimestampMixin, Base):
    """A person who can sign in. `admin` can do everything, including managing users; a `member`
    gets per-module access (`permissions`: {"runs": "manage", "audit": "view", ...}) chosen by an
    admin. Passwords are Argon2id hashes (app/services/passwords.py), never stored or logged plain."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)  # stored lower-cased
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(320))
    role: Mapped[str] = mapped_column(String(20), default=ROLE_MEMBER)
    permissions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    password_hash: Mapped[str] = mapped_column(String(255))
    password_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Set for the bootstrap admin and after an admin (re)sets a password: the next sign-in can do
    # nothing but choose a new password.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(100))


class UserSession(Base):
    """Server-side session. The browser holds a random token in an HttpOnly cookie; only its
    SHA-256 is stored, so a database leak does not hand out live sessions. Revoked on sign-out,
    password change, deactivation, or by an admin."""

    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # absolute lifetime
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))

    user: Mapped[User] = relationship(lazy="joined")


class PasswordHistory(Base):
    """Previous password hashes, so the last N passwords cannot be reused."""

    __tablename__ = "password_history"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# --- Archive ("deleted") tables -------------------------------------------------------------------
# Nothing is hard-deleted: services/soft_delete.archive() moves rows into `<table>_deleted`, a copy of
# the table's columns plus who/when/why. The archives of partitioned tables are partitioned the same
# way (`nov__2026__job_deleted`). `archive_id` is the archive's own key, so a row id that is archived
# twice (e.g. the single email_config row, deleted, re-created, deleted again) never collides.
# audit_log has no archive: audit rows are never removed (the hash chain would break).

ARCHIVED = (
    ResearchResult, Notification, NotificationAttempt, DeadLetter, ProcessEvent, CostEntry,
    DatasetCompany, EmailTemplate, EmailTemplateVersion, LlmProviderConfig, EmailConfig, Schedule,
)


def _archive_table(model: type[Base]) -> Table:
    src = model.__table__
    cols = [Column("archive_id", BigId, primary_key=True, autoincrement=True)]
    for c in src.columns:
        cols.append(Column(c.name, c.type, nullable=c.name != "part_month"))  # part_month: the archive's partition key
    cols += [
        Column("deleted_at", DateTime(timezone=True), nullable=False),
        Column("deleted_by", String(100), nullable=False),
        Column("delete_reason", String(300)),
    ]
    name = f"{src.name}_deleted"
    return Table(name, Base.metadata, *cols, Index(f"ix_{name}_id", "id"), Index(f"ix_{name}_deleted_at", "deleted_at"))


ARCHIVE_TABLES: dict[str, Table] = {m.__table__.name: _archive_table(m) for m in ARCHIVED}
