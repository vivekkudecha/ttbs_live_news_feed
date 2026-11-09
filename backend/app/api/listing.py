"""Server-side sorting and column filters for every table endpoint.

Each endpoint declares a whitelist (`Spec`): column id (as the UI names it) → SQL expression and
filter kind. Requests carry `sort`, `desc` and `filter` (a JSON object, column id → value):

    text   "acme"                      case-insensitive contains
    enum   ["signal", "failed"]        any of (IN)
    range  {"min": 1, "max": 10}       numbers, inclusive; either bound optional
    date   {"from": "2026-11-01", "to": "2026-11-09"}   dates (ISO), inclusive, `to` covers the whole day
    bool   true | false

Unknown columns, kinds that do not match, or malformed values are rejected (422) — nothing the
client sends reaches SQL except as a bound parameter.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Literal

from fastapi import Query
from sqlalchemy import ColumnElement, false, func

from app.core.errors import ValidationFailed

Kind = Literal["text", "enum", "range", "date", "bool"]
MAX_FILTER_JSON = 4000
MAX_ENUM = 50
MAX_TEXT = 200


@dataclass(frozen=True)
class Col:
    expr: Any  # SQLAlchemy column / expression
    kind: Kind | None = None  # None = sortable only
    sortable: bool = True


Spec = dict[str, Col]


@dataclass
class Listing:
    sort: str | None = None
    desc: bool = False
    filters: dict[str, Any] = field(default_factory=dict)

    def key(self) -> str:
        """Stable cache-key fragment."""
        return f"{self.sort}:{int(self.desc)}:{json.dumps(self.filters, sort_keys=True, separators=(',', ':'))}"


def listing(
    sort: str | None = Query(None, max_length=60),
    desc: bool = False,
    filter: str | None = Query(None, max_length=MAX_FILTER_JSON),  # noqa: A002 - the public query name
) -> Listing:
    filters: dict[str, Any] = {}
    if filter:
        try:
            filters = json.loads(filter)
        except ValueError as e:
            raise ValidationFailed("`filter` must be a JSON object", details={"field": "filter"}) from e
        if not isinstance(filters, dict):
            raise ValidationFailed("`filter` must be a JSON object", details={"field": "filter"})
        # Empty values mean "no filter" (cleared inputs).
        filters = {k: v for k, v in filters.items() if v not in (None, "", [], {})}
    return Listing(sort=sort or None, desc=desc, filters=filters)


def _day(v: Any, end: bool) -> datetime:
    try:
        d = date.fromisoformat(str(v)[:10])
    except ValueError as e:
        raise ValidationFailed(f"Not a date: {v!r}") from e
    # `to` is inclusive of the whole day: < next midnight.
    return datetime.combine(d + timedelta(days=1) if end else d, time.min)


def _num(v: Any, col: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise ValidationFailed(f"Filter '{col}': not a number")
    try:
        return float(v)
    except ValueError as e:
        raise ValidationFailed(f"Filter '{col}': not a number") from e


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def conditions(spec: Spec, lst: Listing, *, skip: str | None = None) -> list[ColumnElement[bool]]:
    """WHERE clauses for the request's filters (`skip` one column, e.g. for its own facet counts)."""
    out: list[ColumnElement[bool]] = []
    for name, value in lst.filters.items():
        if name == skip:
            continue
        col = spec.get(name)
        if col is None or col.kind is None:
            raise ValidationFailed(f"Cannot filter by '{name}'", details={"field": "filter", "column": name})
        e = col.expr
        if col.kind == "text":
            if not isinstance(value, str):
                raise ValidationFailed(f"Filter '{name}': expected text")
            out.append(func.lower(e).like(f"%{_escape_like(value.strip()[:MAX_TEXT].lower())}%", escape="\\"))
        elif col.kind == "enum":
            vals = value if isinstance(value, list) else [value]
            if len(vals) > MAX_ENUM or not all(isinstance(v, (str, int)) and not isinstance(v, bool) for v in vals):
                raise ValidationFailed(f"Filter '{name}': expected a list of values")
            out.append(e.in_([str(v) for v in vals]) if vals else false())
        elif col.kind == "range":
            if not isinstance(value, dict):
                raise ValidationFailed(f"Filter '{name}': expected {{min, max}}")
            if value.get("min") not in (None, ""):
                out.append(e >= _num(value["min"], name))
            if value.get("max") not in (None, ""):
                out.append(e <= _num(value["max"], name))
        elif col.kind == "date":
            if not isinstance(value, dict):
                raise ValidationFailed(f"Filter '{name}': expected {{from, to}}")
            if value.get("from"):
                out.append(e >= _day(value["from"], end=False))
            if value.get("to"):
                out.append(e < _day(value["to"], end=True))
        elif col.kind == "bool":
            if not isinstance(value, bool):
                raise ValidationFailed(f"Filter '{name}': expected true or false")
            out.append(e.is_(value))
    return out


def ordering(spec: Spec, lst: Listing, default: list[Any], tiebreak: Any) -> list[Any]:
    """ORDER BY: the requested column (validated) or the endpoint default, always + a unique tiebreak
    so paging is stable."""
    if not lst.sort:
        return [*default, tiebreak]
    col = spec.get(lst.sort)
    if col is None or not col.sortable:
        raise ValidationFailed(f"Cannot sort by '{lst.sort}'", details={"field": "sort", "column": lst.sort})
    e = col.expr
    return [e.desc() if lst.desc else e.asc(), tiebreak.desc() if lst.desc else tiebreak.asc()]

