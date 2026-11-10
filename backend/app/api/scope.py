"""Runtime user scope: the one place where a signed-in user's row-level restrictions are applied.

The cache is centralized (app/core/cache.py): datasets are computed and cached once for every user,
and keys never contain a user id, role or permission. Anything that depends on *who* is asking is
applied here, after the cache read, on the shared copy:

    base = cache.shared("accounts", key, ttl, load)          # same for everyone
    rows = scope.rows(principal, "companies", base_rows)     # this user's slice

Module access ("view"/"manage" per module) is already enforced by `deps.authorize` before a
handler runs. Today no role is limited to a subset of rows, so `rows()` returns its input; a
future rule (e.g. members see only their own PAM's logos) goes here and keeps the cache shared.
Implementations must not mutate the shared rows: return a new list.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.api.deps import Principal

# kind -> rule(principal, rows) -> rows. Empty: every signed-in user with module access sees all rows.
RULES: dict[str, Callable[[Principal, list[Any]], list[Any]]] = {}


def rows(principal: Principal | None, kind: str, data: list[Any]) -> list[Any]:
    rule = RULES.get(kind)
    if rule is None or principal is None:
        return data
    return rule(principal, data)
