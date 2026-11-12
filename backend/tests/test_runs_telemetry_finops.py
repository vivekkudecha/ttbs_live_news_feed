"""Per-upload runs (each upload's own logo → PAM mapping), end-to-end telemetry, run audit trail,
and the FinOps ledger/report/budget."""

from datetime import timedelta

from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import RetryableProviderError
from app.core.timeutil import utcnow
from app.db.models import CostEntry, ImportBatch, Pam, ProcessEvent, ResearchResult
from app.db.session import unit_of_work
from app.research import providers
from tests.conftest import GOOD_ROWS, research, upload

PINE_TO_PRIYA = [["Pine Labs Pvt Ltd", "Fintech", "Enterprise", "", "Priya Nair", "priya@ttbs.example", "9845022002"]]


def _owner_by_company(run_id: str) -> dict[str, int | None]:
    with unit_of_work() as uow:
        rows = uow.session.scalars(select(ResearchResult).where(ResearchResult.run_id == int(run_id))).all()
        return {r.company.name: r.pam_id for r in rows}


def _pam(client, email: str) -> int:
    return int(next(p["id"] for p in client.get(f"/api/v1/pams/search?q={email}").json()))


# --- Per-upload runs ----------------------------------------------------------------------------


def test_each_upload_runs_only_its_logos_for_its_own_pams(client):
    a = upload(client, label="Nov").json()
    b = upload(client, PINE_TO_PRIYA, label="Dec").json()
    aarav, priya = _pam(client, "aarav@ttbs.example"), _pam(client, "priya@ttbs.example")

    # Upload wins: Pine's master owner is now Priya, and the move is in the ownership history.
    pine = client.get("/api/v1/companies/search?q=pine").json()[0]["id"]
    assert [h["pamName"] for h in client.get(f"/api/v1/companies/{pine}").json()["assignments"]] == ["Aarav Mehta", "Priya Nair"]
    assert client.get(f"/api/v1/imports/{b['id']}").json()["reassignments"] == 1

    # Run of upload B: only its one logo, for Priya.
    rb = research(client, b["id"], []).json()
    assert rb["companies"] == 1 and _owner_by_company(rb["id"]) == {"Pine Labs Pvt Ltd": priya}

    # Re-running upload A later uses A's own mapping (Pine → Aarav), not today's owner.
    ra = research(client, a["id"], []).json()
    owners = _owner_by_company(ra["id"])
    assert len(owners) == 3 and owners["Pine Labs Pvt Ltd"] == aarav and owners["Havells India"] == priya
    assert ra["trigger"] == "upload" and client.get("/api/v1/scopes").json()[1]["runs"] == 1  # newest upload first


def test_uploaded_pam_that_left_falls_back_to_current_owner(client):
    a = upload(client).json()
    aarav = _pam(client, "aarav@ttbs.example")
    # A PAM left before uploads alone decided ownership: inactive, logos already with someone else.
    priya = _pam(client, "priya@ttbs.example")
    companies = client.post("/api/v1/companies/query", json={"pamIds": [str(aarav)]}).json()["rows"]
    assert client.post("/api/v1/companies/reassign", json={"companyIds": [c["id"] for c in companies], "toPamId": str(priya)}).status_code == 200
    with unit_of_work() as uow:
        uow.session.get(Pam, int(aarav)).active = False
    run = research(client, a["id"], []).json()
    owners = _owner_by_company(run["id"])
    assert aarav not in owners.values() and None not in owners.values()
    start = client.get(f"/api/v1/runs/{run['id']}/events?kind=run.start").json()["rows"][0]
    assert start["attrs"]["rerouted"] == 2 and "current owner" in start["message"]


def test_run_waits_for_the_upload_to_be_saved(client):
    a = upload(client).json()
    with unit_of_work() as uow:
        uow.session.get(ImportBatch, int(a["id"])).status = "processing"
    r = research(client, a["id"])
    assert r.status_code == 409 and "still being saved" in r.json()["error"]["message"]


