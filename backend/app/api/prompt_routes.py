"""Editable research prompt: versions, save (new version), activate/restore, preview."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import Field

from app.api import schemas as sch
from app.api.deps import current_actor
from app.db.models import ResearchPromptVersion
from app.db.session import unit_of_work
from app.research.prompts import PLACEHOLDERS, REQUIRED_LABELS, REQUIRED_PLACEHOLDERS, default_spec
from app.services import research_prompts

router = APIRouter(prefix="/api/v1")
iso = sch.iso


class PromptIn(sch.In):
    system_instruction: str = Field(max_length=research_prompts.MAX_SYSTEM)
    research_prompt: str = Field(max_length=research_prompts.MAX_TEXT)
    ttbs_context: str = Field(max_length=research_prompts.MAX_TEXT)
    output_rules: str = Field(max_length=research_prompts.MAX_TEXT)
    categories: list[str] = Field(max_length=50)
    window_days: int
    note: str | None = Field(default=None, max_length=500)


class SaveIn(PromptIn):
    activate: bool = True


class PreviewIn(sch.In):
    company: str = Field(default="Example Ltd", max_length=300)
    draft: PromptIn | None = None
    version: int | None = None


def version_out(v: ResearchPromptVersion, full: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "version": v.version, "active": v.active, "note": v.note, "createdAt": iso(v.created_at), "createdBy": v.created_by,
        "activatedAt": iso(v.activated_at), "activatedBy": v.activated_by, "windowDays": v.window_days,
        "categories": list(v.categories or []),
    }
    if full:
        out |= {"systemInstruction": v.system_instruction, "researchPrompt": v.research_prompt,
                "ttbsContext": v.ttbs_context, "outputRules": v.output_rules}
    return out


def _defaults() -> dict[str, Any]:
    d = default_spec()
    return {"systemInstruction": d.system, "researchPrompt": d.research_prompt, "ttbsContext": d.ttbs_context,
            "outputRules": d.output_rules, "categories": list(d.categories), "windowDays": d.window_days}


@router.get("/research-prompt")
def get_prompt() -> dict[str, Any]:
    with unit_of_work() as uow:
        active = research_prompts.active_row(uow)
        versions = research_prompts.list_versions(uow)
        return {
            "active": version_out(active),
            "versions": [version_out(v, full=False) for v in versions],
            "placeholders": [{"key": k, "description": d, "required": k in REQUIRED_PLACEHOLDERS} for k, d in PLACEHOLDERS.items()],
            "requiredLabels": list(REQUIRED_LABELS),
            "limits": {"windowDays": list(research_prompts.WINDOW_DAYS), "maxCategories": research_prompts.MAX_CATEGORIES},
            "defaults": _defaults(),
        }


@router.get("/research-prompt/versions/{version}")
def get_prompt_version(version: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        return version_out(research_prompts.get_version(uow, version))


@router.post("/research-prompt", status_code=201)
def save_prompt(body: SaveIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    data = body.model_dump(exclude={"activate"})
    return version_out(research_prompts.save(data, actor, activate=body.activate))


@router.post("/research-prompt/versions/{version}/activate")
def activate_prompt(version: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    return version_out(research_prompts.activate(version, actor))


@router.post("/research-prompt/preview")
def preview_prompt(body: PreviewIn) -> dict[str, Any]:
    draft = body.draft.model_dump() if body.draft else None
    return research_prompts.preview(draft, body.company, body.version)
