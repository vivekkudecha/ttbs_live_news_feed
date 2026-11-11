"""Excel/CSV uploads (up to 1 GB) as named datasets.

    stage    stream the file to disk (1 MB at a time, SHA-256 on the way), check type + header → "analyzing"
    analyze  background: read every row once (streaming), validate, de-duplicate, compare with the
             database in batches → counts, issues, 200-row sample → "previewed"
    save     the user names it → "queued"; `process` streams the stored file into master data in
             resumable chunks → "completed"
    discard  unsaved previews are dropped (by the user, or after IMPORT_PREVIEW_TTL_HOURS)

Nothing ever holds the whole file in memory; the file itself is kept, time-stamped, under UPLOAD_DIR.

Expected columns (case-insensitive, aliases accepted):
    Company*, Industry, PAM Name*, PAM Email*, PAM WhatsApp*
Region, Zone or Segment columns, if present, are ignored.
"""

import csv
import hashlib
import io
import logging
import os
import re
import time
import uuid
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from itertools import islice
from pathlib import Path
from typing import Any

from email_validator import EmailNotValidError, validate_email
from openpyxl import load_workbook
from sqlalchemy import func, insert, select, update

from app.core import cache, metrics
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, PayloadTooLarge, UnsupportedMedia, ValidationFailed
from app.core.timeutil import as_utc, utcnow
from app.db.models import (
    IMPORT_ACTIVE,
    IMPORT_ANALYZING,
    IMPORT_COMPLETED,
    IMPORT_DISCARDED,
    IMPORT_FAILED,
    IMPORT_PREVIEWED,
    IMPORT_PROCESSING,
    IMPORT_QUEUED,
    Company,
    CompanyAssignment,
    DatasetCompany,
    ImportBatch,
    Pam,
)
from app.db.session import UnitOfWork, unit_of_work
from app.services import assignments, audit, telemetry

log = logging.getLogger(__name__)

HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "company": ("company", "company name", "logo", "account", "account name"),
    "industry": ("industry", "sector"),
    "pam_name": ("pam name", "pam", "account manager"),
    "pam_email": ("pam email", "pam e-mail", "email"),
    "pam_whatsapp": ("pam whatsapp", "whatsapp", "pam phone", "pam mobile", "mobile"),
}
REQUIRED = ("company", "pam_name", "pam_email", "pam_whatsapp")
IGNORED_HEADERS = {"region", "zone", "segment"}
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


# --- Parsing ---------------------------------------------------------------------------------


def sniff(path: Path, file_name: str) -> str:
    """'xlsx' | 'csv' from the name, confirmed by the first bytes."""
    with open(path, "rb") as f:
        head = f.read(4)
    if not head:
        raise ValidationFailed("The file is empty")
    lower = file_name.lower()
    if lower.endswith(".xlsx"):
        if not head.startswith(b"PK"):
            raise UnsupportedMedia("File has an .xlsx name but is not an Excel workbook")
        return "xlsx"
    if lower.endswith(".csv"):
        return "csv"
    raise UnsupportedMedia("Only .xlsx or .csv files are accepted")


def _csv_encoding(path: Path) -> str:
    """UTF-8 unless the first MB is not valid UTF-8 (then Windows-1252, as Excel saves CSV)."""
    with open(path, "rb") as f:
        sample = f.read(1 << 20)
    try:
        sample.decode("utf-8-sig")
        return "utf-8-sig"
    except UnicodeDecodeError as e:
        return "utf-8-sig" if e.start >= len(sample) - 3 else "cp1252"  # a character cut at the sample edge


