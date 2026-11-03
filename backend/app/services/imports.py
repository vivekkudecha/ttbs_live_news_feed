"""Excel/CSV uploads as named datasets: parse → validate → save in the background (chunked,
resumable) → edit / delete rows (changes go to master data).

Expected columns (case-insensitive, aliases accepted):
    Company*, Industry, Segment, PAM Name*, PAM Email*, PAM WhatsApp*
A Region/Zone column, if present, is ignored.
"""

import csv
import hashlib
import io
import logging
import re
import uuid
import zipfile
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from email_validator import EmailNotValidError, validate_email
from openpyxl import load_workbook
from sqlalchemy import delete, func, select, update

from app.core import cache
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, PayloadTooLarge, UnsupportedMedia, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import (
    IMPORT_ACTIVE,
    IMPORT_COMPLETED,
    IMPORT_FAILED,
    IMPORT_PROCESSING,
    IMPORT_QUEUED,
    SEGMENTS,
    Company,
    DatasetCompany,
    ImportBatch,
    Pam,
)
from app.db.session import UnitOfWork, unit_of_work
from app.services import assignments, audit

log = logging.getLogger(__name__)

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


# --- Datasets: create → background save (chunked, resumable) ------------------------------------


def create(uow: UnitOfWork, file_name: str, data: bytes, label: str | None, actor: str) -> ImportBatch:
    """Parse + validate the file and store it as a queued dataset. Rows are saved to master data
    by `process` in the background; nothing else is written here."""
    parsed = parse_file(file_name, data)
    now = utcnow()
    label = (label or "").strip()[:200] or file_name.rsplit(".", 1)[0][:200]
    batch = ImportBatch(
        file_name=file_name[:255],
        file_sha256=hashlib.sha256(data).hexdigest(),
        uploaded_by=actor,
        label=label,
        status=IMPORT_QUEUED if parsed.rows else IMPORT_FAILED,
        rows_total=parsed.total,
        rows_valid=len(parsed.rows),
        rows_error=parsed.errors,
        rows=parsed.rows,
        issues=parsed.issues,
        summary={"new_companies": 0, "updated_companies": 0, "reassignments": 0, "new_pams": 0, "unchanged": 0,
                 "duplicates_merged": parsed.duplicates_merged},
        error=None if parsed.rows else "Every row has errors; nothing to save",
        heartbeat_at=now,
    )
    uow.session.add(batch)
    uow.session.flush()
    audit.record(uow, "dataset.upload", "import", batch.id,
                 {"label": label, "file": batch.file_name, "rows": parsed.total, "valid": len(parsed.rows), "errors": parsed.errors}, actor=actor)
    if parsed.rows:
        _enqueue(uow, batch.id)
    return batch


def _enqueue(uow: UnitOfWork, batch_id: int, countdown: float = 0) -> None:
    from app.worker.tasks import process_import

    uow.after_commit(lambda: process_import.apply_async((batch_id,), countdown=countdown))


def _claim(batch_id: int) -> str | None:
    """Take the processing lease unless another worker holds a fresh one. Returns the token."""
    s = get_settings()
    now = utcnow()
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id, with_for_update=True)
        if b is None or b.status not in IMPORT_ACTIVE:
            return None
        fresh = b.heartbeat_at and as_utc(b.heartbeat_at) > now - timedelta(seconds=s.import_stall_seconds)
        if b.worker_token and fresh:
            return None  # someone else is saving it right now
        b.worker_token = uuid.uuid4().hex
        b.status = IMPORT_PROCESSING
        b.started_at = b.started_at or now
        b.heartbeat_at = now
        return b.worker_token


def process(batch_id: int) -> str:
    """Save a dataset's rows in chunks. Each chunk and the cursor move in ONE transaction, so a
    crash, restart or lost connection resumes exactly after the last saved chunk."""
    token = _claim(batch_id)
    if token is None:
        return "skipped"
    s = get_settings()
    while True:
        try:
            with unit_of_work() as uow:
                b = uow.session.get(ImportBatch, batch_id, with_for_update=True)
                if b is None or b.worker_token != token or b.status != IMPORT_PROCESSING:
                    return "lease lost"
                chunk = (b.rows or [])[b.rows_done: b.rows_done + s.import_chunk_size]
                if not chunk:
                    _finish(uow, b)
                    return "completed"
                counts = _apply(uow, b, chunk)
                b.summary = {**(b.summary or {}), **{k: (b.summary or {}).get(k, 0) + v for k, v in counts.items()}}
                b.rows_done += len(chunk)
                b.heartbeat_at = utcnow()
                b.failures, b.error = 0, None
        except Exception as e:  # rolled back: the cursor did not move, so nothing is half-saved
            log.exception("dataset chunk failed", extra={"import_id": batch_id})
            return _chunk_failed(batch_id, token, e)


