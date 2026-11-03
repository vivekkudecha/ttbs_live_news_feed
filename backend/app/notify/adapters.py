"""Notification channel adapters. `console` logs the message instead of sending it; real
SMTP / WhatsApp Business adapters plug in behind the same interface later."""

import logging
from typing import Any, Protocol

from app.core.config import get_settings
from app.core.errors import ProviderError

log = logging.getLogger("ttbs.notify")


class ChannelAdapter(Protocol):
    def send(self, recipient: str, payload: dict[str, Any]) -> str: ...


class ConsoleAdapter:
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
    s = get_settings()
    name = {"email": s.notify_email_adapter, "whatsapp": s.notify_whatsapp_adapter}.get(channel)
    if name == "console":
        return ConsoleAdapter(channel)
    raise ProviderError(f"no adapter '{name}' for channel '{channel}'")