@contextmanager
def open_table(path: Path, kind: str) -> Iterator[tuple[Iterator[list[Any]], Callable[[], float | None]]]:
    """Stream the first sheet / the CSV row by row. Yields (rows, progress) where progress() is the
    fraction read so far (None when unknown)."""
    if kind == "csv":
        size = max(path.stat().st_size, 1)
        raw = open(path, "rb")  # noqa: SIM115 - closed below
        text = io.TextIOWrapper(raw, encoding=_csv_encoding(path), errors="replace", newline="")
        try:
            yield csv.reader(text), lambda: min(raw.tell() / size, 1.0)
        finally:
            text.close()
        return
    from openpyxl.utils.exceptions import InvalidFileException

    # A file handle, not a path: openpyxl judges paths by extension, and staged files end in ".part".
    fh = open(path, "rb")  # noqa: SIM115 - closed below
    try:
        wb = load_workbook(fh, read_only=True, data_only=True)  # streaming reader; formulas → cached values
    except (zipfile.BadZipFile, KeyError, ValueError, OSError, InvalidFileException) as e:
        fh.close()
        raise ValidationFailed("Could not read the workbook; is it a valid .xlsx file?") from e
    try:
        ws = wb.worksheets[0]
        expected = ws.max_row or None  # from the sheet's dimension tag; may be missing
        read = [0]

        def rows() -> Iterator[list[Any]]:
            for row in ws.iter_rows(values_only=True):
                read[0] += 1
                yield list(row)

        yield rows(), (lambda: min(read[0] / expected, 1.0) if expected else None)
    finally:
        wb.close()
        fh.close()


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


_LABELS = {"company": "Company", "pam_name": "PAM Name", "pam_email": "PAM Email", "pam_whatsapp": "PAM WhatsApp"}


def read_header(rows: Iterator[list[Any]]) -> tuple[dict[str, int], int]:
    """Consume rows up to the header. Returns (column mapping, 1-based header row number)."""
    for i, row in enumerate(rows):
        if any(c not in (None, "") for c in row):
            mapping, _unknown = _map_headers(row)
            missing = [f for f in REQUIRED if f not in mapping]
            if missing:
                raise ValidationFailed(
                    "Missing required column(s): " + ", ".join(_LABELS[m] for m in missing),
                    details={"missing": [_LABELS[m] for m in missing]},
                )
            return mapping, i + 1
        if i > 50:
            break
    raise ValidationFailed("The file has no header row")


def check_header(path: Path, kind: str) -> None:
    """Fast, synchronous: wrong type or missing columns are reported before the background check."""
    with open_table(path, kind) as (rows, _):
        read_header(rows)


@dataclass
class Scan:
    """Running totals of one pass over a file."""

    total: int = 0
    valid: int = 0
    errors: int = 0
    duplicates: int = 0
    issues: list[dict[str, Any]] = field(default_factory=list)


def _key_hash(key: str) -> int:
    return int.from_bytes(hashlib.blake2b(key.encode(), digest_size=8).digest(), "big")


def valid_rows(rows: Iterator[list[Any]], mapping: dict[str, int], header_row: int, scan: Scan) -> Iterator[dict[str, Any]]:
    """Validate and normalise rows one at a time. The first row of a logo wins; later duplicates are
    reported and skipped (only an 8-byte hash per logo is remembered, so millions of rows fit)."""
    s = get_settings()
    seen: set[int] = set()
    pam_names: dict[str, str] = {}

    def issue(rown: int, company: str, fld: str, msg: str, sev: str) -> None:
        if len(scan.issues) < MAX_ISSUES:
            scan.issues.append({"row": rown, "company": company, "field": fld, "message": msg, "severity": sev})

    for offset, row in enumerate(rows):
        rown = header_row + offset + 1  # 1-based sheet row number
        values = {f: _cell(row, mapping.get(f)) for f in HEADER_ALIASES}
        if not any(values.values()):
            continue
        scan.total += 1
        if scan.total > s.import_max_rows:
            raise PayloadTooLarge(f"Too many rows: the limit is {s.import_max_rows:,}")
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
        if row_errors:
            scan.errors += 1
            continue

        key = name_key(company)
        h = _key_hash(key)
        if h in seen:
            scan.duplicates += 1
            issue(rown, company, "Company", "Same logo as an earlier row; the earlier row is used", "warning")
            continue
        seen.add(h)
        if email in pam_names and pam_names[email].lower() != values["pam_name"].lower():
            issue(rown, company, "PAM Name", f"{email} also appears as '{pam_names[email]}'; using the first name", "warning")
        pam_names.setdefault(email, values["pam_name"])
        scan.valid += 1
        yield {
            "row": rown, "company": company, "name_key": key, "industry": values["industry"] or None,
            "pam_name": pam_names[email], "pam_email": email, "pam_whatsapp": wa,
        }


