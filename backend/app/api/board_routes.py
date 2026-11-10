"""Run results board (one table for a run's results, PAM groups, digests and logo timelines).
See services/run_board.py."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.api.deps import current_actor
from app.api.listing import Listing, listing
from app.db.session import unit_of_work
from app.services import run_board

router = APIRouter(prefix="/api/v1")


def _paging(page: int = Query(0, ge=0), page_size: int = Query(20, ge=1, le=200, alias="pageSize")) -> tuple[int, int]:
    return page, page_size


@router.get("/runs/{run_id}/board/groups")
def board_groups(run_id: int, q: str | None = Query(None, max_length=200), pg: tuple[int, int] = Depends(_paging),
                 lst: Listing = Depends(listing)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return run_board.groups(uow, run_board.get_run(uow, run_id), q=q, lst=lst, page=pg[0], size=pg[1])


@router.get("/runs/{run_id}/board/logos")
def board_logos(run_id: int, q: str | None = Query(None, max_length=200), pam_id: int | None = Query(None, alias="pamId", ge=0),
                pg: tuple[int, int] = Depends(_paging), lst: Listing = Depends(listing)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return run_board.logos(uow, run_board.get_run(uow, run_id), q=q, lst=lst, page=pg[0], size=pg[1], pam_id=pam_id)


@router.get("/runs/{run_id}/board/facets")
def board_facets(run_id: int, q: str | None = Query(None, max_length=200), lst: Listing = Depends(listing)) -> dict[str, Any]:
    with unit_of_work() as uow:
        return run_board.facets(uow, run_board.get_run(uow, run_id), q=q, lst=lst)


@router.get("/runs/{run_id}/board/logos/{result_id}/timeline")
def board_timeline(run_id: int, result_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        return run_board.timeline(uow, run_board.get_run(uow, run_id), result_id)


@router.get("/runs/{run_id}/board/pams/{pam_id}/digest")
def board_digest(run_id: int, pam_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        return run_board.digest_preview(uow, run_board.get_run(uow, run_id), pam_id)


class RetryIn(BaseModel):
    result_ids: list[str] = Field(default_factory=list, alias="resultIds", max_length=run_board.MAX_BULK)
    pam_ids: list[str] = Field(default_factory=list, alias="pamIds", max_length=run_board.MAX_BULK)


class ResendIn(BaseModel):
    pam_ids: list[str] = Field(alias="pamIds", min_length=1, max_length=run_board.MAX_BULK)
    channel: Literal["email", "whatsapp"] | None = None


@router.post("/runs/{run_id}/board/retry")
def board_retry(run_id: int, body: RetryIn, actor: str = Depends(current_actor)) -> dict[str, int]:
    with unit_of_work() as uow:
        return run_board.retry(uow, run_id, actor, body.result_ids, body.pam_ids)


@router.post("/runs/{run_id}/board/resend")
def board_resend(run_id: int, body: ResendIn, actor: str = Depends(current_actor)) -> dict[str, int]:
    with unit_of_work() as uow:
        return run_board.resend(uow, run_id, actor, body.pam_ids, body.channel)
