"""PRIORITY ACTIONS: after a PAM's research, the AI ranks its signals into "Why now? / Action:" entries,
shown at the end of the PAM's digest and under the PAM on the run board."""

from sqlalchemy import select

from app.core.errors import ProviderError
from app.db.models import Notification, PamPriority, ResearchPromptVersion
from app.db.session import unit_of_work
from app.research import providers, ratelimit
from app.services import priorities
from tests.conftest import research, upload

ITEMS = [
    {"resultId": 1, "companyId": 11, "company": "3i Infotech Ltd", "category": "Contract", "key_signals": "x", "opportunity": "y", "outreach": "z"},
    {"resultId": 2, "companyId": 12, "company": "AceVector Limited", "category": "Product", "key_signals": "x", "opportunity": "y", "outreach": "z"},
    {"resultId": 3, "companyId": 13, "company": "Aaverina Hospitality Private Limited", "category": "Expansion", "key_signals": "x",
     "opportunity": "y", "outreach": "z"},
]


def test_parse_reads_the_original_format_in_rank_order():
    text = """**1. ACEVECTOR LIMITED**
Why now? Snapdeal launched an AI Solutions Suite,
driving urgent need for scalable cloud connectivity.
**Action:** Target the Head of Technology with Smart Cloud and Managed SOC.

3I INFOTECH LTD
Why now: Secured a 3-year DC/DR contract.
Action - Pitch P2P Leased Lines and SD-WAN iFLX.

UNKNOWN CORP
Why now? Not one of this PAM's accounts.
Action: Ignored.

AAVERINA HOSPITALITY
Why now? New property in Tirupati.
Action: Approach IT leadership for Managed Wi-Fi."""
    got = priorities.parse(text, ITEMS)
    assert [(e["rank"], e["companyId"]) for e in got] == [(1, 12), (2, 11), (3, 13)]  # fuzzy "AAVERINA HOSPITALITY" matched
    assert got[0]["whyNow"] == "Snapdeal launched an AI Solutions Suite, driving urgent need for scalable cloud connectivity."
    assert got[0]["action"] == "Target the Head of Technology with Smart Cloud and Managed SOC."
    assert got[1]["whyNow"] == "Secured a 3-year DC/DR contract." and got[1]["action"] == "Pitch P2P Leased Lines and SD-WAN iFLX."
    assert [e["companyId"] for e in priorities.parse(text, ITEMS, limit=2)] == [12, 11]  # actions per PAM


def _rows(run_id):
    with unit_of_work() as uow:
        return {r.pam_id: r for r in uow.session.scalars(select(PamPriority).where(PamPriority.run_id == int(run_id)))}


def test_each_pam_gets_ranked_actions_at_the_end_of_its_digest_and_on_the_board(client):
    run_id = research(client, upload(client).json()["id"], ["email"]).json()["id"]
    rows = _rows(run_id)
    assert len(rows) == 2 and {r.status for r in rows.values()} == {"ready"}  # Aarav (2 signals), Priya (1)
    aarav = next(r for r in rows.values() if len(r.actions) == 2)
    assert [a["rank"] for a in aarav.actions] == [1, 2] and all(a["whyNow"] and a["action"] for a in aarav.actions)
    assert aarav.model == "fake-model"

    with unit_of_work() as uow:  # the digest waited for them and carries them
        note = uow.session.scalars(select(Notification).where(Notification.run_id == int(run_id), Notification.pam_id == aarav.pam_id)).one()
        assert [a["company"] for a in note.payload["priority_actions"]] == [a["company"] for a in aarav.actions]
    d = client.get(f"/api/v1/runs/{run_id}/board/pams/{aarav.pam_id}/digest").json()
    html = d["html"]
    assert "Priority actions" in html and "Why now?" in html and "Action:" in html
    assert html.index("Priority actions") > html.index("Recommended outreach")  # after all signals

    groups = client.get(f"/api/v1/runs/{run_id}/board/groups").json()["rows"]
    g = next(g for g in groups if g["pamId"] == str(aarav.pam_id))
    assert g["priorities"]["status"] == "ready" and len(g["priorities"]["actions"]) == 2


def test_digest_goes_out_without_the_section_when_the_ai_fails_then_retry(client, monkeypatch):
    real = providers.FakeProvider.generate
    monkeypatch.setattr(providers.FakeProvider, "generate", lambda *a, **k: (_ for _ in ()).throw(ProviderError("HTTP 400: model not allowed")))
    run_id = research(client, upload(client).json()["id"], ["email"]).json()["id"]
    rows = _rows(run_id)
    assert {r.status for r in rows.values()} == {"failed"} and all("model not allowed" in r.error for r in rows.values())
    with unit_of_work() as uow:  # delivery is never blocked
        notes = uow.session.scalars(select(Notification).where(Notification.run_id == int(run_id))).all()
        assert len(notes) == 2 and all(n.payload["priority_actions"] == [] for n in notes)

    monkeypatch.setattr(providers.FakeProvider, "generate", real)
    pam = next(iter(rows))
    r = client.post(f"/api/v1/runs/{run_id}/board/pams/{pam}/priorities/retry")
    assert r.status_code == 200, r.text
    assert _rows(run_id)[pam].status == "ready" and _rows(run_id)[pam].actions
    with unit_of_work() as uow:  # the refreshed digest carries them
        note = uow.session.scalars(select(Notification).where(Notification.run_id == int(run_id), Notification.pam_id == pam)).one()
        assert note.payload["priority_actions"]


def test_rate_limited_priority_call_waits_without_spending_attempts(client, monkeypatch):
    real, calls = providers.FakeProvider.generate, {"n": 0}

    def throttled_once(self, prompt, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ratelimit.Throttled("429 request rate limit", retry_after=0, kind="request")
        return real(self, prompt, **kw)

    monkeypatch.setattr(providers.FakeProvider, "generate", throttled_once)
    run_id = research(client, upload(client).json()["id"], []).json()["id"]
    rows = _rows(run_id)
    assert {r.status for r in rows.values()} == {"ready"} and sorted(r.attempts for r in rows.values()) == [1, 1]


def test_actions_per_pam_and_rules_are_versioned_without_invalidating_research(client):
    cur = client.get("/api/v1/research-prompt").json()["active"]
    body = {k: cur[k] for k in ("systemInstruction", "researchPrompt", "ttbsContext", "outputRules", "categories", "windowDays")}
    r = client.post("/api/v1/research-prompt", json=body | {"priorityLimit": 1, "priorityRules": cur["priorityRules"] + "\n8. Be brief."})
    assert r.status_code == 201, r.text
    assert client.post("/api/v1/research-prompt", json=body | {"priorityLimit": 99}).status_code == 422
    with unit_of_work() as uow:
        v = uow.session.scalars(select(ResearchPromptVersion).where(ResearchPromptVersion.active.is_(True))).one()
        assert (v.priority_limit, v.research_version) == (1, cur["version"])  # research text unchanged: cached answers still apply

    run_id = research(client, upload(client).json()["id"], []).json()["id"]
    assert all(len(r.actions) <= 1 for r in _rows(run_id).values())
