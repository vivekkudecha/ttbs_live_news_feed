"""Perplexity adapter: HTTP status → retryable/permanent classification and response parsing."""

from datetime import date

import httpx
import pytest
import respx

from app.core.errors import ProviderError, RetryableProviderError
from app.research import providers
from app.research.parser import parse_research
from app.research.providers import PerplexityProvider

URL = "https://api.perplexity.ai/v1/agent"
TEXT = (
    "PINE LABS\nCategory: Expansion\nKey signals: Opening **3 new offices** in Pune (https://www.example.com/a).\n"
    "Opportunity type: **SD-WAN** for new branches\nRecommended outreach approach: Pitch **ILL + SD-WAN** to the CIO"
)


@pytest.fixture
def provider():
    return PerplexityProvider("pplx-test-key-123456", "anthropic/claude-sonnet-5")


def call(p):
    return p.research("Pine Labs", date(2026, 10, 24), date(2026, 11, 3))


@respx.mock
def test_success_parses_text_usage_and_cost(provider):
    respx.post(URL).respond(200, json={
        "status": "completed",
        "output": [{"type": "message", "content": [{"type": "output_text", "text": TEXT}]}],
        "usage": {"input_tokens": 1000, "output_tokens": 200, "cost": {"total_cost": 0.0123}},
    })
    out = call(provider)
    assert out.tokens_in == 1000 and out.cost == 0.0123
    parsed = parse_research(out.text)
    assert parsed.status == "signal" and parsed.category == "Expansion"
    assert parsed.sources == [{"title": "example.com", "url": "https://www.example.com/a"}]


@respx.mock
def test_usage_breakdown_is_kept_as_the_provider_billed_it(provider):
    usage = {
        "input_tokens": 12000, "output_tokens": 700, "total_tokens": 12700,
        "input_tokens_details": {"cache_creation_input_tokens": 300, "cache_read_input_tokens": 9000},
        "tool_calls_details": {"web_search": {"invocation": 3, "cost_usd": 0.015}},
        "cost": {"currency": "USD", "input_cost": 0.003, "output_cost": 0.0035, "cache_creation_cost": 0.0004,
                 "cache_read_cost": 0.0009, "tool_calls_cost": 0.015, "total_cost": 0.0228},
    }
    respx.post(URL).respond(200, json={"id": "resp_123", "output": [{"type": "message", "content": [{"type": "output_text", "text": TEXT}]}],
                                       "usage": usage})
    out = call(provider)
    u = out.usage
    assert (out.tokens_in, out.tokens_out, out.cost) == (12000, 700, 0.0228)
    assert (u.cache_read, u.cache_write, u.tool_calls, u.source, u.response_id) == (9000, 300, 3, "provider", "resp_123")
    assert (u.input_cost, u.output_cost, u.tool_cost) == (0.003, 0.0035, 0.015) and u.cache_cost == pytest.approx(0.0013)
    assert u.raw == usage


@respx.mock
def test_cost_falls_back_to_pricing(provider):
    respx.post(URL).respond(200, json={"output": [{"type": "message", "content": [{"type": "output_text", "text": TEXT}]}],
                                       "usage": {"input_tokens": 1000, "output_tokens": 1000}})
    out = call(provider)
    assert out.cost == pytest.approx(0.001 + 0.005) and out.usage.source == "estimate"
    assert (out.usage.input_cost, out.usage.output_cost) == pytest.approx((0.001, 0.005))


@respx.mock
def test_429_is_retryable_with_retry_after(provider):
    respx.post(URL).respond(429, headers={"Retry-After": "7"})
    with pytest.raises(RetryableProviderError) as e:
        call(provider)
    assert e.value.retry_after == 7.0


@respx.mock
@pytest.mark.parametrize("status", [500, 502, 503])
def test_5xx_is_retryable(provider, status):
    respx.post(URL).respond(status)
    with pytest.raises(RetryableProviderError):
        call(provider)


@respx.mock
def test_timeout_is_retryable(provider):
    respx.post(URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(RetryableProviderError):
        call(provider)


@respx.mock
@pytest.mark.parametrize("status", [400, 401, 403])
def test_4xx_is_permanent(provider, status):
    respx.post(URL).respond(status, text="nope")
    with pytest.raises(ProviderError) as e:
        call(provider)
    assert not isinstance(e.value, RetryableProviderError)


@respx.mock
def test_request_uses_given_key_and_model(provider):
    route = respx.post(URL).respond(200, json={"output_text": TEXT})
    call(provider)
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Bearer pplx-test-key-123456"
    assert b'"model":"anthropic/claude-sonnet-5"' in req.content.replace(b" ", b"")


def test_missing_key_or_model_is_permanent():
    with pytest.raises(ProviderError):
        PerplexityProvider("", "anthropic/claude-sonnet-5")
    with pytest.raises(ProviderError):
        PerplexityProvider("pplx-test-key-123456", "")


@respx.mock
def test_fetch_models_groups_by_owner_and_classifies_auth():
    respx.get("https://api.perplexity.ai/v1/models").respond(200, json={"object": "list", "data": [
        {"id": "openai/gpt-5.5", "object": "model", "created": 0, "owned_by": "openai"},
        {"id": "perplexity/kimi-k3", "object": "model", "created": 0, "owned_by": "moonshotai"},
        {"id": "anthropic/claude-sonnet-5", "object": "model", "created": 0, "owned_by": "anthropic"},
    ]})
    models = providers.fetch_models("pplx-test-key-123456")
    assert [m["id"] for m in models] == ["anthropic/claude-sonnet-5", "perplexity/kimi-k3", "openai/gpt-5.5"]
    assert models[1] == {"id": "perplexity/kimi-k3", "provider": "moonshotai", "name": "kimi-k3"}

    respx.get("https://api.perplexity.ai/v1/models").respond(401, json={"error": {"message": "invalid key"}})
    with pytest.raises(providers.AuthError):
        providers.fetch_models("pplx-bad-key-123456")


def test_not_found_text_is_no_signal():
    t = "X LTD\nCategory: None\nKey signals: Details not found\nOpportunity type: Details not found"
    assert parse_research(t).status == "no_signal"
