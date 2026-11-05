"""Prometheus metrics. The API serves /metrics; each Celery worker process serves its own on
METRICS_WORKER_PORT (see app/worker/celery_app.py). Labels are low-cardinality on purpose: never
a company, PAM or run id (those live in process_events, where they belong)."""

from prometheus_client import Counter, Histogram

HTTP_REQUESTS = Counter("ttbs_http_requests_total", "API requests", ["method", "route", "status"])
HTTP_LATENCY = Histogram(
    "ttbs_http_request_seconds", "API latency", ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)

RESEARCH_ATTEMPTS = Counter("ttbs_research_attempts_total", "LLM research attempts", ["provider", "model", "outcome"])
RESEARCH_LATENCY = Histogram(
    "ttbs_research_seconds", "LLM research call latency", ["provider"],
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300),
)
RESEARCH_TOKENS = Counter("ttbs_research_tokens_total", "LLM tokens", ["provider", "model", "direction"])
COST_USD = Counter("ttbs_cost_usd_total", "Spend recorded in the cost ledger (USD)", ["category", "provider"])
CACHE_SAVED_USD = Counter("ttbs_cache_saved_usd_total", "Estimated spend avoided by the research cache (USD)")

NOTIFY_ATTEMPTS = Counter("ttbs_notify_attempts_total", "Digest delivery attempts", ["channel", "outcome"])
RUNS_FINISHED = Counter("ttbs_runs_finished_total", "Research runs finished", ["status"])
RUN_DURATION = Histogram(
    "ttbs_run_seconds", "Run wall time, start to finish",
    buckets=(60, 300, 900, 1800, 3600, 7200, 14400, 28800, 86400),
)
DATASET_ROWS = Counter("ttbs_dataset_rows_saved_total", "Uploaded rows saved to master data")
SWEEPER_RECOVERED = Counter("ttbs_sweeper_recovered_total", "Work re-enqueued by the sweeper", ["what"])
