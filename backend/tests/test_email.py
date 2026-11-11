"""Email backend: Microsoft Graph (app-to-app) settings, time-bucket quota dispatcher, templates with
AI summary, retries with backoff, attempts trail and the dead-letter queue."""

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
import respx
from sqlalchemy import func, select

from app.core.config import get_settings
from app.db.models import (
    AuditLog,
    DeadLetter,
    EmailConfig,
    EmailSendBucket,
    Notification,
    NotificationAttempt,
    Pam,
)
from app.db.session import unit_of_work
from app.notify import graph
from app.services import email_config, email_quota
from tests.conftest import GOOD_ROWS, anon_client, make_user, research, sign_in, upload

TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SECRET = "Xy7Q~very.secret-value_123"
SENDER = "signals@contoso.com"
TOKEN_URL = f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token"
SEND_URL = f"https://graph.microsoft.com/v1.0/users/{SENDER}/sendMail"


def jwt(roles=("Mail.Send",)) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"roles": list(roles), "aud": "https://graph.microsoft.com"}).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{payload}.sig"


@pytest.fixture(autouse=True)
def _clean_tokens():
    graph.clear_token_cache()
    yield
    graph.clear_token_cache()


@pytest.fixture
def ms():
    """Microsoft endpoints: token issues a Mail.Send token for the right secret; sendMail accepts."""
    with respx.mock(assert_all_called=False) as m:
        m.post(TOKEN_URL).mock(side_effect=lambda r: respx.MockResponse(200, json={"access_token": jwt(), "expires_in": 3599})
                               if f"client_secret={SECRET.replace('~', '%7E')}" in r.content.decode() or "client_secret=" + SECRET in r.content.decode()
                               else respx.MockResponse(401, json={"error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret"}))
        m.send = m.post(SEND_URL).mock(return_value=respx.MockResponse(202, headers={"request-id": "rid-1"}))
        yield m


def configure(client, **extra):
    body = {"tenantId": TENANT, "clientId": CLIENT, "clientSecret": SECRET, "senderAddress": SENDER, "senderName": "TTBS Signals",
            "replyTo": "sales-ops@contoso.com"} | extra
    return client.put("/api/v1/settings/email", json=body)


# --- Settings ------------------------------------------------------------------------------------


def test_save_verifies_encrypts_and_never_returns_secret(client, ms):
    r = configure(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] and body["enabled"] and body["connection"]["secretHint"].endswith(SECRET[-4:])
    assert SECRET not in r.text
    with unit_of_work() as uow:
        row = uow.session.get(EmailConfig, 1)
        assert row.client_secret_enc.startswith("v1:") and SECRET not in row.client_secret_enc
        audits = [a.detail for a in uow.session.scalars(select(AuditLog).where(AuditLog.action == "email.config.save"))]
    assert audits and SECRET not in json.dumps(audits)
    # Keep the saved secret when it is omitted (same tenant + app).
    r = client.put("/api/v1/settings/email", json={"tenantId": TENANT, "clientId": CLIENT, "senderAddress": SENDER, "senderName": "Renamed"})
    assert r.status_code == 200 and r.json()["connection"]["senderName"] == "Renamed"


def test_save_rejects_bad_secret_missing_role_and_bad_ids(client, ms):
    r = configure(client, clientSecret="wrong-secret-value")
    assert r.status_code == 422 and "Invalid client secret" in r.json()["error"]["message"]
    ms.post(TOKEN_URL).mock(return_value=respx.MockResponse(200, json={"access_token": jwt(roles=("User.Read.All",)), "expires_in": 3599}))
    r = configure(client)
    assert r.status_code == 422 and "Mail.Send" in r.json()["error"]["message"]
    assert configure(client, clientId="not-a-guid").status_code == 422
    assert configure(client, senderAddress="nope").status_code == 422
    with unit_of_work() as uow:
        assert uow.session.get(EmailConfig, 1) is None  # nothing saved on failure


