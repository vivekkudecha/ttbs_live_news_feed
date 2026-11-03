"""Excel/CSV import: parse → validate → preview (no writes to master data) → commit (one transaction).

Expected columns (case-insensitive, aliases accepted):
    Company*, Industry, Segment, PAM Name*, PAM Email*, PAM WhatsApp*
A Region/Zone column, if present, is ignored.
"""

import csv
import hashlib
import io
import re
import zipfile
from dataclasses import dataclass
from typing import Any

from email_validator import EmailNotValidError, validate_email
from openpyxl import load_workbook
from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, PayloadTooLarge, UnsupportedMedia, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import IMPORT_COMMITTED, IMPORT_PREVIEWED, SEGMENTS, Company, ImportBatch, Pam
from app.db.session import LOCK_IMPORT_COMMIT, UnitOfWork
from app.services import audit

HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "company": ("company", "company name", "logo", "account", "account name"),
    "industry": ("industry", "sector"),
    "segment": ("segment",),
    "pam_name": ("pam name", "pam", "account manager"),
    "pam_email": ("pam email", "pam e-mail", "email"),
    "pam_whatsapp": ("pam whatsapp", "whatsapp", "pam phone", "pam mobile", "mobile"),
}
REQUIRED = ("company", "pam_name", "pam_email", "pam_whatsapp")
IGNORED_HEADERS = {"region", "zone"}
SAMPLE_SIZE = 50
MAX_ISSUES = 500


def name_key(name: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", name.upper())


def normalize_whatsapp(raw: str, default_cc: str) -> str | None:
    digits = re.sub(r"\D", "", raw or "")
    if raw.strip().startswith("00"):
        digits = digits[2:]
    if len(digits) == 10:
        digits = default_cc + digits
    elif len(digits) == 11 and digits.startswith("0"):
        digits = default_cc + digits[1:]
    return f"+{digits}" if 11 <= len(digits) <= 15 else None


def _canon_segment(v: str) -> str | None:
    k = re.sub(r"[^a-z]", "", v.lower())
    return next((s for s in SEGMENTS if re.sub(r"[^a-z]", "", s.lower()) == k), None)


# --- Parsing ---------------------------------------------------------------------------------


def _read_table(file_name: str, data: bytes) -> list[list[Any]]:
    s = get_settings()
    if len(data) > s.import_max_bytes:
        raise PayloadTooLarge(f"File is larger than {s.import_max_bytes // (1024 * 1024)} MB")
    if not data:
        raise ValidationFailed("The file is empty")
    lower = file_name.lower()
    if lower.endswith(".xlsx"):
        if not data.startswith(b"PK"):
            raise UnsupportedMedia("File has an .xlsx name but is not an Excel workbook")
        try:
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)  # formulas → cached values
        except (zipfile.BadZipFile, KeyError, ValueError, OSError) as e:
            raise ValidationFailed("Could not read the workbook; is it a valid .xlsx file?") from e
        try:
            ws = wb.worksheets[0]
            rows = []
            for row in ws.iter_rows(values_only=True):
                rows.append(list(row))
                if len(rows) > s.import_max_rows + 1:
                    break
            return rows
        finally:
            wb.close()
    if lower.endswith(".csv"):
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("cp1252", errors="replace")
        return [r for r in csv.reader(io.StringIO(text))][: s.import_max_rows + 2]
    raise UnsupportedMedia("Only .xlsx or .csv files are accepted")


def _map_headers(header: list[Any]) -> tuple[dict[str, int], list[str]]:
    mapping: dict[str, int] = {}
    unknown: list[str] = []
    for idx, cell in enumerate(header):
        h = re.sub(r"\s+", " ", str(cell or "").strip().lower())
        if not h:
            continue
        field = next((f for f, aliases in HEADER_ALIASES.items() if h in aliases), None)
        if field and field not in mapping:
            mapping[field] = idx
        elif h not in IGNORED_HEADERS:
            unknown.append(str(cell))
    return mapping, unknown


def _cell(row: list[Any], idx: int | None) -> str:
    if idx is None or idx >= len(row) or row[idx] is None:
        return ""
    v = row[idx]
    if isinstance(v, float) and v.is_integer():
        v = int(v)  # phone numbers typed as numbers in Excel
    return re.sub(r"\s+", " ", str(v)).strip()