def stream_valid_rows(path: Path, kind: str, skip: int = 0) -> Iterator[dict[str, Any]]:
    """Valid, de-duplicated rows of a stored file, skipping the first `skip` (a resume cursor)."""
    with open_table(path, kind) as (rows, _):
        mapping, header_row = read_header(rows)
        yield from islice(valid_rows(rows, mapping, header_row, Scan()), skip, None)


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
        elif (r["industry"] and r["industry"] != c.industry) or not c.active:
            change = "updated"
        else:
            change = "unchanged"
        key = {"new": "new_companies", "updated": "updated_companies", "reassigned": "reassignments"}.get(change, "unchanged")
        counts[key] += 1
        out.append({**r, "change": change, "current_pam": c.pam.name if c is not None and c.pam is not None else None})
    counts["new_pams"] = len({r["pam_email"] for r in rows} - set(pams))
    return out, counts


# --- Datasets: create → background save (chunked, resumable) ------------------------------------


PREVIEW_ROWS = 200
_PREVIEW_KEYS = ("new_companies", "updated_companies", "reassignments", "unchanged", "new_pams")


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")[:60] or "upload"


def _ext(file_name: str) -> str:
    return "csv" if file_name.lower().endswith(".csv") else "xlsx"


def stored_path(b: ImportBatch) -> Path:
    folder = get_settings().upload_path.resolve()
    path = (folder / (b.stored_file or "")).resolve()
    if not b.stored_file or path.parent != folder:
        raise NotFound("The original file is not available for this upload")
    return path


def _file_name_for(b: ImportBatch, label: str | None) -> str:
    """"<UTC timestamp>_<id>_<name>.<ext>": built only from a slug, so it can never leave the folder."""
    stamp = as_utc(b.created_at or utcnow()).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}_{b.id}_{_slug(label) if label else 'unsaved'}.{_ext(b.file_name)}"


def stage(uow: UnitOfWork, *, file_name: str, temp_path: Path, size: int, sha256: str, actor: str,
          label: str | None = None) -> ImportBatch:
    """Register a streamed upload and queue the background check. `temp_path` (already on disk, in
    UPLOAD_DIR) is moved into place. With `label` the upload is saved as soon as the check passes."""
    kind = sniff(temp_path, file_name)
    check_header(temp_path, kind)
    now = utcnow()
    label = (label or "").strip()[:200]
    b = ImportBatch(
        file_name=file_name[:255], file_sha256=sha256, uploaded_by=actor, label=label, status=IMPORT_ANALYZING,
        rows=[], issues=[], summary={"size_bytes": size, "auto_save": bool(label), "progress": 0},
        heartbeat_at=now, created_at=now,
    )
    uow.session.add(b)
    uow.session.flush()
    b.stored_file = _file_name_for(b, None)
    os.replace(temp_path, get_settings().upload_path / b.stored_file)
    audit.record(uow, "dataset.receive", "import", b.id,
                 {"file": b.file_name, "size_bytes": size, "sha256": sha256, "stored_as": b.stored_file}, actor=actor)
    telemetry.event(uow, "dataset.receive", import_id=b.id, actor=actor,
                    message=f"{b.file_name}: {size / 1048576:,.1f} MB received; checking rows in the background",
                    size_bytes=size, sha256=sha256[:16])
    from app.worker.tasks import analyze_import

    uow.after_commit(lambda: analyze_import.apply_async((b.id,)))
    return b


def _lease(batch_id: int, status: str) -> str | None:
    s = get_settings()
    now = utcnow()
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id, with_for_update=True)
        if b is None or b.status != status:
            return None
        fresh = b.heartbeat_at and as_utc(b.heartbeat_at) > now - timedelta(seconds=s.import_stall_seconds)
        if b.worker_token and fresh:
            return None
        b.worker_token, b.heartbeat_at = uuid.uuid4().hex, now
        return b.worker_token


