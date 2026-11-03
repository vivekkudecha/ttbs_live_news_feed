"""One error envelope for every failure:
    {"error": {"code", "message", "details", "request_id"}}
Stack traces stay in the server log; the request_id ties a user report to that log line."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.context import request_id_var
from app.core.errors import AppError

log = logging.getLogger("ttbs.api")


def envelope(status: int, code: str, message: str, details=None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "details": details, "request_id": request_id_var.get()}},
    )


def install(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, e: AppError):
        if e.status_code >= 500:
            log.error("app error", extra={"code": e.code, "err": e.message})
        return envelope(e.status_code, e.code, e.message, e.details)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in err["loc"][1:]), "message": err["msg"]} for err in e.errors()]
        return envelope(422, "validation_failed", "Request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "http_error")
        return envelope(e.status_code, code, str(e.detail))

    @app.exception_handler(OperationalError)
    async def _db_down(_: Request, e: OperationalError):
        log.exception("database unavailable")
        return envelope(503, "service_unavailable", "Database is unavailable; please retry shortly")

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, e: Exception):
        log.exception("unhandled error")
        return envelope(500, "internal_error", "Something went wrong. Quote the request id when reporting this.")
