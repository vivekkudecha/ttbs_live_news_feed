"""Request-scoped dependencies: the access guard and the acting user.

`authorize` runs on every /api/v1 route (it is attached to the routers in app/main.py):

1. classify the matched route template (app/core/permissions.py); uncovered routes are refused
2. public routes stop here; everything else needs a live session cookie (401 otherwise)
3. a user who must change their password (first sign-in, admin reset, expiry) may only reach
   the /auth session endpoints (403 password_change_required)
4. writes (POST/PUT/PATCH/DELETE) must echo the session's CSRF token in X-CSRF-Token
5. module routes need the module at "view" (reads) or "manage" (writes); /users needs admin

`current_actor` returns the signed-in username for audit rows. It never trusts a client header.
"""

import hmac
from dataclasses import dataclass, field

from fastapi import Request

from app.core import permissions as perm
from app.core.config import get_settings
from app.core.context import actor_var
from app.core.errors import Forbidden, Unauthorized
from app.db.models import ROLE_ADMIN
from app.db.session import unit_of_work
from app.services import auth

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
CSRF_HEADER = "X-CSRF-Token"


@dataclass(frozen=True)
class Principal:
    user_id: int
    username: str
    role: str
    session_id: int
    csrf_token: str
    permissions: dict[str, str] = field(default_factory=dict)


def authorize(request: Request) -> Principal | None:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    access = perm.classify(path) if path else None
    if access is None:
        raise Forbidden("Access denied.", code="route_not_covered")
    if access == perm.PUBLIC:
        return None

    token = request.cookies.get(get_settings().session_cookie_name)
    with unit_of_work() as uow:
        sess = auth.resolve_session(uow, token)
        if sess is not None:
            user = sess.user
            principal = Principal(user.id, user.username, user.role, sess.id, sess.csrf_token, auth.effective_permissions(user))
            must_change = bool(user.must_change_password) or auth.password_expired(user)
    # Outside the transaction: an idle/expired session was revoked and that is now committed.
    if sess is None:
        raise Unauthorized("Your session has ended. Sign in again.", code="session_expired")

    actor_var.set(principal.username)
    request.state.principal = principal

    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not sent or not hmac.compare_digest(sent, principal.csrf_token):
            raise Forbidden("Missing or invalid CSRF token. Reload the page and try again.", code="csrf_failed")
    if access == perm.SESSION:
        return principal
    if must_change:
        raise Forbidden("Change your password to continue.", code="password_change_required")
    if access == perm.SIGNED_IN:
        return principal
    if access == perm.ADMIN:
        if principal.role != ROLE_ADMIN:
            raise Forbidden("Only administrators can do this.", code="forbidden")
        return principal
    if not perm.allows(principal.permissions.get(access), perm.required_level(request.method, path)):
        raise Forbidden("You do not have access to this.", code="forbidden")
    return principal


def current_principal(request: Request) -> Principal:
    p = getattr(request.state, "principal", None)
    if p is None:
        raise Unauthorized("Sign in to continue.", code="session_expired")
    return p


def current_actor(request: Request) -> str:
    """The signed-in username (set by `authorize`, which runs first on every router)."""
    return current_principal(request).username
