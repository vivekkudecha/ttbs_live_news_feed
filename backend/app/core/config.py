"""Process configuration (12-factor). Business configuration moves to DB tables in later phases."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    app_name: str = "TTBS Live News Feed API"
    log_level: str = "INFO"

    # --- Storage -----------------------------------------------------------------------
    # Temporary dev default: SQLite file in backend/. Switch to Postgres via DATABASE_URL, e.g.
    # postgresql+psycopg://ttbs:<password>@localhost:5432/ttbs_newsfeed
    database_url: str = f"sqlite:///{(Path(__file__).resolve().parents[2] / 'ttbs_dev.db').as_posix()}"
    db_pool_size: int = 10
    db_max_overflow: int = 10
    # Redis is shared with other apps on this host: use dedicated DB numbers, never FLUSHDB.
    broker_url: str = "redis://localhost:6379/5"
    redis_cache_url: str = "redis://localhost:6379/6"
    cache_prefix: str = "ttbs:"

    # --- HTTP --------------------------------------------------------------------------
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    default_actor: str = "admin"  # until auth (Phase 1) lands; see app/api/deps.py

    # --- Imports -----------------------------------------------------------------------
    # Uploads are streamed to disk and read row by row, so size is bounded by disk, not memory.
    import_max_bytes: int = 1024 * 1024 * 1024  # 1 GB
    # Duplicate detection keeps one 8-byte hash per logo while checking a file (~60 B/row in
    # Python): 10M rows ≈ 600 MB on the worker during the check.
    import_max_rows: int = 10_000_000
    import_default_country_code: str = "91"
    pam_default_capacity: int = 500
    import_chunk_size: int = 1000  # rows saved per transaction (one resumable step)
    import_analyze_batch: int = 2000  # rows compared with the database per query while checking a file
    import_preview_ttl_hours: int = 24  # checked-but-never-saved uploads (and their files) are discarded after this
    import_stall_seconds: int = 60  # no heartbeat for this long → the sweeper resumes the upload
    import_max_failures: int = 5  # consecutive chunk failures before the upload is marked failed
    # Original uploaded files are kept here (relative paths resolve against backend/).
    upload_dir: str = "storage/uploads"

    # --- Research ----------------------------------------------------------------------
    # "perplexity": the API key + model come ONLY from the database (set in the UI under
    # Providers & channels). "fake": offline provider for tests/dev, no key needed.
    llm_provider: Literal["fake", "perplexity"] = "perplexity"
    research_window_days: int = 10
    research_max_retries: int = 5
    research_backoff_cap_s: int = 120
    llm_rate_per_second: int = 45  # Perplexity allows 50/s; keep headroom (from test.py)

    # Master key for encrypting stored credentials (see app/core/secrets.py).
    secrets_key: SecretStr | None = None

    perplexity_base_url: str = "https://api.perplexity.ai"
    perplexity_timeout_s: float = 300.0
    llm_models_cache_s: int = 3600  # model lists per provider + key fingerprint
    perplexity_max_output_tokens: int = 50_000
    # Fallback pricing when the API response carries no cost (USD per 1K tokens).
    perplexity_price_in_per_1k: float = 0.001
    perplexity_price_out_per_1k: float = 0.005

    gemini_base_url: str = "https://generativelanguage.googleapis.com"
    gemini_timeout_s: float = 300.0
    gemini_max_output_tokens: int = 32_768  # thinking tokens count toward this on Gemini 2.5+
    # Usage carries no cost: approximate list prices (USD) for FinOps estimates; tune per model/billing.
    gemini_price_in_per_1k: float = 0.0003
    gemini_price_out_per_1k: float = 0.0025
    gemini_price_per_search: float = 0.014  # Google Search grounding, per query beyond the free tier

    fake_latency_ms: int = 400
    fake_failure_rate: float = 0.0  # transient errors, to exercise retries
    fake_signal_rate: float = 0.35

    # --- Notifications -----------------------------------------------------------------
    notify_email_adapter: str = "console"
    notify_whatsapp_adapter: str = "console"
    notify_max_attempts: int = 6

    # --- Queue maintenance ---------------------------------------------------------------
    dispatcher_interval_s: int = 30
    stuck_after_minutes: int = 20
    task_always_eager: bool = False  # tests only

    # --- Cache TTLs (seconds) ------------------------------------------------------------
    cache_ttl_job_running: int = 2
    cache_ttl_job_finished: int = 300
    cache_ttl_lists: int = 15

    # --- FinOps (all amounts USD) ----------------------------------------------------------
    monthly_budget_usd: float = 500.0
    budget_soft_limit_pct: int = 80
    # Hard cap: no new run may start once month-to-date spend reaches the budget.
    budget_hard_cap: bool = True
    # Per-message delivery prices for the cost ledger. Set them from your Meta (WhatsApp) and
    # mail provider rate cards; 0 means "not billed / unknown" and is shown as such.
    notify_price_email_usd: float = 0.0
    notify_price_whatsapp_usd: float = 0.0

    # --- Telemetry -----------------------------------------------------------------------
    # Every pipeline step is stored in process_events (run timeline, telemetry page).
    telemetry_events: bool = True
    # Prometheus: the API serves /metrics; each Celery worker serves its own on this port
    # (0 = off). Threads pool = one process per worker, so one port per worker host.
    metrics_worker_port: int = 9464
    # OpenTelemetry traces are exported only when an OTLP/HTTP collector is configured,
    # e.g. http://localhost:4318. Empty = tracing off (no overhead).
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "ttbs-newsfeed"

    timezone: str = "Asia/Kolkata"
    max_page_size: int = 200

    @property
    def upload_path(self) -> Path:
        p = Path(self.upload_dir)
        return p if p.is_absolute() else Path(__file__).resolve().parents[2] / p

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()
