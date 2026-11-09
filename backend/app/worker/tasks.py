"""Celery tasks. Retries are tracked in the database (attempts, error, enqueued_at) rather than in
Celery's in-memory retry state, so they survive worker restarts and are visible in the UI."""

import logging
import random
import time

from app.core import cache, metrics
from app.core.config import get_settings
from app.core.context import job_id_var
from app.core.errors import ProviderError, RetryableProviderError
from app.db.models import RES_FAILED, RES_NO_SIGNAL, RES_SIGNAL, Run
from app.db.session import unit_of_work
from app.research import ratelimit
from app.research.parser import parse_research
from app.research.prompts import PROMPT_VERSION
from app.research.providers import get_provider
from app.services import maintenance, notifications, runs, telemetry
from app.worker.celery_app import celery_app

log = logging.getLogger(__name__)


def backoff(attempt: int, retry_after: float | None = None) -> float:
    if retry_after:
        return min(float(retry_after), 300.0) + random.uniform(0, 1)
    cap = get_settings().research_backoff_cap_s
    return min(cap, 2 ** attempt) + random.uniform(0, 1)  # jitter: workers don't retry in lockstep


@celery_app.task(name="maintenance.start_run")
def start_run(run_id: int) -> bool:
    job_id_var.set(run_id)
    with unit_of_work() as uow:
        return runs.start(uow, run_id)


@celery_app.task(name="research.company")
def research_company(result_id: int) -> str:
    s = get_settings()
    with unit_of_work() as uow:
        res = runs.claim_result(uow, result_id)
        if res is None:
            return "skipped"
        run = uow.session.get(Run, res.run_id)
        job_id_var.set(run.id)
        run_id, import_id, company_id, pam_id = run.id, run.import_id, res.company_id, res.pam_id
        company_name, name_key = res.company.name, res.company.name_key
        window_start, window_end, attempt = run.window_start, run.window_end, res.attempts
        over_budget = run.budget_cap is not None and run.cost >= run.budget_cap

    if over_budget:
        with unit_of_work() as uow:
            runs.complete_result(uow, result_id, {"status": RES_FAILED, "error": "budget cap reached for this run"},
                                 event_status=telemetry.SKIPPED)
        return "budget"

    try:
        provider = get_provider()  # key + model saved in the UI (re-read per task: rotations apply immediately)
    except ProviderError as e:
        log.warning("research provider unavailable", extra={"result_id": result_id, "err": str(e)})
        with unit_of_work() as uow:
            runs.complete_result(uow, result_id, {"status": RES_FAILED, "error": str(e)[:1000]})
        return "failed"
    ctx = {"run_id": run_id, "import_id": import_id, "company_id": company_id, "pam_id": pam_id,
           "provider": provider.key, "model": provider.model}

    # Model is part of the key: switching models must not serve another model's answers.
    cache_key = f"research:{name_key}:{window_end.isoformat()}:p{PROMPT_VERSION}:{provider.key}:{provider.model}"
    hit = cache.get_json(cache_key)
    if hit:
        with unit_of_work() as uow:
            runs.complete_result(uow, result_id, {**hit, "cached": True, "cost": 0.0, "latency_ms": 0, "error": None})
        return "cached"

    t0 = time.perf_counter()
    try:
        ratelimit.acquire("llm")
        t0 = time.perf_counter()
        out = provider.research(company_name, window_start, window_end)
        parsed = parse_research(out.text)
    except RetryableProviderError as e:
        return _retry_or_fail(result_id, attempt, str(e), e.retry_after, s.research_max_retries, ctx, _ms(t0))
    except ProviderError as e:
        log.warning("research permanent failure", extra={"result_id": result_id, "err": str(e)})
        with unit_of_work() as uow:
            runs.complete_result(uow, result_id, {"status": RES_FAILED, "error": str(e)[:1000], "latency_ms": _ms(t0)})
        return "failed"
    except Exception as e:  # unexpected (bug, DB blip, timeout in limiter): retry, then give up
        log.exception("research crashed", extra={"result_id": result_id})
        return _retry_or_fail(result_id, attempt, f"{type(e).__name__}: {e}", None, s.research_max_retries, ctx, _ms(t0))
    metrics.RESEARCH_LATENCY.labels(provider.key).observe(time.perf_counter() - t0)

    values = {
        "status": RES_SIGNAL if parsed.status == "signal" else RES_NO_SIGNAL,
        "category": parsed.category,
        "key_signals": parsed.key_signals,
        "opportunity": parsed.opportunity,
        "outreach": parsed.outreach,
        "sources": _merge_sources(out.sources, parsed.sources) if parsed.status == "signal" else [],
        "raw_text": out.text[:20000],
        "tokens_in": out.tokens_in,
        "tokens_out": out.tokens_out,
        "cost": out.cost,
        "latency_ms": out.latency_ms or int((time.perf_counter() - t0) * 1000),
        "cached": False,
        "error": None,
    }
    with unit_of_work() as uow:
        runs.complete_result(uow, result_id, values)
    # Cache only successful answers, for the length of the research window.
    cacheable = {k: values[k] for k in ("status", "category", "key_signals", "opportunity", "outreach", "sources", "raw_text", "tokens_in", "tokens_out")}
    cache.set_json(cache_key, cacheable, ttl=s.research_window_days * 86400)
    return values["status"]


