# Data partitioning, soft delete and indexes

Every research run writes 10,000+ research jobs, and about as many telemetry/retry logs, FinOps
ledger rows and audit rows. These tables are split by month so that:
- reads touch only the months they need;
- an emptied month is removed with an instant `DROP PARTITION`;
- a small server is never asked to scan or delete millions of rows.

## Monthly partitions (MySQL)

Migration `0011` RANGE-partitions the high-volume tables by `part_month` (YYYYMM). There is one
partition per month, named `mon__yyyy__module`:

| Table | Partitions | Month taken from |
|---|---|---|
| `research_results` | `nov__2026__job` | the run's scheduled time (`runs.scheduled_for`) |
| `notifications` | `nov__2026__notify` | the run's scheduled time |
| `notification_attempts` (retry log) | `nov__2026__retry` | its notification (the run's month) |
| `dead_letters` | `nov__2026__dlq` | its notification (the run's month) |
| `process_events` (telemetry log) | `nov__2026__logs` | the row's own `ts` |
| `cost_ledger` (FinOps) | `nov__2026__finops` | the row's own `ts` |
| `audit_log` (audit trail) | `nov__2026__audit` | the row's own `ts` |

Months are counted in the business time zone (`TIMEZONE`, default Asia/Kolkata). A run scheduled
at 01:30 IST on 1 Nov is a November run, even though that instant is 31 Oct in UTC.

**Why two rules.**
- **Run-owned rows** (jobs, notifications, retries, dead letters) follow the date the user's schedule
  picked. A run's 10k jobs therefore stay in one partition, even when the run crosses midnight at
  the end of a month.
- **Time-series rows** (logs, costs, audit) follow their own timestamp. A digest resent in March is
  billed and logged in March, so date-range reports (FinOps, telemetry) prune exactly and never miss
  a late row.
- **Run-scoped reads of time-series rows** also skip every month before the run was created.

Every table also has a `p_future` (MAXVALUE) partition. It is the safety net: an insert never
fails because a month's partition has not been created yet.

### Lifecycle

| When | What happens | Code |
|---|---|---|
| A run is created | Partitions for its scheduled month are created, before its first job is written. | `runs.create_run` → `partitions.ensure_months` |
| Every 6 h (beat) | This month and next month are created if missing; empty old months are dropped. | `maintenance.partitions` → `partitions.maintain` |
| Rows are soft-deleted | Maintenance runs right after the commit, so a month whose last live row was deleted loses its live partition. | `soft_delete.archive` |

- **Drop rule:** only *live* partitions are dropped, only when empty, and only for months before
  last month.
- **Run-owned tables are dropped as one group.** Jobs, notifications, retry attempts and dead
  letters share the run's month. A month leaves all four only when all four are empty and no run of
  that month is still scheduled, queued or running (`partitions.month_is_quiet`). This is what makes
  a late write impossible: a resend writes a retry attempt into its notification's month, a late
  digest needs the run's results, and a queued run's jobs need the run. As long as any parent row is
  left, the month stays. Logs, costs and audit always write to the current month, so they are judged
  table by table.
- **No insert can slip in between the check and the drop.** The drop takes `LOCK TABLES … WRITE`
  on the tables involved, plus a read lock on `runs` for the run-owned group. It checks again that
  the month is empty, drops it and unlocks. Writers wait for the lock, typically 15–50 ms, because
  dropping an empty partition only changes the table definition. A writer that arrives during that
  wait still lands its row, in the next month's range, which now covers the dropped month.
- **The drop never stalls the app.** The lock wait is capped at 5 s (`lock_wait_timeout`). On a
  timeout, or if the database user lacks the `LOCK TABLES` privilege, the month is skipped with a
  warning, and the next maintenance run, 6 hours later, tries again. Nothing is dropped without the
  lock.
- **Archive partitions are kept, even when empty.** Old rows arrive in them later, when they are
  deleted.
- **DDL is safe under concurrency.** It runs on its own connection, serialised by a MySQL named
  lock (`ttbs:partition-ddl`).

Partition sizes are reported at `GET /api/v1/telemetry/partitions`. Rows and MB are
`information_schema` estimates, so no table is scanned.

### What partitioning changes

- **No foreign keys** on the partitioned tables: InnoDB does not allow them. Every write goes
  through the services, and nothing hard-deletes a parent row, so integrity is kept by the code.
- **Every unique key includes `part_month`.** The primary key is `(id, part_month)`. The unique
  keys become `(run_id, company_id, part_month)` and `(run_id, pam_id, channel, part_month)`. Since
  `part_month` is a function of `run_id`, uniqueness is unchanged.
- **`part_month` is filled automatically** by context-sensitive column defaults
  (`app/db/partitions.py`). Writers do not pass it.
- **Queries add the partition predicate** wherever they can:
  - run-scoped reads use `in_run(run)` (`run_id` + `part_month`), which is one partition;
  - date-range reads use `partitions.range_months`.
- **SQLite and Postgres** get the same columns and indexes, without partitioning (tests run on
  SQLite).

## Audit trail: one chain across months

The hash chain is global: the first December row links to the last November row.
- `audit_chain_head` (one row) holds the newest id and hash. It is updated under the existing chain
  lock, so appending is O(1) however many partitions there are.
- `GET /audit/verify` walks every partition in id order.
- Audit rows are never deleted or archived, because that would break the chain.

## Soft delete (no hard deletes)

`services/soft_delete.archive(uow, Model, *where, actor=..., reason=...)` moves rows into
`<table>_deleted`:
- the archive has the same columns, plus `deleted_at`, `deleted_by`, `delete_reason`, and its own
  `archive_id` key;
- the copy and the delete happen in the caller's transaction, so the move is all-or-nothing;
- archives of partitioned tables are partitioned the same way (`nov__2026__job_deleted`) and stored
  `ROW_FORMAT=COMPRESSED` (cold data).

Every former hard delete now archives:
- dataset rows (`dataset_companies`);
- email templates and their versions;
- LLM provider settings;
- email settings.

One deliberate exception: `email_quota.prune` still deletes `email_send_buckets`. Those rows are
rolling per-minute counters, not records.

## Indexes (write-heavy tables carry only what queries use)

| Table | Indexes |
|---|---|
| `research_results` | unique `(run_id, company_id, part_month)`, `(run_id, pam_id, status)`, `(run_id, status, finished_at)`, `(company_id, status)`, `(status, enqueued_at)` |
| `process_events` | `(run_id, ts)`, `(import_id, ts)`, `(kind, ts, status)` (standalone `ts` dropped: partitions replace it) |
| `cost_ledger` | `(ts, category)`, `(run_id, pam_id)`, `(import_id)` (was 4 single-column indexes) |
| `audit_log` | `ts`, `(entity_type, entity_id)`, `(action, id)`, `(run_id, id)` (64-char unique `hash` index dropped) |
| `notification_attempts` | `(notification_id, id)` |

Other changes that keep reads bounded:
- **Signal counts:** `company_signal_summary` keeps each company's signal count and newest signal
  date, updated as each result completes. Company lists sorted by signals no longer aggregate every
  month of results.
- **Capped counts:** list totals for audit and telemetry stop at 10,000 (`totalCapped: true`). A
  full `count(*)` over months of logs is no longer run on every page.
- **Event window:** `GET /telemetry/events` with no `hours`, `runId` or `importId` defaults to the
  last 7 days.

## Deploying migration 0011

**Database user privileges.** The app's database user needs, on its own schema: `SELECT, INSERT,
UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, LOCK TABLES`. `ALTER` and `DROP` are for adding and
dropping partitions; `LOCK TABLES` is for dropping them safely. Without `LOCK TABLES`, emptied months
are never dropped (a warning is logged every 6 hours), but nothing else breaks.

```sql
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, LOCK TABLES ON ttbs_newsfeed.* TO 'ttbs'@'%';
```


The migration rebuilds each partitioned table once, copying it, and backfills `part_month` in
50k-row batches. Run it in a maintenance window, with workers stopped. Plan for free disk of about
the size of the largest table. Downgrade (`alembic downgrade 0010`) removes partitioning and
restores the foreign keys and the old indexes.

MySQL settings for a small host are in `compose.db.yml`. For an external production database, apply
the same settings:

| Setting | Value |
|---|---|
| `innodb_buffer_pool_size` | 50–60% of MySQL's RAM |
| `innodb_redo_log_capacity` | 512M |
| `innodb_flush_log_at_trx_commit` | 2 (see the note below) |
| `binlog_expire_logs_seconds` | 3 days |
| `max_connections` | at least (`DB_POOL_SIZE` + `DB_MAX_OVERFLOW`) × API/worker processes |

With `innodb_flush_log_at_trx_commit=2`, an OS crash can lose up to the last second of commits; a
mysqld crash loses nothing. Keep the default (1) if that is not acceptable.
