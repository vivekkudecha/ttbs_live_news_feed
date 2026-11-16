"""PRIORITY ACTIONS: once a PAM's research in a run is done, one AI call reads that PAM's signals and
returns a ranked "Why now? / Action:" list (the original script's last step, now per PAM).

- Stored once per run x PAM (`pam_priorities`), shown at the end of the PAM's digest and under the PAM
  on the run board.
- The digest waits for it (`gate`, called by runs.maybe_queue_pam_digest). If the AI cannot answer,
  the digest goes out without the section: delivery is never blocked.
- `signals_key` ties the list to the signals it was written from. A retry that changes them writes it
  again, and the refreshed digest carries the new list.
- Uses the provider's priority model (Providers & channels; a small model is enough, there is no web
  search) and the run's pinned prompt version (rules + actions per PAM). Rate limited like research,
  metered in the cost ledger (outcome "priority_actions").
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.core import cache
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, ProviderError, RetryableProviderError
from app.db.models import PRIORITY_FAILED, PRIORITY_PENDING, PRIORITY_READY, PamPriority, ResearchResult, Run
from app.db.session import UnitOfWork, unit_of_work
from app.research import ratelimit
from app.research.prompts import PRIORITY_SYSTEM, PromptSpec
from app.services import audit, finops, telemetry
from app.services.imports import name_key

log = logging.getLogger(__name__)

SEPARATOR = "=" * 40
OUTCOME = "priority_actions"  # cost-ledger outcome


# --- Prompt and answer --------------------------------------------------------------------------------


def items(signals: list[ResearchResult]) -> list[dict[str, Any]]:
    """The PAM's signals as the AI reads them (and as answers are matched back)."""
    return [{"resultId": r.id, "companyId": r.company_id, "company": r.company.name, "category": r.category,
             "key_signals": r.key_signals, "opportunity": r.opportunity, "outreach": r.outreach} for r in signals]


def signals_key(its: list[dict[str, Any]]) -> str:
    body = [[i["company"], i["category"], i["key_signals"], i["opportunity"], i["outreach"]] for i in its]
    return hashlib.sha256(json.dumps(body, ensure_ascii=False).encode()).hexdigest()


def prompt(spec: PromptSpec, its: list[dict[str, Any]]) -> str:
    blocks = [f"{i['company'].upper()}\nCategory: {i['category'] or 'None'}\nKey signals: {i['key_signals'] or '-'}\n"
              f"Opportunity type: {i['opportunity'] or '-'}\nRecommended outreach approach: {i['outreach'] or '-'}" for i in its]
    limit = f"\n\nReturn at most {spec.priority_limit} entries: the {spec.priority_limit} strongest." if spec.priority_limit else ""
    return ("Below are TTBS company research results for one PAM.\n\n" + f"\n{SEPARATOR}\n".join(blocks)
            + f"\n\n{SEPARATOR}\n\n{spec.priority_rules}{limit}")


_LEAD = re.compile(r"^[\s>*#\-•\d.)]+")  # list numbering / markdown in front of a line
_LABEL = re.compile(r"^(why now\??|action)\s*[:?\-–]*\s*", re.I)


def _bare(line: str) -> str:
    return _LEAD.sub("", line).replace("**", "").replace("__", "").strip()


def parse(text: str, its: list[dict[str, Any]], limit: int = 0) -> list[dict[str, Any]]:
    """The AI's answer → ranked entries matched to the PAM's signals (ported from the original
    `parse_priority_actions`). Unknown companies and entries without content are dropped."""
    keys = [(name_key(i["company"]), i) for i in its]

    def match(line: str) -> dict[str, Any] | None:
        k = name_key(line)
        if not k:
            return None
        exact = next((i for nk, i in keys if nk == k), None)
        return exact or next((i for nk, i in keys if nk and len(k) >= 6 and (k in nk or nk in k)), None)

    out: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for raw in text.splitlines():
        line = _bare(raw)
        if not line:
            continue
        low = line.lower()
        if low.startswith(("why now", "action")):
            if cur is not None:
                cur["whyNow" if low.startswith("why now") else "action"] = _LABEL.sub("", line).strip()
            continue
        hit = match(line)
        if hit is not None:
            seen = any(e["resultId"] == hit["resultId"] for e in out)
            cur = None if seen else {"resultId": hit["resultId"], "companyId": hit["companyId"], "company": hit["company"],
                                     "whyNow": "", "action": ""}
            if cur is not None:
                out.append(cur)
        elif line.isupper():  # a company heading we cannot place (not this PAM's): skip its lines
            cur = None
        elif cur is not None:  # a wrapped line continues the field above it
            field = "action" if cur["action"] else "whyNow" if cur["whyNow"] else None
            if field:
                cur[field] = f"{cur[field]} {line}"
    out = [e for e in out if e["whyNow"] or e["action"]]
    if limit:
        out = out[:limit]
    for n, e in enumerate(out, start=1):
        e["rank"] = n
    return out