def test_limits_and_policy_validation(client, ms):
    assert client.put("/api/v1/settings/email/limits", json={"perMinute": 30, "perHour": 3600, "perDay": 10000, "safetyMarginPct": 5}).status_code == 404
    configure(client)
    r = client.put("/api/v1/settings/email/limits", json={"perMinute": 20, "perHour": 1000, "perDay": 5000, "safetyMarginPct": 10})
    assert r.status_code == 200 and r.json()["limits"]["effective"] == {"perMinute": 18, "perHour": 900, "perDay": 4500}
    bad = client.put("/api/v1/settings/email/limits", json={"perMinute": 100, "perHour": 50, "perDay": 5000, "safetyMarginPct": 0})
    assert bad.status_code == 422
    r = client.put("/api/v1/settings/email/policy", json={"maxAttempts": 3, "backoffBaseS": 30, "backoffCapS": 600, "sendWhenNoSignals": True})
    assert r.status_code == 200 and r.json()["policy"]["maxAttempts"] == 3


def test_test_send_counts_against_quota(client, ms):
    configure(client)
    r = client.post("/api/v1/settings/email/test-send", json={"to": "me@contoso.com"})
    assert r.status_code == 200 and r.json()["requestId"] == "rid-1"
    sent = json.loads(ms.send.calls.last.request.content)
    assert sent["message"]["toRecipients"][0]["emailAddress"]["address"] == "me@contoso.com"
    with unit_of_work() as uow:
        assert uow.session.scalar(select(func.sum(EmailSendBucket.used))) == 1


def test_member_without_integrations_cannot_manage_email(client):
    make_user("viewer", role="member", permissions={"runs": "manage"})
    with anon_client() as c:
        assert sign_in(c, "viewer").status_code == 200
        assert c.get("/api/v1/settings/email").status_code == 403
        assert c.get("/api/v1/email-templates").status_code == 403
        assert c.get("/api/v1/notifications/dead-letters").status_code == 200  # runs module


# --- Delivery through Graph ---------------------------------------------------------------------------


def test_pipeline_sends_rendered_email_through_graph(client, ms):
    configure(client)
    imp = upload(client).json()
    run_id = research(client, imp["id"], ["email"]).json()["id"]
    run = client.get(f"/api/v1/runs/{run_id}").json()
    assert run["notifications"]["sent"] == 2
    assert ms.send.call_count == 2
    msg = json.loads(ms.send.calls[0].request.content)["message"]
    assert msg["body"]["contentType"] == "HTML" and "TTBS Signals" in msg["body"]["content"]
    assert msg["subject"].startswith("TTBS signals:")
    assert msg["replyTo"][0]["emailAddress"]["address"] == "sales-ops@contoso.com"
    assert msg["internetMessageHeaders"][0]["name"] == "X-TTBS-Notification-Id"
    with unit_of_work() as uow:
        note = uow.session.scalars(select(Notification).where(Notification.channel == "email")).first()
        assert note.rendered["subject"] == msg["subject"] or note.rendered["subject"]
        assert note.template_version == 1 and note.reserved_at is None
        tries = uow.session.scalars(select(NotificationAttempt).where(NotificationAttempt.notification_id == note.id)).all()
        assert [(t.outcome, t.adapter, t.provider_request_id) for t in tries] == [("sent", "graph", "rid-1")]
        assert uow.session.scalar(select(func.sum(EmailSendBucket.used))) == 2
    detail = client.get(f"/api/v1/notifications/{note.id}/detail").json()
    assert detail["rendered"]["html"] and detail["history"][0]["outcome"] == "sent"


def test_401_refreshes_token_once(client, ms):
    configure(client)
    calls = {"n": 0}

    def flaky(_):
        calls["n"] += 1
        return respx.MockResponse(401, json={"error": {"code": "InvalidAuthenticationToken"}}) if calls["n"] == 1 else respx.MockResponse(202)

    ms.post(SEND_URL).mock(side_effect=flaky)
    imp = upload(client, GOOD_ROWS[:1]).json()
    run_id = research(client, imp["id"], ["email"]).json()["id"]
    assert client.get(f"/api/v1/runs/{run_id}").json()["notifications"]["sent"] == 1


