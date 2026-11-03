"""Redis cache. Fail-open: if Redis is unavailable every call degrades to "miss" and the caller
computes the value, so a cache outage slows the app down but never breaks it.

Invalidation uses namespace versions: keys embed `v{n}` of their namespace, and `bump(ns)`
increments n, orphaning every old key at once (they expire by TTL). No SCAN/DEL over a Redis
that is shared with other apps.
"""

import json
import logging
from collections.abc import Callable
from functools import lru_cache
from typing import Any, TypeVar

import redis

from app.core.config import get_settings

log = logging.getLogger(__name__)
T = TypeVar("T")


@lru_cache
def get_redis() -> redis.Redis:
    s = get_settings()
    return redis.Redis.from_url(
        s.redis_cache_url, decode_responses=True, socket_connect_timeout=1, socket_timeout=1, health_check_interval=30
    )


def _k(key: str) -> str:
    return f"{get_settings().cache_prefix}{key}"


def get_json(key: str) -> Any | None:
    try:
        raw = get_redis().get(_k(key))
    except redis.RedisError as e:
        log.warning("cache get failed", extra={"key": key, "err": str(e)})
        return None
    return json.loads(raw) if raw is not None else None


def set_json(key: str, value: Any, ttl: int) -> None:
    try:
        get_redis().set(_k(key), json.dumps(value, default=str), ex=max(1, int(ttl)))
    except redis.RedisError as e:
        log.warning("cache set failed", extra={"key": key, "err": str(e)})


def version(ns: str) -> int:
    try:
        return int(get_redis().get(_k(f"v:{ns}")) or 0)
    except redis.RedisError:
        return -1  # unique "no cache" version; get/set below are skipped for it


def bump(*namespaces: str) -> None:
    for ns in namespaces:
        try:
            get_redis().incr(_k(f"v:{ns}"))
        except redis.RedisError as e:
            log.warning("cache bump failed", extra={"ns": ns, "err": str(e)})


def cached(ns: str, key: str, ttl: int | Callable[[Any], int], fn: Callable[[], T]) -> T:
    """Read-through cache. `ttl` may depend on the value (e.g. short while a run is active)."""
    v = version(ns)
    if v < 0:
        return fn()
    full = f"{ns}:v{v}:{key}"
    hit = get_json(full)
    if hit is not None:
        return hit
    value = fn()
    set_json(full, value, ttl(value) if callable(ttl) else ttl)
    return value
