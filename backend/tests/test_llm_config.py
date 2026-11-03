"""Research AI managed from the UI (Perplexity, Gemini): list models, verify-on-save, encryption at
rest, key never returned or audited, ONE active AI at a time, and research executes with the
active provider's saved key + model only."""

import json

import pytest
import respx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db.models import AuditLog, LlmProviderConfig
from app.db.session import unit_of_work
from app.research import providers
from tests.conftest import GOOD_ROWS, research, upload

PPLX = "https://api.perplexity.ai"
GEM = "https://generativelanguage.googleapis.com"
KEY = "pplx-REALKEY-abcdef123456"
NEW_KEY = "pplx-ROTATED-zzzz98765"
GKEY = "AIzaSyREALGEMINIKEY-0001"
MODELS = {"object": "list", "data": [
    {"id": "anthropic/claude-sonnet-5", "object": "model", "created": 0, "owned_by": "anthropic"},
    {"id": "openai/gpt-5.5", "object": "model", "created": 0, "owned_by": "openai"},
    {"id": "perplexity/sonar", "object": "model", "created": 0, "owned_by": "perplexity"},
]}
GMODELS_P1 = {"models": [
    {"name": "models/gemini-3.6-flash", "displayName": "Gemini 3.6 Flash", "supportedGenerationMethods": ["generateContent", "countTokens"]},
    {"name": "models/gemini-embedding-001", "displayName": "Embedding", "supportedGenerationMethods": ["embedContent"]},
    {"name": "models/gemini-3.6-flash-image", "displayName": "Image", "supportedGenerationMethods": ["generateContent"]},
], "nextPageToken": "p2"}
GMODELS_P2 = {"models": [
    {"name": "models/gemini-4-argon", "displayName": "Gemini 4 Argon", "supportedGenerationMethods": ["generateContent"]},
    {"name": "models/gemma-4-27b", "displayName": "Gemma", "supportedGenerationMethods": ["generateContent"]},
]}
ANSWER = ("PINE LABS\nCategory: Expansion\nKey signals: New Pune office (https://example.com/a)\n"
          "Opportunity type: **SD-WAN**\nRecommended outreach approach: Call the CIO")