def _chunk_failed(batch_id: int, token: str, e: Exception) -> str:
    s = get_settings()
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id)
        if b is None or b.worker_token != token:
            return "lease lost"
        b.failures += 1
        b.error = f"{type(e).__name__}: {e}"[:1000]
        b.worker_token = None
        if b.failures >= s.import_max_failures:
            b.status = IMPORT_FAILED
            audit.record(uow, "dataset.failed", "import", b.id, {"label": b.label, "saved": b.rows_done, "error": b.error}, actor="system")
            uow.after_commit(lambda: cache.bump("imports", "runs"))
            return "failed"
        _enqueue(uow, b.id, countdown=min(2 ** b.failures, 60))
        return "retry"


def _finish(uow: UnitOfWork, b: ImportBatch) -> None:
    b.status = IMPORT_COMPLETED
    b.committed_at = utcnow()
    b.worker_token = None
    sm = b.summary or {}
    audit.record(uow, "dataset.saved", "import", b.id,
                 {"label": b.label, "rows": b.rows_done, **{k: sm.get(k, 0) for k in ("new_companies", "updated_companies", "reassignments", "new_pams")}},
                 actor=b.uploaded_by)
    uow.after_commit(lambda: cache.bump("imports", "runs"))


def _apply(uow: UnitOfWork, b: ImportBatch, rows: list[dict[str, Any]]) -> dict[str, int]:
    """Upsert PAMs + companies, record ownership history, add dataset membership. Idempotent."""
    s = uow.session
    diffed, counts = _diff(uow, rows)
    companies, pams = _load_existing(uow, rows)
    for r in rows:
        p = pams.get(r["pam_email"])
        if p is None:
            p = Pam(name=r["pam_name"], email=r["pam_email"], whatsapp=r["pam_whatsapp"], active=True)
            s.add(p)
            pams[p.email] = p
        else:
            p.name, p.whatsapp, p.active = r["pam_name"], r["pam_whatsapp"], True
    s.flush()

    now = utcnow()
    for r in diffed:
        c = companies.get(r["name_key"])
        if c is None:
            c = Company(name=r["company"], name_key=r["name_key"], industry=r["industry"], segment=r["segment"], active=True)
            s.add(c)
            s.flush()
            companies[c.name_key] = c
        else:
            c.name = r["company"]
            if r["industry"]:
                c.industry = r["industry"]
            if r["segment"]:
                c.segment = r["segment"]
            c.active = True
        assignments.assign(uow, c, pams[r["pam_email"]].id, reason="import", actor=b.uploaded_by, ts=now)
        c.last_import_id = b.id

    ids = [companies[r["name_key"]].id for r in rows]
    have = set(s.scalars(select(DatasetCompany.company_id).where(DatasetCompany.import_id == b.id, DatasetCompany.company_id.in_(ids))))
    for r in rows:
        cid = companies[r["name_key"]].id
        if cid not in have:
            s.add(DatasetCompany(import_id=b.id, company_id=cid, row_no=r.get("row", 0)))
            have.add(cid)
    s.flush()
    return {k: counts.get(k, 0) for k in ("new_companies", "updated_companies", "reassignments", "new_pams", "unchanged")}


def resume(uow: UnitOfWork, batch_id: int, actor: str) -> ImportBatch:
    """Manually resume a failed or stalled upload from its last saved chunk."""
    b = get_dataset(uow, batch_id)
    if b.status == IMPORT_COMPLETED:
        raise Conflict("This dataset is already saved")
    if not b.rows:
        raise Conflict("This upload has no valid rows to save")
    b.status, b.worker_token, b.failures, b.error, b.heartbeat_at = IMPORT_QUEUED, None, 0, None, utcnow()
    audit.record(uow, "dataset.resume", "import", b.id, {"label": b.label, "from_row": b.rows_done}, actor=actor)
    _enqueue(uow, b.id)
    return b


def stalled(uow: UnitOfWork, limit: int = 50) -> list[int]:
    """Uploads whose worker vanished (no heartbeat): the sweeper re-enqueues them."""
    cutoff = utcnow() - timedelta(seconds=get_settings().import_stall_seconds)
    return list(uow.session.scalars(
        select(ImportBatch.id).where(ImportBatch.status.in_(IMPORT_ACTIVE), ImportBatch.heartbeat_at <= cutoff).limit(limit)
    ))


# --- Datasets: read / rename / row edit + delete (row changes update master data) -----------------


def get_dataset(uow: UnitOfWork, batch_id: int) -> ImportBatch:
    b = uow.session.get(ImportBatch, batch_id)
    if b is None:
        raise NotFound(f"Dataset {batch_id} not found")
    return b


def rename(uow: UnitOfWork, batch_id: int, label: str, actor: str) -> ImportBatch:
    b = get_dataset(uow, batch_id)
    label = label.strip()[:200]
    if not label:
        raise ValidationFailed("Label cannot be empty", details={"field": "label"})
    audit.record(uow, "dataset.rename", "import", b.id, {"from": b.label, "to": label}, actor=actor)
    b.label = label
    return b