def test_429_pauses_dispatcher_refunds_quota_and_retries(client, ms):
    configure(client)
    ms.post(SEND_URL).mock(return_value=respx.MockResponse(429, headers={"Retry-After": "120"},
                                                           json={"error": {"code": "ApplicationThrottled", "message": "slow down"}}))
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    with unit_of_work() as uow:
        note = uow.session.scalars(select(Notification)).one()
        assert note.status == "pending" and note.attempts == 1 and note.reserved_at is None
        assert (as_utc(note.next_attempt_at) - datetime.now(UTC)).total_seconds() >= 110  # honours Retry-After
        cfg = uow.session.get(EmailConfig, 1)
        assert cfg.paused_until is not None and "429" in cfg.pause_reason
        assert (uow.session.scalar(select(func.sum(EmailSendBucket.used))) or 0) == 0  # refunded
        t = uow.session.scalars(select(NotificationAttempt)).one()
        assert (t.outcome, t.http_status, t.error_code, t.retryable) == ("retry", 429, "ApplicationThrottled", True)
        nid = note.id
    assert email_quota.dispatch()["reason"] == "paused"
    # Throttling over: resume, the retry becomes due, Graph accepts.
    ms.post(SEND_URL).mock(return_value=respx.MockResponse(202))
    client.post("/api/v1/settings/email/resume")
    with unit_of_work() as uow:
        uow.session.get(Notification, nid).next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
    email_quota.dispatch()
    with unit_of_work() as uow:
        assert uow.session.get(Notification, nid).status == "sent"


def test_permanent_error_goes_to_dead_letter_queue_then_requeue(client, ms):
    configure(client)
    ms.post(SEND_URL).mock(return_value=respx.MockResponse(403, json={"error": {"code": "ErrorAccessDenied", "message": "Access is denied."}}))
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    dl = client.get("/api/v1/notifications/dead-letters").json()
    assert dl["total"] == 1
    row = dl["rows"][0]
    assert row["reason"] == "permanent" and "Mail.Send" in row["lastError"] and row["history"][0]["httpStatus"] == 403
    actions = [a["action"] for a in client.get("/api/v1/audit?pageSize=200").json()["rows"]]
    assert "notify.dead_letter" in actions

    ms.post(SEND_URL).mock(return_value=respx.MockResponse(202))
    r = client.post("/api/v1/notifications/dead-letters/requeue", json={"ids": [int(row["id"])]})
    assert r.json() == {"requeued": 1}
    with unit_of_work() as uow:
        note = uow.session.get(Notification, int(row["notificationId"]))
        assert note.status == "sent" and note.attempts == 1
        assert uow.session.get(DeadLetter, int(row["id"])).status == "requeued"
        assert len(uow.session.scalars(select(NotificationAttempt).where(NotificationAttempt.notification_id == note.id)).all()) == 2
    assert client.get("/api/v1/notifications/dead-letters").json()["total"] == 0


def test_retries_exhaust_into_dead_letter_and_discard_needs_note(client, ms):
    configure(client)
    client.put("/api/v1/settings/email/policy", json={"maxAttempts": 2, "backoffBaseS": 5, "backoffCapS": 30, "sendWhenNoSignals": False})
    ms.post(SEND_URL).mock(return_value=respx.MockResponse(503, json={"error": {"code": "ServiceUnavailable", "message": "busy"}}))
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    with unit_of_work() as uow:
        note = uow.session.scalars(select(Notification)).one()
        assert note.status == "pending" and note.attempts == 1
        note.next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
    email_quota.dispatch()
    dl = client.get("/api/v1/notifications/dead-letters").json()["rows"]
    assert len(dl) == 1 and dl[0]["reason"] == "exhausted" and dl[0]["attempts"] == 2
    assert client.post(f"/api/v1/notifications/dead-letters/{dl[0]['id']}/discard", json={"note": "x"}).status_code == 422
    r = client.post(f"/api/v1/notifications/dead-letters/{dl[0]['id']}/discard", json={"note": "Recipient left the company"})
    assert r.status_code == 200 and r.json()["status"] == "discarded"
    assert client.get("/api/v1/notifications/dead-letters?status=discarded").json()["total"] == 1


def test_disabled_email_holds_the_outbox(client, ms):
    configure(client, enabled=False)
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    assert ms.send.call_count == 0
    with unit_of_work() as uow:
        assert uow.session.scalars(select(Notification)).one().status == "pending"
    client.post("/api/v1/settings/email/enable", json={"enabled": True})
    with unit_of_work() as uow:
        assert uow.session.scalars(select(Notification)).one().status == "sent"


# --- Quota buckets & dispatcher ---------------------------------------------------------------------


def _seed_backlog(client, n: int) -> list[int]:
    """n pending, unreserved email rows (one per PAM) on one run, oldest first."""
    imp = upload(client, GOOD_ROWS[:1]).json()
    run_id = int(research(client, imp["id"], ["whatsapp"]).json()["id"])
    t0 = datetime(2026, 11, 1, tzinfo=UTC)
    ids = []
    with unit_of_work() as uow:
        for i in range(n):
            p = Pam(name=f"PAM {i}", email=f"pam{i}@contoso.com")
            uow.session.add(p)
            uow.session.flush()
            note = Notification(run_id=run_id, pam_id=p.id, channel="email", recipient=p.email, status="pending",
                                payload={"subject": "s", "body": "b", "signals": 1, "total": 1, "items": []},
                                next_attempt_at=t0 + timedelta(seconds=i))
            uow.session.add(note)
            uow.session.flush()
            ids.append(note.id)
    return ids


