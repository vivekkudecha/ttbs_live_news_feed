"""Uploaded datasets: background save in resumable chunks, crash recovery, row edit/delete, grid."""

from datetime import timedelta

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.db.models import Company, DatasetCompany, ImportBatch
from app.db.session import unit_of_work
from app.services import imports, maintenance
from app.worker import tasks
from tests.conftest import GOOD_ROWS, upload

MORE = [["Tata Elxsi", "IT", "Enterprise", "", "Rohan Das", "rohan@ttbs.example", "9830033003"]]


def _small_chunks(monkeypatch, n=1):
    monkeypatch.setenv("IMPORT_CHUNK_SIZE", str(n))
    get_settings.cache_clear()


def _members(import_id):
    with unit_of_work() as uow:
        return uow.session.scalar(select(func.count(DatasetCompany.id)).where(DatasetCompany.import_id == import_id))


def test_crashed_worker_resumes_from_last_saved_chunk(client, monkeypatch):
    _small_chunks(monkeypatch)
    monkeypatch.setattr(tasks.process_import, "apply_async", lambda *a, **k: None)  # worker never picks it up
    ds = upload(client).json()
    assert ds["status"] == "queued" and ds["saved"] == 0

    # A worker saved 1 chunk, then died (its lease/heartbeat went stale).
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, int(ds["id"]))
        chunk = b.rows[:1]
        imports._apply(uow, b, chunk)
        b.rows_done, b.status, b.worker_token = 1, "processing", "dead-worker"
        b.heartbeat_at = utcnow() - timedelta(minutes=5)
    monkeypatch.undo()
    _small_chunks(monkeypatch)
    assert client.get(f"/api/v1/imports/{ds['id']}").json()["progress"] == 33

    assert maintenance.recover_stuck()["imports"] == 1  # sweeper resumes it
    after = client.get(f"/api/v1/imports/{ds['id']}").json()
    assert after["status"] == "completed" and after["saved"] == 3 and after["companies"] == 3
    assert _members(int(ds["id"])) == 3  # nothing duplicated by the resume


def test_live_lease_is_not_stolen(client, monkeypatch):
    monkeypatch.setattr(tasks.process_import, "apply_async", lambda *a, **k: None)
    ds = upload(client).json()
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, int(ds["id"]))
        b.status, b.worker_token, b.heartbeat_at = "processing", "busy-worker", utcnow()
    assert imports.process(int(ds["id"])) == "skipped"
    assert maintenance.recover_stuck()["imports"] == 0


def test_failed_chunk_is_retried_then_succeeds(client, monkeypatch):
    _small_chunks(monkeypatch)
    real = imports._apply
    calls = {"n": 0}

    def flaky(uow, b, rows):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("database blip")
        return real(uow, b, rows)

    monkeypatch.setattr(imports, "_apply", flaky)
    ds = client.get(f"/api/v1/imports/{upload(client).json()['id']}").json()
    assert ds["status"] == "completed" and ds["saved"] == 3 and _members(int(ds["id"])) == 3


def test_gives_up_after_max_failures_and_can_be_resumed(client, monkeypatch):
    monkeypatch.setattr(imports, "_apply", lambda *a: (_ for _ in ()).throw(RuntimeError("disk full")))
    ds = client.get(f"/api/v1/imports/{upload(client).json()['id']}").json()
    assert ds["status"] == "failed" and "disk full" in ds["error"] and ds["saved"] == 0
    monkeypatch.undo()
    r = client.post(f"/api/v1/imports/{ds['id']}/resume")
    assert r.status_code == 200
    assert client.get(f"/api/v1/imports/{ds['id']}").json()["status"] == "completed"
    actions = [a["action"] for a in client.get("/api/v1/audit?pageSize=50").json()["rows"]]
    assert {"dataset.failed", "dataset.resume", "dataset.saved"} <= set(actions)


def test_all_invalid_rows_fail_without_saving(client):
    bad = [["Bad Co", "", "", "", "X", "not-an-email", "1"]]
    ds = upload(client, bad).json()
    assert ds["status"] == "failed" and ds["validRows"] == 0 and ds["issues"]
    assert client.post(f"/api/v1/imports/{ds['id']}/resume").status_code == 409


