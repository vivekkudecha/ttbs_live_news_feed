"""Test harness: fresh SQLite DB per test, fakeredis for cache + rate limiter, Celery eager,
fake LLM provider. Nothing touches the shared local Redis/Postgres."""

import io
import os

os.environ.update(
    ENV="test",
    TASK_ALWAYS_EAGER="true",
    LLM_PROVIDER="fake",
    FAKE_LATENCY_MS="0",
    FAKE_FAILURE_RATE="0",
    FAKE_SIGNAL_RATE="1.0",
    BROKER_URL="redis://127.0.0.1:1/0",  # unreachable on purpose
    REDIS_CACHE_URL="redis://127.0.0.1:1/0",
    LOG_LEVEL="WARNING",
    SECRETS_KEY="dGVzdC1vbmx5LXNlY3JldHMta2V5LTMyLWJ5dGVzISE=",  # 32 bytes, tests only
)

import fakeredis  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import Workbook  # noqa: E402

from app.core import cache  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.db import session as db_session  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.research import providers, ratelimit  # noqa: E402

HEADERS = ["Company", "Industry", "Segment", "Region", "PAM Name", "PAM Email", "PAM WhatsApp"]


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    for fn in (get_settings, db_session.get_engine, db_session.get_sessionmaker):
        fn.cache_clear()
    providers.clear_cache()
    from app.db import models  # noqa: F401

    Base.metadata.create_all(db_session.get_engine())
    fake = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(cache, "get_redis", lambda: fake)
    monkeypatch.setattr(ratelimit, "get_redis", lambda: fake)
    yield fake
    db_session.get_engine().dispose()


@pytest.fixture
def client():
    from app.main import create_app

    with TestClient(create_app(), raise_server_exceptions=False) as c:
        c.headers["X-Actor"] = "tester"
        yield c


def xlsx(rows: list[list], headers: list[str] = HEADERS) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


GOOD_ROWS = [
    ["Pine Labs Pvt Ltd", "Fintech", "Enterprise", "North", "Aarav Mehta", "aarav@ttbs.example", "98100 11001"],
    ["Zomato Hyperpure", "Food", "Mid-market", "South", "Aarav Mehta", "aarav@ttbs.example", "+91 98100 11001"],
    ["Havells India", "Electricals", "enterprise", "", "Priya Nair", "priya@ttbs.example", "9845022002"],
]


def upload(client, rows=GOOD_ROWS, name="mapping.xlsx", headers=HEADERS):
    return client.post("/api/v1/imports", files={"file": (name, xlsx(rows, headers), "application/octet-stream")})
