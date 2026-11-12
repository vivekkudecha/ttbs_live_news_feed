"""UI read models + account commands, end to end on a real upload → run (fake provider)."""

from tests.conftest import GOOD_ROWS, research, upload


def _seed(client):
    imp = upload(client).json()
    r = research(client, imp["id"], ["email", "whatsapp"])
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _pam_id(client, email):
    return next(p["id"] for p in client.get(f"/api/v1/pams/search?q={email}").json())


def test_empty_database_pages(client):
    d = client.get("/api/v1/dashboard").json()
    assert d["latestRun"] is None and d["logos"] == 0 and d["topPriority"] == [] and d["recentRuns"] == []
    assert client.get("/api/v1/run-summaries").json() == []
    c = client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 50}).json()
    assert c["total"] == 0 and c["rows"] == []
    assert client.post("/api/v1/pams/query", json={"page": 0, "pageSize": 50}).json()["total"] == 0
    f = client.get("/api/v1/finops").json()
    assert f["totals"]["total"] == 0 and f["budget"]["monthSpend"] == 0 and f["byRun"] == []


def test_dashboard_runs_signals_digest(client):
    run_id = _seed(client)
    aarav = _pam_id(client, "aarav@ttbs.example")

    d = client.get("/api/v1/dashboard").json()
    assert d["latestRun"]["id"] == run_id and d["latestRun"]["status"] == "completed"
    assert d["logos"] == 3 and d["activePams"] == 2 and d["signals"] == 3 and d["scoped"] == 3
    assert d["emailSent"] == 2 and d["emailTotal"] == 2 and d["whatsappSent"] == 2
    assert len(d["topPriority"]) == 2  # rank-1 signal per PAM
    assert all(t["whyNow"] and "http" not in t["whyNow"] and "**" not in t["whyNow"] for t in d["topPriority"])
    assert sum(c["count"] for c in d["byCategory"]) == 3
    mine = client.get(f"/api/v1/dashboard?pamId={aarav}").json()
    assert mine["logos"] == 2 and mine["signals"] == 2 and [t["rank"] for t in mine["topPriority"]] == [1, 2]

    runs = client.get("/api/v1/run-summaries").json()
    assert runs[0]["pamJobsTotal"] == 2 and runs[0]["pamJobsDone"] == 2 and runs[0]["whatsappEligible"] == 2
    jobs = client.get(f"/api/v1/run-summaries/{run_id}/pam-jobs?pageSize=10").json()
    assert jobs["total"] == 2 and {j["email"] for j in jobs["rows"]} == {"sent"}


def test_companies_query_detail_and_reassign(client):
    run_id = _seed(client)
    aarav, priya = _pam_id(client, "aarav@ttbs.example"), _pam_id(client, "priya@ttbs.example")
    page = client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 2, "sort": {"id": "name", "desc": False}}).json()
    assert page["total"] == 3 and [r["name"] for r in page["rows"]] == ["Havells India", "Pine Labs Pvt Ltd"]
    assert page["facets"] == {"latest": {"signal": 3}} and "segment" not in page["rows"][0]
    row = page["rows"][1]
    assert row["latestStatus"] == "signal" and row["signals"] == 1 and row["cycles"] == [{"runId": run_id, "status": "signal"}]
    scoped = client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 50, "scopePamId": priya}).json()
    assert [r["name"] for r in scoped["rows"]] == ["Havells India"]
    assert client.post("/api/v1/companies/query", json={"segments": ["Mid-market"]}).status_code == 422  # filter retired
    assert [c["name"] for c in client.get("/api/v1/companies/search?q=zom").json()] == ["Zomato Hyperpure"]

    pine = row["id"]
    detail = client.get(f"/api/v1/companies/{pine}").json()
    assert detail["pam"]["id"] == aarav and len(detail["cycles"]) == 1
    assert [(a["pamId"], a["reason"], a["validTo"]) for a in detail["assignments"]] == [(aarav, "import", None)]

    r = client.post("/api/v1/companies/reassign", json={"companyIds": [pine], "toPamId": priya})
    assert r.json() == {"moved": 1}
    hist = client.get(f"/api/v1/companies/{pine}").json()["assignments"]
    assert [(a["pamId"], a["reason"]) for a in hist] == [(aarav, "import"), (priya, "manual")] and hist[0]["validTo"]
    assert client.post("/api/v1/companies/reassign", json={"companyIds": [pine], "toPamId": "999"}).status_code == 404


def test_pams_query_has_load_but_no_capacity_or_rebalancing(client):
    _seed(client)
    upload(client, [["Tata Elxsi", "IT", "Enterprise", "", "Rohan Das", "rohan@ttbs.example", "9830033003"]]).json()
    aarav, rohan = _pam_id(client, "aarav@ttbs.example"), _pam_id(client, "rohan@ttbs.example")

    pg = client.post("/api/v1/pams/query", json={"page": 0, "pageSize": 10, "sort": {"id": "load", "desc": True}}).json()
    assert pg["total"] == 3 and pg["activeTotal"] == 3 and pg["rows"][0]["email"] == "aarav@ttbs.example" and pg["rows"][0]["load"] == 2
    assert "segment" not in pg["rows"][0] and set(pg["facets"]) == {"status"}
    assert [p["id"] for p in client.get(f"/api/v1/pams/by-ids?ids={aarav},{rohan}").json()] == [aarav, rohan]

    # Uploads alone decide ownership: no capacity, no rebalance plan, no PAM deactivation.
    assert "capacity" not in pg["rows"][0]
    assert client.get(f"/api/v1/pams/{aarav}/rebalance-plan").status_code == 404
    assert client.post(f"/api/v1/pams/{aarav}/deactivate").status_code in (404, 405)


