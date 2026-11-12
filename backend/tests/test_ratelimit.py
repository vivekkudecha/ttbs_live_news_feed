"""Provider rate limit: a shared bucket paced at the provider's own limit (learned from its headers),
paused by 429s, and research that waits for it instead of failing."""

import time
from datetime import date

import pytest
import respx
from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import ProviderError, RetryableProviderError
from app.core.timeutil import utcnow
from app.db.models import ProcessEvent, ResearchResult, Run
from app.db.session import unit_of_work
from app.research import providers, ratelimit
from app.services import maintenance
from tests.conftest import GOOD_ROWS, research, upload

URL = "https://api.perplexity.ai/v1/agent"
OK = {"output": [{"type": "message", "content": [{"type": "output_text", "text": "X\nCategory: None"}]}],
      "usage": {"input_tokens": 10, "output_tokens": 2}}


@pytest.fixture
def waits(monkeypatch):
    """Record the bucket's sleeps instead of sleeping."""
    out: list[float] = []
    monkeypatch.setattr(ratelimit.time, "sleep", out.append)
    return out


def test_bucket_spaces_calls_at_the_paced_rate(waits, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_rate_per_second", 10.0)
    monkeypatch.setattr(get_settings(), "llm_rate_headroom", 1.0)
    for _ in range(4):
        ratelimit.acquire("p")
    assert len(waits) == 3 and waits == pytest.approx([0.1, 0.2, 0.3], abs=0.03)  # first call goes straight away


def test_bucket_learns_the_providers_limit_and_pauses_when_none_remain(waits):
    assert ratelimit.limit("perplexity") == (1000.0, "settings")
    ratelimit.observe("perplexity", {"x-ratelimit-limit": "3", "x-ratelimit-remaining": "2"})
    st = ratelimit.status("perplexity")
    assert (st["limitPerSecond"], st["source"], st["pacedPerSecond"]) == (3.0, "provider", 2.7)

    ratelimit.observe("perplexity", {"x-ratelimit-limit": "3", "x-ratelimit-remaining": "0", "x-ratelimit-reset": str(time.time() + 30)})
    with pytest.raises(ratelimit.Throttled) as e:
        ratelimit.acquire("perplexity", max_wait_s=5)
    assert 29 <= e.value.retry_after <= 31 and e.value.kind == "bucket"


def test_token_limit_rejection_pauses_and_halves_the_rate():
    delay = ratelimit.rejected("perplexity", 4, "token")
    assert 4 <= delay <= 5 and ratelimit.status("perplexity")["pacedPerSecond"] == pytest.approx(1000 * 0.9 / 2)
    with pytest.raises(ratelimit.Throttled):
        ratelimit.acquire("perplexity", max_wait_s=1)


def test_bucket_falls_back_to_one_process_when_redis_is_down(waits, monkeypatch):
    import redis

    class Down:
        def __getattr__(self, _):
            def boom(*a, **k):
                raise redis.ConnectionError("down")
            return boom

    monkeypatch.setattr(ratelimit, "get_redis", lambda: Down())
    monkeypatch.setattr(get_settings(), "llm_rate_per_second", 10.0)
    monkeypatch.setattr(get_settings(), "llm_rate_headroom", 1.0)
    ratelimit.acquire("down")
    ratelimit.acquire("down")
    assert waits and waits[-1] == pytest.approx(0.1, abs=0.03)


@respx.mock
def test_perplexity_429_types():
    p = providers.PerplexityProvider("pplx-test-key-123456", "anthropic/claude-haiku-5-5")

    def call():
        return p.research("Pine Labs", date(2026, 11, 1), date(2026, 11, 10))

    respx.post(URL).respond(429, headers={"Retry-After": "2"}, json={"error": {"type": "request_rate_limit_exceeded", "message": "QPS"}})
    with pytest.raises(ratelimit.Throttled) as e:
        call()
    assert e.value.kind == "request" and e.value.retry_after >= 2
    assert ratelimit.status("perplexity")["nextSlotInS"] >= 1.5  # every worker is paused

    respx.post(URL).respond(429, json={"error": {"type": "insufficient_quota"}})  # not a rate limit: an ordinary retry
    with pytest.raises(RetryableProviderError) as e:
        call()
    assert not isinstance(e.value, ratelimit.Throttled)

    respx.post(URL).respond(200, headers={"x-ratelimit-limit": "8", "x-ratelimit-remaining": "7"}, json=OK)
    ratelimit.pause("perplexity", 0)
    with pytest.raises(ratelimit.Throttled):  # still paused by the 429 above: research would re-queue
        ratelimit.acquire("perplexity", max_wait_s=0.5)
    call()
    assert ratelimit.limit("perplexity") == (8.0, "provider")  # Tier 2 learned from the response


def test_rate_limited_logo_waits_without_spending_attempts(client, monkeypatch):
    real, calls = providers.FakeProvider.research, {"n": 0}

    def throttled_twice(self, company, ws, we, prompt=None):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise ratelimit.Throttled("perplexity HTTP 429 request rate limit", retry_after=0, kind="request")
        return real(self, company, ws, we)

    monkeypatch.setattr(providers.FakeProvider, "research", throttled_twice)
    run_id = research(client, upload(client, GOOD_ROWS[:1]).json()["id"], []).json()["id"]
    with unit_of_work() as uow:
        res = uow.session.scalars(select(ResearchResult).where(ResearchResult.run_id == int(run_id))).one()
        assert res.status == "signal" and res.attempts == 1 and res.error is None
        events = uow.session.scalars(select(ProcessEvent).where(ProcessEvent.kind == "research.attempt", ProcessEvent.status == "retry")).all()
        assert len(events) == 2 and all(e.attrs.get("rate_limit") == "request" for e in events)


def test_logo_fails_only_after_waiting_the_maximum(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "research_rate_limited_max_hours", 0)
    monkeypatch.setattr(providers.FakeProvider, "research",
                        lambda *a, **k: (_ for _ in ()).throw(ratelimit.Throttled("429", retry_after=0, kind="request")))
    run_id = research(client, upload(client, GOOD_ROWS[:1]).json()["id"], []).json()["id"]
    res = client.get(f"/api/v1/runs/{run_id}/results").json()["rows"][0]
    assert res["status"] == "failed" and res["error"].startswith("rate limited for over 0 h")


def test_failed_logos_are_retried_automatically_in_rounds(client, monkeypatch):
    real = providers.FakeProvider.research

    def outage(self, company, ws, we, prompt=None):
        if company.startswith("Havells"):
            raise RetryableProviderError("perplexity HTTP 503")
        if company.startswith("Tata"):
            raise ProviderError("perplexity HTTP 400: bad request")  # permanent: never retried automatically
        return real(self, company, ws, we)

    monkeypatch.setattr(providers.FakeProvider, "research", outage)
    rows = [*GOOD_ROWS, ["Tata Elxsi", "IT", "", "", "Rohan Das", "rohan@ttbs.example", "9830033003"]]
    run_id = int(research(client, upload(client, rows).json()["id"], []).json()["id"])
    with unit_of_work() as uow:
        run = uow.session.get(Run, run_id)
        assert run.status == "partial" and run.recover_at is not None and run.recovery_round == 0

    assert maintenance.recover_failed_runs() == []  # not due yet
    with unit_of_work() as uow:
        uow.session.get(Run, run_id).recover_at = utcnow()
    monkeypatch.setattr(providers.FakeProvider, "research", lambda self, c, ws, we, prompt=None: outage(self, "ok " + c, ws, we)
                        if c.startswith("Havells") else outage(self, c, ws, we))
    assert maintenance.recover_failed_runs() == [run_id]

    with unit_of_work() as uow:
        run = uow.session.get(Run, run_id)
        rows = {r.company.name: r for r in uow.session.scalars(select(ResearchResult).where(ResearchResult.run_id == run_id))}
        assert run.recovery_round == 1 and run.failed == 1 and run.recover_at is None  # only the permanent failure is left
        assert next(r for n, r in rows.items() if n.startswith("Havells")).status != "failed"