GEMINI_ANSWER = {
    "candidates": [{
        "content": {"role": "model", "parts": [{"text": "thinking...", "thought": True}, {"text": ANSWER}]},
        "finishReason": "STOP",
        "groundingMetadata": {"webSearchQueries": ["pine labs news"],
                              "groundingChunks": [{"web": {"uri": "https://vertexaisearch.example/r/1", "title": "economictimes.com"}}]},
    }],
    "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 200, "thoughtsTokenCount": 100},
}
DENIED = {"error": "bad key"}
GEM_DENIED = {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT",
                        "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}}


@pytest.fixture(autouse=True)
def live_mode(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "perplexity")  # i.e. "use the AI configured in the DB"
    get_settings.cache_clear()
    providers.clear_cache()


def _pplx_ok(r):
    return r.headers.get("Authorization") in (f"Bearer {KEY}", f"Bearer {NEW_KEY}")


def _gem_ok(r):
    return r.headers.get("x-goog-api-key") == GKEY and "key=" not in str(r.url)


@pytest.fixture
def ai():
    with respx.mock(assert_all_called=False) as m:
        m.get(f"{PPLX}/v1/models").mock(side_effect=lambda r: respx.MockResponse(200, json=MODELS) if _pplx_ok(r) else respx.MockResponse(401, json=DENIED))
        m.post(f"{PPLX}/v1/agent").mock(side_effect=lambda r: respx.MockResponse(200, json={"status": "completed", "output_text": ANSWER,
                                                                                            "usage": {"input_tokens": 10, "output_tokens": 5, "cost": 0.002}})
                                        if _pplx_ok(r) else respx.MockResponse(401, json=DENIED))

        def gem_models(r):
            if not _gem_ok(r):
                return respx.MockResponse(400, json=GEM_DENIED)
            return respx.MockResponse(200, json=GMODELS_P2 if r.url.params.get("pageToken") == "p2" else GMODELS_P1)

        m.get(f"{GEM}/v1beta/models").mock(side_effect=gem_models)
        m.post(url__regex=rf"{GEM}/v1beta/models/[^/]+:generateContent").mock(
            side_effect=lambda r: respx.MockResponse(200, json=GEMINI_ANSWER) if _gem_ok(r) else respx.MockResponse(400, json=GEM_DENIED))
        yield m


def _cfg(body, provider):
    return next(p for p in body["providers"] if p["provider"] == provider)


def _commit_now(client, rows=GOOD_ROWS[:1]):
    imp = upload(client, rows).json()
    return research(client, imp["id"], [])


# --- Perplexity -----------------------------------------------------------------------------------


def test_nothing_active_blocks_runs(client):
    body = client.get("/api/v1/settings/llm").json()
    assert body["active"] is None and body["mode"] == "perplexity"
    assert [p["provider"] for p in body["providers"]] == ["perplexity", "gemini"]
    imp = upload(client, GOOD_ROWS[:1]).json()
    r = research(client, imp["id"], [])
    assert r.status_code == 422 and r.json()["error"]["code"] == "provider_not_configured"
    # The dataset itself is saved independently of research; no run was created.
    assert client.get(f"/api/v1/imports/{imp['id']}").json()["status"] == "completed"
    assert client.get("/api/v1/runs").json()["total"] == 0


def test_list_models_with_typed_key(client, ai):
    r = client.post("/api/v1/settings/llm/perplexity/models", json={"apiKey": KEY})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["id"] for m in body["models"]] == ["anthropic/claude-sonnet-5", "openai/gpt-5.5", "perplexity/sonar"]
    assert body["providers"] == [{"key": "anthropic", "count": 1}, {"key": "openai", "count": 1}, {"key": "perplexity", "count": 1}]

    bad = client.post("/api/v1/settings/llm/perplexity/models", json={"apiKey": "pplx-wrong-000000000"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_api_key"
    assert client.post("/api/v1/settings/llm/perplexity/models", json={}).json()["error"]["code"] == "api_key_required"
    assert client.post("/api/v1/settings/llm/openai/models", json={}).status_code == 422  # unsupported provider


def test_save_verifies_encrypts_and_never_returns_key(client, ai):
    r = client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/gpt-5.5"})
    assert r.status_code == 200, r.text
    body = r.json()
    cfg = _cfg(body, "perplexity")
    assert body["active"] == "perplexity" and cfg["active"] and cfg["configured"]
    assert cfg["model"] == "openai/gpt-5.5" and cfg["modelProvider"] == "openai"
    assert cfg["keyHint"] == "pplx-…3456" and cfg["lastCheckOk"] is True and cfg["updatedBy"] == "tester"
    assert KEY not in r.text and KEY not in client.get("/api/v1/settings/llm").text

    with unit_of_work() as uow:
        row = uow.session.scalars(select(LlmProviderConfig)).one()
        assert row.api_key_enc.startswith("v1:") and KEY not in row.api_key_enc
        audits = uow.session.scalars(select(AuditLog).where(AuditLog.action.like("llm.%"))).all()
        assert [a.action for a in audits] == ["llm.config.save"]
        assert KEY not in json.dumps([a.detail for a in audits])
    assert client.get("/api/v1/audit/verify").json()["ok"] is True

    agent_call = [c for c in ai.calls if c.request.url.path == "/v1/agent"][-1].request
    assert agent_call.headers["Authorization"] == f"Bearer {KEY}" and json.loads(agent_call.content)["model"] == "openai/gpt-5.5"


def test_save_rejects_bad_key_and_unknown_model(client, ai):
    r = client.put("/api/v1/settings/llm/perplexity", json={"apiKey": "pplx-wrong-000000000", "model": "openai/gpt-5.5"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_api_key"
    r = client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/not-a-model"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_model"
    r = client.put("/api/v1/settings/llm/perplexity", json={"apiKey": "short", "model": "openai/gpt-5.5"})
    assert r.json()["error"]["code"] == "invalid_api_key"
    assert client.get("/api/v1/settings/llm").json()["active"] is None


def test_change_model_keeps_key_then_rotate_key(client, ai):
    client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/gpt-5.5"})
    assert client.post("/api/v1/settings/llm/perplexity/models", json={}).status_code == 200
    r = _cfg(client.put("/api/v1/settings/llm/perplexity", json={"model": "anthropic/claude-sonnet-5"}).json(), "perplexity")
    assert r["model"] == "anthropic/claude-sonnet-5" and r["keyHint"] == "pplx-…3456"
    r = _cfg(client.put("/api/v1/settings/llm/perplexity", json={"apiKey": NEW_KEY, "model": "perplexity/sonar"}).json(), "perplexity")
    assert r["keyHint"] == "pplx-…8765"


def test_research_runs_with_saved_perplexity_key_and_model(client, ai):
    client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "anthropic/claude-sonnet-5"})
    r = _commit_now(client)
    assert r.status_code == 201, r.text
    run = client.get(f"/api/v1/runs/{r.json()["id"]}").json()
    assert run["status"] == "completed" and run["withSignal"] == 1

    research = [c.request for c in ai.calls if c.request.url.path == "/v1/agent" and b"web_search" in c.request.content]
    assert len(research) == 1
    assert research[0].headers["Authorization"] == f"Bearer {KEY}"
    assert json.loads(research[0].content)["model"] == "anthropic/claude-sonnet-5"


def test_test_connection_records_failure_and_remove(client, ai):
    client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/gpt-5.5"})
    ok = client.post("/api/v1/settings/llm/perplexity/test").json()
    assert ok["ok"] is True and _cfg(ok, "perplexity")["lastCheckOk"] is True

    ai.post(f"{PPLX}/v1/agent").respond(401, json={"error": "revoked"})  # key revoked at Perplexity
    bad = client.post("/api/v1/settings/llm/perplexity/test").json()
    assert bad["ok"] is False and _cfg(bad, "perplexity")["lastCheckOk"] is False and "rejected" in bad["error"]

    assert client.delete("/api/v1/settings/llm/perplexity").status_code == 204
    assert client.get("/api/v1/settings/llm").json()["active"] is None
    actions = [a["action"] for a in client.get("/api/v1/audit?pageSize=50").json()["rows"]]
    assert {"llm.config.save", "llm.config.test", "llm.config.remove"} <= set(actions)


# --- Gemini + one active AI -----------------------------------------------------------------------


def test_gemini_models_are_paged_and_filtered_and_bad_key_detected(client, ai):
    body = client.post("/api/v1/settings/llm/gemini/models", json={"apiKey": GKEY}).json()
    assert [m["id"] for m in body["models"]] == ["gemini-4-argon", "gemini-3.6-flash"]  # no embedding/image/gemma
    assert body["providers"] == [{"key": "google", "count": 2}]
    assert body["models"][1]["name"] == "Gemini 3.6 Flash"

    bad = client.post("/api/v1/settings/llm/gemini/models", json={"apiKey": "AIzaWRONGKEY-00000"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_api_key"
    assert bad.json()["error"]["message"] == "Google Gemini rejected this API key"


def test_saving_gemini_switches_perplexity_off_and_research_uses_gemini(client, ai):
    client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/gpt-5.5"})
    r = client.put("/api/v1/settings/llm/gemini", json={"apiKey": GKEY, "model": "gemini-3.6-flash"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["active"] == "gemini"
    assert _cfg(body, "gemini")["active"] and _cfg(body, "gemini")["keyHint"] == "…0001"
    assert _cfg(body, "perplexity")["configured"] and not _cfg(body, "perplexity")["active"]  # kept, but off
    assert GKEY not in r.text

    pplx_calls_before = len([c for c in ai.calls if c.request.url.host == "api.perplexity.ai"])
    run_id = _commit_now(client).json()["id"]
    run = client.get(f"/api/v1/runs/{run_id}").json()
    assert run["status"] == "completed" and run["withSignal"] == 1
    assert len([c for c in ai.calls if c.request.url.host == "api.perplexity.ai"]) == pplx_calls_before  # Perplexity untouched

    research = [c.request for c in ai.calls if c.request.url.path.endswith(":generateContent") and b"systemInstruction" in c.request.content][-1]
    assert research.url.path == "/v1beta/models/gemini-3.6-flash:generateContent"
    assert research.headers["x-goog-api-key"] == GKEY and "key=" not in str(research.url)
    assert json.loads(research.content)["tools"] == [{"google_search": {}}]

    res = client.get(f"/api/v1/runs/{run_id}/results").json()["rows"][0]
    assert res["sources"][0]["url"] == "https://vertexaisearch.example/r/1"  # grounded source first
    assert any(s["url"] == "https://example.com/a" for s in res["sources"])
    with unit_of_work() as uow:
        details = [a.detail for a in uow.session.scalars(select(AuditLog).where(AuditLog.action == "llm.config.save"))]
    assert next(d for d in details if d["provider"] == "gemini")["switched_off"] == ["perplexity"]


def test_activate_switches_back_without_reentering_key(client, ai):
    client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/gpt-5.5"})
    client.put("/api/v1/settings/llm/gemini", json={"apiKey": GKEY, "model": "gemini-3.6-flash"})
    r = client.post("/api/v1/settings/llm/perplexity/activate")
    assert r.status_code == 200 and r.json()["active"] == "perplexity"
    assert not _cfg(r.json(), "gemini")["active"]
    assert client.post("/api/v1/settings/llm/perplexity/activate").json()["active"] == "perplexity"  # idempotent

    # Activation re-verifies: a revoked key cannot become active.
    ai.post(url__regex=rf"{GEM}/v1beta/models/[^/]+:generateContent").respond(400, json=GEM_DENIED)
    bad = client.post("/api/v1/settings/llm/gemini/activate")
    assert bad.status_code == 422 and client.get("/api/v1/settings/llm").json()["active"] == "perplexity"
    assert client.get("/api/v1/health").json()["activeAi"] == "perplexity"


def test_removing_active_ai_blocks_runs_even_if_another_is_saved(client, ai):
    client.put("/api/v1/settings/llm/perplexity", json={"apiKey": KEY, "model": "openai/gpt-5.5"})
    client.put("/api/v1/settings/llm/gemini", json={"apiKey": GKEY, "model": "gemini-3.6-flash"})
    client.delete("/api/v1/settings/llm/gemini")
    body = client.get("/api/v1/settings/llm").json()
    assert body["active"] is None and _cfg(body, "perplexity")["configured"]  # no silent fallback
    assert _commit_now(client).json()["error"]["code"] == "provider_not_configured"


def test_database_refuses_two_active_providers():
    with pytest.raises(IntegrityError), unit_of_work() as uow:
        for p in ("perplexity", "gemini"):
            uow.session.add(LlmProviderConfig(provider=p, active=True, api_key_enc="v1:x", key_hint="…", model="m",
                                              model_provider="x", updated_by="t"))
        uow.session.flush()