def test_capacity_is_min_of_rolling_windows():
    lim = email_config.limits(None)
    assert (lim.minute, lim.hour, lim.day) == (28, 3420, 9500)  # 30 / 3,600 / 10,000 minus 5 %
    k = 1_000_000
    assert email_quota.capacity(lim, email_quota.usage({k: 10}, k)) == 18
    hour_full = {k - i: 57 for i in range(60)}  # 3,420 in the last hour
    assert email_quota.capacity(lim, email_quota.usage(hour_full, k)) == 0
    # A minute later the oldest bucket (57) rolled out of the hour: 57 free there, so the minute limit binds.
    assert email_quota.capacity(lim, email_quota.usage(hour_full, k + 1)) == 28
    assert email_quota.usage(hour_full, k + 1)["hour"] == 3420 - 57
    day_full = {k - i * 10: 95 for i in range(100)}  # 9,500 spread over the last ~17 hours
    assert email_quota.capacity(lim, email_quota.usage(day_full, k)) == 0


def test_backlog_beyond_daily_limit_drains_over_days_in_order(client, monkeypatch):
    """The user's scenario, scaled down: limits 3/min, 10/h, 25/day and a backlog of 60. Every turn
    fills the free bucket capacity with the oldest pending emails; when a bucket is full it waits for
    the next window (jumping to the forecast's nextFreeAt) and resumes from the pending ones."""
    from app.worker import tasks

    ids = _seed_backlog(client, 60)
    with unit_of_work() as uow:
        uow.session.add(EmailConfig(id=1, enabled=True, tenant_id=TENANT, client_id=CLIENT, client_secret_enc="x", secret_hint="…",
                                    sender_address=SENDER, per_minute=3, per_hour=10, per_day=25, safety_margin_pct=0,
                                    max_attempts=6, backoff_base_s=60, backoff_cap_s=3600, send_when_no_signals=False, updated_by="t"))
    handed: list[tuple[int, int]] = []  # (minute, notification id)
    monkeypatch.setattr(tasks.send_notification, "apply_async", lambda args, **k: handed.append((cur[0], args[0])))

    now = datetime(2026, 11, 2, tzinfo=UTC)
    cur = [email_quota.minute_key(now)]
    for _ in range(2000):
        cur[0] = email_quota.minute_key(now)
        before = len(handed)
        r = email_quota.dispatch(now, horizon_s=60)
        with unit_of_work() as uow:  # "workers" send what was handed out
            for _, nid in handed[before:]:
                n = uow.session.get(Notification, nid)
                n.status, n.reserved_at, n.sent_at = "sent", None, now
        if len(handed) == len(ids):
            break
        if r["reason"] == "quota":
            with unit_of_work() as uow:
                nxt = datetime.fromisoformat(email_quota.status(uow, now)["nextFreeAt"])
            now = max(now + timedelta(minutes=1), nxt)
        else:
            now += timedelta(minutes=1)
    assert [nid for _, nid in handed] == ids  # oldest pending first, nothing skipped or duplicated
    minutes = [m for m, _ in handed]
    for m in set(minutes):
        assert sum(1 for x in minutes if x == m) <= 3
        assert sum(1 for x in minutes if m - 60 < x <= m) <= 10
        assert sum(1 for x in minutes if m - 1440 < x <= m) <= 25
    span_days = (minutes[-1] - minutes[0]) / 1440
    assert 1.5 < span_days < 3  # 60 emails at 25 per rolling day


def test_status_reports_backlog_and_eta(client):
    _seed_backlog(client, 30)
    with unit_of_work() as uow:
        st = email_quota.status(uow, datetime(2026, 11, 2, tzinfo=UTC))
    assert st["mode"] == "console" and st["backlog"]["pending"] == 30 and st["capacityNow"] == 28
    eta = datetime.fromisoformat(st["drainEta"])
    assert eta == datetime(2026, 11, 2, 0, 2, tzinfo=UTC)  # 28 in the first minute, 2 in the second
    big = email_quota.forecast(email_config.limits(None), {}, 0, 25_000)
    assert big["eta"] is not None and 2 * 1440 < (big["eta"] - email_quota.key_start(0)).total_seconds() / 60 < 3 * 1440


