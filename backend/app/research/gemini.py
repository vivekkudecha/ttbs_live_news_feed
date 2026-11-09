"""Google Gemini research provider (Gemini API, generateContent + Google Search grounding).

- Auth: `x-goog-api-key` header (never in the URL, so it cannot leak into access logs).
- Models: GET /v1beta/models (paged), keeping Gemini text models that support generateContent.
- Research: POST /v1beta/models/{model}:generateContent with tools=[{"google_search": {}}];
  grounded sources come back in candidates[0].groundingMetadata.groundingChunks[].web.
- Errors: 429 / 5xx / timeouts are retryable; an invalid key (400 API_KEY_INVALID, 401, 403) is
  an AuthError; other 4xx and safety blocks are permanent.
"""

import re
import time
from datetime import date
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import get_settings
from app.core.errors import ProviderError, RetryableProviderError
from app.research.prompts import PromptSpec, default_spec
from app.research.providers import AuthError, ResearchOutput, _retry_after

_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$")
# Gemini-family models that are not general text generators (no point offering them for research).
_NOT_TEXT = re.compile(r"embedding|image|imagen|tts|audio|live|veo|robotics|computer-use|aqa", re.I)


def _client(api_key: str, timeout: float) -> httpx.Client:
    return httpx.Client(
        base_url=get_settings().gemini_base_url,
        timeout=httpx.Timeout(timeout, connect=10.0),
        headers={"x-goog-api-key": api_key},
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=50),
    )


def _error(resp: httpx.Response) -> tuple[str, str]:
    """(google status, message) from {"error": {"code", "message", "status", "details"}}."""
    try:
        err = resp.json().get("error") or {}
        detail_reasons = " ".join(str(d.get("reason", "")) for d in err.get("details") or [] if isinstance(d, dict))
        return f"{err.get('status', '')} {detail_reasons}".strip(), str(err.get("message") or "")[:500]
    except (ValueError, AttributeError):
        return "", resp.text[:500]


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code == 200:
        return
    status, message = _error(resp)
    if resp.status_code in (401, 403) or "API_KEY_INVALID" in status or "API key not valid" in message:
        raise AuthError(f"Gemini rejected the API key (HTTP {resp.status_code})")
    if resp.status_code == 429 or resp.status_code >= 500:
        raise RetryableProviderError(f"gemini HTTP {resp.status_code} {status}".strip(), retry_after=_retry_after(resp.headers.get("Retry-After")))
    raise ProviderError(f"gemini HTTP {resp.status_code}: {message or status}")


def _check_model(model: str) -> str:
    model = model.removeprefix("models/")
    if not _MODEL_ID.match(model):
        raise ProviderError(f"invalid Gemini model id: {model!r}")
    return model


def _body(prompt: str, max_tokens: int, *, system: str | None = None, search: bool = True) -> dict[str, Any]:
    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if search:
        body["tools"] = [{"google_search": {}}]
    return body