def analyze(batch_id: int) -> str:
    """One streaming pass over the stored file: validate, de-duplicate, compare with the database in
    batches, keep a 200-row sample. Progress and a heartbeat are written every ~2 s."""
    token = _lease(batch_id, IMPORT_ANALYZING)
    if token is None:
        return "skipped"
    st = get_settings()
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id)
        path, file_name, t_start = stored_path(b), b.file_name, time.monotonic()
    scan = Scan()
    counts = dict.fromkeys(_PREVIEW_KEYS, 0)
    emails: set[str] = set()
    sample: list[dict[str, Any]] = []

    def compare(batch: list[dict[str, Any]]) -> None:
        with unit_of_work() as uow:
            diffed, c = _diff(uow, batch)
        for k in ("new_companies", "updated_companies", "reassignments", "unchanged"):
            counts[k] += c.get(k, 0)
        for r in diffed[: max(0, PREVIEW_ROWS - len(sample))]:
            sample.append({
                "row": r["row"], "company": r["company"], "industry": r["industry"],
                "pamName": r["pam_name"], "pamEmail": r["pam_email"], "pamWhatsapp": r["pam_whatsapp"],
                "change": r["change"], "currentPam": r["current_pam"],
            })

    try:
        with open_table(path, sniff(path, file_name)) as (rows, progress):
            mapping, header_row = read_header(rows)
            batch: list[dict[str, Any]] = []
            last_beat = time.monotonic()
            for r in valid_rows(rows, mapping, header_row, scan):
                emails.add(r["pam_email"])
                batch.append(r)
                if len(batch) >= st.import_analyze_batch:
                    compare(batch)
                    batch = []
                if time.monotonic() - last_beat > 2:
                    last_beat = time.monotonic()
                    if not _beat(batch_id, token, scan, progress()):
                        return "lease lost"
            if batch:
                compare(batch)
    except (ValidationFailed, PayloadTooLarge, UnsupportedMedia, NotFound) as e:  # the file itself is the problem
        return _analysis_failed(batch_id, token, e.message, permanent=True)
    except Exception as e:  # infrastructure (DB blip, …): retry from the start
        log.exception("upload check failed", extra={"import_id": batch_id})
        return _analysis_failed(batch_id, token, f"{type(e).__name__}: {e}", permanent=False)

    with unit_of_work() as uow:
        known = 0
        for chunk in _chunks(sorted(emails)):
            known += uow.session.scalar(select(func.count(Pam.id)).where(Pam.email.in_(chunk))) or 0
        counts["new_pams"] = len(emails) - known
        b = uow.session.get(ImportBatch, batch_id, with_for_update=True)
        if b is None or b.worker_token != token or b.status != IMPORT_ANALYZING:
            return "lease lost"
        took_ms = int((time.monotonic() - t_start) * 1000)
        b.rows_total, b.rows_valid, b.rows_error, b.issues = scan.total, scan.valid, scan.errors, scan.issues
        b.summary = {
            **(b.summary or {}), "progress": 100, "rows_read": scan.total, "duplicates_merged": scan.duplicates,
            "pams": len(emails), "preview_rows": sample, "analyze_ms": took_ms,
            **{f"preview_{k}": v for k, v in counts.items()},
            **dict.fromkeys(_PREVIEW_KEYS, 0),  # filled in as rows are saved
        }
        b.worker_token = None
        if scan.valid == 0:
            b.status, b.error = IMPORT_FAILED, "Every row has errors; nothing to save"
        else:
            b.status = IMPORT_PREVIEWED
        telemetry.event(uow, "dataset.analyzed", telemetry.OK if scan.valid else telemetry.ERROR, import_id=b.id,
                        actor="system", duration_ms=took_ms,
                        message=f"{scan.total:,} rows read: {scan.valid:,} valid, {scan.errors:,} rejected, "
                                f"{scan.duplicates:,} duplicates; {counts['new_companies']:,} new logos, "
                                f"{counts['reassignments']:,} would move PAM",
                        rows=scan.total, valid=scan.valid, errors=scan.errors, **counts)
        if scan.valid and (b.summary or {}).get("auto_save") and b.label:
            _save(uow, b, b.label, b.uploaded_by)
        uow.after_commit(lambda: cache.bump("imports"))
    return b.status


