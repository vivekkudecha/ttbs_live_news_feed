"""LLM research providers. Each returns the raw answer text plus usage; classification of
failures into retryable vs permanent happens here so the task layer stays provider-agnostic."""

import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Protocol

import httpx

from app.core.config import get_settings
from app.core.errors import ProviderError, RetryableProviderError
from app.research.prompts import PromptSpec, default_spec

if TYPE_CHECKING:
    from app.db.session import UnitOfWork

log = logging.getLogger(__name__)


@dataclass
class ResearchOutput:
    text: str
    tokens_in: int = 0
    tokens_out: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    # Sources the provider grounded its answer on (e.g. Gemini groundingMetadata), beyond URLs in text.
    sources: list[dict[str, str]] = field(default_factory=list)


class ResearchProvider(Protocol):
    key: str
    model: str

    # `prompt` is the run's pinned research prompt version; None = the built-in default.
    def research(self, company: str, window_start: date, window_end: date, prompt: PromptSpec | None = None) -> ResearchOutput: ...

    # Plain text generation without web search (e.g. the AI summary in email digests).
    def generate(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> ResearchOutput: ...


class FakeProvider:
    """Deterministic-ish offline provider for development and tests."""

    key = "fake"

    def __init__(self) -> None:
        self.model = "fake-model"

    def research(self, company: str, window_start: date, window_end: date, prompt: PromptSpec | None = None) -> ResearchOutput:
        s = get_settings()
        categories = (prompt or default_spec()).categories
        if s.fake_latency_ms:
            time.sleep(s.fake_latency_ms / 1000)
        if random.random() < s.fake_failure_rate:
            raise RetryableProviderError("fake transient failure", retry_after=0.1)
        if random.random() < s.fake_signal_rate:
            cat = random.choice(categories)
            text = (
                f"{company.upper()}\nCategory: {cat}\n"
                f"Key signals: **{cat}** activity announced in {window_end:%b %Y} (https://example.com/news/{abs(hash(company)) % 9999})\n"
                "Opportunity type: **SD-WAN** and **Managed SOC** for new sites\n"
                "Recommended outreach approach: Reach the **CIO** with a connectivity + security bundle"
            )
        else:
            text = (
                f"{company.upper()}\nCategory: None\nKey signals: Details not found\n"
                "Opportunity type: Details not found\nRecommended outreach approach: Details not found"
            )
        return ResearchOutput(text=text, tokens_in=1200, tokens_out=180, cost=0.0, latency_ms=s.fake_latency_ms)

    def generate(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> ResearchOutput:
        if random.random() < get_settings().fake_failure_rate:
            raise RetryableProviderError("fake transient failure", retry_after=0.1)
        text = "Focus first on the accounts with fresh expansion news; each has a clear TTBS angle and a named next step below."
        return ResearchOutput(text=text, tokens_in=max(1, len(prompt) // 4), tokens_out=24, cost=0.0)


class AuthError(ProviderError):
    """The provider rejected the API key (401/403)."""


def _client(api_key: str, timeout: float) -> httpx.Client:
    return httpx.Client(
        base_url=get_settings().perplexity_base_url,
        timeout=httpx.Timeout(timeout, connect=10.0),
        headers={"Authorization": f"Bearer {api_key}"},
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=50),
    )


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code in (401, 403):
        raise AuthError(f"Perplexity rejected the API key (HTTP {resp.status_code})")
    if resp.status_code == 429 or resp.status_code >= 500:
        raise RetryableProviderError(f"perplexity HTTP {resp.status_code}", retry_after=_retry_after(resp.headers.get("Retry-After")))
    if resp.status_code != 200:
        # Other 4xx: bad request / unknown model / quota. Retrying the same payload will not help.
        raise ProviderError(f"perplexity HTTP {resp.status_code}: {_error_text(resp)}")


def _error_text(resp: httpx.Response) -> str:
    try:
        err = resp.json().get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err)[:500]
        if err:
            return str(err)[:500]
    except ValueError:
        pass
    return resp.text[:500]


class PerplexityProvider:
    key = "perplexity"

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise ProviderError("Perplexity API key is empty")
        if not model:
            raise ProviderError("Perplexity model is not selected")
        self.model = model
        self._client = _client(api_key, get_settings().perplexity_timeout_s)

    def research(self, company: str, window_start: date, window_end: date, prompt: PromptSpec | None = None) -> ResearchOutput:
        s = get_settings()
        spec = prompt or default_spec()
        payload = {
            "model": self.model,
            "input": spec.render(company, window_start.isoformat(), window_end.isoformat()),
            "instructions": spec.system,
            "tools": [{"type": "web_search"}],
            "max_output_tokens": s.perplexity_max_output_tokens,
        }
        t0 = time.perf_counter()
        try:
            resp = self._client.post("/v1/agent", json=payload)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise RetryableProviderError(f"perplexity network error: {type(e).__name__}") from e
        latency = int((time.perf_counter() - t0) * 1000)
        _raise_for(resp)
        try:
            data = resp.json()
        except ValueError as e:
            raise RetryableProviderError("perplexity returned non-JSON body") from e

        status = data.get("status")
        if status not in (None, "completed", "in_progress"):
            raise ProviderError(f"perplexity response status={status}: {str(data.get('error'))[:300]}")

        text = _output_text(data)
        tin, tout, cost = _usage(data)
        if cost is None:
            cost = tin / 1000 * s.perplexity_price_in_per_1k + tout / 1000 * s.perplexity_price_out_per_1k
        return ResearchOutput(text=text, tokens_in=tin, tokens_out=tout, cost=round(cost, 6), latency_ms=latency)

    def generate(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> ResearchOutput:
        """Plain completion with the configured model, no web search tool."""
        s = get_settings()
        payload: dict[str, Any] = {"model": self.model, "input": prompt, "max_output_tokens": max_tokens}
        if system:
            payload["instructions"] = system
        t0 = time.perf_counter()
        try:
            resp = self._client.post("/v1/agent", json=payload)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise RetryableProviderError(f"perplexity network error: {type(e).__name__}") from e
        latency = int((time.perf_counter() - t0) * 1000)
        _raise_for(resp)
        try:
            data = resp.json()
        except ValueError as e:
            raise RetryableProviderError("perplexity returned non-JSON body") from e
        text = _output_text(data)
        tin, tout, cost = _usage(data)
        if cost is None:
            cost = tin / 1000 * s.perplexity_price_in_per_1k + tout / 1000 * s.perplexity_price_out_per_1k
        return ResearchOutput(text=text, tokens_in=tin, tokens_out=tout, cost=round(cost, 6), latency_ms=latency)


def fetch_models(api_key: str) -> list[dict[str, str]]:
    """GET /v1/models → [{"id": "anthropic/claude-sonnet-5", "provider": "anthropic", "name": "claude-sonnet-5"}]."""
    try:
        with _client(api_key, 20.0) as c:
            resp = c.get("/v1/models")
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise RetryableProviderError(f"Cannot reach Perplexity ({type(e).__name__})") from e
    _raise_for(resp)
    try:
        items = resp.json().get("data") or []
    except (ValueError, AttributeError) as e:
        raise ProviderError("Perplexity returned an unexpected model list") from e
    out: dict[str, dict[str, str]] = {}
    for m in items:
        mid = str(m.get("id") or "").strip()
        if not mid:
            continue
        family, _, name = mid.partition("/")
        out[mid] = {"id": mid, "provider": str(m.get("owned_by") or family or "other"), "name": name or mid}
    return sorted(out.values(), key=lambda m: (m["provider"], m["name"]))


def ping(api_key: str, model: str) -> int:
    """Smallest real Agent API call with this key + model (proves both work). Returns latency ms."""
    t0 = time.perf_counter()
    try:
        with _client(api_key, 60.0) as c:
            resp = c.post("/v1/agent", json={"model": model, "input": "Reply with the single word OK.", "max_output_tokens": 32})
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise RetryableProviderError(f"Cannot reach Perplexity ({type(e).__name__})") from e
    _raise_for(resp)
    return int((time.perf_counter() - t0) * 1000)


def _retry_after(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None


def _output_text(data: dict[str, Any]) -> str:
    for item in data.get("output") or []:
        if item.get("type") == "message":
            for c in item.get("content") or []:
                if c.get("type") == "output_text" and c.get("text"):
                    return c["text"].strip()
    if isinstance(data.get("output_text"), str):
        return data["output_text"].strip()
    raise RetryableProviderError("perplexity response had no output text")


def _usage(data: dict[str, Any]) -> tuple[int, int, float | None]:
    u = data.get("usage") or {}
    tin = int(u.get("input_tokens") or u.get("prompt_tokens") or 0)
    tout = int(u.get("output_tokens") or u.get("completion_tokens") or 0)
    raw = u.get("cost")
    if isinstance(raw, dict):
        raw = raw.get("total_cost", raw.get("total"))
    try:
        cost = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        cost = None
    return tin, tout, cost


class NotConfigured(ProviderError):
    """No API key / model saved for the active provider."""


@lru_cache
def _fake() -> FakeProvider:
    return FakeProvider()


@dataclass(frozen=True)
class ProviderSpec:
    """Everything the config service needs to manage one AI provider."""

    key: str
    label: str
    fetch_models: Callable[[str], list[dict[str, str]]]  # api_key -> [{id, provider, name}]
    ping: Callable[[str, str], int]  # (api_key, model) -> latency ms
    build: Callable[[str, str], ResearchProvider]  # (api_key, model) -> provider


def registry() -> dict[str, ProviderSpec]:
    from app.research import gemini  # gemini imports this module's helpers

    return {
        "perplexity": ProviderSpec("perplexity", "Perplexity", fetch_models, ping, PerplexityProvider),
        "gemini": ProviderSpec("gemini", "Google Gemini", gemini.fetch_models, gemini.ping, gemini.GeminiProvider),
    }


PROVIDER_KEYS = ("perplexity", "gemini")


@lru_cache(maxsize=4)
def _build(provider: str, api_key: str, model: str) -> ResearchProvider:
    # Keyed on (provider, key, model): switching AI, rotating a key or changing model in the UI
    # gets a fresh client on the next task, in every worker, without restarts.
    return registry()[provider].build(api_key, model)


def get_provider(uow: "UnitOfWork | None" = None) -> ResearchProvider:
    """Provider for new research calls: the ONE active AI saved in the database (key + model).
    Nothing comes from the environment except LLM_PROVIDER=fake for offline dev/tests."""
    if get_settings().llm_provider == "fake":
        return _fake()
    from app.services import llm_config  # avoid import cycle

    cfg = llm_config.load_active(uow)
    if cfg is None:
        raise NotConfigured("No research AI is active: add an API key and choose a model under Providers & channels")
    return _build(cfg.provider, cfg.api_key, cfg.model)


def clear_cache() -> None:
    _fake.cache_clear()
    _build.cache_clear()
