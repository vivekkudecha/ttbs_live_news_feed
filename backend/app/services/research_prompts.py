"""Editable research prompt: immutable, numbered versions with exactly one active.

Saving creates a new version (and by default activates it); older versions can be re-activated
("restore"). Runs pin the active version when they start, so editing mid-run never mixes two
prompts inside one run. The version number is part of the research result-cache key."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.core.errors import NotFound, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import ResearchPromptVersion
from app.db.session import UnitOfWork, unit_of_work
from app.research.prompts import (
    PLACEHOLDERS,
    REQUIRED_LABELS,
    REQUIRED_PLACEHOLDERS,
    TOKEN,
    PromptSpec,
    default_spec,
)
from app.services import audit

log = logging.getLogger(__name__)

FIELDS = ("system_instruction", "research_prompt", "ttbs_context", "output_rules", "categories", "window_days")
MAX_TEXT = 50_000
MAX_SYSTEM = 4_000
MAX_CATEGORIES = 20
WINDOW_DAYS = (1, 90)

def to_spec(row: ResearchPromptVersion) -> PromptSpec:
    return PromptSpec(version=row.version, system=row.system_instruction, research_prompt=row.research_prompt,
                      ttbs_context=row.ttbs_context, output_rules=row.output_rules,
                      categories=tuple(row.categories or ()), window_days=row.window_days)


def ensure_default(uow: UnitOfWork) -> None:
    """Seed version 1 from the built-in prompt (identical wording, so cached answers stay valid)."""
    s = uow.session
    if s.scalar(select(func.count(ResearchPromptVersion.id))):
        return
    d = default_spec()
    now = utcnow()
    try:
        with s.begin_nested():
            s.add(ResearchPromptVersion(
                version=d.version, system_instruction=d.system, research_prompt=d.research_prompt,
                ttbs_context=d.ttbs_context, output_rules=d.output_rules, categories=list(d.categories),
                window_days=d.window_days, active=True, note="Built-in default", created_at=now, created_by="system",
                activated_at=now, activated_by="system"))
            s.flush()
    except IntegrityError:  # seeded concurrently by another worker
        log.info("research prompt already seeded")


def active_row(uow: UnitOfWork) -> ResearchPromptVersion:
    ensure_default(uow)
    row = uow.session.scalars(select(ResearchPromptVersion).where(ResearchPromptVersion.active.is_(True))).first()
    if row is None:  # never expected (activate is atomic), but never leave research without a prompt
        row = uow.session.scalars(select(ResearchPromptVersion).order_by(ResearchPromptVersion.version.desc())).first()
    return row


def get_version(uow: UnitOfWork, version: int) -> ResearchPromptVersion:
    ensure_default(uow)
    row = uow.session.scalars(select(ResearchPromptVersion).where(ResearchPromptVersion.version == version)).first()
    if row is None:
        raise NotFound(f"Research prompt version {version} not found")
    return row


def spec_for(uow: UnitOfWork, version: int | None) -> PromptSpec:
    """The spec a run uses: its pinned version, or the active one for runs from before pinning."""
    if version is not None:
        row = uow.session.scalars(select(ResearchPromptVersion).where(ResearchPromptVersion.version == version)).first()
        if row is not None:
            return to_spec(row)
    return to_spec(active_row(uow))


def list_versions(uow: UnitOfWork) -> list[ResearchPromptVersion]:
    ensure_default(uow)
    return list(uow.session.scalars(select(ResearchPromptVersion).order_by(ResearchPromptVersion.version.desc())))


# --- validation ----------------------------------------------------------------------------------


def clean(data: dict[str, Any]) -> dict[str, Any]:
    """Normalise and validate an edit; raises ValidationFailed with every problem at once."""
    errors: dict[str, str] = {}
    vals: dict[str, Any] = {}
    for f, limit in (("system_instruction", MAX_SYSTEM), ("research_prompt", MAX_TEXT), ("ttbs_context", MAX_TEXT),
                     ("output_rules", MAX_TEXT)):
        text = str(data.get(f) or "").replace("\r\n", "\n").strip()
        if not text:
            errors[f] = "Required"
        elif len(text) > limit:
            errors[f] = f"At most {limit:,} characters"
        vals[f] = text

    cats: list[str] = []
    for c in data.get("categories") or []:
        c = str(c).strip()
        if c and c.lower() not in {x.lower() for x in cats}:
            cats.append(c)
    if not cats:
        errors["categories"] = "Add at least one category"
    elif len(cats) > MAX_CATEGORIES:
        errors["categories"] = f"At most {MAX_CATEGORIES} categories"
    elif any(len(c) > 40 or "," in c for c in cats):
        errors["categories"] = "Each category: up to 40 characters, no commas"
    elif any(c.lower() == "none" for c in cats):
        errors["categories"] = "'None' is reserved for answers without a qualifying signal"
    vals["categories"] = cats

    try:
        days = int(data.get("window_days"))
    except (TypeError, ValueError):
        days = 0
    if not WINDOW_DAYS[0] <= days <= WINDOW_DAYS[1]:
        errors["window_days"] = f"Between {WINDOW_DAYS[0]} and {WINDOW_DAYS[1]} days"
    vals["window_days"] = days

    if not errors:
        problems: dict[str, list[str]] = {}
        for f in ("research_prompt", "ttbs_context", "output_rules"):
            unknown = sorted({t for t in TOKEN.findall(vals[f]) if t not in PLACEHOLDERS})
            if unknown:
                problems.setdefault(f, []).append("Unknown placeholder(s): " + ", ".join("{" + t + "}" for t in unknown))
        missing = [t for t in (*REQUIRED_PLACEHOLDERS, "ttbs_context", "output_rules") if "{" + t + "}" not in vals["research_prompt"]]
        if missing:
            problems.setdefault("research_prompt", []).append("Must include " + ", ".join("{" + t + "}" for t in missing))
        rendered = _spec(vals, 0).render("Example Ltd", "2026-01-01", "2026-01-10").lower()
        lacking = [lbl for lbl in REQUIRED_LABELS if lbl.lower() not in rendered]
        if lacking:
            problems.setdefault("output_rules", []).append(
                "The answer format must still ask for these lines (results are read from them): " + ", ".join(lacking))
        errors = {f: ". ".join(msgs) for f, msgs in problems.items()}
    if errors:
        camel = {f: f.split("_")[0] + "".join(w.title() for w in f.split("_")[1:]) for f in errors}
        raise ValidationFailed("The research prompt has problems: " + "; ".join(f"{camel[f]}: {m}" for f, m in errors.items()),
                               details={"fields": {camel[f]: m for f, m in errors.items()}})
    vals["note"] = (str(data.get("note") or "").strip() or None)
    if vals["note"] and len(vals["note"]) > 500:
        vals["note"] = vals["note"][:500]
    return vals


def _spec(vals: dict[str, Any], version: int) -> PromptSpec:
    return PromptSpec(version=version, system=vals["system_instruction"], research_prompt=vals["research_prompt"],
                      ttbs_context=vals["ttbs_context"], output_rules=vals["output_rules"],
                      categories=tuple(vals["categories"]), window_days=vals["window_days"])


# --- commands ------------------------------------------------------------------------------------


def save(data: dict[str, Any], actor: str, *, activate: bool = True) -> ResearchPromptVersion:
    vals = clean(data)
    with unit_of_work() as uow:
        cur = active_row(uow)
        if all(getattr(cur, f) == vals[f] for f in FIELDS):
            raise ValidationFailed("No changes compared with the active version")
        s = uow.session
        version = (s.scalar(select(func.max(ResearchPromptVersion.version))) or 0) + 1
        now = utcnow()
        if activate:
            s.execute(update(ResearchPromptVersion).where(ResearchPromptVersion.active.is_(True)).values(active=False))
            s.flush()
        row = ResearchPromptVersion(**{f: vals[f] for f in FIELDS}, version=version, active=activate, note=vals["note"],
                                    created_at=now, created_by=actor,
                                    activated_at=now if activate else None, activated_by=actor if activate else None)
        s.add(row)
        s.flush()
        changed = [f for f in FIELDS if getattr(cur, f) != vals[f]]
        audit.record(uow, "research.prompt.save", "research_prompt", version,
                     {"version": version, "from": cur.version, "changed": changed, "activated": activate, "note": vals["note"]},
                     actor=actor)
        s.refresh(row)
    return row


def activate(version: int, actor: str) -> ResearchPromptVersion:
    with unit_of_work() as uow:
        row = get_version(uow, version)
        if row.active:
            return row
        prev = active_row(uow).version
        s = uow.session
        s.execute(update(ResearchPromptVersion).where(ResearchPromptVersion.active.is_(True)).values(active=False))
        s.flush()
        row.active = True
        row.activated_at = utcnow()
        row.activated_by = actor
        s.flush()
        audit.record(uow, "research.prompt.activate", "research_prompt", version, {"version": version, "previous": prev}, actor=actor)
        s.refresh(row)
    return row


def preview(data: dict[str, Any] | None, company: str, version: int | None = None) -> dict[str, Any]:
    """Render a draft (validated) or a stored version for one company, without calling the AI."""
    if data is not None:
        spec = _spec(clean(data), 0)
    else:
        with unit_of_work() as uow:
            spec = to_spec(get_version(uow, version) if version else active_row(uow))
    end = date.today()
    start = end - timedelta(days=spec.window_days)
    prompt = spec.render(company.strip() or "Example Ltd", start.isoformat(), end.isoformat())
    return {"system": spec.system, "prompt": prompt, "windowStart": start.isoformat(), "windowEnd": end.isoformat(),
            "characters": len(prompt) + len(spec.system), "approxTokens": (len(prompt) + len(spec.system)) // 4}
