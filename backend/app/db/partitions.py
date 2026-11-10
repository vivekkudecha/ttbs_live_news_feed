"""Monthly logical partitioning of the high-volume tables.

Every run writes 10k+ research jobs and as many log, retry, cost and audit rows. Those tables are
RANGE-partitioned by month on MySQL (one partition per month, named `mon__yyyy__module`, e.g.
`nov__2026__job`), so a run's reads touch one partition, month reports touch one or two, and an
emptied month is removed with an instant `DROP PARTITION` instead of a slow DELETE.

Partition key `part_month` = year*100 + month (202611) in the business time zone (settings.timezone):
- run-owned rows (jobs, notifications, retry attempts, dead letters) use the month of the run's
  scheduled time (`runs.scheduled_for`, the date the user's schedule picked), so all of a run's
  jobs live in one partition even when the run crosses midnight at the end of a month;
- time-series rows (telemetry logs, FinOps ledger, audit trail) use the month of their own
  timestamp, so date-range reports prune exactly (a resend months later is billed in the month it
  happened, not in the month of the run).

The column is filled by a context-sensitive column default (`default_for_*`), so every writer is
covered without passing it explicitly. On SQLite/Postgres the column exists but the tables are not
partitioned; the DDL helpers below are no-ops there.

A `p_future` (MAXVALUE) partition is the safety net: an insert never fails because a month's
partition has not been created yet. `ensure_months()` splits it before a month is used.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from datetime import datetime
from functools import lru_cache
from threading import Lock
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import bindparam, text
from sqlalchemy.exc import DBAPIError

log = logging.getLogger(__name__)

MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
FUTURE = "p_future"

# table -> module suffix used in partition names (mon__yyyy__<module>).
PARTITIONED: dict[str, str] = {
    "research_results": "job",
    "notifications": "notify",
    "notification_attempts": "retry",
    "dead_letters": "dlq",
    "process_events": "logs",
    "cost_ledger": "finops",
    "audit_log": "audit",
}
# Archive siblings of the partitioned tables follow the same monthly scheme (`nov__2026__job_deleted`).
# audit_log has none: audit rows are never removed (that would break the hash chain).
PARTITIONED_ARCHIVES: dict[str, str] = {f"{t}_deleted": f"{m}_deleted" for t, m in PARTITIONED.items() if t != "audit_log"}
ALL_PARTITIONED: dict[str, str] = PARTITIONED | PARTITIONED_ARCHIVES


# --- Month keys -----------------------------------------------------------------------------------


@lru_cache
def _tz() -> ZoneInfo:
    from app.core.config import get_settings

    return ZoneInfo(get_settings().timezone)


def month_key(dt: datetime | None) -> int:
    """202611 for any instant in November 2026 (business time zone). Naive datetimes are UTC."""
    from app.core.timeutil import as_utc, utcnow

    local = (as_utc(dt) if dt is not None else utcnow()).astimezone(_tz())
    return local.year * 100 + local.month


def add_months(key: int, n: int) -> int:
    y, m = divmod(key // 100 * 12 + key % 100 - 1 + n, 12)
    return y * 100 + m + 1


def partition_name(key: int, module: str) -> str:
    """partition_name(202611, "job") -> "nov__2026__job"."""
    return f"{MONTHS[key % 100 - 1]}__{key // 100}__{module}"


def parse_partition(name: str) -> int | None:
    """"nov__2026__job" -> 202611; None for p_future or anything else."""
    parts = name.split("__")
    if len(parts) < 3 or parts[0] not in MONTHS or not parts[1].isdigit():
        return None
    return int(parts[1]) * 100 + MONTHS.index(parts[0]) + 1


# --- Owner lookups (immutable, so a bounded in-process cache is always correct) --------------------


class _Lru:
    def __init__(self, size: int = 50_000):
        self._d: OrderedDict[Any, int] = OrderedDict()
        self._size, self._lock = size, Lock()

    def get(self, k: Any) -> int | None:
        with self._lock:
            v = self._d.get(k)
            if v is not None:
                self._d.move_to_end(k)
            return v

    def put(self, k: Any, v: int) -> None:
        with self._lock:
            self._d[k] = v
            self._d.move_to_end(k)
            while len(self._d) > self._size:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


_runs, _notes = _Lru(), _Lru()


def clear_cache() -> None:
    """Tests: ids restart in every fresh database."""
    _runs.clear()
    _notes.clear()
    _tz.cache_clear()


def _lookup(conn, cache: _Lru, table: str, row_id: int | None) -> int | None:
    if row_id is None:
        return None
    hit = cache.get(row_id)
    if hit is not None:
        return hit
    v = conn.execute(text(f"SELECT part_month FROM {table} WHERE id = :i"), {"i": row_id}).scalar()
    if v is not None:
        cache.put(row_id, int(v))
    return v


def run_month(conn, run_id: int | None) -> int | None:
    return _lookup(conn, _runs, "runs", run_id)


def notification_month(conn, notification_id: int | None) -> int | None:
    return _lookup(conn, _notes, "notifications", notification_id)


# --- Column defaults (context-sensitive: see SQLAlchemy "context-sensitive default functions") -----


def _params(ctx) -> dict[str, Any]:
    return ctx.get_current_parameters()


def default_for_run(ctx) -> int:
    """runs.part_month: the month of the scheduled time."""
    return month_key(_params(ctx).get("scheduled_for"))


def default_by_run(ctx) -> int:
    """Jobs, notifications: the run's month."""
    return run_month(ctx.connection, _params(ctx).get("run_id")) or month_key(None)


