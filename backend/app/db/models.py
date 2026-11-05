"""ORM models for the first backend slice: import → schedule → research → results → notify.

Region/zone is intentionally absent: TTBS does not organise accounts by zone.
"""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, BigId, TimestampMixin

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
    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200))
    interval_days: Mapped[int] = mapped_column(Integer)
    run_at_time: Mapped[str] = mapped_column(String(5))  # "HH:MM" in `timezone`
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    scope_key: Mapped[str] = mapped_column(String(100), default="all")
    template_id: Mapped[str] = mapped_column(String(50), default="t1")
    channels: Mapped[list[Any]] = mapped_column(default=lambda: ["email", "whatsapp"])
    budget_cap: Mapped[float | None] = mapped_column(Float)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
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
    triggered_by: Mapped[str] = mapped_column(String(100))
    total: Mapped[int] = mapped_column(Integer, default=0)
    done: Mapped[int] = mapped_column(Integer, default=0)
    with_signal: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    cache_hits: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str | None] = mapped_column(Text)


class ResearchResult(TimestampMixin, Base):
    __tablename__ = "research_results"
    __table_args__ = (
        UniqueConstraint("run_id", "company_id", name="uq_research_results_run_company"),
        Index("ix_research_results_run_status", "run_id", "status"),
        Index("ix_research_results_run_pam", "run_id", "pam_id"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"))
    pam_id: Mapped[int | None] = mapped_column(ForeignKey("pams.id"))  # owner at run time
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

    company: Mapped[Company] = relationship(lazy="joined")


class Notification(TimestampMixin, Base):
    """Outbox row: one digest per (run, PAM, channel). The unique key makes enqueueing idempotent."""

    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("run_id", "pam_id", "channel", name="uq_notifications_run_pam_channel"),
        Index("ix_notifications_status_next", "status", "next_attempt_at"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    pam_id: Mapped[int] = mapped_column(ForeignKey("pams.id"))
    channel: Mapped[str] = mapped_column(String(20))
    recipient: Mapped[str | None] = mapped_column(String(320))
    status: Mapped[str] = mapped_column(String(20), default=NOTE_PENDING)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    pam: Mapped[Pam] = relationship(lazy="joined")


class AuditLog(Base):
    """Append-only, hash-chained: each row's hash covers its content and the previous row's hash,
    so any edit or deletion breaks the chain (`GET /audit/verify`)."""

    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_entity", "entity_type", "entity_id"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    actor: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(80), index=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict[str, Any]] = mapped_column(default=dict)
    # Correlation: every entry about a run or one of its notifications carries the run id, so a
    # run's complete audit trail is one indexed query. Covered by the hash when set.
    run_id: Mapped[int | None] = mapped_column(Integer, index=True)
    request_id: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64), unique=True)


class ProcessEvent(Base):
    """Telemetry: one row per pipeline step (upload chunk, run lifecycle, each research attempt,
    each delivery attempt, sweeper recoveries). Operational, high-volume and not hash-chained;
    the audit log stays the compliance record. Powers the run timeline and the Telemetry page."""

    __tablename__ = "process_events"
    __table_args__ = (
        Index("ix_process_events_run_ts", "run_id", "ts"),
        Index("ix_process_events_kind_ts", "kind", "ts"),
        Index("ix_process_events_import_ts", "import_id", "ts"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
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


COST_LLM, COST_MESSAGING = "llm", "messaging"


class CostEntry(Base):
    """FinOps ledger, append-only. One row per billable unit: each LLM research call (tokens and
    USD), each cache hit (USD 0, with the estimated saving) and each delivered message. Every row
    carries its run, upload, PAM and company, so any cost cut is a GROUP BY over this table."""

    __tablename__ = "cost_ledger"
    __table_args__ = (
        Index("ix_cost_ledger_ts", "ts"),
        Index("ix_cost_ledger_run", "run_id"),
        Index("ix_cost_ledger_import", "import_id"),
        Index("ix_cost_ledger_pam", "pam_id"),
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
