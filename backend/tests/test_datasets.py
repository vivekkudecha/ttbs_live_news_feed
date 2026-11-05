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
    real_apply = tasks.process_import.apply_async
    monkeypatch.setattr(tasks.process_import, "apply_async", lambda *a, **k: None)  # worker never picks it up
    ds = upload(client).json()
    assert ds["status"] == "analyzing"  # the file is checked in the background, then saved
    ds = client.get(f"/api/v1/imports/{ds['id']}").json()
    assert ds["status"] == "queued" and ds["saved"] == 0

    # A worker saved 1 chunk (streamed from the stored file), then died (its lease/heartbeat went stale).
    from itertools import islice

    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, int(ds["id"]))
        chunk = list(islice(imports.stream_valid_rows(imports.stored_path(b), "xlsx"), 1))
        imports._apply(uow, b, chunk)
        b.rows_done, b.status, b.worker_token = 1, "processing", "dead-worker"
        b.heartbeat_at = utcnow() - timedelta(minutes=5)
    # Restore only the task (undo() would also drop the test's UPLOAD_DIR, where the file is kept).
    monkeypatch.setattr(tasks.process_import, "apply_async", real_apply)
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
    ds = client.get(f"/api/v1/imports/{ds['id']}").json()
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
    # Only uploads: every run starts from one (no "all companies" / segment scopes any more).
    labels = [(o["key"], o["label"].split(" · ")[0], o["count"], o["runs"]) for o in opts]
    assert labels == [(f"import:{int(ds['id']) + 1}", "Dec adds", 1, 0), (f"import:{ds['id']}", "November logos", 3, 0)]
    # A run on a dataset covers exactly its members, and is labelled by upload + run number.
    run = client.post("/api/v1/runs", json={"scopeKey": f"import:{ds['id']}", "channels": []}).json()
    assert run["companies"] == 3 and run["label"] == "November logos · run 1" and run["trigger"] == "upload"
    again = client.post("/api/v1/runs", json={"importId": int(ds["id"]), "channels": []}).json()
    assert again["label"] == "November logos · run 2" and again["trigger"] == "rerun"
    assert client.get("/api/v1/scopes").json()[1]["runs"] == 2


def test_preview_shows_rows_and_changes_without_saving(client):
    from tests.conftest import xlsx

    upload(client, label="Nov")  # Pine → Aarav already known
    moved = [["Pine Labs Pvt Ltd", "Fintech", "Enterprise", "Priya Nair", "priya@ttbs.example", "9845022002"],
             ["Brand New Co", "", "", "Priya Nair", "priya@ttbs.example", "9845022002"],
             ["Bad Row", "", "", "Priya Nair", "not-an-email", "9845022002"]]
    headers = ["Company", "Industry", "Segment", "PAM Name", "PAM Email", "PAM WhatsApp"]
    before = client.get("/api/v1/imports").json()
    staged = client.post("/api/v1/imports/stage", files={"file": ("dec.xlsx", xlsx(moved, headers), "application/octet-stream")})
    assert staged.status_code == 201 and staged.json()["status"] == "analyzing"
    p = client.get(f"/api/v1/imports/{staged.json()['id']}/preview").json()  # checked in the background (eager here)
    assert p["status"] == "previewed" and p["rowsTotal"] == 3
    assert client.get(f"/api/v1/imports/{p['id']}").json()["status"] == "previewed" and p["validRows"] == 2 and p["errorRows"] == 1
    assert p["newCompanies"] == 1 and p["reassignments"] == 1 and p["newPams"] == 0
    pine = next(r for r in p["rows"] if r["company"] == "Pine Labs Pvt Ltd")
    assert pine["change"] == "reassigned" and pine["currentPam"] == "Aarav Mehta" and pine["pamName"] == "Priya Nair"
    assert any(i["field"] == "PAM Email" for i in p["issues"])
    assert client.get("/api/v1/imports").json() == before  # nothing was saved, and the preview is not listed

    # Discarding drops it and its file; saving needs a name, then the rows are saved in the background.
    from app.core.config import get_settings

    assert client.post(f"/api/v1/imports/{p['id']}/save", json={"label": "  "}).status_code == 422
    saved = client.post(f"/api/v1/imports/{p['id']}/save", json={"label": "Dec moves"}).json()
    assert saved["label"] == "Dec moves"
    done = client.get(f"/api/v1/imports/{p['id']}").json()
    assert done["status"] == "completed" and done["companies"] == 2 and done["reassignments"] == 1
    assert client.post(f"/api/v1/imports/{p['id']}/save", json={"label": "again"}).status_code == 409
    other = client.post("/api/v1/imports/stage", files={"file": ("x.xlsx", xlsx(moved, headers), "application/octet-stream")}).json()
    assert client.delete(f"/api/v1/imports/{other['id']}").status_code == 204
    assert not any(f.name.startswith(other["id"]) or f"_{other['id']}_" in f.name for f in get_settings().upload_path.iterdir())
    assert client.delete(f"/api/v1/imports/{p['id']}").status_code == 409  # saved uploads are not discardable


