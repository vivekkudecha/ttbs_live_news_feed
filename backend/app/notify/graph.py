"""Microsoft Graph mail adapter: app-to-app (OAuth 2.0 client credentials), no signed-in user.

Setup in Entra ID (Azure AD): register an app, add the *application* permission Mail.Send on
Microsoft Graph, grant admin consent, create a client secret. Optionally restrict the app to the
sender mailbox with an Exchange Application Access Policy (otherwise Mail.Send can send as any
mailbox in the tenant).

- Token: POST {login}/{tenant}/oauth2/v2.0/token, scope https://graph.microsoft.com/.default.
  Cached in this process's memory only (never in Redis or the database) until shortly before expiry.
- Send:  POST {graph}/v1.0/users/{sender}/sendMail → 202 Accepted (no body).
- Errors: 429 / 5xx / timeouts are retryable (honouring Retry-After); 401 refreshes the token once;
  400 / 403 / 404 are permanent (bad recipient, missing permission, unknown mailbox).
Every error carries http_status / error_code / request_id for the attempts audit trail.
"""

import base64
import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import get_settings
from app.core.errors import ProviderError, RetryableProviderError

log = logging.getLogger("ttbs.notify.graph")

SCOPE = "https://graph.microsoft.com/.default"
REQUIRED_ROLE = "Mail.Send"


@dataclass(frozen=True)
class GraphCredentials:
    tenant_id: str
    client_id: str
    client_secret: str
    sender: str
    sender_name: str | None = None
    reply_to: str | None = None
    save_to_sent: bool = False

    @property
    def fingerprint(self) -> str:
        raw = f"{self.tenant_id}|{self.client_id}|{self.client_secret}".encode()
        return hashlib.sha256(raw).hexdigest()[:24]


class GraphError(ProviderError):
    """Permanent Graph/Entra failure (retrying the same request will not help)."""

    def __init__(self, message: str, *, http_status: int | None = None, error_code: str | None = None, request_id: str | None = None):
        super().__init__(message)
        self.http_status, self.error_code, self.request_id = http_status, error_code, request_id


class GraphAuthError(GraphError):
    """Entra rejected the app credentials (tenant, client id or secret)."""


class GraphRetryableError(RetryableProviderError):
    def __init__(self, message: str, *, retry_after: float | None = None, http_status: int | None = None,
                 error_code: str | None = None, request_id: str | None = None):
        super().__init__(message, retry_after=retry_after)
        self.http_status, self.error_code, self.request_id = http_status, error_code, request_id


# --- Token cache (per process) -------------------------------------------------------------------

_tokens: dict[str, tuple[str, float]] = {}
_lock = threading.Lock()


def clear_token_cache() -> None:
    with _lock:
        _tokens.clear()


def _retry_after(resp: httpx.Response) -> float | None:
    try:
        v = resp.headers.get("Retry-After")
        return float(v) if v else None
    except ValueError:
        return None


def _rid(resp: httpx.Response) -> str | None:
    return resp.headers.get("request-id") or resp.headers.get("client-request-id")


def _client(timeout: float | None = None) -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(timeout or get_settings().graph_timeout_s, connect=10.0))


def acquire_token(creds: GraphCredentials, *, force: bool = False) -> tuple[str, dict[str, Any]]:
    """(access token, decoded claims). Raises GraphAuthError for bad credentials."""
    now = time.time()
    if not force:
        with _lock:
            hit = _tokens.get(creds.fingerprint)
        if hit and hit[1] > now:
            return hit[0], _claims(hit[0])
    s = get_settings()
    url = f"{s.graph_login_url.rstrip('/')}/{quote(creds.tenant_id, safe='')}/oauth2/v2.0/token"
    data = {"grant_type": "client_credentials", "client_id": creds.client_id, "client_secret": creds.client_secret, "scope": SCOPE}
    try:
        with _client(20.0) as c:
            resp = c.post(url, data=data)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise GraphRetryableError(f"Cannot reach Microsoft Entra ID ({type(e).__name__})") from e
    if resp.status_code == 200:
        body = resp.json()
        token = str(body.get("access_token") or "")
        if not token:
            raise GraphError("Entra ID returned no access token", http_status=200)
        ttl = max(60, int(body.get("expires_in") or 3600) - 120)
        with _lock:
            _tokens[creds.fingerprint] = (token, now + ttl)
        return token, _claims(token)
    try:
        err = resp.json()
    except ValueError:
        err = {}
    code = str(err.get("error") or "")
    desc = str(err.get("error_description") or resp.text)[:400].split("\r\n")[0]
    if resp.status_code == 429 or resp.status_code >= 500:
        raise GraphRetryableError(f"Entra ID HTTP {resp.status_code}", retry_after=_retry_after(resp), http_status=resp.status_code, error_code=code)
    raise GraphAuthError(f"Microsoft Entra ID rejected the app credentials ({code or resp.status_code}): {desc}",
                         http_status=resp.status_code, error_code=code or None, request_id=err.get("trace_id"))


