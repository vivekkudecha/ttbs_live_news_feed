"""Run results board: PAM groups with logo sub-rows, facets, per-logo timeline, bulk retry / resend."""

import json

from app.core.config import get_settings
from app.core.errors import ProviderError
from app.research import providers
from tests.conftest import research, upload


def _run(client, monkeypatch, fail="Havells"):
    monkeypatch.setattr(get_settings(), "fake_signal_rate", 1.0)
    real = providers.FakeProvider.research

    def picky(self, company, ws, we, prompt=None):
        if fail and company.startswith(fail):
            raise ProviderError("HTTP 429 rate limited, gave up")
        return real(self, company, ws, we, prompt)

    monkeypatch.setattr(providers.FakeProvider, "research", picky)
    imp = upload(client).json()
    run_id = research(client, imp["id"], ["whatsapp"]).json()["id"]
    return run_id, real


def test_groups_logos_and_facets(client, monkeypatch):
    run_id, _ = _run(client, monkeypatch)
    g = client.get(f"/api/v1/runs/{run_id}/board/groups").json()
    assert g["total"] == 2
    by = {r["pamName"]: r for r in g["rows"]}
    assert by["Priya Nair"]["failed"] == 1 and by["Aarav Mehta"]["signal"] == 2
    assert g["rows"][0]["pamName"] == "Priya Nair"  # PAMs with failures first
    assert by["Aarav Mehta"]["digests"]["whatsapp"]["status"] == "sent"

    sub = client.get(f"/api/v1/runs/{run_id}/board/logos", params={"pamId": by["Aarav Mehta"]["pamId"]}).json()
    assert sub["total"] == 2 and {r["pamName"] for r in sub["rows"]} == {"Aarav Mehta"}

    # Search covers company and PAM names; column filters narrow the groups too.
    assert client.get(f"/api/v1/runs/{run_id}/board/logos", params={"q": "priya"}).json()["total"] == 1
    flt = json.dumps({"status": ["signal"]})
    assert client.get(f"/api/v1/runs/{run_id}/board/groups", params={"filter": flt}).json()["total"] == 1
    srt = client.get(f"/api/v1/runs/{run_id}/board/groups", params={"sort": "findings", "desc": "true"}).json()["rows"]
    assert srt[0]["pamName"] == "Aarav Mehta"
    assert client.get(f"/api/v1/runs/{run_id}/board/groups", params={"sort": "nope"}).status_code == 422

    f = client.get(f"/api/v1/runs/{run_id}/board/facets", params={"filter": flt}).json()
    assert f["status"] == {"signal": 2, "failed": 1, "pending": 0} and f["all"] == 3  # the status facet ignores its own filter
    assert {p["label"] for p in f["pams"]} == {"Aarav Mehta"}

    # The PAM picker / "Show only this PAM" filter (ids arrive as strings).
    pam = json.dumps({"pam": [by["Priya Nair"]["pamId"]]})
    only = client.get(f"/api/v1/runs/{run_id}/board/logos", params={"filter": pam}).json()
    assert only["total"] == 1 and only["rows"][0]["pamName"] == "Priya Nair"
    assert client.get(f"/api/v1/runs/{run_id}/board/groups", params={"filter": pam}).json()["total"] == 1


def test_timeline_retry_and_resend(client, monkeypatch):
    run_id, real = _run(client, monkeypatch)
    rows = client.get(f"/api/v1/runs/{run_id}/board/logos").json()["rows"]
    failed = next(r for r in rows if r["status"] == "failed")
    t = client.get(f"/api/v1/runs/{run_id}/board/logos/{failed['id']}/timeline").json()
    assert t["logo"]["companyName"].startswith("Havells") and t["logo"]["error"]
    assert any(e["kind"] == "research.attempt" and e["status"] == "error" for e in t["events"])
    assert t["digests"][0]["includesLogo"] is False

    monkeypatch.setattr(providers.FakeProvider, "research", real)
    assert client.post(f"/api/v1/runs/{run_id}/board/retry", json={"resultIds": [failed["id"]]}).json() == {"requeued": 1}
    assert client.post(f"/api/v1/runs/{run_id}/board/retry", json={"resultIds": [failed["id"]]}).json() == {"requeued": 0}
    t = client.get(f"/api/v1/runs/{run_id}/board/logos/{failed['id']}/timeline").json()
    assert t["logo"]["status"] == "signal" and t["digests"][0]["includesLogo"] is True
    assert any(e["kind"] == "run.retry_selected" for e in t["events"])

    pams = [r["pamId"] for r in client.get(f"/api/v1/runs/{run_id}/board/groups").json()["rows"]]
    r = client.post(f"/api/v1/runs/{run_id}/board/resend", json={"pamIds": pams}).json()
    assert r == {"requeued": 2, "skipped": 0}
    assert client.post(f"/api/v1/runs/{run_id}/board/resend", json={"pamIds": []}).status_code == 422


def test_digest_preview_renders_current_results(client, monkeypatch):
    run_id, _ = _run(client, monkeypatch, fail=None)
    pam = client.get(f"/api/v1/runs/{run_id}/board/groups").json()["rows"][0]
    d = client.get(f"/api/v1/runs/{run_id}/board/pams/{pam['pamId']}/digest").json()
    assert d["asSent"] is False and d["subject"] and d["html"]