def test_upload_needs_a_name_and_keeps_the_original_file(client):
    from app.core.config import get_settings

    r = upload(client, label=None)
    assert r.status_code == 422 and r.json()["error"]["details"] == {"field": "label"}
    d = upload(client, label="Nov logos").json()
    assert d["hasFile"] is True
    stored = list(get_settings().upload_path.iterdir())
    assert len(stored) == 1 and stored[0].name.endswith(f"_{d['id']}_Nov-logos.xlsx") and stored[0].name[:8].isdigit()
    f = client.get(f"/api/v1/imports/{d['id']}/file")
    assert f.status_code == 200 and f.content[:2] == b"PK"  # the xlsx as uploaded
    assert "Nov%20logos%20" in f.headers["content-disposition"]  # "<name> <upload time>.xlsx" (RFC 5987)


def test_large_csv_is_streamed_checked_and_saved(client, monkeypatch):
    """A CSV bigger than one save chunk and one compare batch: counts, duplicates (first row wins),
    progress and the size limit all work without holding the file in memory."""
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "import_chunk_size", 300)
    monkeypatch.setattr(get_settings(), "import_analyze_batch", 250)
    lines = ["Company,PAM Name,PAM Email,PAM WhatsApp"]
    lines += [f"Logo {i:05d} Pvt Ltd,PAM {i % 7},pam{i % 7}@ttbs.example,98100{i % 7:05d}" for i in range(2000)]
    lines += ["LOGO 00001 PVT. LTD,PAM 9,pam9@ttbs.example,9810000009"]  # duplicate of row 3: the first row wins
    data = ("\n".join(lines) + "\n").encode()
    r = client.post("/api/v1/imports", files={"file": ("big.csv", data, "text/csv")}, data={"label": "Big"})
    assert r.status_code == 201, r.text
    d = client.get(f"/api/v1/imports/{r.json()['id']}").json()
    assert d["status"] == "completed" and d["rowsTotal"] == 2001 and d["validRows"] == 2000 and d["duplicatesMerged"] == 1
    assert d["companies"] == 2000 and d["newCompanies"] == 2000 and d["newPams"] == 7 and d["sizeBytes"] == len(data)
    p = client.get(f"/api/v1/imports/{d['id']}/preview").json()
    assert p["rowsShown"] == 200 and p["newCompanies"] == 2000
    assert any("earlier row is used" in i["message"] for i in p["issues"])

    monkeypatch.setattr(get_settings(), "import_max_bytes", 1000)
    r = client.post("/api/v1/imports", files={"file": ("big.csv", data, "text/csv")}, data={"label": "Too big"})
    assert r.status_code == 413
    assert not [f for f in get_settings().upload_path.iterdir() if f.suffix == ".part"]  # nothing left behind