def _merge_sources(grounded: list[dict[str, str]], inline: list[dict[str, str]], limit: int = 10) -> list[dict[str, str]]:
    """Provider-grounded sources first (verified by the search tool), then URLs cited in the text."""
    seen: set[str] = set()
    out = []
    for s in [*grounded, *inline]:
        if s.get("url") and s["url"] not in seen:
            seen.add(s["url"])
            out.append(s)
    return out[:limit]


def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def _retry_or_fail(result_id: int, attempt: int, error: str, retry_after: float | None, max_retries: int,
                   ctx: dict | None = None, duration_ms: int | None = None) -> str:
    if attempt > max_retries:
        with unit_of_work() as uow:
            runs.complete_result(uow, result_id, {"status": RES_FAILED, "error": f"gave up after {attempt} attempts: {error}"[:1000],
                                                  "latency_ms": duration_ms or 0})
        return "failed"
    delay = backoff(attempt, retry_after)
    log.info("research retry scheduled", extra={"result_id": result_id, "attempt": attempt, "delay_s": round(delay, 1), "err": error})
    with unit_of_work() as uow:
        runs.release_for_retry(uow, result_id, f"attempt {attempt}: {error}")
        telemetry.event(uow, "research.attempt", telemetry.RETRY, attempt=attempt, duration_ms=duration_ms,
                        message=f"{error[:300]} (retry in {delay:.0f}s)", retry_in_s=round(delay, 1), **(ctx or {}))
        uow.after_commit(lambda: research_company.apply_async((result_id,), countdown=delay))
    if ctx:
        metrics.RESEARCH_ATTEMPTS.labels(ctx["provider"], ctx["model"], telemetry.RETRY).inc()
    return "retry"


@celery_app.task(name="notify.send")
def send_notification(notification_id: int) -> str:
    return notifications.deliver(notification_id)


@celery_app.task(name="notify.dispatch_email")
def dispatch_email() -> dict:
    """Fill the free email quota (minute/hour/day buckets) from the pending outbox, oldest first."""
    from app.services import email_quota

    return email_quota.dispatch()


@celery_app.task(name="maintenance.process_import")
def process_import(import_id: int) -> str:
    """Save an uploaded dataset in resumable chunks (see services/imports.process)."""
    from app.services import imports

    return imports.process(import_id)


@celery_app.task(name="maintenance.analyze_import")
def analyze_import(import_id: int) -> str:
    """Check an uploaded file row by row (streaming) and build its preview (services/imports.analyze)."""
    from app.services import imports

    return imports.analyze(import_id)


@celery_app.task(name="maintenance.tick")
def tick() -> dict:
    return maintenance.tick()
