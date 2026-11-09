"""Authentication, sessions and user administration.

Sign-in: username + password → a new server-side session (fresh token every time, so a token
planted before sign-in is useless: no session fixation). Failures are answered with one generic
message whatever went wrong (unknown user, bad password, locked, deactivated), and take the same
time, so the API cannot be used to discover accounts. N consecutive failures lock the account.

Sessions end after SESSION_IDLE_MINUTES without a request or SESSION_MAX_HOURS in total, on
sign-out, and whenever the password changes or an admin deactivates the user or revokes them.

Every sign-in, failure, lockout, password change and admin action lands in the audit log.
"""

import hashlib
import logging
import re
import secrets
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.core import permissions as perm
from app.core.config import get_settings
from app.core.errors import Conflict, Forbidden, NotFound, Unauthorized, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import ROLE_ADMIN, ROLE_MEMBER, ROLES, PasswordHistory, User, UserSession
from app.db.session import UnitOfWork, unit_of_work
from app.services import audit, passwords

log = logging.getLogger(__name__)

BAD_CREDENTIALS = "Invalid username or password."
_USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def normalize_username(username: str) -> str:
    return (username or "").strip().lower()


def iso(dt) -> str | None:
    dt = as_utc(dt)
    return dt.isoformat() if dt else None


# --- Read model ------------------------------------------------------------------------------


def password_expires_at(user: User):
    days = get_settings().password_max_age_days
    return as_utc(user.password_changed_at) + timedelta(days=days) if days > 0 else None


def password_expired(user: User) -> bool:
    exp = password_expires_at(user)
    return exp is not None and utcnow() >= exp


def effective_permissions(user: User) -> dict[str, str]:
    if user.role == ROLE_ADMIN:
        return {m.key: "manage" for m in perm.MODULES}
    return perm.clean(user.permissions)


def user_out(user: User, *, admin_view: bool = False) -> dict[str, Any]:
    out = {
        "id": str(user.id),
        "username": user.username,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "permissions": effective_permissions(user),
        "mustChangePassword": bool(user.must_change_password) or password_expired(user),
        "passwordExpiresAt": iso(password_expires_at(user)),
        "lastLoginAt": iso(user.last_login_at),
    }
    if admin_view:
        locked = user.locked_until is not None and as_utc(user.locked_until) > utcnow()
        out.update(
            active=bool(user.active),
            locked=locked,
            lockedUntil=iso(user.locked_until) if locked else None,
            failedLoginCount=user.failed_login_count,
            grantedPermissions=perm.clean(user.permissions),
            passwordChangedAt=iso(user.password_changed_at),
            createdAt=iso(user.created_at),
            createdBy=user.created_by,
        )
    return out


# --- Passwords -------------------------------------------------------------------------------


def _rejected(field: str, problem: str) -> ValidationFailed:
    return ValidationFailed(problem, details={"field": field, "problems": [problem]})


def _check_new_password(uow: UnitOfWork, user: User, new: str) -> None:
    problems = passwords.violations(new, username=user.username, name=user.name)
    if not problems:
        n = get_settings().password_history_count
        previous = [user.password_hash] + list(
            uow.session.scalars(
                select(PasswordHistory.password_hash)
                .where(PasswordHistory.user_id == user.id)
                .order_by(PasswordHistory.id.desc())
                .limit(max(0, n - 1))
            )
        ) if n > 0 and user.password_hash else []
        if any(passwords.verify_password(h, new) for h in previous):
            problems.append(f"Choose a password you have not used for your last {n} passwords.")
    if problems:
        raise ValidationFailed("The new password does not meet the password policy.", details={"field": "newPassword", "problems": problems})


def _store_password(uow: UnitOfWork, user: User, new: str, *, must_change: bool) -> None:
    if user.password_hash:
        uow.session.add(PasswordHistory(user_id=user.id, password_hash=user.password_hash, created_at=utcnow()))
    user.password_hash = passwords.hash_password(new)
    user.password_changed_at = utcnow()
    user.must_change_password = must_change
    user.failed_login_count = 0
    user.locked_until = None


# --- Sessions --------------------------------------------------------------------------------


def _new_session(uow: UnitOfWork, user: User, ip: str | None, user_agent: str | None) -> tuple[str, UserSession]:
    s = get_settings()
    token = secrets.token_urlsafe(32)
    now = utcnow()
    sess = UserSession(
        token_hash=_token_hash(token),
        csrf_token=secrets.token_urlsafe(32),
        user_id=user.id,
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(hours=s.session_max_hours),
        ip=ip,
        user_agent=(user_agent or "")[:300] or None,
    )
    uow.session.add(sess)
    uow.session.flush()
    return token, sess