def _beat(batch_id: int, token: str, scan: Scan, fraction: float | None) -> bool:
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id)
        if b is None or b.worker_token != token or b.status != IMPORT_ANALYZING:
            return False
        b.heartbeat_at = utcnow()
        b.rows_total = scan.total
        b.summary = {**(b.summary or {}), "rows_read": scan.total,
                     "progress": round(fraction * 100) if fraction is not None else None}
    return True


def _analysis_failed(batch_id: int, token: str, error: str, *, permanent: bool) -> str:
    st = get_settings()
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id)
        if b is None or b.worker_token != token:
            return "lease lost"
        b.worker_token, b.failures, b.error = None, b.failures + 1, error[:1000]
        if permanent or b.failures >= st.import_max_failures:
            b.status = IMPORT_FAILED
            telemetry.event(uow, "dataset.analyzed", telemetry.ERROR, import_id=b.id, actor="system", message=b.error)
            uow.after_commit(lambda: cache.bump("imports"))
            return "failed"
        telemetry.event(uow, "dataset.analyzed", telemetry.RETRY, import_id=b.id, actor="system", attempt=b.failures, message=b.error)
        from app.worker.tasks import analyze_import

        delay = min(2 ** b.failures, 60)
        uow.after_commit(lambda: analyze_import.apply_async((batch_id,), countdown=delay))
        return "retry"


def preview_of(b: ImportBatch) -> dict[str, Any]:
    """The checked file, as shown before saving (same shape whatever the file size)."""
    sm = b.summary or {}
    return {
        "id": str(b.id), "status": b.status, "fileName": b.file_name, "sizeBytes": sm.get("size_bytes", 0),
        "rowsTotal": b.rows_total, "validRows": b.rows_valid, "errorRows": b.rows_error,
        "duplicatesMerged": sm.get("duplicates_merged", 0), "pams": sm.get("pams", 0),
        "newCompanies": sm.get("preview_new_companies", 0), "updatedCompanies": sm.get("preview_updated_companies", 0),
        "reassignments": sm.get("preview_reassignments", 0), "unchanged": sm.get("preview_unchanged", 0),
        "newPams": sm.get("preview_new_pams", 0), "issues": b.issues or [], "rows": sm.get("preview_rows", []),
        "rowsShown": len(sm.get("preview_rows", [])),
    }


def save(uow: UnitOfWork, batch_id: int, label: str, actor: str) -> ImportBatch:
    b = get_dataset(uow, batch_id)
    if b.status != IMPORT_PREVIEWED:
        raise Conflict(f"This upload cannot be saved now (it is {b.status})")
    label = (label or "").strip()[:200]
    if not label:
        raise ValidationFailed("Give the upload a name to save it under", details={"field": "label"})
    _save(uow, b, label, actor)
    uow.after_commit(lambda: cache.bump("imports"))
    return b


def _save(uow: UnitOfWork, b: ImportBatch, label: str, actor: str) -> None:
    """Name it, give the kept file its final "<timestamp>_<id>_<name>" name, queue the chunked save."""
    folder = get_settings().upload_path
    new_name = _file_name_for(b, label)
    try:
        os.replace(folder / b.stored_file, folder / new_name)
        b.stored_file = new_name
    except OSError:
        log.warning("could not rename the stored upload; keeping its current name", extra={"import_id": b.id}, exc_info=True)
    b.label, b.status, b.heartbeat_at, b.error, b.failures = label, IMPORT_QUEUED, utcnow(), None, 0
    sm = b.summary or {}
    audit.record(uow, "dataset.upload", "import", b.id,
                 {"label": label, "file": b.file_name, "stored_as": b.stored_file, "sha256": b.file_sha256,
                  "size_bytes": sm.get("size_bytes"), "rows": b.rows_total, "valid": b.rows_valid, "errors": b.rows_error},
                 actor=actor)
    telemetry.event(uow, "dataset.upload", import_id=b.id, actor=actor,
                    message=f"'{label}' ({b.file_name}): {b.rows_total:,} rows, {b.rows_valid:,} valid, {b.rows_error:,} rejected",
                    rows=b.rows_total, valid=b.rows_valid, errors=b.rows_error, duplicates_merged=sm.get("duplicates_merged", 0))
    _enqueue(uow, b.id)