def _claims(token: str) -> dict[str, Any]:
    """Decode the JWT payload for diagnostics (roles granted to the app). Not a signature check."""
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return {}


def verify(creds: GraphCredentials) -> dict[str, Any]:
    """Prove the credentials work and the app holds the Mail.Send application role.
    Returns {"latency_ms", "roles"}. (Whether the sender mailbox accepts the app is only provable
    by sending: use the test email.)"""
    t0 = time.perf_counter()
    _, claims = acquire_token(creds, force=True)
    roles = list(claims.get("roles") or [])
    if claims and REQUIRED_ROLE not in roles:
        raise GraphError(
            "The app registration has no Mail.Send application permission (or admin consent was not granted). "
            "In Entra ID → App registrations → API permissions, add Microsoft Graph → Application → Mail.Send and grant admin consent.",
            error_code="missing_mail_send_role",
        )
    return {"latency_ms": int((time.perf_counter() - t0) * 1000), "roles": roles}


def _recipient(addr: str, name: str | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"address": addr}
    if name:
        e["name"] = name
    return {"emailAddress": e}


def build_message(creds: GraphCredentials, to: str, subject: str, html: str | None, text: str | None,
                  headers: dict[str, str] | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "subject": subject[:255],
        "body": {"contentType": "HTML", "content": html} if html else {"contentType": "Text", "content": text or ""},
        "toRecipients": [_recipient(to)],
    }
    if creds.sender_name:
        msg["from"] = _recipient(creds.sender, creds.sender_name)
    if creds.reply_to:
        msg["replyTo"] = [_recipient(creds.reply_to)]
    if headers:  # custom headers must start with X-
        msg["internetMessageHeaders"] = [{"name": k, "value": v} for k, v in headers.items()]
    return {"message": msg, "saveToSentItems": bool(creds.save_to_sent)}


def _graph_error(resp: httpx.Response) -> tuple[str, str]:
    try:
        err = resp.json().get("error") or {}
        return str(err.get("code") or ""), str(err.get("message") or "")[:500]
    except (ValueError, AttributeError):
        return "", resp.text[:500]


def send_mail(creds: GraphCredentials, body: dict[str, Any]) -> str:
    """POST sendMail. Returns Graph's request-id. Raises GraphError / GraphRetryableError."""
    url = f"{get_settings().graph_base_url.rstrip('/')}/v1.0/users/{quote(creds.sender, safe='@.')}/sendMail"
    for refreshed in (False, True):
        token, _ = acquire_token(creds, force=refreshed)
        try:
            with _client() as c:
                resp = c.post(url, json=body, headers={"Authorization": f"Bearer {token}"})
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise GraphRetryableError(f"Cannot reach Microsoft Graph ({type(e).__name__})") from e
        rid = _rid(resp)
        if resp.status_code in (200, 202):
            return rid or "accepted"
        code, message = _graph_error(resp)
        status = resp.status_code
        if status == 401 and not refreshed:
            continue  # expired/revoked token: fetch a fresh one once
        if status == 429 or status >= 500:
            raise GraphRetryableError(f"Microsoft Graph HTTP {status} {code}: {message}".strip(), retry_after=_retry_after(resp),
                                      http_status=status, error_code=code or None, request_id=rid)
        if status == 403:
            hint = ("Access denied: grant the Mail.Send application permission with admin consent, and check that any "
                    "Application Access Policy includes the sender mailbox")
            raise GraphError(f"{hint} ({code}: {message})", http_status=status, error_code=code or "ErrorAccessDenied", request_id=rid)
        if status == 404:
            raise GraphError(f"Sender mailbox {creds.sender} was not found in this tenant ({code}: {message})",
                             http_status=status, error_code=code or "ResourceNotFound", request_id=rid)
        raise GraphError(f"Microsoft Graph HTTP {status} {code}: {message}".strip(), http_status=status, error_code=code or None, request_id=rid)
    raise GraphError("Microsoft Graph rejected the access token twice", http_status=401, error_code="InvalidAuthenticationToken")


class GraphMailAdapter:
    key = "graph"

    def __init__(self, creds: GraphCredentials):
        self.creds = creds

    def send(self, recipient: str, payload: dict[str, Any]) -> str:
        if not recipient:
            raise GraphError("No recipient address", error_code="no_recipient")
        headers = {"X-TTBS-Notification-Id": str(payload["notification_id"])} if payload.get("notification_id") else None
        body = build_message(self.creds, recipient, payload.get("subject") or "(no subject)", payload.get("html"),
                             payload.get("text") or payload.get("body"), headers)
        return send_mail(self.creds, body)