def default_by_notification(ctx) -> int:
    """Retry attempts, dead letters: their notification's month (= the run's month)."""
    p = _params(ctx)
    return (notification_month(ctx.connection, p.get("notification_id"))
            or run_month(ctx.connection, p.get("run_id")) or month_key(p.get("created_at")))


def default_by_ts(ctx) -> int:
    """Logs, FinOps, audit: the month of the row's own timestamp."""
    return month_key(_params(ctx).get("ts"))


# --- Query helpers (partition pruning) -------------------------------------------------------------


def since_month(col, start: datetime | None):
    """Lower bound for run-scoped reads on time-series tables: nothing about a run is written before
    the run existed, so older partitions are skipped."""
    from sqlalchemy import true

    return col >= add_months(month_key(start), -1) if start is not None else true()


def range_months(col, lo: datetime | None, hi: datetime | None) -> list:
    """Conditions for a [lo, hi) time range on a table partitioned by its own timestamp. One month of
    slack on each side absorbs time-zone edge cases; the exact ts filter stays in the query."""
    out = []
    if lo is not None:
        out.append(col >= add_months(month_key(lo), -1))
    if hi is not None:
        out.append(col <= add_months(month_key(hi), 1))
    return out


# --- DDL (MySQL only) --------------------------------------------------------------------------------

LOCK_NAME = "ttbs:partition-ddl"


def _is_mysql(engine) -> bool:
    return engine.dialect.name == "mysql"


def partition_clause(table: str, months: list[int]) -> str:
    """`PARTITION BY RANGE (part_month) (...)` for the given months plus p_future."""
    module = ALL_PARTITIONED[table]
    parts = [f"PARTITION {partition_name(k, module)} VALUES LESS THAN ({add_months(k, 1)})" for k in sorted(set(months))]
    parts.append(f"PARTITION {FUTURE} VALUES LESS THAN MAXVALUE")
    return "PARTITION BY RANGE (part_month) (\n  " + ",\n  ".join(parts) + "\n)"


def existing(conn, table: str) -> list[tuple[str, int | None, int]]:
    """[(partition, month_key, approx_rows)] in boundary order."""
    rows = conn.execute(text(
        "SELECT PARTITION_NAME, TABLE_ROWS FROM information_schema.PARTITIONS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION"
    ), {"t": table}).all()
    return [(name, parse_partition(name), int(n or 0)) for name, n in rows]


