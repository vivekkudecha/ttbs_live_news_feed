"""Encryption at rest for credentials stored in the database (e.g. the Perplexity API key).

AES-256-GCM with a random 96-bit nonce per value. The master key comes from SECRETS_KEY
(32 random bytes, url-safe base64) in the environment and never touches the database, so a
database dump alone does not reveal provider keys. Generate one with:

    python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
"""

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings
from app.core.errors import ServiceUnavailable

_PREFIX = "v1:"


class SecretUnreadable(Exception):
    """Stored ciphertext cannot be decrypted (SECRETS_KEY changed or data corrupted)."""


def _aead() -> AESGCM:
    raw = get_settings().secrets_key
    if raw is None or not raw.get_secret_value().strip():
        raise ServiceUnavailable("SECRETS_KEY is not set on the server, so credentials cannot be stored", code="secrets_key_missing")
    try:
        key = base64.urlsafe_b64decode(raw.get_secret_value().strip())
    except ValueError as e:
        raise ServiceUnavailable("SECRETS_KEY is not valid base64", code="secrets_key_invalid") from e
    if len(key) != 32:
        raise ServiceUnavailable("SECRETS_KEY must decode to 32 bytes", code="secrets_key_invalid")
    return AESGCM(key)


def encrypt(plaintext: str, *, context: str) -> str:
    """`context` is bound as associated data, so a ciphertext cannot be swapped between fields."""
    nonce = os.urandom(12)
    ct = _aead().encrypt(nonce, plaintext.encode(), context.encode())
    return _PREFIX + base64.urlsafe_b64encode(nonce + ct).decode()


def decrypt(token: str, *, context: str) -> str:
    if not token.startswith(_PREFIX):
        raise SecretUnreadable("unknown ciphertext format")
    try:
        blob = base64.urlsafe_b64decode(token[len(_PREFIX):])
        return _aead().decrypt(blob[:12], blob[12:], context.encode()).decode()
    except (InvalidTag, ValueError) as e:
        raise SecretUnreadable("stored credential cannot be decrypted (was SECRETS_KEY changed?)") from e


def hint(secret: str) -> str:
    """Safe-to-display hint: 'pplx-…a1b2'."""
    s = secret.strip()
    head = s.split("-", 1)[0] + "-" if "-" in s[:8] else ""
    return f"{head}…{s[-4:]}" if len(s) >= 8 else "…"
