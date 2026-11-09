"""End-to-end: upload dataset (background save) → research → results → notifications → audit."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.core.errors import ProviderError, RetryableProviderError
from app.db.models import Notification, ResearchResult, Run
from app.db.session import unit_of_work
from app.research import providers
from app.services import maintenance
from tests.conftest import GOOD_ROWS, research, upload


def test_preview_validates_and_ignores_region(client):
    rows = GOOD_ROWS + [
        ["Bad Phone Co", "", "", "West", "Rohan Das", "rohan@ttbs.example", "12345"],
        ["No Email Ltd", "", "", "", "Rohan Das", "not-an-email", "9830033003"],
        ["PINE LABS PVT. LTD", "Fintech", "Enterprise", "", "Aarav Mehta", "aarav@ttbs.example", "9810011001"],
        ["", "", "", "", "", "", ""],  # blank row skipped
    ]
    r = upload(client, rows, label="Nov logos")
    assert r.status_code == 201, r.text
    p = client.get(f"/api/v1/imports/{r.json()['id']}").json()  # saved in the background (eager in tests)
    assert p["label"] == "Nov logos" and p["displayLabel"].startswith("Nov logos · ")
    assert p["status"] == "completed" and p["progress"] == 100
    assert p["rowsTotal"] == 6 and p["errorRows"] == 2 and p["validRows"] == 3 and p["saved"] == 3 and p["companies"] == 3
    assert p["newCompanies"] == 3 and p["newPams"] == 2
    assert p["duplicatesMerged"] == 1
    fields = {(i["field"], i["severity"]) for i in p["issues"]}
    assert ("PAM WhatsApp", "error") in fields and ("PAM Email", "error") in fields
    grid = client.get(f"/api/v1/imports/{p['id']}/rows?pageSize=50").json()
    assert {row["pamWhatsapp"] for row in grid["rows"]} == {"+919810011001", "+919845022002"}
    assert all("region" not in row for row in grid["rows"])


def test_upload_errors_use_envelope(client):
    r = client.post("/api/v1/imports", files={"file": ("x.pdf", b"%PDF", "application/pdf")}, data={"label": "x"})
    assert r.status_code == 415
    body = r.json()["error"]
    assert body["code"] == "unsupported_media_type" and body["request_id"]

    r = upload(client, headers=["Company", "PAM Name"])
    assert r.status_code == 422 and "PAM Email" in r.json()["error"]["message"]


def test_commit_schedule_now_runs_full_pipeline(client):
    imp = upload(client).json()
    r = research(client, imp["id"], ["email", "whatsapp"])
    assert r.status_code == 201, r.text
    run_id = r.json()["id"]

    run = client.get(f"/api/v1/runs/{run_id}").json()
    assert run["status"] == "completed"
    assert run["companies"] == 3 and run["done"] == 3 and run["withSignal"] == 3
    assert run["notifications"]["sent"] == 4  # 2 PAMs × email + WhatsApp

    res = client.get(f"/api/v1/runs/{run_id}/results").json()
    assert res["total"] == 3 and res["counts"] == {"signal": 3}
    assert all(x["keySignals"] and x["category"] and x["sources"] for x in res["rows"])

    # A saved dataset cannot be "resumed" again.
    assert client.post(f"/api/v1/imports/{imp['id']}/resume").status_code == 409

    actions = [a["action"] for a in client.get("/api/v1/audit?pageSize=200").json()["rows"]]
    for expected in ("dataset.upload", "dataset.saved", "run.queue", "run.start", "run.finish", "notify.queue", "notify.sent"):
        assert expected in actions
    assert client.get("/api/v1/audit/verify").json()["ok"] is True


def test_second_run_uses_result_cache(client):
    imp = upload(client).json()
    research(client, imp["id"])
    run2 = research(client, imp["id"], []).json()  # re-run the same upload
    run2 = client.get(f"/api/v1/runs/{run2['id']}").json()
    assert run2["status"] == "completed" and run2["cacheHits"] == 3 and run2["cost"] == 0


def test_transient_errors_are_retried_then_succeed(client, monkeypatch):
    calls = {"n": 0}
    real = providers.FakeProvider.research

    def flaky(self, company, ws, we, prompt=None):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RetryableProviderError("429 from provider", retry_after=0)
        return real(self, company, ws, we)

    monkeypatch.setattr(providers.FakeProvider, "research", flaky)
    imp = upload(client, GOOD_ROWS[:1]).json()
    run_id = research(client, imp["id"], []).json()["id"]
    with unit_of_work() as uow:
        res = uow.session.scalars(select(ResearchResult).where(ResearchResult.run_id == int(run_id))).one()
        assert res.status == "signal" and res.attempts == 3


def test_permanent_error_fails_company_and_run_is_partial(client, monkeypatch):
    real = providers.FakeProvider.research

    def picky(self, company, ws, we, prompt=None):
        if company.startswith("Havells"):
            raise ProviderError("HTTP 400 bad request")
        return real(self, company, ws, we)

    monkeypatch.setattr(providers.FakeProvider, "research", picky)
    imp = upload(client).json()
    run_id = research(client, imp["id"], []).json()["id"]
    run = client.get(f"/api/v1/runs/{run_id}").json()
    assert run["status"] == "partial" and run["failed"] == 1

    # Retry the failed company once the provider recovers.
    monkeypatch.setattr(providers.FakeProvider, "research", real)
    assert client.post(f"/api/v1/runs/{run_id}/retry-failed").json() == {"requeued": 1}
    run = client.get(f"/api/v1/runs/{run_id}").json()
    assert run["status"] == "completed" and run["failed"] == 0 and run["done"] == 3


def test_retries_give_up_after_max(client, monkeypatch):
    monkeypatch.setattr(providers.FakeProvider, "research", lambda *a: (_ for _ in ()).throw(RetryableProviderError("down")))
    imp = upload(client, GOOD_ROWS[:1]).json()
    run_id = research(client, imp["id"], []).json()["id"]
    run = client.get(f"/api/v1/runs/{run_id}").json()
    assert run["status"] == "failed"
    res = client.get(f"/api/v1/runs/{run_id}/results").json()["rows"][0]
    assert res["attempts"] == 6 and "gave up" in res["error"]


def test_scheduled_for_later_then_dispatcher_starts_it(client):
    imp = upload(client).json()
    at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    run = research(client, imp["id"], runAt=at).json()
    assert run["status"] == "scheduled"
    assert maintenance.promote_scheduled_runs() == []  # not due yet

    with unit_of_work() as uow:
        uow.session.get(Run, int(run["id"])).scheduled_for = datetime.now(UTC) - timedelta(seconds=1)
    assert maintenance.promote_scheduled_runs() == [int(run["id"])]
    assert client.get(f"/api/v1/runs/{run['id']}").json()["status"] == "completed"


def test_recurring_schedules_are_retired(client):
    upload(client)
    assert client.post("/api/v1/schedules", json={"name": "10-day cycle", "intervalDays": 10, "runAtTime": "06:00"}).status_code in (404, 405)
    assert "schedules_fired" not in maintenance.tick()


def test_sweeper_recovers_lost_notifications(client, monkeypatch):
    from app.worker import tasks

    monkeypatch.setattr(tasks.send_notification, "apply_async", lambda *a, **k: None)  # messages "lost"
    imp = upload(client, GOOD_ROWS[:1]).json()
    run_id = research(client, imp["id"], ["email"]).json()["id"]
    with unit_of_work() as uow:
        note = uow.session.scalars(select(Notification).where(Notification.run_id == int(run_id))).one()
        assert note.status == "pending"
        note.next_attempt_at = datetime.now(UTC) - timedelta(minutes=5)
    monkeypatch.undo()
    assert maintenance.recover_stuck()["notifications"] == 1
    with unit_of_work() as uow:
        assert uow.session.scalars(select(Notification)).one().status == "sent"


def test_cache_fails_open_when_redis_down(client, monkeypatch):
    import redis

    from app.core import cache

    class Down:
        def __getattr__(self, _):
            def boom(*a, **k):
                raise redis.ConnectionError("down")
            return boom

    monkeypatch.setattr(cache, "get_redis", lambda: Down())
    from app.research import ratelimit

    monkeypatch.setattr(ratelimit, "get_redis", lambda: Down())
    imp = upload(client, GOOD_ROWS[:1]).json()
    r = research(client, imp["id"], [])
    assert r.status_code == 201
    assert client.get(f"/api/v1/runs/{r.json()["id"]}").json()["status"] == "completed"
    assert client.get("/api/v1/health").json()["redis"].startswith("error")


def test_runs_require_an_upload_and_bad_body(client):
    for body in ({"scopeKey": "region:West"}, {"scopeKey": "all"}, {}):
        r = client.post("/api/v1/runs", json=body)
        assert r.status_code == 422 and r.json()["error"]["code"] == "upload_required", body
    r = client.post("/api/v1/runs", json={"importId": 999})
    assert r.status_code == 422 and r.json()["error"]["code"] == "upload_required"
    r = client.post("/api/v1/runs", json={"importId": 1, "bogus": 1})
    assert r.status_code == 422 and r.json()["error"]["details"][0]["field"] == "bogus"


def test_cors_preflight_allows_frontend(client):
    r = client.options("/api/v1/imports", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token",
    })
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    # Only the headers the SPA sends are allowed; the retired X-Actor identity header is not.
    r = client.options("/api/v1/imports", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-actor",
    })
    assert r.status_code == 400