def test_sweeper_releases_lapsed_reservations(client, monkeypatch):
    from app.services import maintenance
    from app.worker import tasks

    monkeypatch.setattr(tasks.send_notification, "apply_async", lambda *a, **k: None)  # worker message lost
    _seed_backlog(client, 2)
    assert email_quota.dispatch(datetime.now(UTC) - timedelta(minutes=10), horizon_s=60)["dispatched"] == 2
    monkeypatch.undo()
    assert maintenance.recover_stuck()["notifications"] == 2
    with unit_of_work() as uow:
        assert {n.status for n in uow.session.scalars(select(Notification).where(Notification.channel == "email"))} == {"sent"}


# --- Templates & AI ---------------------------------------------------------------------------------


TPL = {"name": "Short", "subjectTpl": "{{ counts.signals }} for {{ pam.first_name }}",
       "htmlTpl": "<p>{{ ai_summary }}</p>{% for s in signals %}<b>{{ s.company }}</b>{{ s.key_signals | rich }}{% endfor %}",
       "textTpl": "", "aiEnabled": True, "aiMaxWords": 40}


def test_template_crud_versions_and_activation(client):
    lst = client.get("/api/v1/email-templates").json()
    assert len(lst) == 1 and lst[0]["active"] and lst[0]["name"] == "PAM digest (default)"
    t = client.post("/api/v1/email-templates", json=TPL).json()
    assert t["version"] == 1 and not t["active"]
    t2 = client.put(f"/api/v1/email-templates/{t['id']}", json=TPL | {"subjectTpl": "Hi {{ pam.name }}", "note": "shorter"}).json()
    assert t2["version"] == 2
    vers = client.get(f"/api/v1/email-templates/{t['id']}/versions").json()
    assert [v["version"] for v in vers] == [2, 1] and vers[0]["note"] == "shorter"
    t3 = client.post(f"/api/v1/email-templates/{t['id']}/versions/1/restore").json()
    assert t3["version"] == 3 and t3["subjectTpl"] == TPL["subjectTpl"]
    assert client.post(f"/api/v1/email-templates/{t['id']}/activate").json()["active"] is True
    assert client.delete(f"/api/v1/email-templates/{t['id']}").status_code == 409  # active
    assert sum(x["active"] for x in client.get("/api/v1/email-templates").json()) == 1


