"""Email delivery: Microsoft Graph settings, sending quota, email templates (+ AI summary), outbox
and dead-letter queue. Thin handlers over services/email_* and services/notifications."""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import func, select

from app.api import schemas as sch
from app.api.deps import current_actor
from app.core.config import get_settings
from app.core.errors import NotFound
from app.db.models import (
    RES_SIGNAL,
    DatasetCompany,
    DeadLetter,
    EmailConfig,
    EmailTemplate,
    EmailTemplateVersion,
    Notification,
    NotificationAttempt,
    Pam,
    ResearchResult,
    Run,
)
from app.db.session import unit_of_work
from app.services import email_config, email_quota, email_templates, notifications, runs

router = APIRouter(prefix="/api/v1")
iso = sch.iso


def _page(page: int = Query(0, ge=0), page_size: int = Query(50, ge=1, alias="pageSize")) -> tuple[int, int]:
    return page, min(page_size, get_settings().max_page_size)


# --- Request bodies -------------------------------------------------------------------------------


class EmailConfigIn(sch.In):
    tenant_id: str = Field(max_length=100)
    client_id: str = Field(max_length=100)
    client_secret: str | None = Field(default=None, max_length=512)  # omit to keep the saved secret
    sender_address: str = Field(max_length=320)
    sender_name: str | None = Field(default=None, max_length=200)
    reply_to: str | None = Field(default=None, max_length=320)
    save_to_sent: bool = False
    enabled: bool | None = None


class LimitsIn(sch.In):
    per_minute: int
    per_hour: int
    per_day: int
    safety_margin_pct: int


class PolicyIn(sch.In):
    max_attempts: int
    backoff_base_s: int
    backoff_cap_s: int
    send_when_no_signals: bool = False


class EnableIn(sch.In):
    enabled: bool


class PauseIn(sch.In):
    minutes: int = Field(ge=1, le=7 * 24 * 60)
    reason: str | None = Field(default=None, max_length=300)


class TestSendIn(sch.In):
    to: str = Field(max_length=320)


class TemplateIn(sch.In):
    name: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    subject_tpl: str = Field(max_length=2000)
    html_tpl: str = Field(default="", max_length=200_000)
    text_tpl: str = Field(default="", max_length=200_000)
    ai_enabled: bool = False
    ai_prompt: str | None = Field(default=None, max_length=4000)
    ai_max_words: int = Field(default=120, ge=20, le=400)
    ai_on_failure: Literal["send_without", "hold"] = "send_without"
    note: str | None = Field(default=None, max_length=500)


class PreviewIn(TemplateIn):
    run_id: int | None = None
    pam_id: int | None = None
    with_ai: bool = False


class RequeueIn(sch.In):
    ids: list[int] = Field(min_length=1, max_length=1000)


class DiscardIn(sch.In):
    note: str = Field(min_length=3, max_length=1000)


# --- Serializers ----------------------------------------------------------------------------------


def config_out(row: EmailConfig | None) -> dict[str, Any]:
    lim, pol = email_config.limits(row), email_config.policy(row)
    base = {
        "configured": row is not None,
        "limits": {"perMinute": lim.configured["per_minute"], "perHour": lim.configured["per_hour"], "perDay": lim.configured["per_day"],
                   "safetyMarginPct": lim.configured["safety_margin_pct"],
                   "effective": {"perMinute": lim.minute, "perHour": lim.hour, "perDay": lim.day}},
        "policy": {"maxAttempts": pol.max_attempts, "backoffBaseS": pol.backoff_base_s, "backoffCapS": pol.backoff_cap_s,
                   "sendWhenNoSignals": pol.send_when_no_signals},
    }
    if row is None:
        return base | {"enabled": False, "connection": None}
    return base | {
        "enabled": row.enabled,
        "pausedUntil": iso(row.paused_until),
        "pauseReason": row.pause_reason,
        "connection": {
            "tenantId": row.tenant_id, "clientId": row.client_id, "secretHint": row.secret_hint, "senderAddress": row.sender_address,
            "senderName": row.sender_name, "replyTo": row.reply_to, "saveToSent": row.save_to_sent,
        },
        "check": {"verifiedAt": iso(row.verified_at), "ok": row.last_check_ok, "error": row.last_check_error,
                  "latencyMs": row.last_check_latency_ms},
        "updatedAt": iso(row.updated_at), "updatedBy": row.updated_by,
    }


def template_out(t: EmailTemplate) -> dict[str, Any]:
    return {
        "id": str(t.id), "name": t.name, "description": t.description, "subjectTpl": t.subject_tpl, "htmlTpl": t.html_tpl,
        "textTpl": t.text_tpl, "aiEnabled": t.ai_enabled, "aiPrompt": t.ai_prompt, "aiMaxWords": t.ai_max_words,
        "aiOnFailure": t.ai_on_failure, "active": t.active, "version": t.version, "updatedAt": iso(t.updated_at), "updatedBy": t.updated_by,
    }