# --- Telemetry + audit --------------------------------------------------------------------------


def test_every_step_is_recorded_and_the_run_has_its_own_timeline_and_audit(client, monkeypatch):
    calls = {"n": 0}
    real = providers.FakeProvider.research

    def flaky(self, company, ws, we, prompt=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RetryableProviderError("429 Too Many Requests", retry_after=0)
        return real(self, company, ws, we)

    monkeypatch.setattr(providers.FakeProvider, "research", flaky)
    imp = upload(client, label="Nov").json()
    run_id = research(client, imp["id"], ["email", "whatsapp"]).json()["id"]

    with unit_of_work() as uow:
        kinds = [(e.kind, e.status) for e in uow.session.scalars(select(ProcessEvent).order_by(ProcessEvent.id))]
    for expected in [("dataset.upload", "ok"), ("dataset.chunk", "ok"), ("dataset.saved", "ok"), ("run.queued", "ok"),
                     ("run.start", "ok"), ("research.attempt", "retry"), ("notify.queued", "ok"), ("notify.attempt", "ok"),
                     ("run.finish", "ok")]:
        assert expected in kinds, expected
    assert kinds.count(("research.attempt", "ok")) == 3 and kinds.count(("notify.attempt", "ok")) == 4

    tl = client.get(f"/api/v1/runs/{run_id}/timeline").json()
    tl_kinds = [e["kind"] for e in tl["events"]]
    assert tl_kinds[:2] == ["dataset.upload", "dataset.saved"]  # the run's upload leads its timeline
    assert "run.finish" in tl_kinds and "research.attempt" in tl_kinds  # the retry is listed as a problem
    assert tl["research"]["attempts"] == 4 and tl["research"]["retries"] == 1
    assert sum(b["ok"] for b in tl["throughput"]) == 3

    trail = client.get(f"/api/v1/runs/{run_id}/audit?pageSize=100").json()
    actions = [a["action"] for a in trail["rows"]]
    assert actions[:2] == ["run.queue", "run.start"] and actions.count("notify.sent") == 4 and "run.finish" in actions
    assert client.get("/api/v1/audit/verify").json()["ok"] is True  # run_id is covered by the hash chain

    ev = client.get(f"/api/v1/runs/{run_id}/events?kind=research.&status=retry").json()
    assert ev["total"] == 1 and ev["rows"][0]["message"].startswith("429")

    summary = client.get("/api/v1/telemetry/summary?hours=1").json()
    assert summary["total"] >= 15 and summary["retries"] == 1 and summary["research"]["samples"] == 0  # fake latency is 0
    assert any(k["kind"] == "research.attempt" and k["retry"] == 1 for k in summary["byKind"])
    assert client.get(f"/api/v1/telemetry/events?importId={imp['id']}&kind=dataset.").json()["total"] >= 3


def test_skipped_notifications_are_audited(client):
    rows = [["Solo Co", "", "", "", "Solo PAM", "solo@ttbs.example", "9876500000"]]
    imp = upload(client, rows).json()
    from app.db.models import Pam

    with unit_of_work() as uow:
        uow.session.scalars(select(Pam)).one().notify_whatsapp = False
    run_id = research(client, imp["id"], ["email", "whatsapp"]).json()["id"]
    trail = [a["action"] for a in client.get(f"/api/v1/runs/{run_id}/audit").json()["rows"]]
    assert "notify.skipped" in trail and "notify.sent" in trail


def test_metrics_endpoint(client):
    imp = upload(client).json()
    research(client, imp["id"], [])
    body = client.get("/metrics").text
    assert 'ttbs_http_requests_total{method="POST",route="/api/v1/imports",status="201"}' in body
    assert "ttbs_runs_active 0.0" in body and "ttbs_research_attempts_total" in body


# --- FinOps -------------------------------------------------------------------------------------


def test_cost_ledger_and_report(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "notify_price_whatsapp_usd", 0.01)
    real = providers.FakeProvider.research

    def priced(self, company, ws, we, prompt=None):
        out = real(self, company, ws, we)
        out.cost = 0.02
        return out

    monkeypatch.setattr(providers.FakeProvider, "research", priced)
    imp = upload(client, label="Nov").json()
    run1 = research(client, imp["id"], ["email", "whatsapp"]).json()["id"]
    research(client, imp["id"], [])  # re-run: all three from cache, cost 0, savings recorded

    with unit_of_work() as uow:
        ledger = uow.session.scalars(select(CostEntry)).all()
    llm = [e for e in ledger if e.category == "llm"]
    msgs = [e for e in ledger if e.category == "messaging"]
    assert len(llm) == 6 and sum(e.cached for e in llm) == 3 and len(msgs) == 4
    assert all(e.import_id == int(imp["id"]) and e.pam_id for e in ledger)

    f = client.get("/api/v1/finops").json()
    t = f["totals"]
    assert t["llm"] == 0.06 and t["messaging"] == 0.02 and t["total"] == 0.08
    assert t["calls"] == 3 and t["cacheHits"] == 3 and t["cacheRate"] == 50.0 and round(t["saved"], 2) == 0.06
    assert t["signals"] == 6 and t["costPerSignal"] == round(0.08 / 6, 4)
    assert [r["label"] for r in f["byRun"]][0] == "Nov · run 1" and f["byUpload"][0]["label"] == "Nov"
    assert {p["name"] for p in f["byPam"]} == {"Aarav Mehta", "Priya Nair"}
    assert {(m["category"], m["provider"]) for m in f["byModel"]} == {("llm", "fake"), ("messaging", "whatsapp"), ("messaging", "email")}
    assert f["series"][-1]["llm"] == 0.06

    rc = client.get(f"/api/v1/runs/{run1}/costs").json()
    assert rc["totals"]["total"] == 0.08 and len(rc["byPam"]) == 2

    csv = client.get("/api/v1/finops/ledger.csv")
    assert csv.headers["content-type"].startswith("text/csv") and "attachment" in csv.headers["content-disposition"]
    lines = csv.text.lstrip("﻿").splitlines()
    assert lines[0].startswith("ts,category,provider") and len(lines) == 11

    assert client.get("/api/v1/finops?from=2026-13-01").status_code == 422
    assert client.get("/api/v1/finops?from=2026-11-05&to=2026-11-01").status_code == 422


def test_ledger_keeps_the_providers_usage_breakdown(client, monkeypatch):
    """Each paid call keeps the provider's usage report in the ledger (cache hits add nothing), the
    ledger CSV carries every part, and the run table shows the model and its tokens."""
    real = providers.FakeProvider.research

    def billed(self, company, ws, we, prompt=None):
        out = real(self, company, ws, we)
        out.tokens_in, out.tokens_out, out.cost = 12000, 700, 0.0228
        out.usage = providers.Usage(cache_read=9000, cache_write=300, tool_calls=3, input_cost=0.003, output_cost=0.0035,
                                    cache_cost=0.0013, tool_cost=0.015, source="provider", response_id=f"resp_{company}",
                                    raw={"input_tokens": 12000})
        return out

    monkeypatch.setattr(providers.FakeProvider, "research", billed)
    imp = upload(client).json()
    research(client, imp["id"], [])
    research(client, imp["id"], [])  # all cache hits: no tokens, nothing billed

    with unit_of_work() as uow:
        paid = uow.session.scalars(select(CostEntry).where(CostEntry.cached.is_(False))).all()
    assert len(paid) == 3 and {(e.cache_read_tokens, e.cache_write_tokens, e.tool_calls, e.cost_source) for e in paid} == {(9000, 300, 3, "provider")}
    assert {(e.input_cost, e.output_cost, e.cache_cost, e.tool_cost) for e in paid} == {(0.003, 0.0035, 0.0013, 0.015)}
    run = client.get("/api/v1/finops").json()["byRun"][0]
    assert (run["provider"], run["model"], run["tokensIn"] + run["tokensOut"]) == ("fake", "fake-model", 38100)
    u = run["usage"]  # the token popover: what the provider reported, added up
    assert (u["cacheRead"], u["cacheWrite"], u["toolCalls"], u["untrackedCalls"], u["estimatedCost"]) == (27000, 900, 9, 0, 0.0)
    assert (u["inputCost"], u["outputCost"], u["cacheCost"], u["toolCost"]) == (0.009, 0.0105, 0.0039, 0.045)

    lines = client.get("/api/v1/finops/ledger.csv").text.lstrip("\ufeff").splitlines()
    head = lines[0].split(",")
    paid = [dict(zip(head, ln.split(","), strict=True)) for ln in lines[1:] if ",no," in ln]
    assert len(paid) == 3 and {p["cost_source"] for p in paid} == {"provider"}
    assert {p["cache_read_tokens"] for p in paid} == {"9000"} and all(p["response_id"].startswith("resp_") for p in paid)


def test_csv_export_guards_against_formula_injection(client):
    # Excel formula cells never get in through an upload (read as cached values → rejected), but a
    # CSV upload or a later rename can carry text starting with "=": the export must neutralise it.
    from app.db.models import Company

    with unit_of_work() as uow:
        c = Company(name='=HYPERLINK("http://x")', name_key="HYPERLINKHTTPX", active=True)
        uow.session.add(c)
        uow.session.flush()
        uow.session.add(CostEntry(ts=utcnow(), category="llm", provider="fake", model="m", company_id=c.id, cost=0.01, units=1))
    text = client.get("/api/v1/finops/ledger.csv").text
    assert "'=HYPERLINK" in text and ",=HYPERLINK" not in text


def test_monthly_budget_is_a_hard_cap(client, monkeypatch):
    imp = upload(client).json()
    monkeypatch.setattr(get_settings(), "monthly_budget_usd", 1.0)
    with unit_of_work() as uow:
        uow.session.add(CostEntry(ts=utcnow() - timedelta(minutes=1), category="llm", provider="fake", model="m", cost=1.5, units=1))
    r = research(client, imp["id"])
    assert r.status_code == 422 and r.json()["error"]["code"] == "budget_exceeded"
    monkeypatch.setattr(get_settings(), "budget_hard_cap", False)
    assert research(client, imp["id"], []).status_code == 201


def test_rows_before_run_correlation_still_verify(client):
    """Audit rows written before audit_log.run_id existed (run_id NULL, not hashed) verify alongside new ones."""
    upload(client)  # dataset.* rows: no run_id
    imp = client.get("/api/v1/imports").json()["rows"][0]
    research(client, imp["id"], [])
    assert client.get("/api/v1/audit/verify").json() == {"ok": True, "checked": client.get("/api/v1/audit").json()["total"]}
    assert GOOD_ROWS


def test_cost_row_handles_mysql_decimal_sums():
    """MySQL returns SUM() as Decimal (SQLite as int/float); the report used to crash on float / Decimal."""
    from decimal import Decimal

    from app.services.finops import _row

    r = _row(Decimal("0.4197"), Decimal("0"), Decimal(100), Decimal(200), Decimal("0.8394"), Decimal(1270112), Decimal(71306),
             Decimal(42), Decimal(18))
    assert (r["total"], r["signals"], r["costPerSignal"], r["costPerCompany"], r["cacheRate"]) == (0.4197, 42, 0.01, 0.0014, 66.7)
    assert all(type(r[k]) is int for k in ("calls", "cacheHits", "tokensIn", "tokensOut", "signals", "messages"))