def test_grid_filters_facets_and_sort(client):
    ds = upload(client, label="Q4").json()
    g = client.get(f"/api/v1/imports/{ds['id']}/rows?pageSize=50&sort=company").json()
    assert [r["company"] for r in g["rows"]] == ["Havells India", "Pine Labs Pvt Ltd", "Zomato Hyperpure"]
    assert g["facets"]["segment"] == {"Enterprise": 2, "Mid-market": 1}
    assert {p["name"]: p["count"] for p in g["facets"]["pams"]} == {"Aarav Mehta": 2, "Priya Nair": 1}
    aarav = next(p["id"] for p in g["facets"]["pams"] if p["name"] == "Aarav Mehta")
    assert client.get(f"/api/v1/imports/{ds['id']}/rows?pamId={aarav}").json()["total"] == 2
    assert client.get(f"/api/v1/imports/{ds['id']}/rows?segment=Mid-market").json()["rows"][0]["company"] == "Zomato Hyperpure"
    assert client.get(f"/api/v1/imports/{ds['id']}/rows?q=priya").json()["total"] == 1
    assert client.get(f"/api/v1/imports/{ds['id']}/rows?sort=pam&desc=true").json()["rows"][0]["pamName"] == "Priya Nair"


def test_row_edit_updates_master_data(client):
    ds = upload(client).json()
    rows = client.get(f"/api/v1/imports/{ds['id']}/rows?q=havells").json()["rows"]
    cid = rows[0]["companyId"]

    r = client.patch(f"/api/v1/imports/{ds['id']}/rows/{cid}", json={"company": "Havells India Ltd", "segment": "mid market", "industry": "Electrical"})
    assert r.status_code == 200, r.text
    assert r.json()["company"] == "Havells India Ltd" and r.json()["segment"] == "Mid-market"
    assert client.get(f"/api/v1/companies/{cid}").json()["company"]["name"] == "Havells India Ltd"  # master record

    # Move to a brand-new PAM: created on the fly, ownership history recorded.
    r = client.patch(f"/api/v1/imports/{ds['id']}/rows/{cid}", json={"pamEmail": "neha@ttbs.example", "pamName": "Neha Rao", "pamWhatsapp": "9876543210"})
    assert r.json()["pamName"] == "Neha Rao" and r.json()["pamWhatsapp"] == "+919876543210"
    hist = client.get(f"/api/v1/companies/{cid}").json()["assignments"]
    assert [a["pamName"] for a in hist] == ["Priya Nair", "Neha Rao"] and hist[-1]["reason"] == "manual"

    assert client.patch(f"/api/v1/imports/{ds['id']}/rows/{cid}", json={"pamEmail": "bad"}).status_code == 422
    assert client.patch(f"/api/v1/imports/{ds['id']}/rows/{cid}", json={"segment": "Galactic"}).status_code == 422
    assert client.patch(f"/api/v1/imports/{ds['id']}/rows/{cid}", json={"company": "Zomato Hyperpure"}).status_code == 409
    assert client.patch(f"/api/v1/imports/{ds['id']}/rows/999", json={"industry": "x"}).status_code == 404
    assert "dataset.row.update" in [a["action"] for a in client.get("/api/v1/audit?pageSize=50").json()["rows"]]


def test_delete_rows_stops_tracking_only_when_in_no_other_dataset(client):
    a = upload(client, label="A").json()
    b = upload(client, GOOD_ROWS[:1] + MORE, label="B").json()  # Pine Labs is in both
    rows = {r["company"]: r["companyId"] for r in client.get(f"/api/v1/imports/{a['id']}/rows?pageSize=50").json()["rows"]}
    out = client.post(f"/api/v1/imports/{a['id']}/rows/delete", json={"companyIds": [rows["Pine Labs Pvt Ltd"], rows["Havells India"]]}).json()
    assert out == {"removed": 2, "stoppedTracking": 1}  # Havells only lived in A
    with unit_of_work() as uow:
        active = {c.name: c.active for c in uow.session.scalars(select(Company))}
    assert active["Pine Labs Pvt Ltd"] is True and active["Havells India"] is False
    assert client.get(f"/api/v1/imports/{a['id']}").json()["companies"] == 1
    assert client.get(f"/api/v1/imports/{b['id']}").json()["companies"] == 2


def test_rename_and_scope_options_use_dataset_labels(client):
    ds = upload(client, label="Nov logos").json()
    upload(client, MORE, label="Dec adds")
    r = client.patch(f"/api/v1/imports/{ds['id']}", json={"label": "November logos"})
    assert r.json()["label"] == "November logos"
    opts = client.get("/api/v1/scopes").json()
    assert opts[0] == {"key": "all", "label": "All active companies", "count": 4}
    labels = [(o["key"], o["label"].split(" · ")[0], o["count"]) for o in opts[1:]]
    assert labels == [(f"import:{int(ds['id']) + 1}", "Dec adds", 1), (f"import:{ds['id']}", "November logos", 3)]
    assert not any(o["key"].startswith("segment:") for o in opts)
    # A run on a dataset covers exactly its members.
    run = client.post("/api/v1/runs", json={"scopeKey": f"import:{ds['id']}", "channels": []}).json()
    assert run["companies"] == 3 and run["label"].startswith("Adhoc: November logos")
