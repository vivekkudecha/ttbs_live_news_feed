"""Turn the model's free-text answer into structured fields."""

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from app.research.prompts import CATEGORIES

NOT_FOUND = "details not found"
_URL = re.compile(r"https?://[^\s)\]>\"'<,]+")
_LABELS = {
    "category": "category",
    "key signals": "key_signals",
    "opportunity type": "opportunity",
    "recommended outreach approach": "outreach",
}
_LINE = re.compile(r"^\W*(category|key signals|opportunity type|recommended outreach approach)\W*:\s*(.*)$", re.I)


@dataclass
class Parsed:
    status: str  # "signal" | "no_signal"
    category: str | None = None
    key_signals: str | None = None
    opportunity: str | None = None
    outreach: str | None = None
    sources: list[dict[str, str]] = field(default_factory=list)


def parse_research(text: str) -> Parsed:
    fields: dict[str, list[str]] = {}
    current: str | None = None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _LINE.match(line)
        if m:
            current = _LABELS[m.group(1).lower()]
            fields[current] = [m.group(2).strip()]
        elif current:
            fields[current].append(line)
    out = {k: "\n".join(v).strip() or None for k, v in fields.items()}

    signals = out.get("key_signals")
    if not signals or NOT_FOUND in signals.lower():
        return Parsed(status="no_signal")

    cat = (out.get("category") or "").strip(" *").lower()
    category = next((c for c in CATEGORIES if c.lower() == cat), None)

    seen: set[str] = set()
    sources = []
    for url in _URL.findall(text):
        url = url.rstrip(".;:")
        if url not in seen:
            seen.add(url)
            sources.append({"title": urlparse(url).netloc.removeprefix("www."), "url": url})

    return Parsed(
        status="signal",
        category=category,
        key_signals=signals,
        opportunity=out.get("opportunity"),
        outreach=out.get("outreach"),
        sources=sources[:10],
    )