def _post(client: httpx.Client, model: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        resp = client.post(f"/v1beta/models/{quote(model, safe='.-_')}:generateContent", json=body)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise RetryableProviderError(f"gemini network error: {type(e).__name__}") from e
    _raise_for(resp)
    try:
        return resp.json()
    except ValueError as e:
        raise RetryableProviderError("gemini returned non-JSON body") from e


def _text_and_sources(data: dict[str, Any]) -> tuple[str, list[dict[str, str]], int]:
    block = (data.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise ProviderError(f"gemini blocked the prompt: {block}")
    cands = data.get("candidates") or []
    if not cands:
        raise RetryableProviderError("gemini response had no candidates")
    cand = cands[0]
    finish = cand.get("finishReason")
    if finish in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"):
        raise ProviderError(f"gemini stopped: {finish}")
    # Skip thought-summary parts; keep the answer text.
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts") or [] if not p.get("thought")).strip()
    if not text:
        raise RetryableProviderError(f"gemini response had no text (finishReason={finish})")

    gm = cand.get("groundingMetadata") or {}
    sources, seen = [], set()
    for ch in gm.get("groundingChunks") or []:
        web = ch.get("web") or {}
        uri = web.get("uri")
        if uri and uri not in seen:
            seen.add(uri)
            sources.append({"title": str(web.get("title") or web.get("domain") or "source"), "url": uri})
    searches = len(gm.get("webSearchQueries") or [])
    return text, sources[:10], searches


class GeminiProvider:
    key = "gemini"

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise ProviderError("Gemini API key is empty")
        if not model:
            raise ProviderError("Gemini model is not selected")
        self.model = _check_model(model)
        self._client = _client(api_key, get_settings().gemini_timeout_s)

    def research(self, company: str, window_start: date, window_end: date, prompt: PromptSpec | None = None) -> ResearchOutput:
        s = get_settings()
        spec = prompt or default_spec()
        body = _body(spec.render(company, window_start.isoformat(), window_end.isoformat()), s.gemini_max_output_tokens, system=spec.system)
        t0 = time.perf_counter()
        data = _post(self._client, self.model, body)
        latency = int((time.perf_counter() - t0) * 1000)
        text, sources, searches = _text_and_sources(data)
        u = data.get("usageMetadata") or {}
        tin = int(u.get("promptTokenCount") or 0)
        tout = int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0)
        cost = tin / 1000 * s.gemini_price_in_per_1k + tout / 1000 * s.gemini_price_out_per_1k + searches * s.gemini_price_per_search
        return ResearchOutput(text=text, tokens_in=tin, tokens_out=tout, cost=round(cost, 6), latency_ms=latency, sources=sources)

    def generate(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> ResearchOutput:
        """Plain completion with the configured model, no Google Search grounding (nothing to bill per query)."""
        s = get_settings()
        t0 = time.perf_counter()
        data = _post(self._client, self.model, _body(prompt, max_tokens, system=system, search=False))
        latency = int((time.perf_counter() - t0) * 1000)
        text, _, _ = _text_and_sources(data)
        u = data.get("usageMetadata") or {}
        tin = int(u.get("promptTokenCount") or 0)
        tout = int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0)
        cost = tin / 1000 * s.gemini_price_in_per_1k + tout / 1000 * s.gemini_price_out_per_1k
        return ResearchOutput(text=text, tokens_in=tin, tokens_out=tout, cost=round(cost, 6), latency_ms=latency)


def fetch_models(api_key: str) -> list[dict[str, str]]:
    """Gemini text models available to this key: [{"id": "gemini-3.6-flash", "provider": "google", "name": "Gemini 3.6 Flash"}]."""
    out: dict[str, dict[str, str]] = {}
    token: str | None = None
    try:
        with _client(api_key, 20.0) as c:
            for _ in range(20):  # page guard
                params = {"pageSize": 1000} | ({"pageToken": token} if token else {})
                resp = c.get("/v1beta/models", params=params)
                _raise_for(resp)
                data = resp.json()
                for m in data.get("models") or []:
                    mid = str(m.get("name") or "").removeprefix("models/")
                    methods = m.get("supportedGenerationMethods") or []
                    if not mid.startswith("gemini") or "generateContent" not in methods or _NOT_TEXT.search(mid):
                        continue
                    out[mid] = {"id": mid, "provider": "google", "name": str(m.get("displayName") or mid)}
                token = data.get("nextPageToken")
                if not token:
                    break
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise RetryableProviderError(f"Cannot reach Gemini ({type(e).__name__})") from e
    except (ValueError, AttributeError) as e:
        raise ProviderError("Gemini returned an unexpected model list") from e
    return sorted(out.values(), key=lambda m: m["id"], reverse=True)  # newest versions first


def ping(api_key: str, model: str) -> int:
    """Smallest real call with this key + model, with Google Search enabled so a model that cannot
    ground answers is rejected at save time, not mid-run. Returns latency ms."""
    model = _check_model(model)
    t0 = time.perf_counter()
    with _client(api_key, 60.0) as c:
        # The model decides whether to search; a trivial prompt normally runs no (billable) search.
        data = _post(c, model, _body("Reply with the single word OK.", 256, search=True))
    if not data.get("candidates"):
        raise ProviderError("Gemini returned no answer to the test prompt")
    return int((time.perf_counter() - t0) * 1000)