def resolve_session(uow: UnitOfWork, token: str | None) -> UserSession | None:
    """The live session for a cookie token, or None (unknown, revoked, idle, expired, user off)."""
    if not token or len(token) > 200:
        return None
    sess = uow.session.scalar(select(UserSession).where(UserSession.token_hash == _token_hash(token)))
    if sess is None or sess.revoked_at is not None:
        return None
    s, now = get_settings(), utcnow()
    idle_cutoff = now - timedelta(minutes=s.session_idle_minutes)
    if as_utc(sess.expires_at) <= now or as_utc(sess.last_seen_at) <= idle_cutoff or not sess.user.active:
        sess.revoked_at = now
        return None
    if (now - as_utc(sess.last_seen_at)).total_seconds() >= s.session_touch_seconds:
        sess.last_seen_at = now
    return sess


def revoke_sessions(uow: UnitOfWork, user_id: int, *, keep: int | None = None) -> int:
    q = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if keep is not None:
        q = q.where(UserSession.id != keep)
    return uow.session.execute(q.values(revoked_at=utcnow())).rowcount or 0


def logout(uow: UnitOfWork, sess: UserSession) -> None:
    sess.revoked_at = utcnow()
    audit.record(uow, "auth.logout", "user", sess.user_id, {}, actor=sess.user.username)


# --- Sign-in ---------------------------------------------------------------------------------


def login(username: str, password: str, *, ip: str | None, user_agent: str | None) -> tuple[str, UserSession, dict[str, Any]]:
    s = get_settings()
    name = normalize_username(username)
    with unit_of_work() as uow:
        user = uow.session.scalar(select(User).where(User.username == name)) if name else None
        ok = passwords.verify_password(user.password_hash if user else None, password or "")
        now = utcnow()
        reason = None
        if user is None:
            reason = "unknown_user"
        elif not user.active:
            reason = "inactive"
        elif user.locked_until is not None and as_utc(user.locked_until) > now:
            reason = "locked"
        elif not ok:
            reason = "bad_password"
            user.failed_login_count = (user.failed_login_count or 0) + 1
            if user.failed_login_count >= s.auth_max_failed_attempts:
                user.locked_until = now + timedelta(minutes=s.auth_lockout_minutes)
                user.failed_login_count = 0
                audit.record(uow, "auth.locked", "user", user.id, {"minutes": s.auth_lockout_minutes}, actor="system")
        if reason:
            audit.record(uow, "auth.login_failed", "user", user.id if user else None,
                         {"username": name[:64], "reason": reason}, actor="anonymous")
    if reason:
        # Committed above (failure counters + audit), then refused with one generic message.
        raise Unauthorized(BAD_CREDENTIALS, code="invalid_credentials")

    with unit_of_work() as uow:
        user = uow.session.get(User, user.id)
        user.failed_login_count = 0
        user.locked_until = None
        user.last_login_at = utcnow()
        if passwords.needs_rehash(user.password_hash):
            user.password_hash = passwords.hash_password(password)
        token, sess = _new_session(uow, user, ip, user_agent)
        audit.record(uow, "auth.login", "user", user.id, {"session": sess.id}, actor=user.username)
        return token, sess, user_out(user)


def change_password(sess_id: int, current: str, new: str, *, ip: str | None, user_agent: str | None) -> tuple[str, UserSession, dict[str, Any]]:
    """Self-service change. Ends every session of the user and issues a fresh one."""
    with unit_of_work() as uow:
        sess = uow.session.get(UserSession, sess_id)
        user = sess.user
        if not passwords.verify_password(user.password_hash, current or ""):
            raise _rejected("currentPassword", "Your current password is incorrect.")
        if current == new:
            raise _rejected("newPassword", "The new password must differ from the current one.")
        _check_new_password(uow, user, new)
        _store_password(uow, user, new, must_change=False)
        revoke_sessions(uow, user.id)
        token, fresh = _new_session(uow, user, ip, user_agent)
        audit.record(uow, "auth.password_changed", "user", user.id, {}, actor=user.username)
        return token, fresh, user_out(user)


# --- Bootstrap -------------------------------------------------------------------------------


def bootstrap_admin() -> None:
    """Create the first admin from ADMIN_* settings while no user exists. Idempotent and safe to
    run from several processes at once (the unique username decides)."""
    s = get_settings()
    with unit_of_work() as uow:
        if uow.session.scalar(select(func.count(User.id))):
            return
    secret = s.admin_initial_password.get_secret_value() if s.admin_initial_password else ""
    username = normalize_username(s.admin_username)
    if not secret:
        log.warning("auth: no users exist and ADMIN_INITIAL_PASSWORD is not set; nobody can sign in")
        return
    problems = passwords.violations(secret, username=username, name=s.admin_name)
    if not _USERNAME.match(username) or problems:
        log.error("auth: bootstrap admin NOT created: ADMIN_USERNAME/ADMIN_INITIAL_PASSWORD fail the policy",
                  extra={"problems": problems or ["invalid username"]})
        return
    try:
        with unit_of_work() as uow:
            user = User(username=username, name=s.admin_name, email=s.admin_email, role=ROLE_ADMIN, permissions={},
                        password_hash="", password_changed_at=utcnow(), must_change_password=True, active=True,
                        failed_login_count=0, created_by="bootstrap")
            uow.session.add(user)
            uow.session.flush()
            _store_password(uow, user, secret, must_change=True)
            audit.record(uow, "user.bootstrap_admin", "user", user.id, {"username": username}, actor="system")
        log.warning("auth: bootstrap admin created; it must change its password at first sign-in", extra={"username": username})
    except IntegrityError:
        pass  # another process created it first