# --- State ---------------------------------------------------------------------------------------------


def _row(uow: UnitOfWork, run_id: int, pam_id: int) -> PamPriority | None:
    return uow.session.scalars(select(PamPriority).where(PamPriority.run_id == run_id, PamPriority.pam_id == pam_id)).first()


def current(uow: UnitOfWork, run: Run, pam_id: int, signals: list[ResearchResult]) -> list[dict[str, Any]]:
    """The stored actions when they were written from exactly these signals (else none)."""
    if not signals:
        return []
    row = _row(uow, run.id, pam_id)
    return list(row.actions or []) if row and row.status == PRIORITY_READY and row.signals_key == signals_key(items(signals)) else []


def _enqueue(uow: UnitOfWork, run_id: int, pam_id: int, countdown: float = 0) -> None:
    from app.worker.tasks import pam_priorities

    uow.after_commit(lambda: pam_priorities.apply_async((run_id, pam_id), countdown=countdown))


def gate(uow: UnitOfWork, run: Run, pam_id: int, signals: list[ResearchResult]) -> list[dict[str, Any]] | None:
    """Before a PAM's digest is written: its actions, or None while they are being written (the task
    writes the digest when done). No signals: nothing to rank, the digest goes ahead."""
    if not signals:
        return []
    key = signals_key(items(signals))
    row = _row(uow, run.id, pam_id)
    if row is not None and row.signals_key == key:
        if row.status == PRIORITY_READY:
            return list(row.actions or [])
        if row.status == PRIORITY_FAILED:
            return []  # the AI could not answer: send without the section
        return None  # already being written
    s = uow.session
    if row is None:
        try:
            with s.begin_nested():
                row = PamPriority(run_id=run.id, pam_id=pam_id, status=PRIORITY_PENDING, signals_key=key, actions=[])
                s.add(row)
                s.flush()
        except IntegrityError:  # created concurrently: that caller queued the task
            return None
    else:  # the signals changed (a retry): write it again
        row.status, row.signals_key, row.error, row.attempts = PRIORITY_PENDING, key, None, 0
    _enqueue(uow, run.id, pam_id)
    return None


def retry(uow: UnitOfWork, run_id: int, pam_id: int, actor: str) -> dict[str, Any]:
    """Write a PAM's priority actions again (from the board, e.g. after the AI failed)."""
    row = _row(uow, run_id, pam_id)
    if row is None:
        raise NotFound("This PAM has no priority actions in this run")
    if row.status == PRIORITY_PENDING:
        raise Conflict("Priority actions are already being written")
    row.status, row.error, row.attempts = PRIORITY_PENDING, None, 0
    audit.record(uow, "priority.retry", "run", run_id, {"pam_id": pam_id}, actor=actor, run_id=run_id)
    _enqueue(uow, run_id, pam_id)
    uow.after_commit(lambda: cache.bump(f"run:{run_id}"))
    return out(row)