def version_out(v: EmailTemplateVersion) -> dict[str, Any]:
    return {"version": v.version, "note": v.note, "createdAt": iso(v.created_at), "createdBy": v.created_by,
            "subjectTpl": v.snapshot.get("subject_tpl"), "aiEnabled": v.snapshot.get("ai_enabled")}


def attempt_out(a: NotificationAttempt) -> dict[str, Any]:
    return {"attempt": a.attempt, "startedAt": iso(a.started_at), "durationMs": a.duration_ms, "outcome": a.outcome, "adapter": a.adapter,
            "httpStatus": a.http_status, "errorCode": a.error_code, "error": a.error, "retryable": a.retryable,
            "providerRequestId": a.provider_request_id}


def outbox_row(n: Notification) -> dict[str, Any]:
    return sch.notification_out(n) | {
        "createdAt": iso(n.created_at), "reservedAt": iso(n.reserved_at), "templateVersion": n.template_version,
        "subject": (n.rendered or {}).get("subject") or (n.payload or {}).get("subject"),
    }


def dead_letter_out(d: DeadLetter) -> dict[str, Any]:
    return {"id": str(d.id), "notificationId": str(d.notification_id), "runId": str(d.run_id) if d.run_id else None,
            "pamId": str(d.pam_id) if d.pam_id else None, "channel": d.channel, "recipient": d.recipient, "subject": d.subject,
            "reason": d.reason, "attempts": d.attempts, "lastError": d.last_error, "status": d.status, "createdAt": iso(d.created_at),
            "resolvedAt": iso(d.resolved_at), "resolvedBy": d.resolved_by, "resolutionNote": d.resolution_note,
            "history": (d.snapshot or {}).get("attempts", [])}


# --- Settings: Microsoft Graph --------------------------------------------------------------------


def _settings_out() -> dict[str, Any]:
    with unit_of_work() as uow:
        return config_out(email_config.get_row(uow)) | {"quota": email_quota.status(uow)}


@router.get("/settings/email")
def get_email_settings() -> dict[str, Any]:
    return _settings_out()