# --- Administration (admin role only; enforced by the route guard) ---------------------------


def _validate_profile(username: str | None, name: str | None, role: str | None) -> None:
    if username is not None and not _USERNAME.match(username):
        raise ValidationFailed("Usernames are 3-64 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit.",
                               details={"field": "username"})
    if name is not None and not name.strip():
        raise ValidationFailed("Enter the person's name.", details={"field": "name"})
    if role is not None and role not in ROLES:
        raise ValidationFailed("Unknown role.", details={"field": "role"})


def _active_admins(uow: UnitOfWork) -> int:
    return uow.session.scalar(select(func.count(User.id)).where(User.role == ROLE_ADMIN, User.active.is_(True))) or 0


def _get(uow: UnitOfWork, user_id: int) -> User:
    user = uow.session.get(User, user_id)
    if user is None:
        raise NotFound("User not found")
    return user


def list_users() -> list[dict[str, Any]]:
    with unit_of_work() as uow:
        return [user_out(u, admin_view=True) for u in uow.session.scalars(select(User).order_by(User.username))]


def create_user(data: dict[str, Any], *, actor: str) -> dict[str, Any]:
    username = normalize_username(data.get("username", ""))
    name = (data.get("name") or "").strip()
    role = data.get("role") or ROLE_MEMBER
    _validate_profile(username, name, role)
    temp = passwords.generate_temporary()
    with unit_of_work() as uow:
        if uow.session.scalar(select(User.id).where(User.username == username)):
            raise Conflict("That username is taken.", details={"field": "username"})
        user = User(username=username, name=name, email=(data.get("email") or None), role=role,
                    permissions=perm.clean(data.get("permissions")), password_hash="", password_changed_at=utcnow(),
                    must_change_password=True, active=True, failed_login_count=0, created_by=actor)
        uow.session.add(user)
        uow.session.flush()
        _store_password(uow, user, temp, must_change=True)
        audit.record(uow, "user.created", "user", user.id,
                     {"username": username, "role": role, "permissions": perm.clean(data.get("permissions"))})
        return {"user": user_out(user, admin_view=True), "temporaryPassword": temp}


def update_user(user_id: int, data: dict[str, Any], *, actor_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        user = _get(uow, user_id)
        before = {"name": user.name, "email": user.email, "role": user.role, "active": user.active,
                  "permissions": perm.clean(user.permissions)}
        _validate_profile(None, data.get("name"), data.get("role"))
        demoting = data.get("role") is not None and data["role"] != ROLE_ADMIN and user.role == ROLE_ADMIN
        deactivating = data.get("active") is False and user.active
        if user.id == actor_id and (demoting or deactivating):
            raise Forbidden("You cannot remove your own admin role or deactivate yourself.", code="self_lockout")
        if (demoting or deactivating) and user.role == ROLE_ADMIN and _active_admins(uow) <= 1:
            raise Conflict("At least one active admin must remain.", code="last_admin")
        if data.get("name") is not None:
            user.name = data["name"].strip()
        if "email" in data:
            user.email = data["email"] or None
        if data.get("role") is not None:
            user.role = data["role"]
        if data.get("permissions") is not None:
            user.permissions = perm.clean(data["permissions"])
        if data.get("active") is not None:
            user.active = bool(data["active"])
        after = {"name": user.name, "email": user.email, "role": user.role, "active": user.active,
                 "permissions": perm.clean(user.permissions)}
        changes = {k: {"from": before[k], "to": after[k]} for k in before if before[k] != after[k]}
        if deactivating or demoting:
            revoke_sessions(uow, user.id)  # access drops immediately, not at the next sign-in
        if changes:
            audit.record(uow, "user.updated", "user", user.id, {"username": user.username, "changes": changes})
        return user_out(user, admin_view=True)


def reset_password(user_id: int) -> dict[str, Any]:
    temp = passwords.generate_temporary()
    with unit_of_work() as uow:
        user = _get(uow, user_id)
        _store_password(uow, user, temp, must_change=True)
        revoked = revoke_sessions(uow, user.id)
        audit.record(uow, "user.password_reset", "user", user.id, {"username": user.username, "sessionsRevoked": revoked})
        return {"user": user_out(user, admin_view=True), "temporaryPassword": temp}


def unlock(user_id: int) -> dict[str, Any]:
    with unit_of_work() as uow:
        user = _get(uow, user_id)
        user.locked_until = None
        user.failed_login_count = 0
        audit.record(uow, "user.unlocked", "user", user.id, {"username": user.username})
        return user_out(user, admin_view=True)


def revoke_all(user_id: int) -> dict[str, int]:
    with unit_of_work() as uow:
        user = _get(uow, user_id)
        n = revoke_sessions(uow, user.id)
        audit.record(uow, "user.sessions_revoked", "user", user.id, {"username": user.username, "count": n})
        return {"revoked": n}
