"""Notification channel adapters. `console` logs the message instead of sending it; email goes
through Microsoft Graph (app/notify/graph.py) once configured in the UI; a WhatsApp Business
adapter plugs in behind the same interface later."""

import logging
from typing import Any, Protocol

from app.core.config import get_settings
from app.core.errors import ProviderError, RetryableProviderError

log = logging.getLogger("ttbs.notify")


class ChannelAdapter(Protocol):
    def send(self, recipient: str, payload: dict[str, Any]) -> str: ...


class ConsoleAdapter:
    key = "console"  # recorded on telemetry events and cost-ledger rows

    def __init__(self, channel: str):
        self.channel = channel

    def send(self, recipient: str, payload: dict[str, Any]) -> str:
        log.info(
            "notification (console adapter)",
            extra={"channel": self.channel, "recipient": recipient, "subject": payload.get("subject"),
                   "body_preview": (payload.get("body") or "")[:500]},
        )
        return f"console-{self.channel}"


def get_adapter(channel: str) -> ChannelAdapter:
    """Email: Microsoft Graph when it is configured in the UI (Providers & channels), else the
    NOTIFY_EMAIL_ADAPTER setting (console in development). WhatsApp: NOTIFY_WHATSAPP_ADAPTER."""
    s = get_settings()
    if channel == "email":
        from app.db.session import unit_of_work
        from app.notify.graph import GraphMailAdapter
        from app.services import email_config

        with unit_of_work() as uow:
            row = email_config.get_row(uow)
            if row is not None:
                if not row.enabled:
                    raise RetryableProviderError("Email delivery is switched off under Providers & channels")
                return GraphMailAdapter(email_config.credentials(row))
    name = {"email": s.notify_email_adapter, "whatsapp": s.notify_whatsapp_adapter}.get(channel)
    if name == "console":
        return ConsoleAdapter(channel)
    raise ProviderError(f"no adapter '{name}' for channel '{channel}'")
