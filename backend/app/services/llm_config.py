"""Research AI configuration (provider + API key + model), managed from the UI.

Rules:
- Several providers can be saved (Perplexity, Gemini), but exactly ONE is active at a time; every
  research run uses the active one. Saving or activating a provider switches the others off in
  the same transaction (and a partial unique index makes a second active row impossible).
- The API key is encrypted at rest and never leaves the server (responses carry only a hint).
- Saving/activating proves the key and model work (model listed for that key + one tiny real
  call) before anything changes, so research never starts on a bad key.
- Network calls happen outside database transactions; only the final write takes a lock.
- Every change is audited without the key itself.
"""

import hashlib
import logging
from dataclasses import dataclass

from sqlalchemy import select, update

from app.core import cache, secrets
from app.core.config import get_settings
from app.core.errors import AppError, NotFound, ProviderError, RetryableProviderError, ServiceUnavailable, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import LlmProviderConfig
from app.db.session import UnitOfWork, unit_of_work
from app.research import providers
from app.services import audit

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ActiveConfig:
    provider: str
    api_key: str
    model: str
    model_provider: str


def spec(provider: str) -> providers.ProviderSpec:
    specs = providers.registry()
    if provider not in specs:
        raise ValidationFailed(f"Unknown AI provider '{provider}'", details={"supported": list(specs)}, code="unknown_provider")
    return specs[provider]


def _ctx(provider: str) -> str:
    return f"llm:{provider}:api_key"  # AEAD associated data: a ciphertext is bound to its provider


# --- Reads ----------------------------------------------------------------------------------------


def get_row(uow: UnitOfWork, provider: str) -> LlmProviderConfig | None:
    return uow.session.scalars(select(LlmProviderConfig).where(LlmProviderConfig.provider == provider)).one_or_none()


def get_active_row(uow: UnitOfWork) -> LlmProviderConfig | None:
    return uow.session.scalars(select(LlmProviderConfig).where(LlmProviderConfig.active.is_(True))).one_or_none()


def list_rows(uow: UnitOfWork) -> dict[str, LlmProviderConfig]:
    return {r.provider: r for r in uow.session.scalars(select(LlmProviderConfig))}


def _decrypt(row: LlmProviderConfig) -> str:
    try:
        return secrets.decrypt(row.api_key_enc, context=_ctx(row.provider))
    except secrets.SecretUnreadable as e:
        raise providers.NotConfigured(f"Saved {spec(row.provider).label} key cannot be read ({e}); enter it again under Providers & channels") from e


def load_active(uow: UnitOfWork | None = None) -> ActiveConfig | None:
    """Decrypted config of the active AI for execution, or None when none is active."""
    if uow is None:
        with unit_of_work() as own:
            return load_active(own)
    row = get_active_row(uow)
    if row is None:
        return None
    return ActiveConfig(provider=row.provider, api_key=_decrypt(row), model=row.model, model_provider=row.model_provider)


def _saved_key(provider: str) -> str | None:
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        return _decrypt(row) if row else None


# --- Helpers --------------------------------------------------------------------------------------


def _clean_key(api_key: str | None, label: str) -> str | None:
    if api_key is None or not api_key.strip():
        return None
    key = api_key.strip()
    if len(key) < 10 or len(key) > 400 or any(ch.isspace() for ch in key):
        raise ValidationFailed(f"That does not look like a {label} API key", details={"field": "apiKey"}, code="invalid_api_key")
    return key


def _resolve_key(provider: str, api_key: str | None) -> tuple[str, bool]:
    """(key to use, whether it is a newly entered key)."""
    label = spec(provider).label
    key = _clean_key(api_key, label)
    if key:
        return key, True
    saved = _saved_key(provider)
    if saved is None:
        raise ValidationFailed(f"Enter a {label} API key", details={"field": "apiKey"}, code="api_key_required")
    return saved, False


def _map_provider_error(provider: str, e: ProviderError) -> AppError:
    label = spec(provider).label
    if isinstance(e, providers.AuthError):
        return ValidationFailed(f"{label} rejected this API key", details={"field": "apiKey"}, code="invalid_api_key")
    if isinstance(e, RetryableProviderError):
        return ServiceUnavailable(f"{label} is not reachable right now: {e}", code="provider_unavailable")
    return ValidationFailed(f"{label} refused the request: {e}", code="provider_error")


def _ping(provider: str, key: str, model: str) -> int:
    try:
        return spec(provider).ping(key, model)
    except ProviderError as e:
        raise _map_provider_error(provider, e) from e


def _make_active(uow: UnitOfWork, row: LlmProviderConfig) -> list[str]:
    """Switch every other provider off, then this one on. Returns the providers switched off."""
    others = [r.provider for r in uow.session.scalars(
        select(LlmProviderConfig).where(LlmProviderConfig.active.is_(True), LlmProviderConfig.provider != row.provider))]
    if others:
        uow.session.execute(update(LlmProviderConfig).where(LlmProviderConfig.provider != row.provider).values(active=False))
        uow.session.flush()
    row.active = True
    return others


