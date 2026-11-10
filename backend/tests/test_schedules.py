"""Recurring research schedules: the repeat-rule maths, the API, and the dispatcher firing them."""

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select

from app.db.models import RUN_RUNNING, Notification, Run, Schedule
from app.db.session import unit_of_work
from app.services import finops, maintenance
from app.services.schedules import Rule
from tests.conftest import anon_client, make_user, sign_in, upload

IST = "Asia/Kolkata"


def at(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=UTC)


# --- Repeat rule ----------------------------------------------------------------------------------


def test_every_n_days_starts_at_the_next_local_time_and_keeps_its_cadence():
    rule = Rule("interval", 10, run_at_time="06:00", timezone=IST)
    # 06:00 IST = 00:30 UTC. At 00:00 UTC it is still due today; at 01:00 UTC, tomorrow.
    assert rule.next_after(at("2026-11-10T00:00:00")) == at("2026-11-10T00:30:00")
    assert rule.next_after(at("2026-11-10T01:00:00")) == at("2026-11-11T00:30:00")
    # After firing on the 10th: the 20th, even when the dispatcher runs a little late.
    assert rule.next_after(at("2026-11-10T00:31:00"), prev=at("2026-11-10T00:30:00")) == at("2026-11-20T00:30:00")


def test_missed_times_are_skipped_not_replayed():
    rule = Rule("interval", 1, run_at_time="06:00", timezone=IST)
    # Down for three days: the next fire is the next future one, not three catch-up runs.
    assert rule.next_after(at("2026-11-13T05:00:00"), prev=at("2026-11-10T00:30:00")) == at("2026-11-14T00:30:00")


def test_weekly_picks_the_next_chosen_day():
    rule = Rule("weekly", weekdays=(0, 3), run_at_time="09:30", timezone=IST)  # Mon, Thu
    # Tue 10 Nov 2026 → Thu 12 Nov, then Mon 16 Nov.
    first = rule.next_after(at("2026-11-10T08:00:00"))
    assert first == at("2026-11-12T04:00:00")
    assert rule.next_after(first, prev=first) == at("2026-11-16T04:00:00")
    assert rule.describe() == "Weekly on Mon, Thu at 09:30"


def test_monthly_day_31_falls_on_the_last_day_of_short_months():
    rule = Rule("monthly", month_day=31, run_at_time="06:00", timezone=IST)
    times = rule.upcoming(3, after=at("2027-01-31T01:00:00"))
    assert [t.date() for t in times] == [date(2027, 2, 28), date(2027, 3, 31), date(2027, 4, 30)]


def test_end_date_stops_the_schedule():
    rule = Rule("interval", 10, run_at_time="06:00", timezone=IST, ends_on=date(2026, 11, 15))
    assert rule.upcoming(5, after=at("2026-11-10T00:00:00")) == [at("2026-11-10T00:30:00")]


# --- API + dispatcher ------------------------------------------------------------------------------


def make(client, dataset_id=None, **extra):
    body = {"name": "Key accounts", "frequency": "interval", "intervalDays": 10, "runAtTime": "06:00"}
    body |= {"target": "upload", "importId": int(dataset_id)} if dataset_id else {"target": "latest"}
    return client.post("/api/v1/schedules", json=body | extra)


def make_due(schedule_id):
    with unit_of_work() as uow:
        uow.session.get(Schedule, int(schedule_id)).next_run_at = datetime.now(UTC) - timedelta(seconds=1)


def runs_of(schedule_id) -> list[Run]:
    with unit_of_work() as uow:
        return list(uow.session.scalars(select(Run).where(Run.schedule_id == int(schedule_id)).order_by(Run.id)))


def test_create_and_fire_a_schedule_for_a_fixed_upload(client):
    imp = upload(client).json()
    r = make(client, imp["id"])
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["summary"] == "Every 10 days at 06:00" and s["target"] == "upload" and s["enabled"]
    assert datetime.fromisoformat(s["nextRunAt"]) > datetime.now(UTC)
    assert maintenance.tick()["schedules_fired"] == {"started": 0, "skipped": 0, "failed": 0}  # not due yet

    make_due(s["id"])
    assert maintenance.tick()["schedules_fired"]["started"] == 1
    [run] = runs_of(s["id"])
    assert run.trigger == "scheduled" and run.import_id == int(imp["id"]) and run.label.startswith("Key accounts · ")
    assert run.status == "completed"  # Celery is eager in tests

    after = client.get("/api/v1/schedules").json()["rows"][0]
    assert after["lastOutcome"] == "started" and after["lastRun"] == {"id": str(run.id), "status": "completed"}
    assert datetime.fromisoformat(after["nextRunAt"]) > datetime.now(UTC) + timedelta(days=9)


