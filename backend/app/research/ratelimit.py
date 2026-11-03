"""Cluster-wide rate limit for LLM calls (Perplexity allows 50 req/s; we use 45).

A fixed one-second window counter in Redis is shared by every worker thread and process, so
adding workers never exceeds the provider limit. If Redis is unreachable we fall back to a
per-process limiter rather than failing research.
"""

import logging
import threading
import time
from collections import deque

import redis

from app.core.cache import get_redis
from app.core.config import get_settings

log = logging.getLogger(__name__)


class _LocalLimiter:
    def __init__(self, rate: int):
        self.rate, self.calls, self.lock = rate, deque(), threading.Lock()

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] >= 1.0:
                    self.calls.popleft()
                if len(self.calls) < self.rate:
                    self.calls.append(now)
                    return
                wait = 1.0 - (now - self.calls[0])
            time.sleep(max(wait, 0.005))


_local: _LocalLimiter | None = None


def acquire(name: str = "llm", max_wait_s: float = 120.0) -> None:
    global _local
    s = get_settings()
    rate = s.llm_rate_per_second
    deadline = time.monotonic() + max_wait_s
    while True:
        now = time.time()
        window = int(now)
        key = f"{s.cache_prefix}rl:{name}:{window}"
        try:
            r = get_redis()
            pipe = r.pipeline()
            pipe.incr(key)
            pipe.expire(key, 2)
            count = pipe.execute()[0]
        except redis.RedisError as e:
            log.warning("rate limiter: redis unavailable, using local limiter", extra={"err": str(e)})
            if _local is None:
                _local = _LocalLimiter(rate)
            _local.acquire()
            return
        if count <= rate:
            return
        if time.monotonic() > deadline:
            raise TimeoutError("rate limiter wait exceeded")
        time.sleep(max(window + 1 - now, 0.005))
