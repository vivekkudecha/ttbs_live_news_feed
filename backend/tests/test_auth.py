"""Authentication, sessions, password policy, CSRF and module permissions."""

from datetime import timedelta

import pytest
from fastapi.routing import APIRoute

from app.core import permissions as perm
from app.core.config import get_settings
from tests.conftest import TEST_PASSWORD, anon_client, make_user, sign_in

STRONG = "Granite-Lake-47-Orbit!"
STRONG2 = "Velvet-Comet-83-Harbor?"


def _routes():
    """Every APIRoute of the app. FastAPI keeps included routers as lazy wrappers, so walk them
    (the routers carry the /api/v1 prefix in their own route paths)."""
    from app.main import create_app

    out, todo = [], list(create_app().routes)
    while todo:
        r = todo.pop()
        if isinstance(r, APIRoute):
            out.append(r)
        elif hasattr(r, "original_router"):
            todo.extend(r.original_router.routes)
    return [r for r in out if r.path.startswith("/api/")]


def test_every_api_route_is_covered_by_an_access_rule():
    routes = _routes()
    assert len(routes) > 60  # the walk really found the API
    uncovered = [r.path for r in routes if perm.classify(r.path) is None]
    assert uncovered == []
    public = sorted({r.path for r in _routes() if perm.classify(r.path) == perm.PUBLIC})
    assert public == ["/api/v1/auth/login", "/api/v1/auth/password-policy", "/api/v1/health"]


def test_protected_routes_need_a_session():
    with anon_client() as c:
        assert c.get("/api/v1/health").status_code == 200
        for path in ("/api/v1/dashboard", "/api/v1/runs", "/api/v1/audit", "/api/v1/users", "/api/v1/auth/me", "/api/v1/settings/llm"):
            r = c.get(path)
            assert r.status_code == 401 and r.json()["error"]["code"] == "session_expired", path
        assert c.post("/api/v1/runs", json={}).status_code == 401
        # The retired identity header grants nothing.
        assert c.get("/api/v1/dashboard", headers={"X-Actor": "admin"}).status_code == 401


def test_login_cookie_flags_and_generic_failures():
    make_user("alice")
    with anon_client() as c:
        bad_pw = c.post("/api/v1/auth/login", json={"username": "alice", "password": "Wrong-Password-1!"})
        no_user = c.post("/api/v1/auth/login", json={"username": "nobody", "password": "Wrong-Password-1!"})
        assert bad_pw.status_code == no_user.status_code == 401
        assert bad_pw.json()["error"]["message"] == no_user.json()["error"]["message"]  # no enumeration
        assert "set-cookie" not in bad_pw.headers

        r = sign_in(c, "ALICE ")  # usernames are case-insensitive and trimmed
        assert r.status_code == 200
        cookie = r.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie and "secure" in cookie and "path=/api" in cookie
        body = r.json()
        assert body["user"]["username"] == "alice" and body["csrfToken"]
        assert not any("hash" in k.lower() for k in body["user"])  # no password material leaves the API
        assert c.get("/api/v1/auth/me").json()["user"]["username"] == "alice"


def test_lockout_after_repeated_failures_and_admin_unlock(client):
    uid = make_user("bob", role="member", permissions={"dashboard": "view"})
    with anon_client() as c:
        for _ in range(get_settings().auth_max_failed_attempts):
            assert c.post("/api/v1/auth/login", json={"username": "bob", "password": "Nope-Nope-12!x"}).status_code == 401
        assert sign_in(c, "bob").status_code == 401  # locked: even the right password is refused
    users = {u["username"]: u for u in client.get("/api/v1/users").json()["rows"]}
    assert users["bob"]["locked"] is True
    assert client.post(f"/api/v1/users/{uid}/unlock").json()["locked"] is False
    with anon_client() as c:
        assert sign_in(c, "bob").status_code == 200
    actions = [r["action"] for r in client.get("/api/v1/audit?pageSize=50").json()["rows"]]
    assert "auth.locked" in actions and "auth.login_failed" in actions and "user.unlocked" in actions