def test_latest_target_researches_the_newest_upload(client):
    upload(client, label="october")
    newest = upload(client, rows=[["Tata Steel", "Steel", "Enterprise", "", "Priya Nair", "priya@ttbs.example", "9845022002"]], label="november").json()
    s = make(client).json()
    assert s["targetLabel"] == "Latest upload"
    make_due(s["id"])
    maintenance.tick()
    [run] = runs_of(s["id"])
    assert run.import_id == int(newest["id"]) and run.total == 1


def test_never_overlaps_a_run_that_is_still_going(client):
    s = make(client, upload(client).json()["id"]).json()
    make_due(s["id"])
    maintenance.tick()
    [first] = runs_of(s["id"])
    with unit_of_work() as uow:
        uow.session.get(Run, first.id).status = RUN_RUNNING
    make_due(s["id"])
    assert maintenance.tick()["schedules_fired"]["skipped"] == 1
    assert len(runs_of(s["id"])) == 1
    row = client.get("/api/v1/schedules").json()["rows"][0]
    assert row["lastOutcome"] == "skipped" and f"#{first.id}" in row["lastError"]


def test_research_only_sends_no_digests(client):
    s = make(client, upload(client).json()["id"], channels=[]).json()
    assert s["channels"] == []
    make_due(s["id"])
    maintenance.tick()
    [run] = runs_of(s["id"])
    with unit_of_work() as uow:
        assert uow.session.scalar(select(func.count(Notification.id)).where(Notification.run_id == run.id)) == 0


def test_a_firing_that_cannot_start_is_recorded_and_keeps_the_cadence(client, monkeypatch):
    s = make(client, upload(client).json()["id"]).json()

    def full(*_a, **_k):
        from app.core.errors import ValidationFailed

        raise ValidationFailed("The monthly research budget has been reached", code="budget_exceeded")

    monkeypatch.setattr(finops, "check_budget", full)
    make_due(s["id"])
    assert maintenance.tick()["schedules_fired"]["failed"] == 1
    assert runs_of(s["id"]) == []
    row = client.get("/api/v1/schedules").json()["rows"][0]
    assert row["lastOutcome"] == "failed" and "budget" in row["lastError"] and row["enabled"]
    assert datetime.fromisoformat(row["nextRunAt"]) > datetime.now(UTC)


def test_pause_resume_edit_and_run_now(client):
    imp = upload(client).json()
    s = make(client, imp["id"]).json()
    assert client.patch(f"/api/v1/schedules/{s['id']}", json={"enabled": False}).json()["nextRunAt"] is None
    make_due(s["id"])
    assert maintenance.tick()["schedules_fired"]["started"] == 0  # paused

    edited = client.patch(f"/api/v1/schedules/{s['id']}", json={"enabled": True, "frequency": "weekly", "weekdays": [4, 0, 4]}).json()
    assert edited["weekdays"] == [0, 4] and edited["summary"] == "Weekly on Mon, Fri at 06:00"
    assert datetime.fromisoformat(edited["nextRunAt"]) > datetime.now(UTC)

    run = client.post(f"/api/v1/schedules/{s['id']}/run")
    assert run.status_code == 201 and run.json()["trigger"] == "scheduled"
    assert client.get("/api/v1/schedules").json()["rows"][0]["nextRunAt"] == edited["nextRunAt"]  # cadence unchanged


def test_delete_archives_the_schedule_and_keeps_its_runs(client):
    s = make(client, upload(client).json()["id"]).json()
    run_id = client.post(f"/api/v1/schedules/{s['id']}/run").json()["id"]
    assert client.delete(f"/api/v1/schedules/{s['id']}").status_code == 204
    assert client.get("/api/v1/schedules").json()["rows"] == []
    kept = client.get(f"/api/v1/runs/{run_id}").json()
    assert kept["trigger"] == "scheduled" and kept["scheduleId"] is None
    assert client.delete(f"/api/v1/schedules/{s['id']}").status_code == 404


