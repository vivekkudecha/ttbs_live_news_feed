"""Engine + Unit of Work.

`unit_of_work()` is the only way services get a session: everything inside the block commits
together or rolls back together (ACID), and side effects that must only happen after a commit
(enqueueing Celery tasks, cache invalidation) are registered with `uow.after_commit(...)`.
"""

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

log = logging.getLogger(__name__)


@lru_cache
def get_engine() -> Engine:
    s = get_settings()
    if s.is_sqlite:
        engine = create_engine(s.database_url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - dev/test only
            dbapi_conn.isolation_level = None  # let SQLAlchemy emit BEGIN itself (see _begin_immediate)
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

        @event.listens_for(engine, "begin")
        def _begin_immediate(conn):  # pragma: no cover - dev/test only
            # Take the write lock up front: many worker threads upgrading read→write locks would
            # otherwise fail with "database is locked". This also serialises writers the way the
            # Postgres advisory locks do (audit hash chain, import commit).
            conn.exec_driver_sql("BEGIN IMMEDIATE")

        return engine
    if s.database_url.startswith("mysql"):
        engine = create_engine(
            s.database_url,
            pool_size=s.db_pool_size,
            max_overflow=s.db_max_overflow,
            pool_pre_ping=True,
            pool_recycle=1800,
            # Postgres semantics: READ COMMITTED (InnoDB defaults to REPEATABLE READ, whose gap locks
            # deadlock the concurrent worker updates), and UTC for CURRENT_TIMESTAMP defaults, which
            # must match the UTC values the app writes whatever the server's time zone is.
            isolation_level="READ COMMITTED",
            connect_args={"init_command": "SET time_zone = '+00:00'"},
        )

        @event.listens_for(engine, "checkin")
        def _release_named_locks(dbapi_conn, _):
            # GET_LOCK is connection-scoped; the Session returns the connection to the pool right
            # after commit/rollback, so releasing here makes advisory_lock() transaction-scoped.
            if dbapi_conn is None:
                return
            try:
                cur = dbapi_conn.cursor()
                cur.execute("DO RELEASE_ALL_LOCKS()")
                cur.close()
            except Exception:  # broken connection: the server drops its locks with it
                log.debug("could not release MySQL named locks on checkin", exc_info=True)

        return engine
    return create_engine(
        s.database_url,
        pool_size=s.db_pool_size,
        max_overflow=s.db_max_overflow,
        pool_pre_ping=True,
        pool_recycle=1800,
    )


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, autoflush=False)


class UnitOfWork:
    def __init__(self, session: Session):
        self.session = session
        self._after_commit: list[Callable[[], None]] = []

    def after_commit(self, fn: Callable[[], None]) -> None:
        self._after_commit.append(fn)

    def _run_after_commit(self) -> None:
        for fn in self._after_commit:
            try:
                fn()
            except Exception:  # a failed side effect must never undo a committed transaction
                log.exception("after-commit hook failed; the maintenance sweeper will recover it")

    @property
    def is_postgres(self) -> bool:
        return self.session.get_bind().dialect.name == "postgresql"

    @property
    def dialect(self) -> str:
        return self.session.get_bind().dialect.name

    @property
    def supports_skip_locked(self) -> bool:
        return self.dialect in ("postgresql", "mysql")  # MySQL 8.0+

    def advisory_lock(self, key: int) -> None:
        """Transaction-scoped advisory lock (serializes e.g. audit hash chain, import commit).

        Postgres: pg_advisory_xact_lock. MySQL: GET_LOCK, released when the connection goes back
        to the pool at the end of the transaction (see get_engine). SQLite: BEGIN IMMEDIATE already
        serializes writers."""
        dialect = self.dialect
        if dialect == "postgresql":
            self.session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})
        elif dialect == "mysql":
            got = self.session.execute(text("SELECT GET_LOCK(:n, :t)"), {"n": f"ttbs:{key}", "t": MYSQL_LOCK_TIMEOUT_S}).scalar()
            if got != 1:
                raise TimeoutError(f"could not acquire MySQL named lock ttbs:{key} within {MYSQL_LOCK_TIMEOUT_S}s")


@contextmanager
def unit_of_work() -> Iterator[UnitOfWork]:
    session = get_sessionmaker()()
    uow = UnitOfWork(session)
    try:
        yield uow
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()
    uow._run_after_commit()


# Advisory lock keys (arbitrary, stable).
LOCK_AUDIT_CHAIN = 7_100_001
LOCK_IMPORT_COMMIT = 7_100_002
MYSQL_LOCK_TIMEOUT_S = 60