def test_edit_pam_details(client):
    _seed(client)
    upload(client, [["Tata Elxsi", "IT", "Enterprise", "", "Rohan Das", "rohan@ttbs.example", "9830033003"]])
    aarav = _pam_id(client, "aarav@ttbs.example")

    out = client.patch(f"/api/v1/pams/{aarav}", json={"name": " Aarav M. ", "email": "Aarav.M@TTBS.example", "whatsapp": "98100 11002",
                                                      "notifyWhatsapp": False})
    assert out.status_code == 200, out.text
    card = out.json()
    assert (card["name"], card["email"], card["whatsapp"], card["notifyEmail"], card["notifyWhatsapp"], card["load"]) == (
        "Aarav M.", "aarav.m@ttbs.example", "+919810011002", True, False, 2)
    # The cached PAM table shows the edit straight away, and the change is audited.
    row = next(r for r in client.post("/api/v1/pams/query", json={"search": "aarav"}).json()["rows"])
    assert row["email"] == "aarav.m@ttbs.example" and row["notifyWhatsapp"] is False
    assert any(e["action"] == "pam.update" for e in client.get("/api/v1/audit").json()["rows"])

    assert client.patch(f"/api/v1/pams/{aarav}", json={"email": "rohan@ttbs.example"}).status_code == 409
    assert client.patch(f"/api/v1/pams/{aarav}", json={"email": "not-an-email"}).status_code == 422
    assert client.patch(f"/api/v1/pams/{aarav}", json={"whatsapp": "12"}).status_code == 422
    assert client.patch(f"/api/v1/pams/{aarav}", json={"name": "  "}).status_code == 422
    assert client.patch(f"/api/v1/pams/{aarav}", json={"active": False}).status_code == 422  # not editable here
    assert client.patch("/api/v1/pams/999999", json={"name": "X"}).status_code == 404


def test_runs_list_groups_search_and_results_search(client):
    run_id = _seed(client)
    body = client.get("/api/v1/runs?status=finished&pageSize=10").json()
    assert [r["id"] for r in body["rows"]] == [run_id]
    assert body["groups"] == {"all": 1, "active": 0, "finished": 1, "attention": 0}
    assert client.get("/api/v1/runs?status=active").json()["total"] == 0
    assert client.get("/api/v1/runs?q=nomatch").json()["groups"]["all"] == 0

    res = client.get(f"/api/v1/runs/{run_id}/results?q=havells").json()
    assert [r["companyName"] for r in res["rows"]] == ["Havells India"] and res["total"] == 1
    allr = client.get(f"/api/v1/runs/{run_id}/results").json()["rows"]
    assert [r["companyName"] for r in allr] == sorted(r["companyName"] for r in allr)  # all signals → by name


def test_live_grid_and_changes(client):
    run_id = _seed(client)
    snap = client.get(f"/api/v1/run-summaries/{run_id}/live").json()
    assert snap["total"] == 3 and snap["statuses"] == [1, 1, 1] and snap["pamNames"] == ["Aarav Mehta", "Aarav Mehta", "Priya Nair"]
    ch = client.get(f"/api/v1/run-summaries/{run_id}/live/changes", params={"since": "2000-01-01T00:00:00Z"}).json()
    assert len(ch["items"]) == 3 and ch["done"] == 3 and ch["status"] == "completed" and ch["serverTime"]
    assert all(i["s"] == 1 and i["category"] for i in ch["items"])


def test_finops_templates_channels_session(client):
    _seed(client)
    f = client.get("/api/v1/finops").json()
    assert f["currency"] == "USD" and f["budget"]["monthly"] > 0 and f["series"][-1]["date"] == f["to"]
    assert f["totals"]["calls"] == 3 and f["byModel"][0]["provider"] == "fake" and len(f["byPam"]) == 2
    t = client.get("/api/v1/templates").json()
    assert t[0]["id"] == "t1" and "{company}" in t[0]["versions"][0]["researchPrompt"]
    assert [c["key"] for c in client.get("/api/v1/channels").json()] == ["email", "whatsapp"]

    # The name-only sign-in is gone: identity comes from a password session (tests/test_auth.py).
    assert client.post("/api/v1/session", json={"username": "vivek"}).status_code in (403, 404, 405)
    me = client.get("/api/v1/auth/me").json()["user"]
    assert me["username"] == "tester" and me["role"] == "admin" and me["lastLoginAt"]
    assert "role" not in client.get("/api/v1/audit?pageSize=5").json()["rows"][0]


def test_import_keeps_assignment_history(client):
    _seed(client)
    moved = [["Pine Labs Pvt Ltd", "Fintech", "Enterprise", "", "Priya Nair", "priya@ttbs.example", "9845022002"]]
    upload(client, moved).json()
    pine = client.get("/api/v1/companies/search?q=pine").json()[0]["id"]
    hist = client.get(f"/api/v1/companies/{pine}").json()["assignments"]
    assert [a["pamName"] for a in hist] == ["Aarav Mehta", "Priya Nair"] and hist[0]["validTo"] and hist[1]["validTo"] is None
    assert GOOD_ROWS  # fixture rows unchanged
