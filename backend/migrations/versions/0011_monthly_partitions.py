"""monthly partitions (mon__yyyy__module), archive (_deleted) tables, audit chain head,
company signal roll-up, leaner indexes

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-10 10:00:00.000000

MySQL: research_results, notifications, notification_attempts, dead_letters, process_events,
cost_ledger and audit_log become RANGE-partitioned by `part_month` (YYYYMM), one partition per month
named `mon__yyyy__module` (e.g. `nov__2026__job`) plus a MAXVALUE `p_future` safety net. Their
`<table>_deleted` archives are partitioned the same way. Partitioned InnoDB tables cannot have
foreign keys and every unique key must contain the partition column, so the FKs are dropped
(integrity is kept by the services) and the PK becomes (id, part_month).

Each big table is rebuilt once (a single ALTER carries the PK, unique keys and partitioning), and
backfills run in id-range batches, so a small server is not asked for one huge transaction. Run it
in a maintenance window: the rebuild copies each table.

SQLite / Postgres: additive only (columns, indexes, new tables); no partitioning, FKs kept.
"""
from datetime import UTC, datetime
from typing import Sequence, Union
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from alembic import op

revision: str = '0011'
down_revision: Union[str, None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIG_ID = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')
TS = sa.DateTime(timezone=True)
BATCH = 50_000
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")

# table -> (module suffix, how part_month is derived)
PARTITIONED = {
    "research_results": ("job", "run"),
    "notifications": ("notify", "run"),
    "notification_attempts": ("retry", "notification"),
    "dead_letters": ("dlq", "notification"),
    "process_events": ("logs", "ts"),
    "cost_ledger": ("finops", "ts"),
    "audit_log": ("audit", "ts"),
}
# Fallback timestamp for rows whose owner is missing.
OWN_TS = {"research_results": "created_at", "notifications": "created_at", "notification_attempts": "started_at",
          "dead_letters": "created_at", "process_events": "ts", "cost_ledger": "ts", "audit_log": "ts"}
ARCHIVED = ["research_results", "notifications", "notification_attempts", "dead_letters", "process_events", "cost_ledger",
            "dataset_companies", "email_templates", "email_template_versions", "llm_provider_configs", "email_config"]

MYSQL_FKS = {
    "research_results": ["fk_research_results_run_id_runs", "fk_research_results_company_id_companies", "fk_research_results_pam_id_pams"],
    "notifications": ["fk_notifications_run_id_runs", "fk_notifications_pam_id_pams"],
    "notification_attempts": ["fk_notification_attempts_notification_id_notifications"],
    "dead_letters": ["fk_dead_letters_notification_id_notifications"],
}
# Indexes that only existed to back a dropped FK (MySQL creates them implicitly).
MYSQL_FK_INDEXES = {
    "research_results": ["fk_research_results_company_id_companies", "fk_research_results_pam_id_pams"],
    "notifications": ["fk_notifications_pam_id_pams"],
}
# (table, drop, create[(name, cols)]) — all dialects.
INDEX_CHANGES = [
    ("research_results", ["ix_research_results_run_pam", "ix_research_results_run_status"],
     [("ix_research_results_run_pam_status", ["run_id", "pam_id", "status"]),
      ("ix_research_results_run_status_fin", ["run_id", "status", "finished_at"]),
      ("ix_research_results_company_status", ["company_id", "status"]),
      ("ix_research_results_status_enq", ["status", "enqueued_at"])]),
    ("notifications", ["ix_notifications_run_id"], []),
    ("notification_attempts", ["ix_notification_attempts_notification_id"],
     [("ix_notification_attempts_note", ["notification_id", "id"])]),
    ("process_events", ["ix_process_events_kind_ts", "ix_process_events_ts"],
     [("ix_process_events_kind_ts_status", ["kind", "ts", "status"])]),
    ("cost_ledger", ["ix_cost_ledger_ts", "ix_cost_ledger_run", "ix_cost_ledger_pam"],
     [("ix_cost_ledger_ts_category", ["ts", "category"]), ("ix_cost_ledger_run_pam", ["run_id", "pam_id"])]),
    ("audit_log", ["ix_audit_log_action", "ix_audit_log_run_id"],
     [("ix_audit_log_action_id", ["action", "id"]), ("ix_audit_log_run_id_id", ["run_id", "id"])]),
]


# --- helpers --------------------------------------------------------------------------------------


def _tz() -> ZoneInfo:
    from app.core.config import get_settings

    return ZoneInfo(get_settings().timezone)


def _key(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    local = dt.astimezone(_tz())
    return local.year * 100 + local.month


def _add(key: int, n: int) -> int:
    y, m = divmod(key // 100 * 12 + key % 100 - 1 + n, 12)
    return y * 100 + m + 1


def _span(lo: int, hi: int) -> list[int]:
    out, k = [], lo
    while k <= hi:
        out.append(k)
        k = _add(k, 1)
    return out


def _start_utc(key: int) -> datetime:
    """First instant of month `key` (business time zone) as a naive UTC datetime (how rows are stored)."""
    return datetime(key // 100, key % 100, 1, tzinfo=_tz()).astimezone(UTC).replace(tzinfo=None)


def _pname(key: int, module: str) -> str:
    return f"{MONTHS[key % 100 - 1]}__{key // 100}__{module}"


def _now_key() -> int:
    return _key(datetime.now(UTC))


def _as_dt(v) -> datetime | None:
    if v is None or isinstance(v, datetime):
        return v
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def _month_case(bind, col: str, table: str) -> tuple[str, dict]:
    """CASE expression mapping a timestamp column to its YYYYMM month (business time zone), built
    from UTC month boundaries, so the backfill is set-based and correct across DST rules."""
    lo, hi = bind.execute(sa.text(f"SELECT MIN({col}), MAX({col}) FROM {table}")).one()
    lo, hi = _as_dt(lo), _as_dt(hi)
    if lo is None:
        return str(_now_key()), {}
    months = _span(_key(lo), _key(hi))
    parts, params = [], {}
    for i, m in enumerate(months[1:], start=1):
        params[f"b{i}"] = _start_utc(m)
        parts.append(f"WHEN {col} < :b{i} THEN {months[i - 1]}")
    return f"CASE {' '.join(parts)} ELSE {months[-1]} END" if parts else str(months[0]), params


def _batched(bind, table: str, set_sql: str, where_sql: str = "1=1", params: dict | None = None) -> None:
    """UPDATE in id ranges (bounded undo log / lock footprint on a small server)."""
    lo, hi = bind.execute(sa.text(f"SELECT MIN(id), MAX(id) FROM {table}")).one()
    if lo is None:
        return
    start = int(lo)
    while start <= int(hi):
        bind.execute(sa.text(f"UPDATE {table} SET {set_sql} WHERE id >= :lo AND id < :hi AND ({where_sql})"),
                     {"lo": start, "hi": start + BATCH, **(params or {})})
        start += BATCH


def _set_from_owner(bind, table: str, owner: str, fk: str) -> None:
    if bind.dialect.name == "mysql":
        lo, hi = bind.execute(sa.text(f"SELECT MIN(id), MAX(id) FROM {table}")).one()
        if lo is None:
            return
        start = int(lo)
        while start <= int(hi):
            bind.execute(sa.text(f"UPDATE {table} t JOIN {owner} o ON o.id = t.{fk} SET t.part_month = o.part_month "
                                 f"WHERE t.id >= :lo AND t.id < :hi"), {"lo": start, "hi": start + BATCH})
            start += BATCH
    else:
        _batched(bind, table, f"part_month = (SELECT o.part_month FROM {owner} o WHERE o.id = {table}.{fk})")


def _backfill(bind, table: str, how: str) -> None:
    if how == "run":
        _set_from_owner(bind, table, "runs", "run_id")
    elif how == "notification":
        _set_from_owner(bind, table, "notifications", "notification_id")
    # Time-series rows, and rows whose owner is gone: their own timestamp.
    col = OWN_TS[table]
    expr, params = _month_case(bind, col, table)
    _batched(bind, table, f"part_month = {expr}", "part_month IS NULL", params)


def _months_in(bind, table: str) -> list[int]:
    lo, hi = bind.execute(sa.text(f"SELECT MIN(part_month), MAX(part_month) FROM {table}")).one()
    now = _now_key()
    lo = min(int(lo), now) if lo is not None else now
    hi = max(int(hi), _add(now, 1)) if hi is not None else _add(now, 1)
    return _span(lo, hi)


def _partition_clause(months: list[int], module: str) -> str:
    parts = [f"PARTITION {_pname(k, module)} VALUES LESS THAN ({_add(k, 1)})" for k in months]
    parts.append("PARTITION p_future VALUES LESS THAN MAXVALUE")
    return "PARTITION BY RANGE (part_month) (" + ", ".join(parts) + ")"


def _archive_table(bind, source: str, months: list[int] | None) -> None:
    """`<source>_deleted`: the source's columns (as they are now, reflected) + who/when/why."""
    src = sa.Table(source, sa.MetaData(), autoload_with=bind)
    name = f"{source}_deleted"
    mysql = bind.dialect.name == "mysql"
    partitioned = mysql and months is not None
    cols = [sa.Column("archive_id", BIG_ID, autoincrement=True, nullable=False)]
    for c in src.columns:
        cols.append(sa.Column(c.name, c.type, nullable=(c.name != "part_month" or not partitioned)))
    cols += [sa.Column("deleted_at", TS, nullable=False), sa.Column("deleted_by", sa.String(100), nullable=False),
             sa.Column("delete_reason", sa.String(300), nullable=True)]
    pk = ["archive_id", "part_month"] if partitioned else ["archive_id"]
    kw = {}
    if mysql:
        kw["mysql_row_format"] = "COMPRESSED"  # cold data: smaller on disk, rarely read
    op.create_table(name, *cols, sa.PrimaryKeyConstraint(*pk, name=f"pk_{name}"), **kw)
    op.create_index(f"ix_{name}_id", name, ["id"])
    op.create_index(f"ix_{name}_deleted_at", name, ["deleted_at"])
    if partitioned:
        op.execute(sa.text(f"ALTER TABLE {name} {_partition_clause(months, PARTITIONED[source][0] + '_deleted')}"))


# --- upgrade --------------------------------------------------------------------------------------


def upgrade() -> None:
    bind = op.get_bind()
    mysql = bind.dialect.name == "mysql"

    # 1. runs.part_month: the month of the scheduled time.
    op.add_column("runs", sa.Column("part_month", sa.Integer(), nullable=True))
    expr, params = _month_case(bind, "scheduled_for", "runs")
    _batched(bind, "runs", f"part_month = {expr}", "1=1", params)
    with op.batch_alter_table("runs") as b:
        b.alter_column("part_month", existing_type=sa.Integer(), nullable=False)

    # 2. part_month on the high-volume tables, backfilled.
    for table, (_, how) in PARTITIONED.items():
        op.add_column(table, sa.Column("part_month", sa.Integer(), nullable=True))
        _backfill(bind, table, how)

    # 3. MySQL: foreign keys go (not allowed on partitioned tables), with the indexes backing them.
    if mysql:
        for table, fks in MYSQL_FKS.items():
            for fk in fks:
                op.execute(sa.text(f"ALTER TABLE {table} DROP FOREIGN KEY {fk}"))
        for table, idx in MYSQL_FK_INDEXES.items():
            for name in idx:
                op.execute(sa.text(f"DROP INDEX {name} ON {table}"))

    # 4. Leaner, query-shaped indexes.
    for table, drops, creates in INDEX_CHANGES:
        for name in drops:
            op.drop_index(name, table_name=table)
        for name, cols in creates:
            op.create_index(name, table, cols)

    # 5. MySQL: one rebuild per table: NOT NULL key, PK (id, part_month), unique keys with part_month,
    #    monthly RANGE partitions.
    months_of: dict[str, list[int]] = {}
    for table, (module, _) in PARTITIONED.items():
        if not mysql:
            with op.batch_alter_table(table) as b:
                b.alter_column("part_month", existing_type=sa.Integer(), nullable=False)
            continue
        months = _months_in(bind, table)
        months_of[table] = months
        alters = ["MODIFY part_month INT NOT NULL", "DROP PRIMARY KEY", "ADD PRIMARY KEY (id, part_month)"]
        if table == "research_results":
            alters += ["DROP INDEX uq_research_results_run_company",
                       "ADD UNIQUE KEY uq_research_results_run_company (run_id, company_id, part_month)"]
        elif table == "notifications":
            alters += ["DROP INDEX uq_notifications_run_pam_channel",
                       "ADD UNIQUE KEY uq_notifications_run_pam_channel (run_id, pam_id, channel, part_month)"]
        elif table == "audit_log":
            alters += ["DROP INDEX uq_audit_log_hash"]  # the hash chain is the integrity check
        op.execute(sa.text(f"ALTER TABLE {table} {', '.join(alters)} {_partition_clause(months, module)}"))

    # 6. Archive tables (soft delete), partitioned like their source on MySQL.
    for source in ARCHIVED:
        _archive_table(bind, source, months_of.get(source) if source in PARTITIONED else None)

    # 7. Audit chain head (O(1) append across partitions), seeded from the newest audit row.
    op.create_table(
        "audit_chain_head",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("last_id", sa.BigInteger(), nullable=False),
        sa.Column("last_hash", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_chain_head")),
    )
    last = bind.execute(sa.text("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1")).first()
    if last is not None:
        bind.execute(sa.text("INSERT INTO audit_chain_head (id, last_id, last_hash) VALUES (1, :i, :h)"), {"i": last[0], "h": last[1]})

    # 8. Per-company signal roll-up (company lists never aggregate every partition).
    op.create_table(
        "company_signal_summary",
        sa.Column("company_id", BIG_ID, autoincrement=False, nullable=False),
        sa.Column("signals", sa.Integer(), nullable=False),
        sa.Column("last_signal_date", sa.Date(), nullable=True),
        sa.PrimaryKeyConstraint("company_id", name=op.f("pk_company_signal_summary")),
    )
    bind.execute(sa.text(
        "INSERT INTO company_signal_summary (company_id, signals, last_signal_date) "
        "SELECT r.company_id, COUNT(*), MAX(u.window_end) FROM research_results r JOIN runs u ON u.id = r.run_id "
        "WHERE r.status = 'signal' GROUP BY r.company_id"
    ))


# --- downgrade ------------------------------------------------------------------------------------


def downgrade() -> None:
    bind = op.get_bind()
    mysql = bind.dialect.name == "mysql"
    op.drop_table("company_signal_summary")
    op.drop_table("audit_chain_head")
    for source in ARCHIVED:
        op.drop_table(f"{source}_deleted")

    if mysql:
        for table in PARTITIONED:
            alters = ["REMOVE PARTITIONING"]
            op.execute(sa.text(f"ALTER TABLE {table} {alters[0]}"))
            alters = ["DROP PRIMARY KEY", "ADD PRIMARY KEY (id)"]
            if table == "research_results":
                alters += ["DROP INDEX uq_research_results_run_company",
                           "ADD UNIQUE KEY uq_research_results_run_company (run_id, company_id)"]
            elif table == "notifications":
                alters += ["DROP INDEX uq_notifications_run_pam_channel",
                           "ADD UNIQUE KEY uq_notifications_run_pam_channel (run_id, pam_id, channel)"]
            elif table == "audit_log":
                alters += ["ADD UNIQUE KEY uq_audit_log_hash (hash)"]
            op.execute(sa.text(f"ALTER TABLE {table} {', '.join(alters)}"))

    for table, _drops, creates in INDEX_CHANGES:
        for name, _ in creates:
            op.drop_index(name, table_name=table)
    restore = {
        "ix_research_results_run_pam": ("research_results", ["run_id", "pam_id"]),
        "ix_research_results_run_status": ("research_results", ["run_id", "status"]),
        "ix_notifications_run_id": ("notifications", ["run_id"]),
        "ix_notification_attempts_notification_id": ("notification_attempts", ["notification_id"]),
        "ix_process_events_kind_ts": ("process_events", ["kind", "ts"]),
        "ix_process_events_ts": ("process_events", ["ts"]),
        "ix_cost_ledger_ts": ("cost_ledger", ["ts"]),
        "ix_cost_ledger_run": ("cost_ledger", ["run_id"]),
        "ix_cost_ledger_pam": ("cost_ledger", ["pam_id"]),
        "ix_audit_log_action": ("audit_log", ["action"]),
        "ix_audit_log_run_id": ("audit_log", ["run_id"]),
    }
    for name, (table, cols) in restore.items():
        op.create_index(name, table, cols)

    if mysql:
        fk_targets = {
            "fk_research_results_run_id_runs": ("research_results", "run_id", "runs", "CASCADE"),
            "fk_research_results_company_id_companies": ("research_results", "company_id", "companies", None),
            "fk_research_results_pam_id_pams": ("research_results", "pam_id", "pams", None),
            "fk_notifications_run_id_runs": ("notifications", "run_id", "runs", "CASCADE"),
            "fk_notifications_pam_id_pams": ("notifications", "pam_id", "pams", None),
            "fk_notification_attempts_notification_id_notifications": ("notification_attempts", "notification_id", "notifications", "CASCADE"),
            "fk_dead_letters_notification_id_notifications": ("dead_letters", "notification_id", "notifications", "CASCADE"),
        }
        for name, (table, col, ref, ondelete) in fk_targets.items():
            op.create_foreign_key(name, table, ref, [col], ["id"], ondelete=ondelete)

    for table in PARTITIONED:
        with op.batch_alter_table(table) as b:
            b.drop_column("part_month")
    with op.batch_alter_table("runs") as b:
        b.drop_column("part_month")