def _with_lock(engine, fn):
    with engine.connect() as conn:
        got = conn.execute(text("SELECT GET_LOCK(:n, 60)"), {"n": LOCK_NAME}).scalar()
        if got != 1:
            raise TimeoutError("could not acquire the partition DDL lock")
        try:
            return fn(conn)
        finally:
            conn.execute(text("DO RELEASE_LOCK(:n)"), {"n": LOCK_NAME})


def ensure_months(*keys: int, engine=None) -> list[str]:
    """Create the monthly partitions for `keys` in every partitioned table (if missing) by splitting
    p_future. Months older than the newest existing partition are already covered by a range and
    are left alone. Returns the partitions created."""
    from app.db.session import get_engine

    engine = engine or get_engine()
    if not keys or not _is_mysql(engine):
        return []

    def go(conn) -> list[str]:
        created: list[str] = []
        for table, module in ALL_PARTITIONED.items():
            have = existing(conn, table)
            if not have:  # not partitioned (migration not applied)
                continue
            top = max((k for _, k, _ in have if k is not None), default=0)
            new = sorted(k for k in set(keys) if k > top)
            if not new:
                continue
            # Fill gaps so the ranges stay one month each: top+1 .. max(new).
            months, k = [], add_months(top, 1) if top else new[0]
            while k <= new[-1]:
                months.append(k)
                k = add_months(k, 1)
            parts = ", ".join(f"PARTITION {partition_name(m, module)} VALUES LESS THAN ({add_months(m, 1)})" for m in months)
            conn.execute(text(f"ALTER TABLE {table} REORGANIZE PARTITION {FUTURE} INTO "
                              f"({parts}, PARTITION {FUTURE} VALUES LESS THAN MAXVALUE)"))
            created += [partition_name(m, module) for m in months]
        if created:
            log.info("partitions created", extra={"partitions": created})
        return created

    return _with_lock(engine, go)


# Run-owned tables share one month key (the run's). A late write into an old month always has a
# parent row in that same month: a retry attempt or dead letter needs its notification, a digest
# notification needs the run's results, a run's jobs need the run itself (still active). So the
# group's month is dropped only when all four are empty *and* no run of that month is active; then
# nothing can write into it any more.
RUN_GROUP: tuple[str, ...] = ("research_results", "notifications", "notification_attempts", "dead_letters")
LOCK_WAIT_S = 5  # lock_wait_timeout for the drop: never queue writers behind a long transaction


def month_is_quiet(conn, month: int, tables: tuple[str, ...] = RUN_GROUP) -> bool:
    """True when no row of `tables` has `part_month == month` and (for the run group) no run of that
    month is still scheduled, queued or running. Works on any dialect; on MySQL each probe reads
    only that month's partition."""
    from app.db.models import RUN_ACTIVE

    for table in tables:
        if conn.execute(text(f"SELECT 1 FROM {table} WHERE part_month = :m LIMIT 1"), {"m": month}).first() is not None:
            return False
    if tables == RUN_GROUP:
        busy = conn.execute(text("SELECT 1 FROM runs WHERE part_month = :m AND status IN :s LIMIT 1")
                            .bindparams(bindparam("s", expanding=True)), {"m": month, "s": list(RUN_ACTIVE)}).first()
        if busy is not None:
            return False
    return True


