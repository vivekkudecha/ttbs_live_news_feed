"""Password hashing and policy.

Hashing: Argon2id (argon2-cffi defaults: 64 MiB, 3 passes, 4 lanes), the OWASP first choice.
Hashes self-describe their parameters, so raising them later re-hashes on the next sign-in.

Policy (every rule is checked server-side; the UI only mirrors it):
- PASSWORD_MIN_LENGTH (default 12) to 128 characters
- at least one upper-case letter, one lower-case letter, one digit and one symbol
- no character repeated 3+ times in a row, and not built on a common password or the username
- not one of the last PASSWORD_HISTORY_COUNT passwords
"""

import re
import secrets
import string
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

MAX_LENGTH = 128
_hasher = PasswordHasher()
# Verified when the username does not exist, so a miss costs as long as a hit (no user enumeration
# by timing).
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))

# Words that make a password guessable however it is decorated ("Password@2026!").
_COMMON = (
    "password", "passw0rd", "qwerty", "123456", "12345678", "abc123", "111111", "letmein",
    "welcome", "admin", "changeme", "default", "iloveyou", "monkey", "dragon", "master", "secret",
    "login", "ttbs", "tata",
)
_SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/~"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def policy() -> dict[str, Any]:
    """The rules, for the UI checklist."""
    s = get_settings()
    return {
        "minLength": s.password_min_length,
        "maxLength": MAX_LENGTH,
        "requireUpper": True,
        "requireLower": True,
        "requireDigit": True,
        "requireSymbol": True,
        "historyCount": s.password_history_count,
        "maxAgeDays": s.password_max_age_days,
    }


def violations(password: str, *, username: str = "", name: str = "") -> list[str]:
    """Human-readable reasons the password is rejected (empty = acceptable). History is checked by
    the caller, which has the user's previous hashes."""
    s = get_settings()
    out: list[str] = []
    if len(password) < s.password_min_length:
        out.append(f"Use at least {s.password_min_length} characters.")
    if len(password) > MAX_LENGTH:
        out.append(f"Use at most {MAX_LENGTH} characters.")
    if not re.search(r"[A-Z]", password):
        out.append("Add an upper-case letter.")
    if not re.search(r"[a-z]", password):
        out.append("Add a lower-case letter.")
    if not re.search(r"\d", password):
        out.append("Add a digit.")
    if not re.search(r"[^A-Za-z0-9]", password):
        out.append("Add a symbol, such as ! @ # $ %.")
    if re.search(r"(.)\1\1", password):
        out.append("Do not repeat a character three or more times in a row.")
    if any(c.isspace() for c in password[:1] + password[-1:]):
        out.append("Do not start or end with a space.")
    low = password.lower()
    if any(w in low for w in _COMMON):
        out.append("Avoid common words such as 'password', 'admin' or 'welcome'.")
    personal = [p for p in [username.lower(), *name.lower().split()] if len(p) >= 3]
    if any(p in low for p in personal):
        out.append("Do not include your username or name.")
    return out


def generate_temporary() -> str:
    """A random 16-character password that meets the policy, for admin-issued (re)sets."""
    alphabet = string.ascii_letters + string.digits + _SYMBOLS
    length = max(16, get_settings().password_min_length)
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if not violations(pw):
            return pw
