"""Gemini adapter: status → retryable/permanent/auth classification, safety blocks, cost, sources."""

from datetime import date

import httpx
import pytest
import respx

from app.core.errors import ProviderError, RetryableProviderError
from app.research import gemini
from app.research.providers import AuthError

URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"
OK = {
    "candidates": [{"content": {"parts": [{"text": "X\nKey signals: Details not found"}]}, "finishReason": "STOP",
                    "groundingMetadata": {"webSearchQueries": ["a", "b"], "groundingChunks": [{"web": {"uri": "https://r/1", "title": "t.com"}}]}}],
    "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 1000, "thoughtsTokenCount": 0},
}


@pytest.fixture
def p():
    return gemini.GeminiProvider("AIzaTESTKEY-123456", "models/gemini-3.6-flash")


def call(p):
    return p.research("Pine Labs", date(2026, 10, 24), date(2026, 11, 3))


@respx.mock
def test_success_cost_includes_searches_and_sources(p):
    respx.post(URL).respond(200, json=OK)
    out = call(p)
    assert out.sources == [{"title": "t.com", "url": "https://r/1"}]
    assert out.cost == pytest.approx(0.0003 + 0.0025 + 2 * 0.014)
    # No cost in Gemini responses: the split is our estimate, and web searches are the tool calls.
    assert out.usage.source == "estimate" and out.usage.tool_calls == 2 and out.usage.tool_cost == pytest.approx(0.028)


@respx.mock
@pytest.mark.parametrize("status", [429, 500, 503])
def test_transient_is_retryable(p, status):
    respx.post(URL).respond(status, json={"error": {"status": "RESOURCE_EXHAUSTED", "message": "slow down"}})
    with pytest.raises(RetryableProviderError):
        call(p)


@respx.mock
def test_timeout_is_retryable(p):
    respx.post(URL).mock(side_effect=httpx.ConnectTimeout("x"))
    with pytest.raises(RetryableProviderError):
        call(p)


@respx.mock
def test_invalid_key_is_auth_error(p):
    respx.post(URL).respond(400, json={"error": {"status": "INVALID_ARGUMENT", "message": "API key not valid.",
                                                 "details": [{"reason": "API_KEY_INVALID"}]}})
    with pytest.raises(AuthError):
        call(p)


@respx.mock
def test_other_400_and_safety_are_permanent(p):
    respx.post(URL).respond(400, json={"error": {"status": "INVALID_ARGUMENT", "message": "bad field"}})
    with pytest.raises(ProviderError) as e:
        call(p)
    assert not isinstance(e.value, RetryableProviderError)

    respx.post(URL).respond(200, json={"candidates": [{"finishReason": "SAFETY"}]})
    with pytest.raises(ProviderError) as e:
        call(p)
    assert not isinstance(e.value, RetryableProviderError)


def test_model_id_is_validated():
    with pytest.raises(ProviderError):
        gemini.GeminiProvider("AIzaTESTKEY-123456", "../../v1/evil")
