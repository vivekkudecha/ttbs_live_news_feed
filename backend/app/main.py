"""FastAPI application.

    uvicorn app.main:app --reload --port 8000
"""

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api import errors
from app.api.page_routes import router as page_router
from app.api.routes import router
from app.core.config import get_settings
from app.core.context import client_ip_var, request_id_var, user_agent_var
from app.core.logging import configure_logging

log = logging.getLogger("ttbs.http")


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level)
    app = FastAPI(title=s.app_name, version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        request_id_var.set(rid[:64])
        client_ip_var.set(request.client.host if request.client else None)
        user_agent_var.set(request.headers.get("User-Agent"))
        t0 = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        log.info("request", extra={"method": request.method, "path": request.url.path, "status": response.status_code,
                                   "ms": round((time.perf_counter() - t0) * 1000, 1)})
        return response

    errors.install(app)
    app.include_router(router)
    app.include_router(page_router)
    return app


app = create_app()
