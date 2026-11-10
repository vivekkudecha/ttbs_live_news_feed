"""FastAPI application.

    uvicorn app.main:app --reload --port 8010
"""

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, REGISTRY, CollectorRegistry, Gauge, generate_latest

from app.api import errors
from app.api.auth_routes import router as auth_router
from app.api.deps import authorize
from app.api.email_routes import router as email_router
from app.api.page_routes import router as page_router
from app.api.prompt_routes import router as prompt_router
from app.api.routes import router
from app.core import metrics
from app.core.config import get_settings
from app.core.context import client_ip_var, request_id_var, user_agent_var
from app.core.logging import configure_logging
from app.core.tracing import setup_tracing

log = logging.getLogger("ttbs.http")


def _state_gauges() -> bytes:
    """Point-in-time pipeline state, computed per scrape from the database and the broker."""
    import redis

    reg = CollectorRegistry()
    g_runs = Gauge("ttbs_runs_active", "Runs scheduled, queued or running", registry=reg)
    g_res = Gauge("ttbs_research_outstanding", "Logos waiting or being researched", ["state"], registry=reg)
    g_notes = Gauge("ttbs_notifications_pending", "Digests waiting to be delivered", registry=reg)
    g_queue = Gauge("ttbs_queue_depth", "Messages waiting in the broker", ["queue"], registry=reg)
    try:
        from app.api.routes import QUEUE_COUNTS_TTL_S, outstanding_work
        from app.core import cache

        db = cache.shared("queues", "db", QUEUE_COUNTS_TTL_S, outstanding_work)
        g_runs.set(db["runsActive"])
        g_res.labels("pending").set(db["researchPending"])
        g_res.labels("running").set(db["researchRunning"])
        g_notes.set(db["notificationsPending"])
    except Exception:  # noqa: BLE001 - a scrape must not fail because the DB blinked
        log.warning("metrics: database gauges unavailable", exc_info=True)
    try:
        r = redis.Redis.from_url(get_settings().broker_url, socket_connect_timeout=1, socket_timeout=1)
        for q in ("research", "notify", "maintenance"):
            g_queue.labels(q).set(int(r.llen(q)))
    except redis.RedisError:
        pass
    return generate_latest(reg)


@asynccontextmanager
async def _lifespan(_: FastAPI):
    from app.services.auth import bootstrap_admin

    try:
        bootstrap_admin()  # first admin from ADMIN_* settings, only while no user exists
    except Exception:  # noqa: BLE001 - a DB hiccup at boot must not crash-loop the API
        log.exception("auth: bootstrap admin check failed")
    yield


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level)
    # Interactive docs and the schema are development aids: off in prod (less attack surface).
    docs = s.env != "prod"
    app = FastAPI(title=s.app_name, version="0.2.0", lifespan=_lifespan, docs_url="/docs" if docs else None,
                  redoc_url=None, openapi_url="/openapi.json" if docs else None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,  # explicit list only (never "*"), so credentials are safe
        allow_credentials=True,  # the session cookie, for the vite dev server on another port
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-CSRF-Token", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Content-Disposition"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        request_id_var.set(rid[:64])
        client_ip_var.set(request.client.host if request.client else None)
        user_agent_var.set(request.headers.get("User-Agent"))
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - t0
        response.headers["X-Request-ID"] = rid
        # API data is per-user and changes constantly: never stored by browsers or proxies.
        # (Static assets are served and cached by the gateway; see docs/caching-policy.md.)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
            response.headers.setdefault("Pragma", "no-cache")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        # Label by route template (/api/v1/runs/{run_id}), never the raw path: bounded cardinality.
        route = getattr(request.scope.get("route"), "path", None) or "unmatched"
        if route != "/metrics":
            metrics.HTTP_REQUESTS.labels(request.method, route, str(response.status_code)).inc()
            metrics.HTTP_LATENCY.labels(request.method, route).observe(elapsed)
        log.info("request", extra={"method": request.method, "path": request.url.path, "status": response.status_code,
                                   "ms": round(elapsed * 1000, 1)})
        return response

    @app.get("/metrics", include_in_schema=False)
    def prometheus_metrics() -> Response:
        """Prometheus scrape endpoint: API counters/histograms + live pipeline gauges.
        Research/notify counters are exported by each worker on METRICS_WORKER_PORT."""
        return Response(generate_latest(REGISTRY) + _state_gauges(), media_type=CONTENT_TYPE_LATEST)

    errors.install(app)
    # Every /api/v1 route passes the access guard (fails closed: see app/core/permissions.py).
    guard = [Depends(authorize)]
    app.include_router(auth_router, dependencies=guard)
    app.include_router(router, dependencies=guard)
    app.include_router(page_router, dependencies=guard)
    app.include_router(email_router, dependencies=guard)
    app.include_router(prompt_router, dependencies=guard)
    setup_tracing("api", app)
    return app


app = create_app()