def out(row: PamPriority | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {"status": row.status, "provider": row.provider, "model": row.model, "error": row.error, "actions": list(row.actions or [])}


def for_pams(uow: UnitOfWork, run_id: int, pam_ids: list[int]) -> dict[int, dict[str, Any] | None]:
    if not pam_ids:
        return {}
    rows = uow.session.scalars(select(PamPriority).where(PamPriority.run_id == run_id, PamPriority.pam_id.in_(pam_ids)))
    return {r.pam_id: out(r) for r in rows}


# --- The task ------------------------------------------------------------------------------------------


def generate(run_id: int, pam_id: int) -> str:
    """Celery task body (worker/tasks.pam_priorities). Returns what happened."""
    from app.research import providers
    from app.services import research_prompts, runs

    s_ = get_settings()
    with unit_of_work() as uow:
        run, row = uow.session.get(Run, run_id), _row(uow, run_id, pam_id)
        if run is None or row is None or row.status != PRIORITY_PENDING:
            return "skipped"
        _, signals, _ = runs.pam_digest(uow, run, pam_id)
        its = items(signals)
        if signals_key(its) != row.signals_key:
            return "stale"  # signals changed since; that change queued its own task
        row.attempts += 1
        attempt, key = row.attempts, row.signals_key
        spec = research_prompts.spec_for(uow, run.prompt_version)
    try:
        provider = providers.get_provider(purpose="priority")
        text = prompt(spec, its)
        # Same signals, rules and model as an earlier run (e.g. a re-run served from the research cache):
        # reuse that answer instead of paying for it again. Re-parsed, so ids are this run's.
        ck = f"priority:{hashlib.sha256(f'{text}|{PRIORITY_SYSTEM}'.encode()).hexdigest()}:{provider.key}:{provider.model}"
        hit = cache.get_json(ck)
        if isinstance(hit, dict) and hit.get("text"):
            return _finish(run_id, pam_id, key, actions=parse(hit["text"], its, spec.priority_limit), provider=provider)
        ratelimit.acquire(provider.key)
        out_ = provider.generate(text, system=PRIORITY_SYSTEM, max_tokens=s_.priority_max_output_tokens)
        actions = parse(out_.text, its, spec.priority_limit)
        cache.set_json(ck, {"text": out_.text}, ttl=spec.window_days * 86400)
    except ratelimit.Throttled as e:  # not a failure: back in line, no attempt spent
        return _again(run_id, pam_id, float(e.retry_after or 1.0), refund=True)
    except RetryableProviderError as e:
        if attempt <= s_.research_max_retries:
            from app.worker.tasks import backoff

            return _again(run_id, pam_id, backoff(attempt, e.retry_after))
        return _finish(run_id, pam_id, key, error=f"gave up after {attempt} attempts: {e}")
    except ProviderError as e:
        return _finish(run_id, pam_id, key, error=str(e))
    return _finish(run_id, pam_id, key, actions=actions, provider=provider, out=out_)


def _again(run_id: int, pam_id: int, delay: float, *, refund: bool = False) -> str:
    with unit_of_work() as uow:
        if refund:
            uow.session.execute(update(PamPriority).where(PamPriority.run_id == run_id, PamPriority.pam_id == pam_id)
                                .values(attempts=PamPriority.attempts - 1))
        _enqueue(uow, run_id, pam_id, countdown=delay)
    return "retry"


def _finish(run_id: int, pam_id: int, key: str, *, actions: list[dict[str, Any]] | None = None, error: str | None = None,
            provider: Any = None, out: Any = None) -> str:
    from app.services import runs

    with unit_of_work() as uow:
        run, row = uow.session.get(Run, run_id), _row(uow, run_id, pam_id)
        if run is None or row is None or row.status != PRIORITY_PENDING or row.signals_key != key:
            return "stale"
        row.status = PRIORITY_READY if error is None else PRIORITY_FAILED
        row.actions, row.error = actions or [], (error or None) and error[:1000]
        if provider is not None:
            row.provider, row.model = provider.key, provider.model
        if out is not None and (out.cost or out.tokens_in or out.tokens_out):
            finops.record_ai_call(uow, run=run, pam_id=pam_id, outcome=OUTCOME, provider=provider.key, model=provider.model, out=out)
            uow.session.execute(update(Run).where(Run.id == run.id).values(cost=Run.cost + float(out.cost or 0.0)))
        telemetry.event(uow, "priority.written" if error is None else "priority.failed",
                        telemetry.OK if error is None else telemetry.ERROR, run_id=run.id, import_id=run.import_id, pam_id=pam_id,
                        actor="system", provider=row.provider, model=row.model, cost=getattr(out, "cost", None),
                        message=f"{len(row.actions)} priority actions" if error is None else f"Priority actions not written: {error[:300]}")
        uow.session.flush()
        status = row.status
        runs.maybe_queue_pam_digest(uow, run, pam_id)  # the digest was waiting for these
        uow.after_commit(lambda: cache.bump(f"run:{run_id}", "runs"))
    if error:
        log.warning("priority actions failed", extra={"run_id": run_id, "pam_id": pam_id, "err": error})
    return status
