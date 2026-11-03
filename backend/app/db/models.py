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
IMPORT_PREVIEWED, IMPORT_COMMITTED, IMPORT_FAILED = "previewed", "committed", "failed"

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
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)


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
    request_id: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64), unique=True)