def _drop_locked(conn, month: int, tables: tuple[str, ...], names: dict[str, str]) -> list[str]:
    """Drop `names` (table -> partition of `month`) while the tables are write-locked, after
    re-checking under the lock that the month is still quiet. Writers wait for the lock (a few ms:
    dropping an empty partition is metadata-only) instead of racing the check. Lock timeout or a
    missing LOCK TABLES privilege skips the month; the next maintenance run tries again."""
    locks = [f"{t} WRITE" for t in tables] + (["runs READ"] if tables == RUN_GROUP else [])
    try:
        conn.execute(text("LOCK TABLES " + ", ".join(locks)))
    except DBAPIError as e:
        log.warning("partition drop skipped: could not lock tables",
                    extra={"month": month, "tables": list(tables), "error": str(e.orig)})
        return []
    dropped: list[str] = []
    try:
        if month_is_quiet(conn, month, tables):
            for table in tables:
                if table in names:
                    conn.execute(text(f"ALTER TABLE {table} DROP PARTITION {names[table]}"))
                    dropped.append(f"{table}.{names[table]}")
    except DBAPIError as e:
        log.warning("partition drop stopped", extra={"month": month, "dropped": dropped, "error": str(e.orig)})
    finally:
        try:
            conn.execute(text("UNLOCK TABLES"))
        except DBAPIError:
            conn.invalidate()  # connection unusable: discard it rather than return a locked session to the pool
    return dropped


def drop_empty(engine=None, keep_from: int | None = None) -> list[str]:
    """Drop live-table month partitions that hold no rows, for months before `keep_from` (default:
    last month, so the current and previous month always stay): archiving the last row of a month
    removes that month's live partition. Archive (`_deleted`) partitions are kept even when empty,
    because rows of old months arrive there later, when they are deleted.

    Race-free against late inserts: the run-owned tables are dropped together only when the whole
    group is quiet for that month (`month_is_quiet`), and every drop re-checks under LOCK TABLES."""
    from app.db.session import get_engine

    engine = engine or get_engine()
    if not _is_mysql(engine):
        return []
    keep_from = keep_from or add_months(month_key(None), -1)

    def go(conn) -> list[str]:
        conn.execute(text(f"SET SESSION lock_wait_timeout = {LOCK_WAIT_S}"))
        old: dict[str, dict[int, str]] = {}  # table -> month -> partition
        for table in PARTITIONED:
            old[table] = {key: name for name, key, _ in existing(conn, table) if key is not None and key < keep_from}
        dropped: list[str] = []
        group_months = sorted({m for t in RUN_GROUP for m in old[t]})
        for month in group_months:
            if month_is_quiet(conn, month):  # cheap pre-check, repeated under the lock
                names = {t: old[t][month] for t in RUN_GROUP if month in old[t]}
                dropped += _drop_locked(conn, month, RUN_GROUP, names)
        for table in PARTITIONED:
            if table in RUN_GROUP:
                continue
            for month, name in sorted(old[table].items()):
                if month_is_quiet(conn, month, (table,)):
                    dropped += _drop_locked(conn, month, (table,), {table: name})
        if dropped:
            log.info("empty partitions dropped", extra={"partitions": dropped})
        return dropped

    return _with_lock(engine, go)


def maintain(engine=None) -> dict[str, list[str]]:
    """Daily: make sure this month and next month exist everywhere, then drop emptied old months."""
    now = month_key(None)
    return {"created": ensure_months(now, add_months(now, 1), engine=engine), "dropped": drop_empty(engine=engine)}


def overview(engine=None) -> list[dict[str, Any]]:
    """Partitions with approximate rows and size (information_schema estimates, no table scans)."""
    from app.db.session import get_engine

    engine = engine or get_engine()
    if not _is_mysql(engine):
        return []
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT TABLE_NAME, PARTITION_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH FROM information_schema.PARTITIONS "
            "WHERE TABLE_SCHEMA = DATABASE() AND PARTITION_NAME IS NOT NULL AND TABLE_NAME IN :t "
            "ORDER BY TABLE_NAME, PARTITION_ORDINAL_POSITION"
        ).bindparams(_expanding("t")), {"t": list(ALL_PARTITIONED)}).all()
    return [{"table": t, "partition": p, "month": parse_partition(p), "rows": int(n or 0),
             "dataMb": round((d or 0) / 1048576, 2), "indexMb": round((i or 0) / 1048576, 2)} for t, p, n, d, i in rows]


def _expanding(name: str):
    from sqlalchemy import bindparam

    return bindparam(name, expanding=True)