def test_bootstrap_admin_must_change_password_first(monkeypatch):
    monkeypatch.setenv("ADMIN_USERNAME", "root-admin")
    monkeypatch.setenv("ADMIN_INITIAL_PASSWORD", STRONG)
    get_settings.cache_clear()
    with anon_client() as c:  # startup creates the admin (users table empty)
        r = sign_in(c, "root-admin", STRONG)
        assert r.status_code == 200 and r.json()["user"]["mustChangePassword"] is True and r.json()["user"]["role"] == "admin"
        blocked = c.get("/api/v1/dashboard")
        assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "password_change_required"

        weak = c.post("/api/v1/auth/change-password", json={"currentPassword": STRONG, "newPassword": "short"})
        assert weak.status_code == 422 and len(weak.json()["error"]["details"]["problems"]) >= 3
        same = c.post("/api/v1/auth/change-password", json={"currentPassword": STRONG, "newPassword": STRONG})
        assert same.status_code == 422
        wrong = c.post("/api/v1/auth/change-password", json={"currentPassword": "Not-It-123!", "newPassword": STRONG2})
        assert wrong.status_code == 422 and wrong.json()["error"]["details"]["field"] == "currentPassword"

        old_cookie = c.cookies.get("ttbs_session")
        ok = c.post("/api/v1/auth/change-password", json={"currentPassword": STRONG, "newPassword": STRONG2})
        assert ok.status_code == 200 and ok.json()["user"]["mustChangePassword"] is False
        assert c.cookies.get("ttbs_session") != old_cookie  # rotated
        c.headers["X-CSRF-Token"] = ok.json()["csrfToken"]
        assert c.get("/api/v1/dashboard").status_code == 200

    with anon_client() as c:  # the pre-change session is dead
        c.cookies.set("ttbs_session", old_cookie, domain="testserver", path="/api")
        assert c.get("/api/v1/auth/me").status_code == 401
    with anon_client() as c:  # a second start does not create another admin or reset the password
        assert sign_in(c, "root-admin", STRONG).status_code == 401
        assert sign_in(c, "root-admin", STRONG2).status_code == 200


def test_bootstrap_refuses_a_weak_initial_password(monkeypatch):
    monkeypatch.setenv("ADMIN_INITIAL_PASSWORD", "admin123")
    get_settings.cache_clear()
    with anon_client() as c:
        assert sign_in(c, "admin", "admin123").status_code == 401


@pytest.mark.parametrize("pw,problem", [
    ("Sh0rt!", "at least"),
    ("alllowercase-123!", "upper-case"),
    ("ALLUPPERCASE-123!", "lower-case"),
    ("No-Digits-Here!!x", "digit"),
    ("NoSymbols12345abc", "symbol"),
    ("Aaaa-1111-bbbb!", "repeat"),
    ("My-Password-2026!", "common"),
    ("Carol-Secure-99!", "username"),
])
def test_password_policy_rules(pw, problem):
    from app.services.passwords import generate_temporary, violations

    assert any(problem in v.lower() for v in violations(pw, username="carol")), (pw, violations(pw, username="carol"))
    assert violations(STRONG, username="carol") == []
    for _ in range(20):
        assert violations(generate_temporary()) == []


def test_password_history_blocks_reuse(client):
    make_user("dave", role="member")
    with anon_client() as c:
        sign_in(c, "dave")
        r = c.post("/api/v1/auth/change-password", json={"currentPassword": TEST_PASSWORD, "newPassword": STRONG})
        c.headers["X-CSRF-Token"] = r.json()["csrfToken"]
        r = c.post("/api/v1/auth/change-password", json={"currentPassword": STRONG, "newPassword": TEST_PASSWORD})
        assert r.status_code == 422 and "last" in " ".join(r.json()["error"]["details"]["problems"])


def test_writes_need_the_csrf_token(client):
    token = client.headers.pop("X-CSRF-Token")
    r = client.post("/api/v1/auth/logout")
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "forged"}).status_code == 403
    assert client.get("/api/v1/auth/me").status_code == 200  # reads do not need it
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": token}).status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401  # signed out server-side


def test_member_gets_only_granted_modules(client):
    make_user("erin", role="member", permissions={"runs": "view", "dashboard": "manage", "bogus": "manage"})
    with anon_client() as c:
        me = sign_in(c, "erin").json()["user"]
        assert me["permissions"] == {"runs": "view", "dashboard": "manage"}  # unknown modules dropped
        assert c.get("/api/v1/runs").status_code == 200
        assert c.get("/api/v1/dashboard").status_code == 200
        assert c.get("/api/v1/templates").status_code == 200  # reference data: any signed-in user
        denied = c.post("/api/v1/runs/1/cancel")
        assert denied.status_code == 403 and denied.json()["error"]["code"] == "forbidden"  # view-only
        for path in ("/api/v1/audit", "/api/v1/imports", "/api/v1/settings/llm", "/api/v1/finops", "/api/v1/users"):
            assert c.get(path).status_code == 403, path
        assert c.post("/api/v1/signals/query", json={}).status_code == 403  # read-POST still needs the module


