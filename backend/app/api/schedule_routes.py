"""Recurring research schedules (services/schedules.py) and the one-time runs waiting to start."""

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy import select

from app.api import schemas as sch
from app.api.deps import current_actor
from app.core.config import get_settings
from app.core.errors import ValidationFailed
from app.db.models import RUN_SCHEDULED, Run
from app.db.session import unit_of_work
from app.services import schedules

router = APIRouter(prefix="/api/v1")

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class RuleIn(sch.In):
    frequency: Literal["interval", "weekly", "monthly"] = "interval"
    interval_days: int = Field(default=10, ge=1, le=365)
    weekdays: list[int] = Field(default_factory=list, max_length=7)
    month_day: int | None = Field(default=None, ge=1, le=31)
    run_at_time: str = Field(default="06:00", pattern=HHMM)
    timezone: str = Field(default_factory=lambda: get_settings().timezone, max_length=64)
    ends_on: date | None = None


class ScheduleIn(RuleIn):
    name: str = Field(min_length=1, max_length=200)
    target: Literal["upload", "latest"] = "upload"
    import_id: int | None = Field(default=None, gt=0)
    channels: list[sch.Channel] = Field(default_factory=lambda: ["email", "whatsapp"])  # [] = research only
    enabled: bool = True


class SchedulePatch(sch.In):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    frequency: Literal["interval", "weekly", "monthly"] | None = None
    interval_days: int | None = Field(default=None, ge=1, le=365)
    weekdays: list[int] | None = Field(default=None, max_length=7)
    month_day: int | None = Field(default=None, ge=1, le=31)
    run_at_time: str | None = Field(default=None, pattern=HHMM)
    timezone: str | None = Field(default=None, max_length=64)
    ends_on: date | None = None
    target: Literal["upload", "latest"] | None = None
    import_id: int | None = Field(default=None, gt=0)
    channels: list[sch.Channel] | None = None
    enabled: bool | None = None


def _scope_key(target: str | None, import_id: int | None) -> str | None:
    if target == "latest":
        return schedules.LATEST
    if target == "upload" or import_id:
        if not import_id:
            raise ValidationFailed("Pick the upload to research", code="upload_required")
        return f"import:{import_id}"
    return None


@router.get("/schedules")
def list_schedules() -> dict[str, Any]:
    """Recurring schedules, plus one-time runs waiting for their start time (soonest first)."""
    with unit_of_work() as uow:
        once = uow.session.scalars(select(Run).where(Run.status == RUN_SCHEDULED).order_by(Run.scheduled_for).limit(50))
        return {"rows": schedules.listing(uow), "oneTime": [sch.run_out(r) for r in once]}


@router.post("/schedules", status_code=201)
def create_schedule(body: ScheduleIn, actor: str = Depends(current_actor)) -> dict[str, Any]:
    data = body.model_dump(exclude={"target", "import_id"})
    data["scope_key"] = _scope_key(body.target, body.import_id)
    with unit_of_work() as uow:
        return schedules.out(uow, schedules.create(uow, data, actor))


@router.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: SchedulePatch, actor: str = Depends(current_actor)) -> dict[str, Any]:
    data = body.model_dump(exclude_unset=True, exclude={"target", "import_id"})
    scope = _scope_key(body.target, body.import_id)
    if scope:
        data["scope_key"] = scope
    with unit_of_work() as uow:
        return schedules.out(uow, schedules.update_schedule(uow, schedule_id, data, actor))


@router.delete("/schedules/{schedule_id}", status_code=204)
def delete_schedule(schedule_id: int, actor: str = Depends(current_actor)) -> None:
    with unit_of_work() as uow:
        schedules.delete(uow, schedule_id, actor)


@router.post("/schedules/{schedule_id}/run", status_code=201)
def run_schedule_now(schedule_id: int, actor: str = Depends(current_actor)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return sch.run_out(schedules.run_now(uow, schedule_id, actor))


@router.post("/schedules/preview")
def preview(body: RuleIn) -> dict[str, Any]:
    """Plain-language summary and the next five times a rule fires (drives the live form preview)."""
    rule = schedules.Rule(**body.model_dump()).validate()
    return {"summary": rule.describe(), "upcoming": [t.isoformat() for t in rule.upcoming(5)]}