def _member(uow: UnitOfWork, batch_id: int, company_id: int) -> Company:
    ok = uow.session.scalar(select(DatasetCompany.id).where(DatasetCompany.import_id == batch_id, DatasetCompany.company_id == company_id))
    c = uow.session.get(Company, company_id) if ok else None
    if c is None:
        raise NotFound(f"Company {company_id} is not in dataset {batch_id}")
    return c


def update_row(uow: UnitOfWork, batch_id: int, company_id: int, patch: dict[str, Any], actor: str) -> Company:
    """Edit one row. Changes go to the real company / PAM records (used by research and digests)."""
    get_dataset(uow, batch_id)
    c = _member(uow, batch_id, company_id)
    s_ = get_settings()
    before = {"company": c.name, "industry": c.industry, "segment": c.segment, "pam": c.pam.email if c.pam else None}

    if "company" in patch:
        name = re.sub(r"\s+", " ", str(patch["company"] or "")).strip()
        if not name:
            raise ValidationFailed("Company name is required", details={"field": "company"})
        key = name_key(name)
        clash = uow.session.scalar(select(Company.id).where(Company.name_key == key, Company.id != c.id))
        if clash:
            raise Conflict(f"Another company is already called '{name}'", details={"field": "company"})
        c.name, c.name_key = name, key
    if "industry" in patch:
        c.industry = (str(patch["industry"] or "").strip() or None)
    if "segment" in patch:
        raw = str(patch["segment"] or "").strip()
        seg = _canon_segment(raw) if raw else None
        if raw and not seg:
            raise ValidationFailed(f"Segment must be one of {', '.join(SEGMENTS)}", details={"field": "segment"})
        c.segment = seg

    pam_fields = {k: patch[k] for k in ("pam_name", "pam_email", "pam_whatsapp") if k in patch}
    if pam_fields:
        cur = c.pam
        email = str(pam_fields.get("pam_email", cur.email if cur else "") or "").strip()
        try:
            email = validate_email(email, check_deliverability=False).normalized.lower()
        except EmailNotValidError as e:
            raise ValidationFailed(f"Invalid PAM email: {e}", details={"field": "pamEmail"}) from e
        target = uow.session.scalars(select(Pam).where(Pam.email == email)).first()
        name = str(pam_fields.get("pam_name") or (target.name if target else cur.name if cur else "")).strip()
        wa_raw = pam_fields.get("pam_whatsapp")
        wa = normalize_whatsapp(str(wa_raw), s_.import_default_country_code) if wa_raw not in (None, "") else None
        if wa_raw not in (None, "") and not wa:
            raise ValidationFailed(f"'{wa_raw}' is not a valid mobile number", details={"field": "pamWhatsapp"})
        if target is None:
            if not name or not wa:
                raise ValidationFailed("A new PAM needs a name and WhatsApp number", details={"field": "pamEmail"})
            target = Pam(name=name, email=email, whatsapp=wa, active=True)
            uow.session.add(target)
            uow.session.flush()
        else:
            target.name, target.active = name or target.name, True
            if wa:
                target.whatsapp = wa
        assignments.assign(uow, c, target.id, reason="manual", actor=actor, ts=utcnow())

    uow.session.flush()
    uow.session.expire(c, ["pam"])  # pam_id may have changed: reload the relationship
    after = {"company": c.name, "industry": c.industry, "segment": c.segment, "pam": c.pam.email if c.pam else None}
    audit.record(uow, "dataset.row.update", "company", c.id, {"dataset": batch_id, "before": before, "after": after}, actor=actor)
    uow.after_commit(lambda: cache.bump("imports", "runs"))
    return c


def delete_rows(uow: UnitOfWork, batch_id: int, company_ids: list[int], actor: str) -> dict[str, int]:
    """Remove companies from a dataset. A company in no other dataset stops being tracked."""
    b = get_dataset(uow, batch_id)
    ids = sorted(set(company_ids))
    removed = uow.session.execute(delete(DatasetCompany).where(DatasetCompany.import_id == b.id, DatasetCompany.company_id.in_(ids))).rowcount or 0
    still = set(uow.session.scalars(select(DatasetCompany.company_id).where(DatasetCompany.company_id.in_(ids))))
    orphans = [i for i in ids if i not in still]
    deactivated = 0
    if orphans:
        deactivated = uow.session.execute(update(Company).where(Company.id.in_(orphans), Company.active.is_(True)).values(active=False)).rowcount or 0
    audit.record(uow, "dataset.rows.delete", "import", b.id, {"label": b.label, "removed": removed, "stopped_tracking": deactivated}, actor=actor)
    uow.after_commit(lambda: cache.bump("imports", "runs"))
    return {"removed": removed, "stoppedTracking": deactivated}


def member_count(uow: UnitOfWork, batch_id: int) -> int:
    return uow.session.scalar(select(func.count(DatasetCompany.id)).where(DatasetCompany.import_id == batch_id)) or 0


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