def test_admin_user_lifecycle(client):
    r = client.post("/api/v1/users", json={"username": "frank", "name": "Frank Li", "permissions": {"audit": "view"}})
    assert r.status_code == 201
    uid, temp = r.json()["user"]["id"], r.json()["temporaryPassword"]
    assert r.json()["user"]["mustChangePassword"] is True and len(temp) >= 16
    assert client.post("/api/v1/users", json={"username": "FRANK", "name": "Again"}).status_code == 409
    assert client.post("/api/v1/users", json={"username": "x", "name": "Too short"}).status_code == 422

    with anon_client() as c:
        assert sign_in(c, "frank", temp).status_code == 200
        assert c.get("/api/v1/audit").status_code == 403  # must change first

    p = client.patch(f"/api/v1/users/{uid}", json={"permissions": {"audit": "manage", "runs": "view"}})
    assert p.status_code == 200 and p.json()["grantedPermissions"] == {"audit": "manage", "runs": "view"}

    reset = client.post(f"/api/v1/users/{uid}/reset-password").json()
    assert reset["temporaryPassword"] != temp
    with anon_client() as c:
        assert sign_in(c, "frank", temp).status_code == 401
        assert sign_in(c, "frank", reset["temporaryPassword"]).status_code == 200
        assert client.patch(f"/api/v1/users/{uid}", json={"active": False}).json()["active"] is False
        assert c.get("/api/v1/auth/me").status_code == 401  # deactivation ends live sessions
    actions = {r["action"] for r in client.get("/api/v1/audit?pageSize=50").json()["rows"]}
    assert {"user.created", "user.updated", "user.password_reset"} <= actions


def test_admins_cannot_lock_themselves_or_the_org_out(client):
    me = client.get("/api/v1/auth/me").json()["user"]
    r = client.patch(f"/api/v1/users/{me['id']}", json={"active": False})
    assert r.status_code == 403 and r.json()["error"]["code"] == "self_lockout"
    assert client.patch(f"/api/v1/users/{me['id']}", json={"role": "member"}).status_code == 403
    other = make_user("grace", role="admin")
    assert client.patch(f"/api/v1/users/{other}", json={"role": "member"}).status_code == 200  # tester still admin


def test_idle_and_absolute_session_expiry(client):
    from sqlalchemy import update

    from app.core.timeutil import utcnow
    from app.db.models import UserSession
    from app.db.session import unit_of_work

    assert client.get("/api/v1/auth/me").status_code == 200
    with unit_of_work() as uow:
        uow.session.execute(update(UserSession).values(last_seen_at=utcnow() - timedelta(minutes=get_settings().session_idle_minutes + 1)))
    assert client.get("/api/v1/auth/me").status_code == 401

    assert sign_in(client).status_code == 200
    with unit_of_work() as uow:
        uow.session.execute(update(UserSession).where(UserSession.revoked_at.is_(None)).values(expires_at=utcnow() - timedelta(seconds=1)))
    assert client.get("/api/v1/auth/me").status_code == 401


def test_audit_actor_is_the_signed_in_user_not_a_header(client):
    client.post("/api/v1/auth/logout", headers={"X-Actor": "mallory"})
    rows = client.get("/api/v1/audit?pageSize=5")
    assert rows.status_code == 401  # signed out
    assert sign_in(client).status_code == 200
    latest = client.get("/api/v1/audit?pageSize=5").json()["rows"]
    assert all(r["actor"] != "mallory" for r in latest)
    assert any(r["action"] == "auth.logout" and r["actor"] == "tester" for r in latest)


def test_api_responses_are_never_cached(client):
    for r in (client.get("/api/v1/auth/me"), client.get("/api/v1/health"), anon_client().get("/api/v1/runs")):
        assert r.headers["cache-control"] == "no-store" and r.headers["x-content-type-options"] == "nosniff"


def test_docs_are_off_in_prod(monkeypatch):
    monkeypatch.setenv("ENV", "prod")
    get_settings.cache_clear()
    with anon_client() as c:
        assert c.get("/docs").status_code == 404 and c.get("/openapi.json").status_code == 404 and c.get("/redoc").status_code == 404