def discard(uow: UnitOfWork, batch_id: int, actor: str) -> None:
    """Drop an upload that was never saved (and its file)."""
    b = get_dataset(uow, batch_id)
    if b.status not in (IMPORT_ANALYZING, IMPORT_PREVIEWED) and not (b.status == IMPORT_FAILED and not b.label):
        raise Conflict("Only uploads that have not been saved can be discarded")
    _discard(uow, b, actor)


def _discard(uow: UnitOfWork, b: ImportBatch, actor: str) -> None:
    try:
        stored_path(b).unlink(missing_ok=True)
    except NotFound:
        pass
    b.status, b.worker_token = IMPORT_DISCARDED, None
    audit.record(uow, "dataset.discard", "import", b.id, {"file": b.file_name}, actor=actor)
    telemetry.event(uow, "dataset.discard", telemetry.INFO, import_id=b.id, actor=actor, message=f"{b.file_name} discarded without saving")


def discard_stale_previews(uow: UnitOfWork, limit: int = 100) -> int:
    cutoff = utcnow() - timedelta(hours=get_settings().import_preview_ttl_hours)
    stale = list(uow.session.scalars(
        select(ImportBatch).where(ImportBatch.status == IMPORT_PREVIEWED, ImportBatch.created_at <= cutoff).limit(limit)
    ))
    for b in stale:
        _discard(uow, b, "system")
    return len(stale)


def stalled_checks(uow: UnitOfWork, limit: int = 50) -> list[int]:
    cutoff = utcnow() - timedelta(seconds=get_settings().import_stall_seconds)
    return list(uow.session.scalars(
        select(ImportBatch.id).where(ImportBatch.status == IMPORT_ANALYZING, ImportBatch.heartbeat_at <= cutoff).limit(limit)
    ))


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
    stream: Iterator[dict[str, Any]] | None = None
    with unit_of_work() as uow:
        b = uow.session.get(ImportBatch, batch_id)
        if not b.rows:  # streamed upload: read the stored file from the cursor (legacy uploads keep rows in the DB)
            try:
                stream = stream_valid_rows(stored_path(b), sniff(stored_path(b), b.file_name), skip=b.rows_done)
            except Exception as e:  # file missing/unreadable
                return _chunk_failed(batch_id, token, e)
    try:
        return _process_loop(batch_id, token, s, stream)
    finally:
        if stream is not None:
            stream.close()


def _process_loop(batch_id: int, token: str, s, stream: Iterator[dict[str, Any]] | None) -> str:
    while True:
        try:
            pending = list(islice(stream, s.import_chunk_size)) if stream is not None else None
            with unit_of_work() as uow:
                b = uow.session.get(ImportBatch, batch_id, with_for_update=True)
                if b is None or b.worker_token != token or b.status != IMPORT_PROCESSING:
                    return "lease lost"
                chunk = pending if pending is not None else (b.rows or [])[b.rows_done: b.rows_done + s.import_chunk_size]
                if not chunk:
                    _finish(uow, b)
                    return "completed"
                t0 = utcnow()
                counts = _apply(uow, b, chunk)
                b.summary = {**(b.summary or {}), **{k: (b.summary or {}).get(k, 0) + v for k, v in counts.items()}}
                b.rows_done += len(chunk)
                b.heartbeat_at = utcnow()
                b.failures, b.error = 0, None
                telemetry.event(uow, "dataset.chunk", import_id=b.id, actor="system",
                                duration_ms=int((utcnow() - t0).total_seconds() * 1000),
                                message=f"rows {b.rows_done - len(chunk) + 1}-{b.rows_done} of {b.rows_valid} saved", **counts)
            metrics.DATASET_ROWS.inc(len(chunk))
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
        telemetry.event(uow, "dataset.chunk", telemetry.ERROR if b.failures >= s.import_max_failures else telemetry.RETRY,
                        import_id=b.id, actor="system", attempt=b.failures, message=b.error)
        if b.failures >= s.import_max_failures:
            b.status = IMPORT_FAILED
            audit.record(uow, "dataset.failed", "import", b.id, {"label": b.label, "saved": b.rows_done, "error": b.error}, actor="system")
            telemetry.event(uow, "dataset.failed", telemetry.ERROR, import_id=b.id, actor="system",
                            message=f"Stopped after {b.failures} failures at row {b.rows_done}: {b.error}")
            uow.after_commit(lambda: cache.bump("imports", "runs"))
            return "failed"
        _enqueue(uow, b.id, countdown=min(2 ** b.failures, 60))
        return "retry"


