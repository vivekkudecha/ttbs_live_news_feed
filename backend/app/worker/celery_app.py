"""Celery wiring.

Queues (separate so a 10k-company research backlog never delays notifications):
    research     one task per company (slow, rate-limited LLM calls)
    notify       digest delivery
    maintenance  start_run fan-out + the periodic dispatcher/sweeper

Windows has no prefork pool; run workers with the thread pool (research is I/O-bound):
    celery -A app.worker.celery_app worker -P threads -c 32 -Q research,notify,maintenance -l INFO
    celery -A app.worker.celery_app beat -l INFO
"""

import logging

from celery import Celery
from celery.signals import setup_logging, worker_init

from app.core.config import get_settings
from app.core.logging import configure_logging

settings = get_settings()

celery_app = Celery("ttbs", broker=settings.broker_url, include=["app.worker.tasks"])
celery_app.conf.update(
    task_always_eager=settings.task_always_eager,
    task_eager_propagates=True,
    task_ignore_result=True,
    task_acks_late=True,  # a task killed mid-flight is redelivered, not lost
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,  # fair dispatch for long LLM calls
    broker_connection_retry_on_startup=True,
    # Must exceed the longest task + countdown, or Redis redelivers early (tasks are idempotent anyway).
    broker_transport_options={"visibility_timeout": 3600},
    task_default_queue="maintenance",
    task_routes={
        "research.*": {"queue": "research"},
        "notify.*": {"queue": "notify"},
        "maintenance.*": {"queue": "maintenance"},
    },
    beat_schedule={
        "dispatcher-tick": {"task": "maintenance.tick", "schedule": float(settings.dispatcher_interval_s)},
    },
    timezone="UTC",
)


@setup_logging.connect
def _logging(**_):  # use our JSON logs instead of Celery's
    configure_logging(settings.log_level)


@worker_init.connect
def _telemetry(**_):
    """Worker telemetry: Prometheus counters on METRICS_WORKER_PORT, traces if OTLP is configured.
    (Beat does not fire worker_init, so it never binds the port.)"""
    log = logging.getLogger("ttbs.worker")
    if settings.metrics_worker_port:
        from prometheus_client import start_http_server

        try:
            start_http_server(settings.metrics_worker_port)
            log.info("worker metrics listening", extra={"port": settings.metrics_worker_port})
        except OSError as e:  # a second worker on the same host: keep running without its own endpoint
            log.warning("worker metrics port busy; metrics endpoint not started", extra={"port": settings.metrics_worker_port, "err": str(e)})
    from app.core.tracing import setup_tracing

    setup_tracing("worker")
