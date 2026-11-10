"""Centralized cache, shared by every user. Fail-open: if Redis is unavailable every call degrades
to "miss" and the caller computes the value, so a cache outage slows the app down but never breaks it.

Invalidation uses namespace versions: keys embed `v{n}` of their namespace, and `bump(ns)`
increments n, orphaning every old key at once (they expire by TTL). No SCAN/DEL over a Redis
that is shared with other apps.

Centralized, not per user: a key never contains a user id, role or permission. Routes cache a
*base dataset* (a run's PAM jobs, the company table, the dashboard of the latest run) once for
everybody and apply the request's filters, sort, paging and user scope (app/api/scope.py) on that
shared copy at request time. One computation serves every user.

Two tiers, one truth:
- L1: decoded values in this process (bounded LRU, a few seconds at most), so a busy endpoint
  does not re-download and re-parse a multi-MB dataset from Redis on every request;
- L2: Redis (zlib-compressed above CACHE_COMPRESS_OVER_BYTES), shared by every API process.
Both are keyed by the namespace version, which is read from Redis on every call, so a `bump()` in
any process invalidates L1 everywhere on the next read.
Single-flight: on a miss one caller computes (Redis SET NX lock) while the others wait briefly for
its result, so 50 users opening a cold page cost one query, not 50.
"""

import json
import logging
import threading
import time
import zlib
from collections import OrderedDict
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


_Z = "z:"  # prefix of compressed payloads (zlib + latin-1, so the client can stay decode_responses=True)


def _encode(value: Any) -> str:
    raw = json.dumps(value, default=str, separators=(",", ":"))
    if len(raw) >= get_settings().cache_compress_over_bytes:
        return _Z + zlib.compress(raw.encode(), 3).decode("latin-1")
    return raw


def _decode(raw: str) -> Any:
    if raw.startswith(_Z):
        return json.loads(zlib.decompress(raw[len(_Z):].encode("latin-1")))
    return json.loads(raw)


def get_json(key: str) -> Any | None:
    try:
        raw = get_redis().get(_k(key))
    except redis.RedisError as e:
        log.warning("cache get failed", extra={"key": key, "err": str(e)})
        return None
    return _decode(raw) if raw is not None else None


def set_json(key: str, value: Any, ttl: int) -> None:
    try:
        get_redis().set(_k(key), _encode(value), ex=max(1, int(ttl)))
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


class _Local:
    """L1: per-process LRU of decoded values with their own (short) expiry."""

    def __init__(self) -> None:
        self._d: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            if hit[0] < time.monotonic():
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return hit[1]

    def put(self, key: str, value: Any, ttl: float) -> None:
        cap = get_settings().cache_local_entries
        if cap <= 0 or ttl <= 0:
            return
        with self._lock:
            self._d[key] = (time.monotonic() + ttl, value)
            self._d.move_to_end(key)
            while len(self._d) > cap:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


local = _Local()
LOCK_TTL_S, WAIT_S, POLL_S = 10, 2.0, 0.05


def cached(ns: str, key: str, ttl: int | Callable[[Any], int], fn: Callable[[], T]) -> T:
    """Read-through shared cache (L1 process + L2 Redis, single-flight on a miss). `ttl` may depend
    on the value (e.g. short while a run is active). Values must be JSON-shaped (what callers get
    back from L2 is the JSON round trip), and must never be user-specific."""
    v = version(ns)
    if v < 0:
        return fn()
    full = f"{ns}:v{v}:{key}"
    hit = local.get(full)
    if hit is not None:
        return hit
    hit = get_json(full)
    if hit is not None:
        local.put(full, hit, get_settings().cache_local_ttl_s)
        return hit
    lock = _k(f"lock:{full}")
    owner = _try_lock(lock)
    if not owner:  # someone else is computing it: wait for their result, then fall back to computing
        deadline = time.monotonic() + WAIT_S
        while time.monotonic() < deadline:
            time.sleep(POLL_S)
            hit = get_json(full)
            if hit is not None:
                local.put(full, hit, get_settings().cache_local_ttl_s)
                return hit
    try:
        value = fn()
        seconds = ttl(value) if callable(ttl) else ttl
        set_json(full, value, seconds)
        local.put(full, value, min(seconds, get_settings().cache_local_ttl_s))
        return value
    finally:
        if owner:
            _unlock(lock)


shared = cached  # the name used by routes that cache a base dataset for every user


def _try_lock(key: str) -> bool:
    try:
        return bool(get_redis().set(key, "1", nx=True, ex=LOCK_TTL_S))
    except redis.RedisError:
        return True  # no Redis: just compute


def _unlock(key: str) -> None:
    try:
        get_redis().delete(key)
    except redis.RedisError:
        pass