@dataclass
class ParsedFile:
    rows: list[dict[str, Any]]
    issues: list[dict[str, Any]]
    total: int
    errors: int
    duplicates_merged: int


def parse_file(file_name: str, data: bytes) -> ParsedFile:
    s = get_settings()
    table = _read_table(file_name, data)
    # Skip leading blank rows to find the header.
    start = next((i for i, r in enumerate(table) if any(c not in (None, "") for c in r)), None)
    if start is None:
        raise ValidationFailed("The file has no header row")
    mapping, _unknown = _map_headers(table[start])
    missing = [f for f in REQUIRED if f not in mapping]
    if missing:
        labels = {"company": "Company", "pam_name": "PAM Name", "pam_email": "PAM Email", "pam_whatsapp": "PAM WhatsApp"}
        raise ValidationFailed(
            "Missing required column(s): " + ", ".join(labels[m] for m in missing),
            details={"missing": [labels[m] for m in missing]},
        )
    body = table[start + 1 :]
    if len(body) > s.import_max_rows:
        raise PayloadTooLarge(f"Too many rows: limit is {s.import_max_rows:,}")

    issues: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    pam_names: dict[str, str] = {}
    total = errors = dupes = 0

    def issue(rown: int, company: str, field: str, msg: str, sev: str) -> None:
        if len(issues) < MAX_ISSUES:
            issues.append({"row": rown, "company": company, "field": field, "message": msg, "severity": sev})

    for offset, row in enumerate(body):
        rown = start + offset + 2  # 1-based sheet row number
        values = {f: _cell(row, mapping.get(f)) for f in HEADER_ALIASES}
        if not any(values.values()):
            continue
        total += 1
        company = values["company"]
        row_errors = 0
        if not company:
            issue(rown, "", "Company", "Company name is required", "error")
            row_errors += 1
        if not values["pam_name"]:
            issue(rown, company, "PAM Name", "PAM name is required", "error")
            row_errors += 1
        email = values["pam_email"]
        try:
            email = validate_email(email, check_deliverability=False).normalized.lower()
        except EmailNotValidError as e:
            issue(rown, company, "PAM Email", f"Invalid email: {e}", "error")
            row_errors += 1
        wa = normalize_whatsapp(values["pam_whatsapp"], s.import_default_country_code)
        if not wa:
            issue(rown, company, "PAM WhatsApp", f"'{values['pam_whatsapp'] or 'blank'}' is not a valid mobile number", "error")
            row_errors += 1
        segment = None
        if values["segment"]:
            segment = _canon_segment(values["segment"])
            if not segment:
                issue(rown, company, "Segment", f"Unknown segment '{values['segment']}'; left blank", "warning")
        if row_errors:
            errors += 1
            continue

        if email in pam_names and pam_names[email].lower() != values["pam_name"].lower():
            issue(rown, company, "PAM Name", f"{email} also appears as '{pam_names[email]}'; using the first name", "warning")
        pam_names.setdefault(email, values["pam_name"])

        key = name_key(company)
        if key in by_key:
            dupes += 1
            issue(rown, company, "Company", f"Duplicate of row {by_key[key]['row']}; this later row wins", "warning")
        by_key[key] = {
            "row": rown,
            "company": company,
            "name_key": key,
            "industry": values["industry"] or None,
            "segment": segment,
            "pam_name": pam_names[email],
            "pam_email": email,
            "pam_whatsapp": wa,
        }

    if total == 0:
        raise ValidationFailed("The file has a header but no data rows")
    return ParsedFile(rows=list(by_key.values()), issues=issues, total=total, errors=errors, duplicates_merged=dupes)


# --- Diff against the database ----------------------------------------------------------------


def _chunks(seq: list[Any], n: int = 900):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def _load_existing(uow: UnitOfWork, rows: list[dict[str, Any]]) -> tuple[dict[str, Company], dict[str, Pam]]:
    s = uow.session
    companies: dict[str, Company] = {}
    for chunk in _chunks([r["name_key"] for r in rows]):
        for c in s.scalars(select(Company).where(Company.name_key.in_(chunk))):
            companies[c.name_key] = c
    pams: dict[str, Pam] = {}
    for chunk in _chunks(sorted({r["pam_email"] for r in rows})):
        for p in s.scalars(select(Pam).where(Pam.email.in_(chunk))):
            pams[p.email] = p
    return companies, pams


