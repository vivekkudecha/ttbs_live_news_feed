"""Monthly partitioning (part_month on every high-volume row), the audit chain across months, soft
delete into `_deleted` archives, the company signal roll-up, and the centralized (shared) cache.

Tests run on SQLite, where the tables are not partitioned: these check the keys, routing and
behaviour the MySQL partitions rely on. The MySQL DDL itself (partition creation/drop, pruning) is
exercised against a real MySQL by the 0011 migration round trip (see deploy/README.md)."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.core import cache
from app.core.errors import ValidationFailed
from app.core.timeutil import utcnow
from app.db import partitions
from app.db.models import (
    ARCHIVE_TABLES,
    RES_SIGNAL,
    RUN_QUEUED,
    AuditChainHead,
    AuditLog,
    CompanySignalSummary,
    CostEntry,
    DatasetCompany,
    Notification,
    NotificationAttempt,
    ProcessEvent,
    ResearchResult,
    Run,
)
from app.db.session import unit_of_work
from app.services import audit, soft_delete
from tests.conftest import anon_client, make_user, research, sign_in, upload

# --- Month keys ---------------------------------------------------------------------------------------


def test_month_keys_and_partition_names():
    # 20:00 UTC on 31 Oct is 01:30 on 1 Nov in the business time zone (Asia/Kolkata).
    assert partitions.month_key(datetime(2026, 10, 31, 20, 0, tzinfo=UTC)) == 202611
    assert partitions.month_key(datetime(2026, 10, 31, 18, 0)) == 202610  # naive = UTC
    assert partitions.add_months(202612, 1) == 202701 and partitions.add_months(202601, -1) == 202512
    assert partitions.partition_name(202611, "job") == "nov__2026__job"
    assert partitions.partition_name(202701, "finops_deleted") == "jan__2027__finops_deleted"
    assert partitions.parse_partition("nov__2026__job") == 202611 and partitions.parse_partition("p_future") is None


def test_ddl_helpers_are_noops_off_mysql():
    assert partitions.ensure_months(202611) == [] and partitions.drop_empty() == [] and partitions.overview() == []


def test_a_run_month_is_dropped_only_when_the_whole_group_is_quiet(client):
    """The drop guard: an old month of the run-owned tables may go only when no job, notification,
    retry attempt or dead letter is left in it and no run of that month is active. A lone retry
    attempt keeps the month, because a resend of its notification could still write into it."""
    from app.db.session import get_engine

    ds = upload(client).json()
    rid = int(research(client, ds["id"]).json()["id"])
    with unit_of_work() as uow:
        month = uow.session.get(Run, rid).part_month

    def quiet() -> bool:
        with get_engine().connect() as conn:
            return partitions.month_is_quiet(conn, month)

    assert not quiet()
    with unit_of_work() as uow:
        soft_delete.archive(uow, ResearchResult, ResearchResult.run_id == rid, actor="t")
        soft_delete.archive(uow, Notification, Notification.run_id == rid, actor="t")
    assert not quiet()  # retry attempts of the run's notifications are still there
    with unit_of_work() as uow:
        soft_delete.archive(uow, NotificationAttempt, NotificationAttempt.part_month == month, actor="t")
    assert quiet()
    with unit_of_work() as uow:  # an active run of that month keeps it too (its jobs are still to come)
        uow.session.get(Run, rid).status = RUN_QUEUED
    assert not quiet()
    with get_engine().connect() as conn:  # time-series tables are judged on their own
        assert not partitions.month_is_quiet(conn, partitions.month_key(None), ("audit_log",))


# --- part_month on every row -------------------------------------------------------------------------


def test_every_row_of_a_run_is_keyed_to_its_month(client):
    ds = upload(client).json()
    run = research(client, ds["id"]).json()
    rid = int(run["id"])
    with unit_of_work() as uow:
        s = uow.session
        r = s.get(Run, rid)
        assert r.part_month == partitions.month_key(r.scheduled_for)
        # Run-owned rows: the run's (scheduled) month.
        for model in (ResearchResult, Notification):
            months = set(s.scalars(select(model.part_month).where(model.run_id == rid)))
            assert months == {r.part_month}, model
        note_ids = list(s.scalars(select(Notification.id).where(Notification.run_id == rid)))
        assert set(s.scalars(select(NotificationAttempt.part_month).where(NotificationAttempt.notification_id.in_(note_ids)))) == {r.part_month}
        # Time-series rows: their own timestamp's month.
        for model in (ProcessEvent, CostEntry, AuditLog):
            rows = s.execute(select(model.ts, model.part_month).where(model.run_id == rid)).all()
            assert rows and all(pm == partitions.month_key(ts) for ts, pm in rows), model


def test_jobs_of_a_run_scheduled_next_month_live_in_that_month(client):
    """A run scheduled for a later month keeps all its jobs in the scheduled month, even though
    they are written now (the month comes from the schedule, not from the insert time)."""
    ds = upload(client).json()
    later = utcnow() + timedelta(days=40)
    run = research(client, ds["id"], [], runAt=later.isoformat()).json()
    rid = int(run["id"])
    with unit_of_work() as uow:
        r = uow.session.get(Run, rid)
        assert r.part_month == partitions.month_key(later) != partitions.month_key(utcnow())
        r.status, r.queued_at = RUN_QUEUED, utcnow()  # start it now (as if the time had come)
    from app.worker.tasks import start_run

    start_run(rid)
    with unit_of_work() as uow:
        assert set(uow.session.scalars(select(ResearchResult.part_month).where(ResearchResult.run_id == rid))) == {partitions.month_key(later)}


# --- Audit chain across months -----------------------------------------------------------------------


def test_audit_chain_head_continues_one_chain(client, monkeypatch):
    upload(client)
    with unit_of_work() as uow:
        head = uow.session.get(AuditChainHead, 1)
        last = uow.session.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).one()
        assert (head.last_id, head.last_hash) == (last.id, last.hash)
    # Rows written in three different months (three partitions on MySQL) are one chain.
    real_now = utcnow()
    for months_ago in (2, 1):
        monkeypatch.setattr(audit, "utcnow", lambda m=months_ago: real_now - timedelta(days=31 * m))
        with unit_of_work() as uow:
            a = audit.record(uow, "test.month", "x", months_ago, actor="t")
            assert a.part_month == partitions.month_key(real_now - timedelta(days=31 * months_ago))
    monkeypatch.setattr(audit, "utcnow", lambda: real_now)
    # The head pointer is derived: losing it just rebuilds it from the newest row.
    with unit_of_work() as uow:
        uow.session.delete(uow.session.get(AuditChainHead, 1))
    with unit_of_work() as uow:
        audit.record(uow, "test.after_head_rebuild", "x", 1, actor="t")
    with unit_of_work() as uow:
        assert len(set(uow.session.scalars(select(AuditLog.part_month)))) == 3
    assert client.get("/api/v1/audit/verify").json()["ok"] is True


# --- Soft delete -------------------------------------------------------------------------------------


def test_dataset_row_delete_is_archived_not_hard_deleted(client):
    ds = upload(client).json()
    with unit_of_work() as uow:
        cid = uow.session.scalars(select(DatasetCompany.company_id).where(DatasetCompany.import_id == int(ds["id"]))).first()
    from app.services import imports

    with unit_of_work() as uow:
        assert imports.delete_rows(uow, int(ds["id"]), [cid], "tester")["removed"] == 1
    arch = ARCHIVE_TABLES["dataset_companies"]
    with unit_of_work() as uow:
        assert uow.session.scalar(select(func.count()).select_from(DatasetCompany).where(DatasetCompany.company_id == cid)) == 0
        kept = uow.session.execute(select(arch).where(arch.c.company_id == cid)).mappings().one()
        assert kept["deleted_by"] == "tester" and kept["import_id"] == int(ds["id"]) and kept["deleted_at"] is not None


def test_archiving_results_moves_them_and_refreshes_the_signal_rollup(client):
    ds = upload(client).json()
    rid = int(research(client, ds["id"], []).json()["id"])
    with unit_of_work() as uow:
        cid = uow.session.scalars(select(ResearchResult.company_id).where(ResearchResult.run_id == rid,
                                                                          ResearchResult.status == RES_SIGNAL)).first()
        assert uow.session.get(CompanySignalSummary, cid).signals == 1
        run = uow.session.get(Run, rid)
        moved = soft_delete.archive(uow, ResearchResult, ResearchResult.run_id == rid, ResearchResult.part_month == run.part_month,
                                    actor="tester", reason="test")
        assert moved == 3
    with unit_of_work() as uow:
        assert uow.session.scalar(select(func.count(ResearchResult.id)).where(ResearchResult.run_id == rid)) == 0
        arch = ARCHIVE_TABLES["research_results"]
        assert uow.session.scalar(select(func.count()).select_from(arch).where(arch.c.run_id == rid)) == 3
        assert uow.session.get(CompanySignalSummary, cid).signals == 0
        assert uow.session.scalars(select(AuditLog.action).where(AuditLog.action == "research_results.archive")).first()


def test_audit_rows_are_never_archived():
    with unit_of_work() as uow, pytest.raises(ValidationFailed):
        soft_delete.archive(uow, AuditLog, AuditLog.id > 0, actor="x")
    with unit_of_work() as uow, pytest.raises(ValidationFailed):
        soft_delete.archive(uow, ResearchResult, actor="x")  # no condition: never a whole table


# --- Signal roll-up ----------------------------------------------------------------------------------


def test_signal_rollup_matches_the_results(client):
    ds = upload(client).json()
    for _ in range(2):
        research(client, ds["id"], [])
    with unit_of_work() as uow:
        expected = dict(uow.session.execute(select(ResearchResult.company_id, func.count()).where(ResearchResult.status == RES_SIGNAL)
                                            .group_by(ResearchResult.company_id)).all())
        got = dict(uow.session.execute(select(CompanySignalSummary.company_id, CompanySignalSummary.signals)).all())
    assert expected and got == expected
    page = client.post("/api/v1/companies/query", json={"sort": {"id": "signals", "desc": True}}).json()
    assert page["rows"][0]["signals"] == 2 and page["rows"][0]["lastSignal"]


# --- Centralized cache --------------------------------------------------------------------------------


def test_company_table_is_one_shared_dataset_for_every_user(client, monkeypatch, env):
    upload(client)
    from app.api import read_models as rm

    calls = []
    real = rm.company_base
    monkeypatch.setattr(rm, "company_base", lambda uow: calls.append(1) or real(uow))

    make_user("member1", role="member", permissions={"companies": "view"})
    with anon_client() as other:
        assert sign_in(other, "member1").status_code == 200
        a = client.post("/api/v1/companies/query", json={"search": "pine"}).json()
        b = other.post("/api/v1/companies/query", json={"segments": ["Enterprise"], "sort": {"id": "name", "desc": True}}).json()
        c = other.post("/api/v1/companies/query", json={}).json()
    assert len(calls) == 1  # computed once, served to both users with their own filters
    assert [r["name"] for r in a["rows"]] == ["Pine Labs Pvt Ltd"]
    assert {r["segment"] for r in b["rows"]} == {"Enterprise"} and c["total"] == 3
    keys = env.keys("*")
    assert keys and not any("tester" in k or "member1" in k for k in keys)  # no user in any cache key


def test_cache_invalidates_on_bump_and_fails_open(monkeypatch):
    n = {"v": 0}

    def load():
        n["v"] += 1
        return {"v": n["v"]}

    assert cache.shared("t", "k", 60, load) == {"v": 1}
    assert cache.shared("t", "k", 60, load) == {"v": 1}  # L1/L2 hit
    cache.bump("t")
    assert cache.shared("t", "k", 60, load) == {"v": 2}  # new namespace version, new value

    import redis

    def down():
        raise redis.ConnectionError("down")

    class Broken:
        def __getattr__(self, _):
            return lambda *a, **k: down()

    monkeypatch.setattr(cache, "get_redis", lambda: Broken())
    assert cache.shared("t", "k", 60, load) == {"v": 3}  # Redis down: computed, never an error


def test_single_flight_waits_for_the_computing_caller(monkeypatch, env):
    v = cache.version("t2")
    full = f"t2:v{v}:k"
    env.set(cache._k(f"lock:{full}"), "1", ex=10)  # someone else is computing
    monkeypatch.setattr(cache, "WAIT_S", 0.3)
    computed = []
    assert cache.shared("t2", "k", 60, lambda: computed.append(1) or {"ok": 1}) == {"ok": 1}
    assert computed == [1]  # waited, then computed itself rather than failing


def test_large_values_are_compressed_in_redis(env):
    big = {"rows": ["x" * 100] * 1000}
    cache.set_json("big", big, 60)
    raw = env.get(cache._k("big"))
    assert raw.startswith("z:") and len(raw) < 10_000 and cache.get_json("big") == big


# --- Bounded reads -------------------------------------------------------------------------------------


def test_list_counts_are_capped(client, monkeypatch):
    upload(client)
    from app.services import telemetry

    monkeypatch.setattr(telemetry, "COUNT_CAP", 2)
    page = client.get("/api/v1/audit").json()
    assert page["total"] == 2 and page["totalCapped"] is True
    ev = client.get("/api/v1/telemetry/events").json()  # no window given: defaults to the last 7 days
    assert ev["total"] <= 2 and "totalCapped" in ev