def _finish(uow: UnitOfWork, b: ImportBatch) -> None:
    b.status = IMPORT_COMPLETED
    b.committed_at = utcnow()
    b.worker_token = None
    sm = b.summary or {}
    changes = {k: sm.get(k, 0) for k in ("new_companies", "updated_companies", "reassignments", "new_pams", "unchanged")}
    audit.record(uow, "dataset.saved", "import", b.id, {"label": b.label, "rows": b.rows_done, **changes}, actor=b.uploaded_by)
    took = (as_utc(b.committed_at) - as_utc(b.started_at)).total_seconds() if b.started_at else None
    telemetry.event(uow, "dataset.saved", import_id=b.id, actor=b.uploaded_by,
                    duration_ms=int(took * 1000) if took is not None else None,
                    message=f"{b.rows_done} rows: {changes['new_companies']} new logos, {changes['reassignments']} reassigned, "
                            f"{changes['unchanged']} already known, {changes['new_pams']} new PAMs", **changes)
    uow.after_commit(lambda: cache.bump("imports", "runs"))


def _apply(uow: UnitOfWork, b: ImportBatch, rows: list[dict[str, Any]]) -> dict[str, int]:
    """Upsert PAMs + companies, record ownership history, add dataset membership, for one chunk.
    Set-based (a few statements per chunk, not per row) so million-row files save quickly; the
    ownership history is written exactly as `assignments.assign` would. Idempotent on re-apply."""
    s = uow.session
    companies, pams = _load_existing(uow, rows)
    counts = {"new_companies": 0, "updated_companies": 0, "reassignments": 0, "unchanged": 0}
    counts["new_pams"] = len({r["pam_email"] for r in rows} - set(pams))

    # PAMs: create the new ones, refresh the known ones (the upload is the latest word on name/number).
    for r in rows:
        pm = pams.get(r["pam_email"])
        if pm is None:
            pams[r["pam_email"]] = Pam(name=r["pam_name"], email=r["pam_email"], whatsapp=r["pam_whatsapp"], active=True)
            s.add(pams[r["pam_email"]])
        else:
            pm.name, pm.whatsapp, pm.active = r["pam_name"], r["pam_whatsapp"], True

    # Companies: classify against what is saved, then insert all new ones in one flush.
    new_rows, moves = [], []  # moves: (company, new pam email) for known logos changing owner
    for r in rows:
        c = companies.get(r["name_key"])
        if c is None:
            counts["new_companies"] += 1
            c = Company(name=r["company"], name_key=r["name_key"], industry=r["industry"], active=True,
                        last_import_id=b.id)
            companies[r["name_key"]] = c
            s.add(c)
            new_rows.append(r)
            continue
        if c.pam is None or c.pam.email != r["pam_email"]:
            counts["reassignments"] += 1
            moves.append((c, r["pam_email"]))
        elif (r["industry"] and r["industry"] != c.industry) or not c.active:
            counts["updated_companies"] += 1
        else:
            counts["unchanged"] += 1
        c.name = r["company"]
        if r["industry"]:
            c.industry = r["industry"]
        c.active, c.last_import_id = True, b.id
    s.flush()  # new PAMs + companies get ids (batched INSERTs)

    # Ownership history: close the open rows of moving logos in one UPDATE, open the new ones in bulk.
    now = utcnow()
    moving = [c for c, email in moves if c.pam_id != pams[email].id]
    for ids in _chunks([c.id for c in moving]):
        s.execute(update(CompanyAssignment).where(CompanyAssignment.company_id.in_(ids), CompanyAssignment.valid_to.is_(None))
                  .values(valid_to=now))
    opened = [(companies[r["name_key"]], pams[r["pam_email"]].id) for r in new_rows]
    opened += [(c, pams[email].id) for c, email in moves if c.pam_id != pams[email].id]
    if opened:
        s.execute(insert(CompanyAssignment), [
            {"company_id": c.id, "pam_id": pid, "valid_from": now, "valid_to": None, "reason": "import", "actor": b.uploaded_by}
            for c, pid in opened
        ])
        for c, pid in opened:
            c.pam_id = pid

    # Membership + this upload's own logo → PAM mapping (what its runs, and re-runs, deliver to).
    ids = [companies[r["name_key"]].id for r in rows]
    have: dict[int, DatasetCompany] = {}
    for chunk in _chunks(ids):
        have.update({m.company_id: m for m in s.scalars(
            select(DatasetCompany).where(DatasetCompany.import_id == b.id, DatasetCompany.company_id.in_(chunk))
        )})
    fresh = []
    for r in rows:
        cid, pid = companies[r["name_key"]].id, pams[r["pam_email"]].id
        if cid in have:
            have[cid].pam_id = pid  # chunk re-applied after a crash: same values, idempotent
        else:
            fresh.append({"import_id": b.id, "company_id": cid, "row_no": r.get("row", 0), "pam_id": pid})
            have[cid] = None  # type: ignore[assignment]  # same logo twice in one chunk cannot happen (de-duplicated)
    if fresh:
        s.execute(insert(DatasetCompany), fresh)
    s.flush()
    return {k: counts.get(k, 0) for k in ("new_companies", "updated_companies", "reassignments", "new_pams", "unchanged")}


