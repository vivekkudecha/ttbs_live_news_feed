"""UI read models + account commands, end to end on a real upload → run (fake provider)."""

from tests.conftest import GOOD_ROWS, upload


def _seed(client):
    imp = upload(client).json()
    r = client.post(f"/api/v1/imports/{imp['id']}/commit", json={"schedule": {"mode": "now", "channels": ["email", "whatsapp"]}})
    assert r.status_code == 200, r.text
    return r.json()["run"]["id"]


def _pam_id(client, email):
    return next(p["id"] for p in client.get(f"/api/v1/pams/search?q={email}").json())


def test_empty_database_pages(client):
    d = client.get("/api/v1/dashboard").json()
    assert d["latestRun"] is None and d["logos"] == 0 and d["topPriority"] == [] and d["recentRuns"] == []
    assert client.get("/api/v1/run-summaries").json() == []
    c = client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 50}).json()
    assert c["total"] == 0 and c["rows"] == []
    assert client.post("/api/v1/pams/query", json={"page": 0, "pageSize": 50}).json()["total"] == 0
    assert client.get("/api/v1/finops").json()["monthSpend"] == 0
    assert client.post("/api/v1/signals/query", json={"runId": "999", "page": 0, "pageSize": 20}).json()["total"] == 0


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

    s = client.post("/api/v1/signals/query", json={"runId": run_id, "page": 0, "pageSize": 20}).json()
    assert s["counts"]["signal"] == 3 and s["counts"]["all"] == 3 and s["total"] == 3
    assert all(r["priority"]["rank"] >= 1 and r["offerings"] for r in s["rows"])
    only = client.post("/api/v1/signals/query", json={"runId": run_id, "page": 0, "pageSize": 20, "pamId": aarav, "search": "pine"}).json()
    assert [r["companyName"] for r in only["rows"]] == ["Pine Labs Pvt Ltd"]
    none = client.post("/api/v1/signals/query", json={"runId": run_id, "page": 0, "pageSize": 20, "status": "failed"}).json()
    assert none["total"] == 0 and none["counts"]["signal"] == 3

    dg = client.get(f"/api/v1/digest?runId={run_id}&pamId={aarav}").json()
    assert dg["pam"]["email"] == "aarav@ttbs.example" and len(dg["rows"]) == 2 and dg["job"]["status"] == "completed"
    assert [r["priority"]["rank"] for r in dg["rows"]] == [1, 2]


def test_companies_query_detail_and_reassign(client):
    run_id = _seed(client)
    aarav, priya = _pam_id(client, "aarav@ttbs.example"), _pam_id(client, "priya@ttbs.example")
    page = client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 2, "sort": {"id": "name", "desc": False}}).json()
    assert page["total"] == 3 and [r["name"] for r in page["rows"]] == ["Havells India", "Pine Labs Pvt Ltd"]
    assert page["facets"]["segment"] == {"Enterprise": 2, "Mid-market": 1} and page["facets"]["latest"] == {"signal": 3}
    row = page["rows"][1]
    assert row["latestStatus"] == "signal" and row["signals"] == 1 and row["cycles"] == [{"runId": run_id, "status": "signal"}]
    scoped = client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 50, "scopePamId": priya}).json()
    assert [r["name"] for r in scoped["rows"]] == ["Havells India"]
    assert client.post("/api/v1/companies/query", json={"page": 0, "pageSize": 50, "segments": ["Mid-market"]}).json()["total"] == 1
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


def test_pams_query_rebalance_and_deactivate(client):
    _seed(client)
    upload_more = upload(client, [["Tata Elxsi", "IT", "Enterprise", "", "Rohan Das", "rohan@ttbs.example", "9830033003"]]).json()
    client.post(f"/api/v1/imports/{upload_more['id']}/commit", json={})
    aarav, rohan = _pam_id(client, "aarav@ttbs.example"), _pam_id(client, "rohan@ttbs.example")

    pg = client.post("/api/v1/pams/query", json={"page": 0, "pageSize": 10, "sort": {"id": "load", "desc": True}}).json()
    assert pg["total"] == 3 and pg["activeTotal"] == 3 and pg["rows"][0]["email"] == "aarav@ttbs.example" and pg["rows"][0]["load"] == 2
    assert pg["rows"][0]["segment"] in ("Enterprise", "Mid-market")
    assert [p["id"] for p in client.get(f"/api/v1/pams/by-ids?ids={aarav},{rohan}").json()] == [aarav, rohan]

    plan = client.get(f"/api/v1/pams/{aarav}/rebalance-plan").json()
    assert len(plan["moves"]) == 2 and all(m["toPamId"] != aarav for m in plan["moves"])
    out = client.post(f"/api/v1/pams/{aarav}/deactivate").json()
    assert len(out["moves"]) == 2
    after = client.post("/api/v1/pams/query", json={"page": 0, "pageSize": 10, "status": ["inactive"]}).json()
    assert [p["id"] for p in after["rows"]] == [aarav] and after["rows"][0]["load"] == 0
    assert client.post(f"/api/v1/pams/{aarav}/deactivate").status_code == 409
    assert "pam.deactivate" in [a["action"] for a in client.get("/api/v1/audit?pageSize=50").json()["rows"]]


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
    assert f["monthBudget"] > 0 and len(f["series"]) == 6 and f["byProvider"][0]["name"] == "Offline (fake)"
    t = client.get("/api/v1/templates").json()
    assert t[0]["id"] == "t1" and "{company}" in t[0]["versions"][0]["researchPrompt"]
    assert [c["key"] for c in client.get("/api/v1/channels").json()] == ["email", "whatsapp"]

    me = client.post("/api/v1/session", json={"username": " vivek "}).json()
    assert me == {"id": "vivek", "username": "vivek", "name": "vivek", "lastLoginAt": me["lastLoginAt"]}
    assert client.post("/api/v1/session", json={"username": "   "}).status_code == 422
    assert client.post("/api/v1/session", json={"username": "x", "role": "admin"}).status_code == 422  # roles no longer exist
    assert "role" not in client.get("/api/v1/audit?pageSize=5").json()["rows"][0]


def test_import_keeps_assignment_history(client):
    _seed(client)
    moved = [["Pine Labs Pvt Ltd", "Fintech", "Enterprise", "", "Priya Nair", "priya@ttbs.example", "9845022002"]]
    imp = upload(client, moved).json()
    client.post(f"/api/v1/imports/{imp['id']}/commit", json={})
    pine = client.get("/api/v1/companies/search?q=pine").json()[0]["id"]
    hist = client.get(f"/api/v1/companies/{pine}").json()["assignments"]
    assert [a["pamName"] for a in hist] == ["Aarav Mehta", "Priya Nair"] and hist[0]["validTo"] and hist[1]["validTo"] is None
    assert GOOD_ROWS  # fixture rows unchanged
