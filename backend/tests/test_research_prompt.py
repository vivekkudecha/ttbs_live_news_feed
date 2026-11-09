"""Editable research prompt: seeding, validation, versioning, activation/restore, run pinning,
what the provider actually receives, cache-key separation, preview and permissions."""

from sqlalchemy import select

from app.db.models import AuditLog, ResearchResult, Run
from app.db.session import unit_of_work
from app.research import providers
from app.research.parser import parse_research
from app.research.prompts import default_spec
from tests.conftest import GOOD_ROWS, anon_client, make_user, research, sign_in, upload

URL = "/api/v1/research-prompt"


def draft(client, **changes):
    a = client.get(URL).json()["active"]
    body = {k: a[k] for k in ("systemInstruction", "researchPrompt", "ttbsContext", "outputRules", "categories", "windowDays")}
    return body | changes


def test_seeded_default_matches_builtin_prompt(client):
    r = client.get(URL).json()
    assert r["active"]["version"] == 1 and r["active"]["active"] and r["active"]["createdBy"] == "system"
    assert [v["version"] for v in r["versions"]] == [1]
    d = default_spec()
    assert r["active"]["researchPrompt"] == d.research_prompt and r["active"]["categories"] == list(d.categories)
    rendered = d.render("Pine Labs", "2026-10-24", "2026-11-03")
    assert "Research the company: Pine Labs" in rendered and "Research window: 2026-10-24 to 2026-11-03" in rendered
    assert "Smartflo CCaaS" in rendered and "Category: <one of: Expansion, Funding" in rendered and "{" not in rendered
    assert {p["key"] for p in r["placeholders"] if p["required"]} == {"company", "window_start", "window_end"}


def test_save_creates_new_active_version_and_restore(client):
    body = draft(client, systemInstruction="Be terse.", categories=["Expansion", "Funding", "Cloud"], windowDays=14, note="tighter")
    v2 = client.post(URL, json=body)
    assert v2.status_code == 201, v2.text
    assert v2.json()["version"] == 2 and v2.json()["active"] and v2.json()["createdBy"] == "tester"
    r = client.get(URL).json()
    assert r["active"]["version"] == 2 and r["active"]["windowDays"] == 14 and [v["active"] for v in r["versions"]] == [True, False]

    # Saving the identical text again is rejected (no empty versions).
    assert client.post(URL, json=body).status_code == 422
    # Save without activating keeps v2 live.
    v3 = client.post(URL, json=body | {"systemInstruction": "Draft", "activate": False}).json()
    assert v3["version"] == 3 and not v3["active"] and client.get(URL).json()["active"]["version"] == 2

    # Restore the built-in v1.
    assert client.post(f"{URL}/versions/1/activate").json()["active"]
    assert client.get(URL).json()["active"]["version"] == 1
    assert client.get(f"{URL}/versions/2").json()["systemInstruction"] == "Be terse."
    assert client.post(f"{URL}/versions/99/activate").status_code == 404
    with unit_of_work() as uow:
        actions = [a for (a,) in uow.session.execute(select(AuditLog.action).where(AuditLog.action.like("research.prompt.%")).order_by(AuditLog.id))]
    assert actions == ["research.prompt.save", "research.prompt.save", "research.prompt.activate"]


def test_validation_lists_every_problem(client):
    bad = draft(client, researchPrompt="Research {company} please. {output_rules} {ttbs_context} {foo}", categories=[], windowDays=0,
                systemInstruction="  ")
    r = client.post(URL, json=bad)
    assert r.status_code == 422
    assert set(r.json()["error"]["details"]["fields"]) == {"systemInstruction", "categories", "windowDays"}

    # Missing window placeholders and unknown tokens are caught once the basics are valid.
    r = client.post(URL, json=draft(client, researchPrompt="Research {company}. {ttbs_context} {output_rules} {colour}"))
    msg = str(r.json())
    assert r.status_code == 422 and "{window_start}" in msg and "{colour}" in msg

    # The answer format must keep the lines the parser reads.
    rules = draft(client)["outputRules"].replace("Opportunity type:", "Opportunity:")
    r = client.post(URL, json=draft(client, outputRules=rules))
    assert r.status_code == 422 and "Opportunity type:" in str(r.json())

    # 'None' is reserved.
    assert client.post(URL, json=draft(client, categories=["Expansion", "none"])).status_code == 422


def test_runs_pin_the_active_version_and_provider_gets_it(client, monkeypatch):
    seen = []
    real = providers.FakeProvider.research

    def spy(self, company, ws, we, prompt=None):
        seen.append((prompt.version, prompt.render(company, ws.isoformat(), we.isoformat()), prompt.system, (we - ws).days))
        return real(self, company, ws, we, prompt)

    monkeypatch.setattr(providers.FakeProvider, "research", spy)
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    assert seen[-1][0] == 1

    client.post(URL, json=draft(client, systemInstruction="Custom system", windowDays=7,
                                ttbsContext="TTBS sells **Smart Internet** only.", categories=["Expansion", "Network"]))
    run_id = research(client, imp["id"], ["email"]).json()["id"]
    version, prompt, system, days = seen[-1]
    assert version == 2 and system == "Custom system" and days == 7
    assert "TTBS sells **Smart Internet** only." in prompt and "Expansion, Network" in prompt and "Pine Labs" in prompt
    with unit_of_work() as uow:
        run = uow.session.get(Run, int(run_id))
        assert run.prompt_version == 2
        res = uow.session.scalars(select(ResearchResult).where(ResearchResult.run_id == run.id)).one()
        assert not res.cached  # v2 answers never come from v1's cache
    assert client.get(f"/api/v1/runs/{run_id}").json()["promptVersion"] == 2


def test_parser_uses_the_versions_categories():
    text = "X\nCategory: Network\nKey signals: new branches (https://a.example/x)\nOpportunity type: SD-WAN\nRecommended outreach approach: call CIO"
    assert parse_research(text).category is None
    assert parse_research(text, ("Expansion", "Network")).category == "Network"


def test_preview_renders_draft_and_versions(client):
    r = client.post(f"{URL}/preview", json={"company": "Havells India", "draft": draft(client, windowDays=5)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Research the company: Havells India" in body["prompt"] and body["system"] and body["approxTokens"] > 100
    assert f"Research window: {body['windowStart']} to {body['windowEnd']}" in body["prompt"]
    assert client.post(f"{URL}/preview", json={"company": "Acme", "version": 1}).json()["prompt"].startswith("Research the company: Acme")
    assert client.post(f"{URL}/preview", json={"draft": draft(client, categories=[])}).status_code == 422


def test_permissions(client):
    make_user("analyst", role="member", permissions={"integrations": "view"})
    make_user("runner", role="member", permissions={"runs": "manage"})
    with anon_client() as c:
        assert sign_in(c, "analyst").status_code == 200
        assert c.get(URL).status_code == 200
        assert c.post(f"{URL}/preview", json={"company": "Acme"}).status_code == 200  # read-only POST
        assert c.post(URL, json=draft(client, systemInstruction="x")).status_code == 403
        assert c.post(f"{URL}/versions/1/activate").status_code == 403
    with anon_client() as c:
        assert sign_in(c, "runner").status_code == 200
        assert c.get(URL).status_code == 403
        assert c.get("/api/v1/templates").status_code == 200  # read-only summary stays open to everyone
