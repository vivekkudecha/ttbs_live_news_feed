"""Request models (camelCase on the wire) and response serializers matching frontend/src/api/types.ts."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.core.timeutil import as_utc
from app.db.models import AuditLog, ImportBatch, LlmProviderConfig, Notification, ResearchResult, Run
from app.services.imports import summary_text
from app.services.runs import EST_COST_PER_COMPANY, dataset_label


class In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Channel = Literal["email", "whatsapp"]


class RunCreate(In):
    """A run always researches one saved upload: pass importId (or scopeKey "import:<id>")."""

    import_id: int | None = Field(default=None, gt=0)
    scope_key: str | None = None
    label: str | None = Field(default=None, max_length=300)
    template_id: str = "t1"
    run_at: datetime | None = None
    channels: list[Channel] = Field(default_factory=lambda: ["email", "whatsapp"])
    budget_cap: float | None = Field(default=None, gt=0)


# --- Serializers ------------------------------------------------------------------------------


def iso(dt: datetime | None) -> str | None:
    return as_utc(dt).isoformat() if dt else None


_LEGACY_STATUS = {"committed": "completed"}  # "previewed" rows from before datasets were migrated to "failed" (0005)


def dataset_out(b: ImportBatch, *, companies: int | None = None, with_issues: bool = False,
                runs: tuple[int, Any, float] | None = None) -> dict[str, Any]:
    """An uploaded dataset: label + timestamp, background-save progress, what it changed, and
    (in lists) how often it has been researched: (run count, last run created_at, total cost)."""
    sm = b.summary or {}
    n_runs, last_run, run_cost = runs or (0, None, 0.0)
    valid = b.rows_valid or 0
    out: dict[str, Any] = {
        "id": str(b.id),
        "label": b.label or b.file_name,
        "displayLabel": dataset_label(b),
        "fileName": b.file_name,
        "uploadedBy": b.uploaded_by,
        "uploadedAt": iso(b.created_at),
        "status": _LEGACY_STATUS.get(b.status, b.status),
        "rowsTotal": b.rows_total,
        "validRows": valid,
        "errorRows": b.rows_error,
        "saved": min(b.rows_done, valid) if b.status != "committed" else valid,
        # analyzing: share of the file read so far (None if the workbook does not say how big it is);
        # saving: share of valid rows saved.
        "progress": 100 if b.status in ("completed", "committed", "previewed")
        else sm.get("progress") if b.status == "analyzing"
        else (round(b.rows_done * 100 / valid) if valid else 0),
        "rowsRead": sm.get("rows_read", b.rows_total),
        "sizeBytes": sm.get("size_bytes"),
        "companies": companies,
        "newCompanies": sm.get("new_companies", 0),
        "updatedCompanies": sm.get("updated_companies", 0),
        "reassignments": sm.get("reassignments", 0),
        "newPams": sm.get("new_pams", 0),
        "duplicatesMerged": sm.get("duplicates_merged", 0),
        "startedAt": iso(b.started_at),
        "finishedAt": iso(b.committed_at),
        "error": b.error,
        "summary": summary_text(b),
        "hasFile": bool(b.stored_file),
        "unchanged": sm.get("unchanged", 0),
        "runs": n_runs,
        "lastRunAt": iso(last_run),
        "researchCost": round(float(run_cost or 0), 4),
    }
    if with_issues:
        out["issues"] = b.issues or []
    return out


class DatasetPatch(In):
    label: str = Field(min_length=1, max_length=200)


class RowPatch(In):
    """Row edit; only the fields sent are changed. Changes update the real company / PAM."""

    company: str | None = Field(default=None, max_length=300)
    industry: str | None = Field(default=None, max_length=200)
    segment: str | None = Field(default=None, max_length=40)
    pam_name: str | None = Field(default=None, max_length=200)
    pam_email: str | None = Field(default=None, max_length=320)
    pam_whatsapp: str | None = Field(default=None, max_length=40)


class RowsDelete(In):
    company_ids: list[str] = Field(min_length=1, max_length=10_000)


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
        "promptVersion": r.prompt_version,
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


def result_out(x: ResearchResult, pam_name: str | None = None) -> dict[str, Any]:
    return {
        "id": str(x.id),
        "runId": str(x.run_id),
        "companyId": str(x.company_id),
        "companyName": x.company.name,
        "pamId": str(x.pam_id) if x.pam_id else None,
        "pamName": pam_name,
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
