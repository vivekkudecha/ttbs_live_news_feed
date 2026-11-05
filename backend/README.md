# TTBS Live News Feed: backend

FastAPI + SQLAlchemy + Celery/Redis. **Every research run starts from an upload** (the Excel/CSV
of logos and their PAMs for that run):

```
upload Excel/CSV ─► validate ─► save in background (chunked, resumable; logos/PAMs de-duplicated,
                                 owner changes kept in company_assignments history)
                                   │  run now / once at a time / re-run an earlier upload later
                                   ▼
dispatcher (beat, 30 s) ─► start_run ─► research.company × N  (rate-limited, cached, retried)
                                   │  each PAM's last logo done
                                   ▼
                          notifications outbox ─► notify.send (retried with backoff)
```

* A run covers only that upload's logos and delivers to the PAMs **that upload** mapped them to
  (`dataset_companies.pam_id`). Re-running an older upload keeps its mapping; if that PAM has
  since been deactivated, the logo's current owner gets it (recorded on the run's timeline).
* The upload's PAM becomes the logo's owner (`reassigned` in the upload summary); history is kept.
* Recurring schedules are retired (the `schedules` table is kept, disabled, for history).

## Audit, telemetry, FinOps

| What | Where |
|---|---|
| Audit trail | `audit_log`, hash-chained. Every run and notification entry carries `run_id`: `GET /runs/{id}/audit`. `GET /audit/verify` checks the chain. |
| Process telemetry | `process_events`: every upload chunk, run step, research attempt (latency, tokens, cost, retries) and delivery attempt. `GET /runs/{id}/timeline`, `/runs/{id}/events`, `/telemetry/summary`, `/telemetry/events`. |
| Metrics | Prometheus at `GET /metrics` (API + live queue/run gauges) and `:METRICS_WORKER_PORT/metrics` per worker. |
| Traces | OpenTelemetry (FastAPI, httpx, SQLAlchemy, Redis, Celery) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. |
| Cost ledger | `cost_ledger`: one row per LLM call, cache hit (with estimated saving) and delivered message, tagged with run, upload, PAM and logo. `GET /finops?from&to`, `GET /finops/ledger.csv`, `GET /runs/{id}/costs`. Monthly budget is a hard cap on new runs (`BUDGET_HARD_CAP`). |

## One-time setup

```powershell
cd backend
python -m venv .venv; .venv\Scripts\pip install -r requirements-dev.txt
copy .env.example .env          # then fill in DATABASE_URL and SECRETS_KEY (Perplexity key is set in the UI)
# create the Postgres role + database (edit the password in the file first):
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -f scripts/create_db.sql
.venv\Scripts\alembic upgrade head
```

### Temporary: SQLite instead of Postgres

`backend/.env` currently has `DATABASE_URL=sqlite:///…/backend/ttbs_dev.db` (the Postgres line is kept
commented out). `alembic upgrade head` creates the file. Every SQLite transaction starts with
`BEGIN IMMEDIATE`, so writers queue up instead of failing with "database is locked". To switch to
Postgres later: run `scripts/create_db.sql`, swap the two `DATABASE_URL` lines in `.env`, then run
`alembic upgrade head` again.

### Research AI: Perplexity or Gemini, one at a time (set in the UI, not in .env)

Open **Providers & channels** in the frontend. Each provider card has the same flow: enter the API
key, click **Load models** (fetched with that key: Perplexity `GET /v1/models`, Gemini
`GET /v1beta/models`), choose the model provider and the model, then click **Verify & save**.

- **One active AI.** Saving a provider makes it the active one and switches the other off in the
  same transaction. A partial unique index on `llm_provider_configs(active)` makes a second
  active row impossible. The switched-off provider keeps its key, so **Use for research**
  re-activates it (after a fresh check) without re-entering anything. Removing the active
  provider blocks research; there is no silent fallback to the other one.
- **Verification.** Save and activate make one tiny real call with that key and model first. For
  Gemini that call has Google Search enabled, so a model that cannot do grounding is rejected
  at save time.
- **Secrets.** Keys are AES-256-GCM encrypted with `SECRETS_KEY` from `.env`. The API never
  returns a key, only a hint (`pplx-…a1b2`, `…9xYz`). Gemini keys are sent in the
  `x-goog-api-key` header, never in the URL. Keep `SECRETS_KEY` stable: if it changes, saved
  keys become unreadable and must be entered again.
- **Execution.** Every research task uses the active provider's key and model, with no
  restart. Cached answers are keyed by provider and model. Gemini's grounded sources come from
  `groundingMetadata`, and its cost is estimated from `GEMINI_PRICE_*` (tokens plus searches);
  tune those to your billing.
- **Audit.** Changes are recorded as `llm.config.save|test|remove` and `llm.provider.activate`.

Endpoints (provider = `perplexity` | `gemini`): `GET /api/v1/settings/llm`,
`POST /settings/llm/{provider}/models`, `PUT /settings/llm/{provider}`,
`POST /settings/llm/{provider}/activate`, `POST /settings/llm/{provider}/test`,
`DELETE /settings/llm/{provider}`.

## Run (three terminals)

```powershell
.venv\Scripts\uvicorn app.main:app --reload --port 8010
.venv\Scripts\celery -A app.worker.celery_app worker -P threads -c 32 -Q research,notify,maintenance -l INFO
.venv\Scripts\celery -A app.worker.celery_app beat -l INFO
```

Port 8000 is already used by another app on this machine, hence 8010 (the frontend's
`.env.development` points there). Windows has no prefork pool, so the worker uses threads.

## Test

```powershell
.venv\Scripts\python -m pytest      # SQLite + fakeredis + eager Celery; touches nothing shared
.venv\Scripts\ruff check app tests
```

## Reliability notes

| Concern | How it is handled |
|---|---|
| Errors | One envelope `{"error": {code, message, details, request_id}}`; stack traces stay in logs. |
| Audit | `audit_log` written in the same transaction as each change; SHA-256 hash chain, `GET /api/v1/audit/verify`. |
| Retry | Research: 429/5xx/timeouts retried with exponential backoff + jitter (honours `Retry-After`), up to `RESEARCH_MAX_RETRIES`; 4xx fails fast. Notifications: backoff up to `NOTIFY_MAX_ATTEMPTS`. Attempts are stored in the DB. |
| Lost work | Every task is idempotent (conditional status UPDATEs). The sweeper re-enqueues stuck/lost research and notifications. |
| Caching | Research results cached in Redis per company + window + prompt version (cost 0 on reuse); API reads cached with namespace versioning. Fails open if Redis is down. |
| Queues | `research`, `notify`, `maintenance` are separate so a 10k-company backlog never delays digests. `GET /api/v1/queues` shows depth. |
| Rate limit | Redis-backed 45 req/s shared by all workers (Perplexity allows 50). |
| Budget | Optional per-run budget cap; companies beyond it are marked failed with a reason. |