def resume(uow: UnitOfWork, batch_id: int, actor: str) -> ImportBatch:
    """Manually resume a failed or stalled upload from its last saved chunk."""
    b = get_dataset(uow, batch_id)
    if b.status == IMPORT_COMPLETED:
        raise Conflict("This dataset is already saved")
    if not b.rows and not (b.stored_file and b.rows_valid):
        raise Conflict("This upload has no valid rows to save")
    b.status, b.worker_token, b.failures, b.error, b.heartbeat_at = IMPORT_QUEUED, None, 0, None, utcnow()
    audit.record(uow, "dataset.resume", "import", b.id, {"label": b.label, "from_row": b.rows_done}, actor=actor)
    telemetry.event(uow, "dataset.resume", telemetry.INFO, import_id=b.id, actor=actor, message=f"Resumed from row {b.rows_done + 1}")
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
    before = {"company": c.name, "industry": c.industry, "pam": c.pam.email if c.pam else None}

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
        # The edited row is this upload's mapping too: its next run delivers to the new PAM.
        uow.session.execute(
            update(DatasetCompany).where(DatasetCompany.import_id == batch_id, DatasetCompany.company_id == c.id)
            .values(pam_id=target.id)
        )

    uow.session.flush()
    uow.session.expire(c, ["pam"])  # pam_id may have changed: reload the relationship
    after = {"company": c.name, "industry": c.industry, "pam": c.pam.email if c.pam else None}
    audit.record(uow, "dataset.row.update", "company", c.id, {"dataset": batch_id, "before": before, "after": after}, actor=actor)
    uow.after_commit(lambda: cache.bump("imports", "runs"))
    return c


def delete_rows(uow: UnitOfWork, batch_id: int, company_ids: list[int], actor: str) -> dict[str, int]:
    """Remove companies from a dataset. A company in no other dataset stops being tracked."""
    b = get_dataset(uow, batch_id)
    ids = sorted(set(company_ids))
    from app.services import soft_delete

    removed = soft_delete.archive(uow, DatasetCompany, DatasetCompany.import_id == b.id, DatasetCompany.company_id.in_(ids),
                                  actor=actor, reason=f"removed from dataset {b.id}", record_audit=False)
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
