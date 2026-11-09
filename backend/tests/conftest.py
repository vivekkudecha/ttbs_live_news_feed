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
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
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


TEST_PASSWORD = "Correct-Horse-9-Battery!"


def make_user(username="tester", *, role="admin", permissions=None, password=TEST_PASSWORD, must_change=False, name=None):
    """Create a user directly in the database (bypassing the admin API)."""
    from app.core.timeutil import utcnow
    from app.db.models import User
    from app.db.session import unit_of_work
    from app.services import passwords

    with unit_of_work() as uow:
        u = User(username=username, name=name or username.title(), role=role, permissions=permissions or {},
                 password_hash=passwords.hash_password(password), password_changed_at=utcnow(),
                 must_change_password=must_change, active=True, failed_login_count=0, created_by="test")
        uow.session.add(u)
        uow.session.flush()
        return u.id


def sign_in(c, username="tester", password=TEST_PASSWORD):
    """Sign in on a TestClient: the session cookie is kept by the client, the CSRF token is set as
    a default header (as the SPA does). Returns the response."""
    r = c.post("/api/v1/auth/login", json={"username": username, "password": password})
    if r.status_code == 200:
        c.headers["X-CSRF-Token"] = r.json()["csrfToken"]
    return r


def anon_client():
    """A client with no session. HTTPS base URL, so the Secure session cookie is sent back."""
    from app.main import create_app

    return TestClient(create_app(), base_url="https://testserver", raise_server_exceptions=False)


@pytest.fixture
def client():
    """Signed in as admin "tester"."""
    make_user("tester")
    with anon_client() as c:
        assert sign_in(c).status_code == 200
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


def upload(client, rows=GOOD_ROWS, name="mapping.xlsx", headers=HEADERS, label="mapping"):
    """Upload a dataset under a name (required). Celery is eager in tests, so it is fully saved when this returns."""
    data = {"label": label} if label else None
    return client.post("/api/v1/imports", files={"file": (name, xlsx(rows, headers), "application/octet-stream")}, data=data)


def research(client, dataset_id, channels=("email", "whatsapp"), **extra):
    """Start research on a dataset (what the "Research now" step in the upload dialog does)."""
    return client.post("/api/v1/runs", json={"scopeKey": f"import:{dataset_id}", "channels": list(channels), **extra})
