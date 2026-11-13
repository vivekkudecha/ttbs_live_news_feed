"""Sign-in, sign-out, the current user, password change, and user administration (/api/v1).

The session token travels only in an HttpOnly, SameSite=Strict cookie scoped to /api (JavaScript
cannot read it); responses carry the CSRF token the SPA echoes on writes.
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import Field

from app.api import schemas as sch
from app.api import table_specs as spec
from app.api.deps import Principal, current_principal
from app.api.listing import Listing, listing
from app.core import permissions as perm
from app.core.config import get_settings
from app.core.errors import NotFound
from app.db.models import UserSession
from app.db.session import unit_of_work
from app.services import auth, passwords

router = APIRouter(prefix="/api/v1")
COOKIE_PATH = "/api"


class LoginIn(sch.In):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=passwords.MAX_LENGTH)


class ChangePasswordIn(sch.In):
    current_password: str = Field(min_length=1, max_length=passwords.MAX_LENGTH)
    new_password: str = Field(min_length=1, max_length=passwords.MAX_LENGTH)


Level = Literal["view", "manage"]


class UserCreateIn(sch.In):
    username: str = Field(min_length=3, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: Literal["admin", "member"] = "member"
    permissions: dict[str, Level] = Field(default_factory=dict)


class UserPatchIn(sch.In):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: Literal["admin", "member"] | None = None
    permissions: dict[str, Level] | None = None
    active: bool | None = None


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _set_cookie(response: Response, token: str) -> None:
    s = get_settings()
    # No Max-Age: a browser-session cookie. The server enforces idle and absolute expiry.
    response.set_cookie(s.session_cookie_name, token, httponly=True, secure=s.session_cookie_secure,
                        samesite="strict", path=COOKIE_PATH)


def _clear_cookie(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(s.session_cookie_name, path=COOKIE_PATH, httponly=True,
                           secure=s.session_cookie_secure, samesite="strict")


def _session_out(sess: UserSession, user: dict[str, Any]) -> dict[str, Any]:
    return {"user": user, "csrfToken": sess.csrf_token, "expiresAt": auth.iso(sess.expires_at),
            "idleMinutes": get_settings().session_idle_minutes}


# --- Session ---------------------------------------------------------------------------------


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response) -> dict[str, Any]:
    token, sess, user = auth.login(body.username, body.password, ip=_ip(request), user_agent=request.headers.get("User-Agent"))
    _set_cookie(response, token)
    return _session_out(sess, user)


@router.post("/auth/logout", status_code=204)
def logout(response: Response, p: Principal = Depends(current_principal)) -> None:
    with unit_of_work() as uow:
        auth.logout(uow, uow.session.get(UserSession, p.session_id))
    _clear_cookie(response)


@router.get("/auth/me")
def me(p: Principal = Depends(current_principal)) -> dict[str, Any]:
    with unit_of_work() as uow:
        sess = uow.session.get(UserSession, p.session_id)
        return _session_out(sess, auth.user_out(sess.user))


@router.post("/auth/change-password")
def change_password(body: ChangePasswordIn, request: Request, response: Response,
                    p: Principal = Depends(current_principal)) -> dict[str, Any]:
    token, sess, user = auth.change_password(p.session_id, body.current_password, body.new_password,
                                             ip=_ip(request), user_agent=request.headers.get("User-Agent"))
    _set_cookie(response, token)
    return _session_out(sess, user)


@router.get("/auth/password-policy")
def password_policy() -> dict[str, Any]:
    return passwords.policy()


@router.get("/auth/modules")
def modules() -> list[dict[str, str]]:
    return [{"key": m.key, "label": m.label, "description": m.description} for m in perm.MODULES]


# --- User administration (admin only: see permissions.PREFIXES) -----------------------------


def _uid(user_id: str) -> int:
    if not user_id.isdigit():
        raise NotFound("User not found")
    return int(user_id)


@router.get("/users")
def list_users(page: int = Query(0, ge=0), page_size: int = Query(50, ge=1, le=500, alias="pageSize"),
               lst: Listing = Depends(listing)) -> dict[str, Any]:
    return auth.list_users(page=page, size=page_size, spec=spec.USERS, lst=lst)


@router.post("/users", status_code=201)
def create_user(body: UserCreateIn, p: Principal = Depends(current_principal)) -> dict[str, Any]:
    return auth.create_user(body.model_dump(), actor=p.username)


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UserPatchIn, p: Principal = Depends(current_principal)) -> dict[str, Any]:
    return auth.update_user(_uid(user_id), body.model_dump(exclude_unset=True), actor_id=p.user_id)


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: str, p: Principal = Depends(current_principal)) -> dict[str, Any]:
    return auth.reset_password(_uid(user_id), actor_id=p.user_id)


@router.post("/users/{user_id}/unlock")
def unlock(user_id: str) -> dict[str, Any]:
    return auth.unlock(_uid(user_id))


@router.post("/users/{user_id}/revoke-sessions")
def revoke_sessions(user_id: str) -> dict[str, int]:
    return auth.revoke_all(_uid(user_id))