def test_template_validation_sandbox_and_escaping(client):
    r = client.post("/api/v1/email-templates", json=TPL | {"subjectTpl": "{{ pam.nmae }}"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "template_error"
    r = client.post("/api/v1/email-templates", json=TPL | {"name": "evil", "htmlTpl": "{{ ''.__class__.__mro__[1].__subclasses__() }}"})
    assert r.status_code == 422
    pv = client.post("/api/v1/email-templates/preview", json=TPL | {"htmlTpl": "{{ pam.name }} {{ '<script>x</script>' }}"}).json()
    assert "&lt;script&gt;" in pv["html"] and "<script>" not in pv["html"] and pv["sample"] is True
    pv = client.post("/api/v1/email-templates/preview", json=TPL).json()
    assert "<strong>new Pune campus</strong>" in pv["html"] and '<a href="https://example.com/news/1"' in pv["html"]


def test_ai_summary_is_rendered_once_and_costed(client, ms):
    configure(client)
    t = client.post("/api/v1/email-templates", json=TPL).json()
    client.post(f"/api/v1/email-templates/{t['id']}/activate")
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    msg = json.loads(ms.send.calls.last.request.content)["message"]
    assert "Focus first on the accounts" in msg["body"]["content"]  # FakeProvider.generate
    with unit_of_work() as uow:
        note = uow.session.scalars(select(Notification)).one()
        assert note.rendered["ai_summary"] and note.template_version == 1
        from app.db.models import CostEntry

        assert uow.session.scalars(select(CostEntry).where(CostEntry.outcome == "email_ai")).one().notification_id == note.id


@pytest.mark.parametrize("policy,expected", [("send_without", "sent"), ("hold", "pending")])
def test_ai_failure_policy(client, ms, monkeypatch, policy, expected):
    from app.core.errors import ProviderError
    from app.research.providers import FakeProvider

    def boom(self, *a, **k):
        raise ProviderError("AI is down")

    monkeypatch.setattr(FakeProvider, "generate", boom)
    configure(client)
    t = client.post("/api/v1/email-templates", json=TPL | {"aiOnFailure": policy}).json()
    client.post(f"/api/v1/email-templates/{t['id']}/activate")
    imp = upload(client, GOOD_ROWS[:1]).json()
    research(client, imp["id"], ["email"])
    with unit_of_work() as uow:
        note = uow.session.scalars(select(Notification)).one()
        assert note.status == expected
        if expected == "sent":
            assert note.rendered["ai_summary"] == "" and "AI is down" in note.rendered["ai_error"]
        else:
            assert "held" in note.last_error and ms.send.call_count == 0


def test_email_estimate_for_new_run(client):
    r = client.get("/api/v1/notifications/email-estimate?emails=20000").json()
    assert r["perDay"] == 9500 and r["remainingToday"] == 9500 and r["drainEta"]
    imp = upload(client).json()
    assert client.get(f"/api/v1/notifications/email-estimate?importId={imp['id']}").json()["emails"] == 2  # 2 PAMs


def as_utc(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def test_settings_defaults_without_config(client):
    s = client.get("/api/v1/settings/email").json()
    assert s["configured"] is False and s["quota"]["mode"] == "console"
    assert s["limits"]["perDay"] == 10000 and get_settings().email_dispatch_interval_s == 10


def test_default_digest_shows_each_account_in_sections():
    from app.services import email_templates as et

    item = {"company": "3i Infotech", "category": "Contract", "outreach": "Call the CIO",
            "key_signals": "New **IT contract** with a state utility (https://a.example/1); expansion to three more Indian cities. "
                           "Hiring 200 engineers for a new Pune campus (https://www.b.example/2)",
            "opportunity": "SD-WAN for the new sites (https://a.example/1)",
            "sources": [{"title": "Utility award", "url": "https://a.example/1"}]}
    ctx = et.context({"pam": {"name": "Vivek K"}, "run": {"label": "Run #3", "window_start": "2026-11-01", "window_end": "2026-11-10"}, "items": [item]})
    s = ctx["signals"][0]
    assert s["points"] == ["New **IT contract** with a state utility", "Expansion to three more Indian cities", "Hiring 200 engineers for a new Pune campus"]
    assert s["opportunity_text"] == "SD-WAN for the new sites" and s["outreach_text"] == "Call the CIO"
    assert s["links"] == [{"url": "https://a.example/1", "label": "Utility award"}, {"url": "https://www.b.example/2", "label": "b.example"}]

    out = et.render(et.DEFAULT_TEMPLATE, ctx, strict=True)
    for label in ("Key signals", "Opportunity", "Recommended outreach", "Sources"):
        assert label in out["html"] and label in out["text"]
    assert out["html"].count("<li ") == 3 and "<strong>IT contract</strong>" in out["html"]
    assert "(https://" not in out["html"] and "  - Expansion to three more Indian cities" in out["text"]


def test_unedited_builtin_template_is_upgraded_but_edited_one_is_kept(client, monkeypatch):
    from app.db.models import EmailTemplate, EmailTemplateVersion
    from app.services import email_templates as et

    with unit_of_work() as uow:
        et.ensure_default(uow)
        t = uow.session.scalars(select(EmailTemplate)).one()
        t.html_tpl, t.text_tpl = "<p>old built-in</p>", "old"
    monkeypatch.setattr(et, "_PREVIOUS_BUILTINS", {(et._sha("<p>old built-in</p>"), et._sha("old"))})
    monkeypatch.setattr(et, "_builtin_checked", False)
    with unit_of_work() as uow:
        et.ensure_default(uow)
    with unit_of_work() as uow:
        t = uow.session.scalars(select(EmailTemplate)).one()
        assert t.html_tpl == et.DEFAULT_TEMPLATE["html_tpl"] and t.version == 2
        assert uow.session.scalar(select(func.count(EmailTemplateVersion.id)).where(EmailTemplateVersion.template_id == t.id)) == 2
        t.html_tpl = "<p>my own edit</p>"  # edited by someone: never overwritten
    monkeypatch.setattr(et, "_builtin_checked", False)
    with unit_of_work() as uow:
        et.ensure_default(uow)
        assert uow.session.scalars(select(EmailTemplate)).one().html_tpl == "<p>my own edit</p>"