@router.put("/settings/email")
def save_email_settings(body: EmailConfigIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    """Verify with Microsoft (token + Mail.Send role), then save. The secret is write-only."""
    email_config.save(body.model_dump(), actor)
    return _settings_out()


@router.post("/settings/email/test")
def test_email_settings(actor: str = Depends(current_actor)) -> dict[str, Any]:
    _, error = email_config.test_connection(actor)
    return _settings_out() | {"ok": error is None, "error": error}


@router.post("/settings/email/test-send")
def send_test_email(body: TestSendIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    return email_config.send_test(body.to, actor)


@router.put("/settings/email/limits")
def save_email_limits(body: LimitsIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    email_config.update_limits(body.model_dump(), actor)
    return _settings_out()


@router.put("/settings/email/policy")
def save_email_policy(body: PolicyIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    email_config.update_policy(body.model_dump(), actor)
    return _settings_out()


@router.post("/settings/email/enable")
def enable_email(body: EnableIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    email_config.set_enabled(body.enabled, actor)
    return _settings_out()


@router.post("/settings/email/pause")
def pause_email(body: PauseIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    email_config.pause(body.minutes, body.reason, actor)
    return _settings_out()


@router.post("/settings/email/resume")
def resume_email(actor: str = Depends(current_actor)) -> dict[str, Any]:
    email_config.resume(actor)
    return _settings_out()


@router.delete("/settings/email", status_code=204)
def remove_email_settings(actor: str = Depends(current_actor)) -> None:
    email_config.remove(actor)


@router.get("/settings/email/quota")
def email_quota_status() -> dict[str, Any]:
    with unit_of_work() as uow:
        return email_quota.status(uow)


# --- Email templates ------------------------------------------------------------------------------


@router.get("/email-templates")
def list_email_templates() -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return [template_out(t) for t in email_templates.list_all(uow)]


@router.post("/email-templates", status_code=201)
def create_email_template(body: TemplateIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    return template_out(email_templates.create(body.model_dump(), actor))


@router.get("/email-templates/{template_id}")
def get_email_template(template_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        return template_out(email_templates.get(uow, template_id))


@router.put("/email-templates/{template_id}")
def update_email_template(template_id: int, body: TemplateIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    return template_out(email_templates.update_template(template_id, body.model_dump(), actor))


@router.delete("/email-templates/{template_id}", status_code=204)
def delete_email_template(template_id: int, actor: str = Depends(current_actor)) -> None:
    email_templates.delete_template(template_id, actor)


@router.post("/email-templates/{template_id}/activate")
def activate_email_template(template_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    return template_out(email_templates.activate(template_id, actor))


@router.get("/email-templates/{template_id}/versions")
def email_template_versions(template_id: int) -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return [version_out(v) for v in email_templates.versions(uow, template_id)]


@router.post("/email-templates/{template_id}/versions/{version}/restore")
def restore_email_template(template_id: int, version: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    return template_out(email_templates.restore(template_id, version, actor))


def _digest_payload(run_id: int, pam_id: int) -> dict[str, Any]:
    """The digest a PAM got (or would get) for a run: the queued snapshot if there is one."""
    with unit_of_work() as uow:
        s = uow.session
        run, pam = s.get(Run, run_id), s.get(Pam, pam_id)
        if run is None or pam is None:
            raise NotFound("Run or PAM not found")
        note = s.scalars(select(Notification).where(Notification.run_id == run_id, Notification.pam_id == pam_id,
                                                    Notification.channel == "email")).first()
        if note is not None and (note.payload or {}).get("items") is not None:
            return dict(note.payload)
        signals = list(s.scalars(select(ResearchResult).where(ResearchResult.run_id == run_id, ResearchResult.pam_id == pam_id,
                                                              ResearchResult.status == RES_SIGNAL).order_by(ResearchResult.id)))
        total = s.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.run_id == run_id, ResearchResult.pam_id == pam_id)) or 0
        return runs.build_digest(run, pam, signals, total)


@router.post("/email-templates/preview")
def preview_email_template(body: PreviewIn) -> dict[str, Any]:
    """Render a template (saved or a draft) for a real run + PAM, or sample data. `withAi` makes one real AI call."""
    payload = _digest_payload(body.run_id, body.pam_id) if body.run_id and body.pam_id else None
    return email_templates.preview(body.model_dump(), payload, with_ai=body.with_ai) | {"sample": payload is None}


# --- Outbox & dead-letter queue -------------------------------------------------------------------


@router.get("/notifications/outbox")
def list_outbox(pg: tuple[int, int] = Depends(_page), status: str | None = None, channel: str | None = None,
                q: str | None = None) -> dict[str, Any]:
    page, size = pg
    with unit_of_work() as uow:
        r = notifications.outbox(uow, page=page, size=size, status=status, channel=channel, q=q)
        return {"rows": [outbox_row(n) for n in r["rows"]], "total": r["total"], "counts": r["counts"], "page": page, "pageSize": size}


@router.get("/notifications/email-estimate")
def email_estimate(emails: int = Query(0, ge=0, le=10_000_000), import_id: int | None = Query(None, alias="importId", gt=0)) -> dict[str, Any]:
    """How long a run's email digests would take behind the current queue (new-run dialog).
    With `importId`: one digest per PAM (opted in to email) that the upload maps logos to."""
    with unit_of_work() as uow:
        if import_id:
            emails = uow.session.scalar(
                select(func.count(func.distinct(DatasetCompany.pam_id))).join(Pam, Pam.id == DatasetCompany.pam_id)
                .where(DatasetCompany.import_id == import_id, Pam.active.is_(True), Pam.notify_email.is_(True))
            ) or 0
        return email_quota.estimate(uow, emails)


@router.get("/notifications/dead-letters")
def list_dead_letters(pg: tuple[int, int] = Depends(_page), status: str | None = "open", channel: str | None = None) -> dict[str, Any]:
    page, size = pg
    with unit_of_work() as uow:
        r = notifications.dead_letters(uow, page=page, size=size, status=status or None, channel=channel)
        return {"rows": [dead_letter_out(d) for d in r["rows"]], "total": r["total"], "counts": r["counts"], "page": page, "pageSize": size}


@router.post("/notifications/dead-letters/requeue")
def requeue_dead_letters(body: RequeueIn, actor: str = Depends(current_actor)) -> dict[str, int]:
    with unit_of_work() as uow:
        return {"requeued": notifications.requeue_dead_letters(uow, body.ids, actor)}


@router.post("/notifications/dead-letters/{dead_letter_id}/discard")
def discard_dead_letter(dead_letter_id: int, body: DiscardIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return dead_letter_out(notifications.discard_dead_letter(uow, dead_letter_id, body.note, actor))


@router.get("/notifications/{notification_id}/detail")
def notification_detail(notification_id: int) -> dict[str, Any]:
    """One outbox row with its attempts and the exact rendered email (subject, HTML, text)."""
    with unit_of_work() as uow:
        tries = notifications.attempts(uow, notification_id)
        n = uow.session.get(Notification, notification_id)
        r = n.rendered or {}
        return outbox_row(n) | {
            "history": [attempt_out(a) for a in tries],
            "rendered": {"subject": r.get("subject"), "html": r.get("html"), "text": r.get("text"), "aiSummary": r.get("ai_summary"),
                         "aiError": r.get("ai_error")} if n.rendered else None,
            "body": (n.payload or {}).get("body"),
        }