def _diff(uow: UnitOfWork, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    companies, pams = _load_existing(uow, rows)
    counts = {"new_companies": 0, "updated_companies": 0, "reassignments": 0, "unchanged": 0}
    out = []
    for r in rows:
        c = companies.get(r["name_key"])
        if c is None:
            change = "new"
        elif c.pam is None or c.pam.email != r["pam_email"]:
            change = "reassigned"
        elif (r["industry"] and r["industry"] != c.industry) or (r["segment"] and r["segment"] != c.segment) or not c.active:
            change = "updated"
        else:
            change = "unchanged"
        key = {"new": "new_companies", "updated": "updated_companies", "reassigned": "reassignments"}.get(change, "unchanged")
        counts[key] += 1
        out.append({**r, "change": change})
    counts["new_pams"] = len({r["pam_email"] for r in rows} - set(pams))
    return out, counts


# --- Public API --------------------------------------------------------------------------------


def preview(uow: UnitOfWork, file_name: str, data: bytes, actor: str) -> ImportBatch:
    parsed = parse_file(file_name, data)
    diffed, counts = _diff(uow, parsed.rows)
    batch = ImportBatch(
        file_name=file_name[:255],
        file_sha256=hashlib.sha256(data).hexdigest(),
        uploaded_by=actor,
        status=IMPORT_PREVIEWED,
        rows_total=parsed.total,
        rows_valid=len(parsed.rows),
        rows_error=parsed.errors,
        rows=parsed.rows,
        issues=parsed.issues,
        summary={**counts, "duplicates_merged": parsed.duplicates_merged, "sample": diffed[:SAMPLE_SIZE]},
    )
    uow.session.add(batch)
    uow.session.flush()
    audit.record(
        uow, "import.preview", "import", batch.id,
        {"file": batch.file_name, "rows": parsed.total, "errors": parsed.errors, **counts},
        actor=actor,
    )
    return batch


def commit(uow: UnitOfWork, import_id: int, actor: str) -> ImportBatch:
    uow.advisory_lock(LOCK_IMPORT_COMMIT)
    s = uow.session
    batch = s.get(ImportBatch, import_id, with_for_update=True)
    if batch is None:
        raise NotFound(f"Import {import_id} not found")
    if batch.status != IMPORT_PREVIEWED:
        raise Conflict(f"Import {import_id} is already {batch.status}")
    if not batch.rows:
        raise ValidationFailed("Nothing to commit: every row has errors")

    # Re-diff against the current database: someone may have changed data since the preview.
    diffed, counts = _diff(uow, batch.rows)
    companies, pams = _load_existing(uow, batch.rows)

    for r in batch.rows:
        p = pams.get(r["pam_email"])
        if p is None:
            p = Pam(name=r["pam_name"], email=r["pam_email"], whatsapp=r["pam_whatsapp"], active=True)
            s.add(p)
            pams[p.email] = p
        else:
            p.name, p.whatsapp, p.active = r["pam_name"], r["pam_whatsapp"], True
    s.flush()

    for r in diffed:
        p = pams[r["pam_email"]]
        c = companies.get(r["name_key"])
        if c is None:
            c = Company(name=r["company"], name_key=r["name_key"], industry=r["industry"], segment=r["segment"], active=True)
            s.add(c)
        else:
            c.name = r["company"]
            if r["industry"]:
                c.industry = r["industry"]
            if r["segment"]:
                c.segment = r["segment"]
            c.active = True
        c.pam_id = p.id
        c.last_import_id = batch.id
    s.flush()

    batch.status = IMPORT_COMMITTED
    batch.committed_at = utcnow()
    batch.summary = {**batch.summary, **counts, "committed": len(diffed)}
    audit.record(uow, "import.commit", "import", batch.id, {"file": batch.file_name, **counts}, actor=actor)
    return batch


def summary_text(batch: ImportBatch) -> str:
    sm = batch.summary or {}
    parts = [
        f"{sm.get('new_companies', 0)} new companies",
        f"{sm.get('updated_companies', 0)} updated",
        f"{sm.get('reassignments', 0)} reassignments",
        f"{sm.get('new_pams', 0)} new PAMs",
    ]
    if sm.get("duplicates_merged"):
        parts.append(f"{sm['duplicates_merged']} duplicates merged")
    if batch.rows_error:
        parts.append(f"{batch.rows_error} rows rejected")
    return " · ".join(parts)
