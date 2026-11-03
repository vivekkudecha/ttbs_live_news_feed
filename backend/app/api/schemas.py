"""Request models (camelCase on the wire) and response serializers matching frontend/src/api/types.ts."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.core.timeutil import as_utc
from app.db.models import AuditLog, ImportBatch, LlmProviderConfig, Notification, ResearchResult, Run, Schedule
from app.services.imports import summary_text
from app.services.runs import EST_COST_PER_COMPANY


class In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Channel = Literal["email", "whatsapp"]


class RunSchedule(In):
    """How to schedule research after an import commit (or for an ad-hoc run)."""

    mode: Literal["none", "now", "at"] = "none"
    run_at: datetime | None = None
    channels: list[Channel] = Field(default_factory=lambda: ["email", "whatsapp"])


class CommitIn(In):
    schedule: RunSchedule = Field(default_factory=RunSchedule)


class RunCreate(In):
    scope_key: str = "all"
    label: str | None = Field(default=None, max_length=300)
    template_id: str = "t1"
    run_at: datetime | None = None
    channels: list[Channel] = Field(default_factory=lambda: ["email", "whatsapp"])
    budget_cap: float | None = Field(default=None, gt=0)


class ScheduleCreate(In):
    name: str = Field(min_length=1, max_length=200)
    interval_days: int = Field(ge=1, le=90)
    run_at_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    timezone: str = "Asia/Kolkata"
    scope_key: str = "all"
    template_id: str = "t1"
    channels: list[Channel] = Field(default_factory=lambda: ["email", "whatsapp"])
    budget_cap: float | None = Field(default=None, gt=0)
    enabled: bool = True
    next_run_at: datetime | None = None


class ScheduleUpdate(In):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    interval_days: int | None = Field(default=None, ge=1, le=90)
    run_at_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    timezone: str | None = None
    scope_key: str | None = None
    template_id: str | None = None
    channels: list[Channel] | None = None
    budget_cap: float | None = Field(default=None, gt=0)
    enabled: bool | None = None


# --- Serializers ------------------------------------------------------------------------------


def iso(dt: datetime | None) -> str | None:
    return as_utc(dt).isoformat() if dt else None


def import_record(b: ImportBatch) -> dict[str, Any]:
    return {
        "id": str(b.id),
        "fileName": b.file_name,
        "uploadedBy": b.uploaded_by,
        "uploadedAt": iso(b.created_at),
        "rows": b.rows_total,
        "status": b.status,
        "summary": summary_text(b) if b.status == "committed" else f"{b.rows_valid} valid · {b.rows_error} with errors",
    }


def import_preview(b: ImportBatch) -> dict[str, Any]:
    sm = b.summary or {}
    return {
        "id": str(b.id),
        "fileName": b.file_name,
        "rows": b.rows_total,
        "validRows": b.rows_valid,
        "errorRows": b.rows_error,
        "newCompanies": sm.get("new_companies", 0),
        "updatedCompanies": sm.get("updated_companies", 0),
        "newPams": sm.get("new_pams", 0),
        "reassignments": sm.get("reassignments", 0),
        "duplicatesMerged": sm.get("duplicates_merged", 0),
        "issues": b.issues,
        "sample": [
            {"company": r["company"], "pam": r["pam_name"], "email": r["pam_email"], "whatsapp": r["pam_whatsapp"],
             "segment": r.get("segment"), "change": r["change"]}
            for r in sm.get("sample", [])
        ],
    }


def run_out(r: Run, notes: dict[str, int] | None = None) -> dict[str, Any]:
    notes = notes or {}
    return {
        "id": str(r.id),
        "label": r.label,
        "trigger": r.trigger,
        "scheduleId": str(r.schedule_id) if r.schedule_id else None,
        "importId": str(r.import_id) if r.import_id else None,
        "scopeKey": r.scope_key,
        "templateId": r.template_id,
        "channels": r.channels,
        "provider": r.provider,
        "model": r.model,
        "status": r.status,
        "scheduledFor": iso(r.scheduled_for),
        "startedAt": iso(r.started_at),
        "finishedAt": iso(r.finished_at),
        "windowStart": r.window_start.isoformat() if r.window_start else None,
        "windowEnd": r.window_end.isoformat() if r.window_end else None,
        "triggeredBy": r.triggered_by,
        "companies": r.total,
        "done": r.done,
        "withSignal": r.with_signal,
        "failed": r.failed,
        "cacheHits": r.cache_hits,
        "cost": round(r.cost, 4),
        "estimatedCost": round(r.total * EST_COST_PER_COMPANY, 2),
        "budgetCap": r.budget_cap,
        "error": r.error,
        "notifications": {
            "pending": notes.get("pending", 0) + notes.get("sending", 0),
            "sent": notes.get("sent", 0),
            "failed": notes.get("failed", 0),
            "skipped": notes.get("skipped", 0),
        },
    }


def result_out(x: ResearchResult) -> dict[str, Any]:
    return {
        "id": str(x.id),
        "runId": str(x.run_id),
        "companyId": str(x.company_id),
        "companyName": x.company.name,
        "pamId": str(x.pam_id) if x.pam_id else None,
        "status": x.status,
        "category": x.category,
        "keySignals": x.key_signals,
        "opportunity": x.opportunity,
        "outreach": x.outreach,
        "sources": x.sources or [],
        "tokensIn": x.tokens_in,
        "tokensOut": x.tokens_out,
        "cost": x.cost,
        "latencyMs": x.latency_ms,
        "cached": x.cached,
        "attempts": x.attempts,
        "error": x.error,
        "finishedAt": iso(x.finished_at),
    }


def notification_out(n: Notification) -> dict[str, Any]:
    return {
        "id": str(n.id),
        "runId": str(n.run_id),
        "pamId": str(n.pam_id),
        "pamName": n.pam.name if n.pam else None,
        "channel": n.channel,
        "recipient": n.recipient,
        "status": n.status,
        "attempts": n.attempts,
        "lastError": n.last_error,
        "nextAttemptAt": iso(n.next_attempt_at),
        "sentAt": iso(n.sent_at),
        "subject": (n.payload or {}).get("subject"),
    }


def schedule_out(s: Schedule) -> dict[str, Any]:
    return {
        "id": str(s.id),
        "name": s.name,
        "intervalDays": s.interval_days,
        "runAtTime": s.run_at_time,
        "timezone": s.timezone,
        "nextRunAt": iso(s.next_run_at),
        "lastRunAt": iso(s.last_run_at),
        "templateId": s.template_id,
        "providerKey": "perplexity",
        "scopeKey": s.scope_key,
        "scope": s.scope_key,  # replaced with a label by the route
        "enabled": s.enabled,
        "budgetCap": s.budget_cap,
        "channels": s.channels,
    }


class LlmModelsIn(In):
    # Omit to list models with the saved key. Never echoed back or logged.
    api_key: str | None = Field(default=None, max_length=400)


class LlmConfigIn(In):
    api_key: str | None = Field(default=None, max_length=400)  # omit to keep the saved key
    model: str = Field(min_length=3, max_length=200)


def llm_settings_out(rows: dict[str, LlmProviderConfig], labels: dict[str, str], *, mode: str) -> dict[str, Any]:
    active = next((p for p, r in rows.items() if r.active), None)
    return {
        "mode": mode,
        "active": active,
        "providers": [llm_config_out(rows.get(p), provider=p, label=label) for p, label in labels.items()],
    }


def llm_config_out(row: LlmProviderConfig | None, *, provider: str, label: str) -> dict[str, Any]:
    base: dict[str, Any] = {"provider": provider, "label": label, "configured": row is not None, "active": bool(row and row.active)}
    if row is None:
        return base | {"keyHint": None, "model": None, "modelProvider": None, "verifiedAt": None,
                       "lastCheckOk": None, "lastCheckError": None, "lastCheckLatencyMs": None, "updatedAt": None, "updatedBy": None}
    return base | {
        "keyHint": row.key_hint,
        "model": row.model,
        "modelProvider": row.model_provider,
        "verifiedAt": iso(row.verified_at),
        "lastCheckOk": row.last_check_ok,
        "lastCheckError": row.last_check_error,
        "lastCheckLatencyMs": row.last_check_latency_ms,
        "updatedAt": iso(row.updated_at),
        "updatedBy": row.updated_by,
    }


def audit_out(a: AuditLog) -> dict[str, Any]:
    return {
        "id": str(a.id),
        "ts": iso(a.ts),
        "actor": a.actor,
        "action": a.action,
        "entity": f"{a.entity_type.capitalize()} {a.entity_id}" if a.entity_id else a.entity_type.capitalize(),
        "detail": ", ".join(f"{k}: {v}" for k, v in (a.detail or {}).items() if v not in (None, "", [], {})),
        "ip": a.ip or "",
        "requestId": a.request_id,
    }
