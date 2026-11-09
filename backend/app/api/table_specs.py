"""Sortable / filterable columns per table endpoint (see listing.py). Keys are the column ids the
UI uses (the camelCase field names of each row)."""

from sqlalchemy import case

from app.api.listing import Col, Spec
from app.db.models import AuditLog, Company, DeadLetter, ImportBatch, Notification, Pam, ProcessEvent, ResearchResult, Run, User

RUNS: Spec = {
    "id": Col(Run.id, "range"),
    "label": Col(Run.label, "text"),
    "status": Col(Run.status, "enum"),
    "trigger": Col(Run.trigger, "enum"),
    "provider": Col(Run.provider, "enum"),
    "model": Col(Run.model, "text"),
    "triggeredBy": Col(Run.triggered_by, "text"),
    "companies": Col(Run.total, "range"),
    "done": Col(Run.done, "range"),
    "withSignal": Col(Run.with_signal, "range"),
    "failed": Col(Run.failed, "range"),
    "scheduledFor": Col(Run.scheduled_for, "date"),
    "startedAt": Col(Run.started_at, "date"),
    "finishedAt": Col(Run.finished_at, "date"),
}

RESULTS: Spec = {
    "companyName": Col(Company.name, "text"),
    "status": Col(ResearchResult.status, "enum"),
    "category": Col(ResearchResult.category, "enum"),
    "keySignals": Col(ResearchResult.key_signals, "text", sortable=False),
    "attempts": Col(ResearchResult.attempts, "range"),
    "latencyMs": Col(ResearchResult.latency_ms, "range"),
    "cached": Col(ResearchResult.cached, "bool"),
    "finishedAt": Col(ResearchResult.finished_at, "date"),
}

NOTIFICATIONS: Spec = {
    "id": Col(Notification.id, "range"),
    "pamName": Col(Pam.name, "text"),
    "channel": Col(Notification.channel, "enum"),
    "recipient": Col(Notification.recipient, "text"),
    "status": Col(Notification.status, "enum"),
    "attempts": Col(Notification.attempts, "range"),
    "lastError": Col(Notification.last_error, "text", sortable=False),
    "createdAt": Col(Notification.created_at, "date"),
    "sentAt": Col(Notification.sent_at, "date"),
    "nextAttemptAt": Col(Notification.next_attempt_at, "date"),
}

DEAD_LETTERS: Spec = {
    "id": Col(DeadLetter.id, "range"),
    "channel": Col(DeadLetter.channel, "enum"),
    "recipient": Col(DeadLetter.recipient, "text"),
    "subject": Col(DeadLetter.subject, "text"),
    "reason": Col(DeadLetter.reason, "enum"),
    "attempts": Col(DeadLetter.attempts, "range"),
    "status": Col(DeadLetter.status, "enum"),
    "lastError": Col(DeadLetter.last_error, "text", sortable=False),
    "createdAt": Col(DeadLetter.created_at, "date"),
    "resolvedAt": Col(DeadLetter.resolved_at, "date"),
}

EVENTS: Spec = {
    "id": Col(ProcessEvent.id, "range"),
    "ts": Col(ProcessEvent.ts, "date"),
    "kind": Col(ProcessEvent.kind, "text"),
    "status": Col(ProcessEvent.status, "enum"),
    "message": Col(ProcessEvent.message, "text"),
    "runId": Col(ProcessEvent.run_id, "range"),
    "attempt": Col(ProcessEvent.attempt, "range"),
    "durationMs": Col(ProcessEvent.duration_ms, "range"),
    "provider": Col(ProcessEvent.provider, "enum"),
    "model": Col(ProcessEvent.model, "text"),
    "actor": Col(ProcessEvent.actor, "text"),
}

AUDIT: Spec = {
    "id": Col(AuditLog.id, "range"),
    "ts": Col(AuditLog.ts, "date"),
    "actor": Col(AuditLog.actor, "text"),
    "action": Col(AuditLog.action, "text"),
    "entity": Col(AuditLog.entity_type, "text"),
    "ip": Col(AuditLog.ip, "text"),
}

IMPORTS: Spec = {
    "id": Col(ImportBatch.id, "range"),
    "label": Col(ImportBatch.label, "text"),
    "fileName": Col(ImportBatch.file_name, "text"),
    "uploadedBy": Col(ImportBatch.uploaded_by, "text"),
    "uploadedAt": Col(ImportBatch.created_at, "date"),
    # Legacy "committed" rows read as "completed", as the UI shows them.
    "status": Col(case((ImportBatch.status == "committed", "completed"), else_=ImportBatch.status), "enum"),
    "rowsTotal": Col(ImportBatch.rows_total, "range"),
    "errorRows": Col(ImportBatch.rows_error, "range"),
}

USERS: Spec = {
    "username": Col(User.username, "text"),
    "name": Col(User.name, "text"),
    "email": Col(User.email, "text"),
    "role": Col(User.role, "enum"),
    "active": Col(User.active, "bool"),
    "lastLoginAt": Col(User.last_login_at, "date"),
    "createdAt": Col(User.created_at, "date"),
}
