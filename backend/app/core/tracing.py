"""OpenTelemetry tracing, opt-in. With OTEL_EXPORTER_OTLP_ENDPOINT unset nothing is installed and
there is no overhead. With it set, FastAPI, httpx (LLM calls), SQLAlchemy, Redis and Celery are
instrumented, spans are exported over OTLP/HTTP, and the current trace id is attached to logs and
process_events so a timeline row links straight to its trace."""

import logging

from app.core.config import get_settings

log = logging.getLogger(__name__)
_installed = False


def setup_tracing(component: str, app=None) -> bool:
    """component: "api" | "worker". Idempotent. Returns True when tracing is active."""
    global _installed
    s = get_settings()
    if not s.otel_exporter_otlp_endpoint:
        return False
    if _installed:
        if app is not None:
            _instrument_app(app)
        return True
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.redis import RedisInstrumentor
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        from app.db.session import get_engine

        provider = TracerProvider(resource=Resource.create({
            "service.name": f"{s.otel_service_name}-{component}", "deployment.environment": s.env,
        }))
        endpoint = s.otel_exporter_otlp_endpoint.rstrip("/") + "/v1/traces"
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(provider)
        HTTPXClientInstrumentor().instrument()
        RedisInstrumentor().instrument()
        SQLAlchemyInstrumentor().instrument(engine=get_engine())
        if component == "worker":
            from opentelemetry.instrumentation.celery import CeleryInstrumentor

            CeleryInstrumentor().instrument()
        _installed = True
        if app is not None:
            _instrument_app(app)
        log.info("tracing enabled", extra={"endpoint": endpoint, "component": component})
        return True
    except Exception:  # tracing must never stop the app from starting
        log.exception("tracing setup failed; continuing without traces")
        return False


def _instrument_app(app) -> None:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app, excluded_urls="metrics,api/v1/health")


def current_trace_id() -> str | None:
    if not _installed:
        return None
    from opentelemetry import trace

    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx and ctx.is_valid else None
