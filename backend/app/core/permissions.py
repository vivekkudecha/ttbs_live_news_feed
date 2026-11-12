"""Modules, access levels and the API routes each module covers.

Access is decided per request from the matched route TEMPLATE (e.g. /api/v1/runs/{run_id}), not
the raw path, and fails closed: a route that no rule covers is refused (tests/test_auth.py asserts
every route is covered, so a new endpoint cannot ship unprotected by accident).

Levels: "view" (read) < "manage" (create, change, delete, start/cancel/resend...). GET and HEAD
need "view"; any other method needs "manage", except the read-only POST searches in READ_POSTS.
Admins have every level on every module; members have what an admin granted them.
"""

from dataclasses import dataclass
from typing import Literal

Level = Literal["view", "manage"]
LEVELS: tuple[Level, ...] = ("view", "manage")
_RANK = {"view": 1, "manage": 2}


@dataclass(frozen=True)
class Module:
    key: str
    label: str
    description: str


MODULES: tuple[Module, ...] = (
    Module("dashboard", "Dashboard", "Overview of the latest run and signals."),
    Module("signals", "Signals", "Signals feed."),
    Module("runs", "Research runs", "Start, cancel and retry runs; resend digests; run details."),
    Module("companies", "Companies (Logos)", "Browse companies and reassign them between PAMs."),
    Module("pams", "PAMs", "Browse PAMs and the logos each owns."),
    Module("imports", "Uploads", "Upload, edit, save and download datasets."),
    Module("integrations", "Providers & channels", "AI provider keys and models, the research prompt, email (Microsoft Graph) settings and email templates."),
    Module("costs", "Costs (FinOps)", "Spend reports and the cost ledger export."),
    Module("telemetry", "Telemetry", "Pipeline events and queue health."),
    Module("audit", "Audit log", "The tamper-evident audit trail."),
)
MODULE_KEYS = frozenset(m.key for m in MODULES)

# Access classes besides modules.
PUBLIC = "public"  # no session needed
SESSION = "session"  # any signed-in user, even one who must still change their password
SIGNED_IN = "signed_in"  # any signed-in user with a usable password
ADMIN = "admin"  # role admin only (user management)

P = "/api/v1"

# Exact route templates outside the module scheme.
EXACT: dict[str, str] = {
    f"{P}/health": PUBLIC,
    f"{P}/auth/login": PUBLIC,
    f"{P}/auth/password-policy": PUBLIC,
    f"{P}/auth/me": SESSION,
    f"{P}/auth/logout": SESSION,
    f"{P}/auth/change-password": SESSION,
    f"{P}/auth/modules": SIGNED_IN,
    # Reference data and pickers used across pages (ids + names only).
    f"{P}/templates": SIGNED_IN,
    f"{P}/channels": SIGNED_IN,
    f"{P}/companies/search": SIGNED_IN,
    f"{P}/pams/search": SIGNED_IN,
    f"{P}/pams/by-ids": SIGNED_IN,
}

# Route-template prefixes → module (or ADMIN). First match wins, so list specific ones first.
PREFIXES: tuple[tuple[str, str], ...] = (
    (f"{P}/users", ADMIN),
    (f"{P}/dashboard", "dashboard"),
    (f"{P}/signals", "signals"),
    (f"{P}/run-summaries", "runs"),
    (f"{P}/runs", "runs"),
    (f"{P}/schedules", "runs"),
    (f"{P}/scopes", "runs"),
    (f"{P}/notifications", "runs"),
    (f"{P}/companies", "companies"),
    (f"{P}/pams", "pams"),
    (f"{P}/imports", "imports"),
    (f"{P}/settings/llm", "integrations"),
    (f"{P}/settings/email", "integrations"),
    (f"{P}/email-templates", "integrations"),
    (f"{P}/research-prompt", "integrations"),
    (f"{P}/finops", "costs"),
    (f"{P}/telemetry", "telemetry"),
    (f"{P}/queues", "telemetry"),
    (f"{P}/audit", "audit"),
)

# POST endpoints that only read (complex filters in the body).
READ_POSTS = frozenset({
    f"{P}/companies/query",
    f"{P}/pams/query",
    f"{P}/settings/llm/{{provider}}/models",
    f"{P}/research-prompt/preview",
    f"{P}/schedules/preview",
})


def classify(route_path: str) -> str | None:
    """Access class or module key for a route template; None = not covered (deny)."""
    if route_path in EXACT:
        return EXACT[route_path]
    for prefix, target in PREFIXES:
        if route_path == prefix or route_path.startswith(prefix + "/"):
            return target
    return None


def required_level(method: str, route_path: str) -> Level:
    if method in ("GET", "HEAD") or (method == "POST" and route_path in READ_POSTS):
        return "view"
    return "manage"


def allows(granted: str | None, needed: Level) -> bool:
    return _RANK.get(granted or "", 0) >= _RANK[needed]


def clean(perms: dict | None) -> dict[str, Level]:
    """Keep only known modules with valid levels ("none" and unknown keys are dropped)."""
    out: dict[str, Level] = {}
    for k, v in (perms or {}).items():
        if k in MODULE_KEYS and v in LEVELS:
            out[k] = v
    return out
