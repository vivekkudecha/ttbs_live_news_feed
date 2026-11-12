"""Cluster-wide rate limit for AI provider calls: one token bucket per provider, shared through Redis
by every worker thread and process, so adding workers never exceeds the provider's limit.

The rate is the provider's own limit, not a guess:
- Perplexity reports it on every successful response (`x-ratelimit-limit`, requests per rolling second
  for your usage tier; docs.perplexity.ai/guides/usage-tiers). `observe` stores it, and the bucket
  paces at LLM_RATE_HEADROOM of it. Until a provider has told us, LLM_RATE_PER_SECOND applies (default 1,
  Perplexity's Tier 0, so a new key never starts above its limit).
- `x-ratelimit-remaining: 0` or a 429 pauses the whole bucket until the provider says to resume
  (`x-ratelimit-reset` / `Retry-After`). A 429 on the token budget (TPM/TPH) also halves the rate for
  LLM_TOKEN_SLOWDOWN_S, since token limits are not reported in headers.

The bucket is a "theoretical arrival time" (GCRA): each call reserves the next free slot. `acquire`
waits for a near slot; when the next slot is further than `max_wait_s` it raises `Throttled` without
reserving, and the caller re-queues the work for later instead of blocking a worker. If Redis is
unreachable a per-process bucket is used rather than failing research.
"""

import logging
import random
import threading
import time
from typing import Any

import redis

from app.core.cache import get_redis
from app.core.config import get_settings
from app.core.errors import RetryableProviderError

log = logging.getLogger(__name__)


class Throttled(RetryableProviderError):
    """No call slot soon enough (or the provider said 429): try again in `retry_after` seconds.
    Not a failure: callers re-queue without spending a retry attempt."""

    def __init__(self, message: str, retry_after: float, kind: str = "bucket"):
        super().__init__(message, retry_after=retry_after)
        self.kind = kind  # bucket | request | token


def _key(name: str, part: str) -> str:
    return f"{get_settings().cache_prefix}rl:{name}:{part}"


def _float(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


# --- What rate to pace at -------------------------------------------------------------------------


def limit(name: str) -> tuple[float, str]:
    """(requests per second, "provider" | "settings"): the provider's reported limit when known."""
    s = get_settings()
    try:
        learned = _float(get_redis().get(_key(name, "limit")))
    except redis.RedisError:
        learned = None
    return (learned, "provider") if learned and learned > 0 else (float(s.llm_rate_per_second), "settings")


def _rate(name: str) -> float:
    s = get_settings()
    per_s, _ = limit(name)
    try:
        slow = _float(get_redis().get(_key(name, "slow"))) or 1.0
    except redis.RedisError:
        slow = 1.0
    return max(per_s * s.llm_rate_headroom * slow, 0.01)


def status(name: str) -> dict[str, Any]:
    """For the UI: the limit in force and how fast calls are paced."""
    per_s, source = limit(name)
    paused = 0.0
    try:
        paused = max((_float(get_redis().get(_key(name, "tat"))) or 0) - time.time(), 0.0)
    except redis.RedisError:
        pass
    return {"limitPerSecond": per_s, "source": source, "pacedPerSecond": round(_rate(name), 3), "nextSlotInS": round(paused, 1)}


# --- The bucket --------------------------------------------------------------------------------------


class _LocalBucket:
    """Per-process fallback while Redis is down (same reservation rules, one process only)."""

    def __init__(self) -> None:
        self.tat: dict[str, float] = {}
        self.lock = threading.Lock()

    def reserve(self, name: str, interval: float, max_wait: float) -> float:
        with self.lock:
            now = time.time()
            start = max(self.tat.get(name, 0.0), now)
            if start - now > max_wait:
                return -(start - now)
            self.tat[name] = start + interval
            return start - now

    def push(self, name: str, until: float) -> None:
        with self.lock:
            self.tat[name] = max(self.tat.get(name, 0.0), until)


_local = _LocalBucket()


def _reserve(name: str, interval: float, max_wait: float) -> float:
    """Seconds until this call's slot (reserved), or minus the wait when it is beyond max_wait (not reserved)."""
    r, key = get_redis(), _key(name, "tat")
    with r.pipeline() as p:
        while True:
            try:
                p.watch(key)
                now = time.time()
                start = max(_float(p.get(key)) or 0.0, now)
                if start - now > max_wait:
                    p.unwatch()
                    return -(start - now)
                p.multi()
                p.set(key, repr(start + interval), px=int((start + interval - now) * 1000) + 60_000)
                p.execute()
                return start - now
            except redis.WatchError:
                continue  # another worker took a slot meanwhile: read again


def acquire(name: str = "llm", max_wait_s: float | None = None) -> None:
    """Wait for this call's slot in the provider's bucket. Raises Throttled when it is further away
    than `max_wait_s` (default LLM_MAX_INLINE_WAIT_S)."""
    s = get_settings()
    max_wait = s.llm_max_inline_wait_s if max_wait_s is None else max_wait_s
    interval = 1.0 / _rate(name)
    try:
        wait = _reserve(name, interval, max_wait)
    except redis.RedisError as e:
        log.warning("rate limiter: redis unavailable, using a per-process bucket", extra={"err": str(e)})
        wait = _local.reserve(name, interval, max_wait)
    if wait < 0:
        raise Throttled(f"{name}: waiting for the rate limit", retry_after=-wait + random.uniform(0, 1))
    if wait > 0:
        time.sleep(wait)


def pause(name: str, seconds: float) -> None:
    """Hold every caller of this bucket for `seconds` (provider said: no more calls until then)."""
    until = time.time() + max(seconds, 0.0)
    key = _key(name, "tat")
    try:
        r = get_redis()
        with r.pipeline() as p:
            while True:
                try:
                    p.watch(key)
                    if (_float(p.get(key)) or 0.0) >= until:
                        p.unwatch()
                        return
                    p.multi()
                    p.set(key, repr(until), px=int(seconds * 1000) + 60_000)
                    p.execute()
                    return
                except redis.WatchError:
                    continue
    except redis.RedisError:
        _local.push(name, until)


def observe(name: str, headers: Any) -> None:
    """Learn the provider's limit from a successful response; pause until reset when none remain."""
    lim, remaining, reset = (_float(headers.get(h)) for h in ("x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"))
    try:
        if lim and lim > 0:
            get_redis().set(_key(name, "limit"), repr(lim), ex=get_settings().llm_rate_limit_ttl_s)
    except redis.RedisError:
        pass
    if remaining is not None and remaining <= 0 and reset:
        # reset is a Unix time; tolerate providers that send seconds-from-now instead.
        pause(name, reset - time.time() if reset > 1e9 else reset)


def rejected(name: str, retry_after: float | None, kind: str) -> float:
    """A 429 from the provider: pause the whole bucket (and slow it down on token limits).
    Returns the delay to re-queue the rejected call with."""
    s = get_settings()
    delay = max(retry_after or 1.0, 1.0)
    if kind == "token":
        try:
            r, k = get_redis(), _key(name, "slow")
            r.set(k, repr(max((_float(r.get(k)) or 1.0) / 2, 0.05)), ex=s.llm_token_slowdown_s)
        except redis.RedisError:
            pass
    pause(name, delay)
    return delay + random.uniform(0, 1)
