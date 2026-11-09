"""Server-side sort and column filters (api/listing.py) across the table endpoints."""

import json

from tests.conftest import GOOD_ROWS, make_user, research, upload


def q(**f):
    return json.dumps(f)


def test_users_sort_filter_and_paging(client):
    for i, name in enumerate(["zara", "amit", "bina"]):
        make_user(name, role="member" if i else "admin", permissions={"dashboard": "view"})
    r = client.get("/api/v1/users", params={"sort": "username", "desc": "true", "pageSize": 2}).json()
    assert r["total"] == 4 and [u["username"] for u in r["rows"]] == ["zara", "tester"]
    r = client.get("/api/v1/users", params={"filter": q(role=["member"])}).json()
    assert {u["username"] for u in r["rows"]} == {"amit", "bina"} and r["total"] == 2
    r = client.get("/api/v1/users", params={"filter": q(username="IN")}).json()  # case-insensitive contains
    assert [u["username"] for u in r["rows"]] == ["bina"]
    r = client.get("/api/v1/users", params={"filter": q(username="%")}).json()  # LIKE wildcards are literal
    assert r["total"] == 0


def test_rejects_unknown_columns_and_bad_values(client):
    assert client.get("/api/v1/users", params={"sort": "password_hash"}).status_code == 422
    assert client.get("/api/v1/users", params={"filter": q(password_hash="x")}).status_code == 422
    assert client.get("/api/v1/users", params={"filter": "not json"}).status_code == 422
    assert client.get("/api/v1/users", params={"filter": "[1,2]"}).status_code == 422
    assert client.get("/api/v1/users", params={"filter": q(active="yes")}).status_code == 422
    assert client.get("/api/v1/users", params={"filter": q(lastLoginAt={"from": "nope"})}).status_code == 422
    assert client.get("/api/v1/runs", params={"filter": q(companies={"min": "abc"})}).status_code == 422
    # Empty values are ignored (a cleared filter input).
    assert client.get("/api/v1/users", params={"filter": q(username="", role=[])}).json()["total"] == 1


def test_runs_results_and_notifications(client):
    imp = upload(client).json()
    run_id = research(client, imp["id"]).json()["id"]
    research(client, imp["id"])

    runs = client.get("/api/v1/runs", params={"sort": "id", "desc": "false"}).json()["rows"]
    assert [r["id"] for r in runs] == sorted((r["id"] for r in runs), key=int)
    assert client.get("/api/v1/runs", params={"filter": q(id={"min": int(run_id), "max": int(run_id)})}).json()["total"] == 1
    assert client.get("/api/v1/runs", params={"filter": q(companies={"min": 99})}).json()["total"] == 0
    assert client.get("/api/v1/runs", params={"filter": q(startedAt={"from": "2000-01-01", "to": "2999-12-31"})}).json()["total"] == 2

    res = client.get(f"/api/v1/runs/{run_id}/results", params={"sort": "companyName"}).json()
    names = [r["companyName"] for r in res["rows"]]
    assert names == sorted(names) and res["total"] == len(GOOD_ROWS)
    res = client.get(f"/api/v1/runs/{run_id}/results", params={"filter": q(companyName="pine")}).json()
    assert [r["companyName"] for r in res["rows"]] == ["Pine Labs Pvt Ltd"]

    notes = client.get(f"/api/v1/runs/{run_id}/notifications", params={"filter": q(channel=["email"])}).json()
    assert notes["total"] == 2 and {n["channel"] for n in notes["rows"]} == {"email"}
    by_pam = client.get(f"/api/v1/runs/{run_id}/notifications", params={"sort": "pamName", "filter": q(pamName="priya")}).json()
    assert {n["pamName"] for n in by_pam["rows"]} == {"Priya Nair"} and by_pam["total"] == 2


def test_imports_audit_and_events(client):
    upload(client, label="alpha")
    upload(client, label="beta")
    r = client.get("/api/v1/imports", params={"sort": "label", "pageSize": 1}).json()
    assert r["total"] == 2 and r["rows"][0]["label"] == "alpha"
    assert client.get("/api/v1/imports", params={"filter": q(label="bet")}).json()["rows"][0]["label"] == "beta"

    audit = client.get("/api/v1/audit", params={"filter": q(action="dataset."), "sort": "ts"}).json()
    assert audit["total"] >= 2 and all(a["action"].startswith("dataset.") for a in audit["rows"])

    ev = client.get("/api/v1/telemetry/events", params={"filter": q(status=["ok"]), "sort": "kind"}).json()
    kinds = [e["kind"] for e in ev["rows"]]
    assert kinds == sorted(kinds) and all(e["status"] == "ok" for e in ev["rows"])