# --- Commands -------------------------------------------------------------------------------------


def list_models(provider: str, api_key: str | None) -> list[dict[str, str]]:
    """Models available to this key (cached per provider + key fingerprint, never per raw key)."""
    key, _ = _resolve_key(provider, api_key)
    ck = f"llm:models:{provider}:{hashlib.sha256(key.encode()).hexdigest()[:24]}"
    hit = cache.get_json(ck)
    if hit:
        return hit
    try:
        models = spec(provider).fetch_models(key)
    except ProviderError as e:
        raise _map_provider_error(provider, e) from e
    if not models:
        raise ValidationFailed(f"{spec(provider).label} returned no usable models for this key", code="no_models")
    cache.set_json(ck, models, ttl=get_settings().llm_models_cache_s)
    return models


def save(provider: str, api_key: str | None, model: str, actor: str) -> LlmProviderConfig:
    """Verify key + model, store them, and make this provider the active AI."""
    key, key_changed = _resolve_key(provider, api_key)
    model = (model or "").strip()
    match = next((m for m in list_models(provider, key) if m["id"] == model), None)
    if match is None:
        raise ValidationFailed(f"Model '{model}' is not available for this key", details={"field": "model"}, code="unknown_model")
    latency = _ping(provider, key, model)

    enc = secrets.encrypt(key, context=_ctx(provider))  # fails fast (503) if SECRETS_KEY is missing
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        before = {"model": row.model, "key_hint": row.key_hint, "active": row.active} if row else None
        if row is None:
            row = LlmProviderConfig(provider=provider, active=False)
            uow.session.add(row)
        if key_changed or not row.api_key_enc:
            row.api_key_enc, row.key_hint = enc, secrets.hint(key)
        row.model, row.model_provider = model, match["provider"]
        row.verified_at, row.last_check_ok, row.last_check_error, row.last_check_latency_ms = utcnow(), True, None, latency
        row.updated_by = actor
        uow.session.flush()
        switched_off = _make_active(uow, row)
        uow.session.flush()
        audit.record(
            uow, "llm.config.save", "llm_provider", row.id,
            {"provider": provider, "model": model, "model_provider": match["provider"], "key_changed": key_changed,
             "key_hint": row.key_hint, "latency_ms": latency, "switched_off": switched_off, "before": before},
            actor=actor,
        )
        uow.after_commit(lambda: cache.bump("llm"))
    log.info("llm config saved", extra={"provider": provider, "model": model, "key_changed": key_changed})
    return row


def activate(provider: str, actor: str) -> LlmProviderConfig:
    """Switch research to an already saved provider (re-verified first, so a dead key is refused)."""
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        if row is None:
            raise NotFound(f"{spec(provider).label} is not configured yet")
        if row.active:
            return row
        key, model = _decrypt(row), row.model
    latency = _ping(provider, key, model)
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        if row is None:
            raise NotFound(f"{spec(provider).label} is not configured yet")
        switched_off = _make_active(uow, row)
        row.verified_at, row.last_check_ok, row.last_check_error, row.last_check_latency_ms = utcnow(), True, None, latency
        row.updated_by = actor
        uow.session.flush()
        audit.record(uow, "llm.provider.activate", "llm_provider", row.id,
                     {"provider": provider, "model": row.model, "switched_off": switched_off, "latency_ms": latency}, actor=actor)
        uow.after_commit(lambda: cache.bump("llm"))
    return row


def test(provider: str, actor: str) -> tuple[LlmProviderConfig, str | None]:
    """Re-verify a saved key + model with a tiny real call. Records the outcome; never raises for a
    provider failure (the result is shown in the UI)."""
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        if row is None:
            raise ValidationFailed(f"{spec(provider).label} is not configured yet", code="provider_not_configured")
        key, model = _decrypt(row), row.model
    error: str | None = None
    latency: int | None = None
    try:
        latency = spec(provider).ping(key, model)
    except ProviderError as e:
        error = _map_provider_error(provider, e).message
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        if row is None:  # removed meanwhile
            raise ValidationFailed(f"{spec(provider).label} is not configured yet", code="provider_not_configured")
        row.last_check_ok, row.last_check_error, row.last_check_latency_ms = error is None, error, latency
        if error is None:
            row.verified_at = utcnow()
        audit.record(uow, "llm.config.test", "llm_provider", row.id,
                     {"provider": provider, "model": row.model, "ok": error is None, "error": error, "latency_ms": latency}, actor=actor)
        uow.after_commit(lambda: cache.bump("llm"))
    return row, error


def remove(provider: str, actor: str) -> None:
    with unit_of_work() as uow:
        row = get_row(uow, provider)
        if row is None:
            return
        audit.record(uow, "llm.config.remove", "llm_provider", row.id,
                     {"provider": provider, "model": row.model, "key_hint": row.key_hint, "was_active": row.active}, actor=actor)
        uow.session.delete(row)
        uow.after_commit(lambda: cache.bump("llm"))