def test_validation_and_preview(client):
    imp = upload(client).json()
    assert make(client, imp["id"], frequency="weekly").status_code == 422  # no days picked
    assert make(client, imp["id"], runAtTime="25:00").status_code == 422
    assert make(client, imp["id"], endsOn="2020-01-01").status_code == 422
    assert client.post("/api/v1/schedules", json={"name": "x", "target": "upload"}).status_code == 422  # which upload?
    p = client.post("/api/v1/schedules/preview", json={"frequency": "monthly", "monthDay": 1, "runAtTime": "07:15"}).json()
    assert p["summary"] == "Monthly on day 1 at 07:15" and len(p["upcoming"]) == 5


def test_viewers_can_see_but_not_change_schedules(client):
    make_user("vera", role="member", permissions={"runs": "view"})
    with anon_client() as c:
        assert sign_in(c, "vera").status_code == 200
        assert c.get("/api/v1/schedules").status_code == 200
        assert c.post("/api/v1/schedules/preview", json={}).status_code == 200
        assert c.post("/api/v1/schedules", json={"name": "x", "target": "latest"}).status_code == 403


def test_accepts_the_payloads_the_web_app_sends(client):
    """The form always sends every rule field (unused ones too) and nulls for "no end date"."""
    imp = upload(client).json()
    rule = {"frequency": "interval", "intervalDays": 10, "weekdays": [0], "monthDay": 1, "runAtTime": "06:00", "endsOn": None}
    assert client.post("/api/v1/schedules/preview", json=rule).status_code == 200
    created = client.post("/api/v1/schedules", json=rule | {"name": "Cycle", "target": "upload", "importId": int(imp["id"]), "channels": ["email"]})
    assert created.status_code == 201, created.text
    edit = rule | {"name": "Cycle", "target": "latest", "channels": [], "frequency": "monthly", "monthDay": 31}
    patched = client.patch(f"/api/v1/schedules/{created.json()['id']}", json=edit)
    assert patched.status_code == 200, patched.text
    assert patched.json()["target"] == "latest" and patched.json()["summary"] == "Monthly on the last day at 06:00"


def test_each_schedule_lists_its_own_runs(client):
    """The Research page: schedules with their run counts; a schedule page lists only its runs."""
    from tests.conftest import research

    imp = upload(client).json()
    a = make(client, imp["id"], name="A").json()
    b = make(client, imp["id"], name="B").json()
    run_a = client.post(f"/api/v1/schedules/{a['id']}/run").json()["id"]
    client.post(f"/api/v1/schedules/{b['id']}/run")
    client.post(f"/api/v1/schedules/{b['id']}/run")
    research(client, imp["id"], [])  # a run no schedule started

    listing = client.get("/api/v1/schedules").json()
    assert {s["name"]: s["runs"] for s in listing["rows"]} == {"A": 1, "B": 2} and listing["unscheduled"] == 1
    assert client.get(f"/api/v1/schedules/{a['id']}").json()["runs"] == 1
    assert client.get("/api/v1/schedules/999").status_code == 404

    only_a = client.get("/api/v1/runs", params={"schedule": a["id"]}).json()
    assert [r["id"] for r in only_a["rows"]] == [run_a] and only_a["groups"]["all"] == 1
    assert client.get("/api/v1/runs", params={"schedule": b["id"]}).json()["total"] == 2
    assert client.get("/api/v1/runs", params={"schedule": "none"}).json()["total"] == 1
    assert client.get("/api/v1/runs").json()["total"] == 4


def test_schedule_dashboard_stats(client):
    from tests.conftest import research

    imp = upload(client).json()
    s = make(client, imp["id"], channels=[]).json()
    for _ in range(2):
        client.post(f"/api/v1/schedules/{s['id']}/run")
    research(client, imp["id"], [])

    st = client.get(f"/api/v1/schedules/{s['id']}/stats").json()
    assert st["totals"]["runs"] == 2 and st["totals"]["logos"] == 6 and st["byStatus"] == {"completed": 2}
    assert [r["logos"] for r in st["recent"]] == [3, 3] and int(st["recent"][0]["id"]) < int(st["recent"][1]["id"])
    assert client.get("/api/v1/schedules/unscheduled/stats").json()["totals"]["runs"] == 1
    assert client.get("/api/v1/schedules/999/stats").status_code == 404
    assert client.get("/api/v1/schedules/abc/stats").status_code == 422
    assert len(client.get(f"/api/v1/schedules/{s['id']}").json()["upcoming"]) == 5
