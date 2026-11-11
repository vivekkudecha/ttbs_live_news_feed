"""Email templates for PAM digests: Jinja2 in a sandbox, versioned, one active at a time.

Rendering uses only the digest snapshot stored on the notification (`payload`), never live rows,
so what is sent matches what was queued. HTML output is auto-escaped; research text goes through
the `rich` filter (escape, then **bold** and links). Templates are validated on save by rendering
them against sample data with undefined variables treated as errors.

Variables: pam.{name, first_name, email}, run.{id, label, window_start, window_end},
signals[].{company, category, key_signals, opportunity, outreach, sources[].{title, url}},
counts.{signals, total}, ai_summary, generated_at.
Each signal also carries ready-to-show sections (same rules as the web app's lib/findings.ts):
points[] (key signals split into points, URLs taken out), opportunity_text, outreach_text (URLs taken
out) and links[].{url, label} (sources plus URLs mentioned in the text, each once).
"""

import hashlib
import logging
import re
from typing import Any
from urllib.parse import urlparse

from jinja2 import StrictUndefined, TemplateError, Undefined
from jinja2.sandbox import SandboxedEnvironment
from markupsafe import Markup, escape
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.core import cache
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.timeutil import utcnow
from app.db.models import AI_ON_FAILURE, EmailTemplate, EmailTemplateVersion
from app.db.session import UnitOfWork, unit_of_work
from app.services import audit

log = logging.getLogger(__name__)

FIELDS = ("name", "description", "subject_tpl", "html_tpl", "text_tpl", "ai_enabled", "ai_prompt", "ai_max_words", "ai_on_failure")
MAX_TPL = 200_000

_URL = re.compile(r"(https?://[^\s<>()\"']+)")
_BOLD = re.compile(r"\*\*(.+?)\*\*")


def _rich(value: Any) -> Markup:
    """Escape research text, then turn **bold** into <strong> and URLs into links."""
    s = str(escape(value or ""))
    s = _BOLD.sub(r"<strong>\1</strong>", s)
    s = _URL.sub(r'<a href="\1" style="color:#0072b1">\1</a>', s)
    return Markup(s.replace("\n", "<br>"))


def _plain(value: Any) -> str:
    return _BOLD.sub(r"\1", str(value or ""))


# --- Findings as sections (mirrors frontend/src/lib/findings.ts) -----------------------------------

_TEXT_URL = re.compile(r"https?://[^\s)\];,<>\"']+")
_POINT_SPLIT = re.compile(r";\s+|(?<=[a-z0-9)\]*%])\.\s+(?=\*{0,2}[A-Z])")


def _urls_in(text: str | None) -> list[str]:
    return list(dict.fromkeys(u.rstrip(".,") for u in _TEXT_URL.findall(text or "")))


def _without_urls(text: str | None) -> str:
    s = _TEXT_URL.sub("", text or "")
    s = re.sub(r"\(\s*(?:[;,|]\s*)*\)", "", s)  # "( ; ; )" left by a URL list
    s = re.sub(r"\[\s*\]", "", s)
    s = re.sub(r"\s+([.,;])", r"\1", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def _points(text: str | None) -> list[str]:
    """Key signals as points: split at "; " and sentence ends; short fragments join the point before."""
    out: list[str] = []
    for piece in (p.strip().rstrip(".;") for p in _POINT_SPLIT.split(_without_urls(text))):
        if not piece:
            continue
        if out and len(piece) < 25:
            out[-1] += f"; {piece}"
        else:
            out.append(piece[0].upper() + piece[1:])
    return out


def _host(url: str) -> str:
    return (urlparse(url).hostname or url).removeprefix("www.")


def _links(item: dict[str, Any]) -> list[dict[str, str]]:
    """The item's sources, then any URL only mentioned in its text; each once, with a short label."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for src in item.get("sources") or []:
        url = src.get("url") if isinstance(src, dict) else None
        if not url or url in seen:
            continue
        seen.add(url)
        title = src.get("title") or ""
        out.append({"url": url, "label": title if title and not title.startswith(("http://", "https://")) else _host(url)})
    for url in (u for f in ("key_signals", "opportunity", "outreach") for u in _urls_in(item.get(f))):
        if url not in seen:
            seen.add(url)
            out.append({"url": url, "label": _host(url)})
    return out


def _sections(item: dict[str, Any]) -> dict[str, Any]:
    return item | {"points": _points(item.get("key_signals")), "opportunity_text": _without_urls(item.get("opportunity")),
                   "outreach_text": _without_urls(item.get("outreach")), "links": _links(item)}


def _env(*, html: bool, strict: bool) -> SandboxedEnvironment:
    env = SandboxedEnvironment(autoescape=html, undefined=StrictUndefined if strict else Undefined,
                               trim_blocks=True, lstrip_blocks=True)
    env.filters["rich"] = _rich if html else _plain
    env.filters["plain"] = _plain
    return env


_ENVS = {(h, s): _env(html=h, strict=s) for h in (True, False) for s in (True, False)}


# --- Context --------------------------------------------------------------------------------------


def context(payload: dict[str, Any], ai_summary: str = "") -> dict[str, Any]:
    pam = payload.get("pam") or {}
    name = pam.get("name") or "there"
    items = payload.get("items") or []
    return {
        "pam": {"name": name, "first_name": name.split(" ")[0], "email": pam.get("email") or ""},
        "run": payload.get("run") or {},
        "signals": [_sections(i) for i in items if isinstance(i, dict)],
        "counts": {"signals": payload.get("signals", len(items)), "total": payload.get("total", len(items))},
        "ai_summary": ai_summary,
        "generated_at": utcnow().strftime("%d %b %Y"),
    }


SAMPLE_PAYLOAD: dict[str, Any] = {
    "signals": 2, "total": 14,
    "pam": {"id": 0, "name": "Aarav Mehta", "email": "aarav@example.com"},
    "run": {"id": 0, "label": "Sample run", "window_start": "2026-11-01", "window_end": "2026-11-08"},
    "items": [
        {"company": "Pine Labs Pvt Ltd", "category": "Expansion",
         "key_signals": "Opening a **new Pune campus** for 1,200 staff (https://example.com/news/1)",
         "opportunity": "**SD-WAN** and **Managed SOC** for the new site", "outreach": "Call the CIO with a connectivity + security bundle",
         "sources": [{"title": "example.com", "url": "https://example.com/news/1"}]},
        {"company": "Havells India", "category": "Digital transformation",
         "key_signals": "ERP migration to cloud announced", "opportunity": "**Cloud connect** and SIP trunking",
         "outreach": "Email the IT head with a migration case study", "sources": []},
    ],
}


# --- Render ---------------------------------------------------------------------------------------


def render(tpl: dict[str, Any], ctx: dict[str, Any], *, strict: bool = False) -> dict[str, str]:
    """{subject, html, text}. Raises jinja2.TemplateError (incl. sandbox SecurityError)."""
    subject = _ENVS[(False, strict)].from_string(tpl["subject_tpl"]).render(ctx)
    subject = " ".join(subject.split())[:255]
    html = _ENVS[(True, strict)].from_string(tpl["html_tpl"]).render(ctx) if (tpl.get("html_tpl") or "").strip() else ""
    text = _ENVS[(False, strict)].from_string(tpl["text_tpl"]).render(ctx) if (tpl.get("text_tpl") or "").strip() else ""
    return {"subject": subject, "html": html, "text": text}


def snapshot(t: EmailTemplate) -> dict[str, Any]:
    return {"id": t.id, "version": t.version, **{f: getattr(t, f) for f in FIELDS}}


def _validate(data: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    name = (data.get("name") or "").strip()
    if not name or len(name) > 200:
        raise ValidationFailed("Give the template a name (up to 200 characters)", details={"field": "name"})
    out["name"] = name
    out["description"] = (data.get("description") or "").strip()[:1000] or None
    for f in ("subject_tpl", "html_tpl", "text_tpl"):
        v = data.get(f) or ""
        if len(v) > MAX_TPL:
            raise ValidationFailed(f"{f} is too long", details={"field": f})
        out[f] = v
    if not out["subject_tpl"].strip():
        raise ValidationFailed("The subject template is required", details={"field": "subjectTpl"})
    if not out["html_tpl"].strip() and not out["text_tpl"].strip():
        raise ValidationFailed("Provide an HTML body, a plain-text body, or both", details={"field": "htmlTpl"})
    out["ai_enabled"] = bool(data.get("ai_enabled"))
    out["ai_prompt"] = (data.get("ai_prompt") or "").strip()[:4000] or None
    try:
        out["ai_max_words"] = max(20, min(400, int(data.get("ai_max_words") or 120)))
    except (TypeError, ValueError) as e:
        raise ValidationFailed("AI summary length must be a number of words", details={"field": "aiMaxWords"}) from e
    out["ai_on_failure"] = data.get("ai_on_failure") or "send_without"
    if out["ai_on_failure"] not in AI_ON_FAILURE:
        raise ValidationFailed("Unknown AI failure policy", details={"field": "aiOnFailure", "allowed": list(AI_ON_FAILURE)})
    try:  # compile + render against sample data, strictly (typos in variable names fail here, not at send time)
        render(out, context(SAMPLE_PAYLOAD, "Sample AI summary."), strict=True)
    except TemplateError as e:
        raise ValidationFailed(f"Template error: {e}", details={"line": getattr(e, "lineno", None)}, code="template_error") from e
    return out


# --- Reads ----------------------------------------------------------------------------------------


def list_all(uow: UnitOfWork) -> list[EmailTemplate]:
    ensure_default(uow)
    return list(uow.session.scalars(select(EmailTemplate).order_by(EmailTemplate.active.desc(), EmailTemplate.name)))


def get(uow: UnitOfWork, template_id: int) -> EmailTemplate:
    t = uow.session.get(EmailTemplate, template_id)
    if t is None:
        raise NotFound(f"Email template {template_id} not found")
    return t


def active(uow: UnitOfWork) -> EmailTemplate:
    ensure_default(uow)
    t = uow.session.scalars(select(EmailTemplate).where(EmailTemplate.active.is_(True))).first()
    if t is None:  # every template deactivated somehow: fall back to the oldest
        t = uow.session.scalars(select(EmailTemplate).order_by(EmailTemplate.id)).first()
    return t


def versions(uow: UnitOfWork, template_id: int) -> list[EmailTemplateVersion]:
    get(uow, template_id)
    return list(uow.session.scalars(select(EmailTemplateVersion).where(EmailTemplateVersion.template_id == template_id)
                                    .order_by(EmailTemplateVersion.version.desc())))


def ensure_default(uow: UnitOfWork) -> None:
    s = uow.session
    if s.scalar(select(func.count(EmailTemplate.id))):
        _upgrade_builtin(uow)
        return
    try:
        with s.begin_nested():
            t = EmailTemplate(**DEFAULT_TEMPLATE, active=True, version=1, updated_by="system")
            s.add(t)
            s.flush()
            s.add(EmailTemplateVersion(template_id=t.id, version=1, snapshot=snapshot(t), note="Built-in default",
                                       created_at=utcnow(), created_by="system"))
            s.flush()
    except IntegrityError:  # seeded concurrently
        pass


# Earlier built-in bodies (sha256 of html_tpl, text_tpl). A template still exactly equal to one of them
# was never edited, so it moves to the current built-in body (recorded as a new version).
_PREVIOUS_BUILTINS = {("af7cddfacabfa4287dc6f231be20c6d5c276b234154d0cd280f916a91fae9fa5",
                       "a822bf84b7f737d554c4ec0c459b3dad859204a4d06ce7ed382bb4f95a57326d")}
_builtin_checked = False


def _sha(v: str | None) -> str:
    return hashlib.sha256((v or "").encode()).hexdigest()


def _upgrade_builtin(uow: UnitOfWork) -> None:
    global _builtin_checked
    if _builtin_checked:  # once per process
        return
    s = uow.session
    for t in s.scalars(select(EmailTemplate).where(EmailTemplate.name == DEFAULT_TEMPLATE["name"])):
        if (_sha(t.html_tpl), _sha(t.text_tpl)) not in _PREVIOUS_BUILTINS:
            continue
        try:
            with s.begin_nested():
                t.html_tpl, t.text_tpl = DEFAULT_TEMPLATE["html_tpl"], DEFAULT_TEMPLATE["text_tpl"]
                t.description = DEFAULT_TEMPLATE["description"]
                t.version += 1
                t.updated_by = "system"
                s.flush()
                _version(uow, t, "system", "Built-in default updated: findings shown as sections")
                s.flush()
            uow.after_commit(lambda: cache.bump("email"))
        except IntegrityError:  # another process upgraded it first
            pass
    _builtin_checked = True


# --- Commands -------------------------------------------------------------------------------------


def _version(uow: UnitOfWork, t: EmailTemplate, actor: str, note: str | None) -> None:
    uow.session.add(EmailTemplateVersion(template_id=t.id, version=t.version, snapshot=snapshot(t), note=(note or "")[:500] or None,
                                         created_at=utcnow(), created_by=actor))


def create(data: dict[str, Any], actor: str) -> EmailTemplate:
    vals = _validate(data)
    with unit_of_work() as uow:
        ensure_default(uow)
        if uow.session.scalar(select(EmailTemplate.id).where(EmailTemplate.name == vals["name"])):
            raise Conflict(f"A template named '{vals['name']}' already exists")
        t = EmailTemplate(**vals, active=False, version=1, updated_by=actor)
        uow.session.add(t)
        uow.session.flush()
        _version(uow, t, actor, data.get("note") or "Created")
        audit.record(uow, "email.template.create", "email_template", t.id, {"name": t.name}, actor=actor)
        uow.after_commit(lambda: cache.bump("email"))
        uow.session.flush()
        uow.session.refresh(t)  # load server-side timestamps before the session closes
    return t


def update_template(template_id: int, data: dict[str, Any], actor: str) -> EmailTemplate:
    vals = _validate(data)
    with unit_of_work() as uow:
        t = get(uow, template_id)
        clash = uow.session.scalar(select(EmailTemplate.id).where(EmailTemplate.name == vals["name"], EmailTemplate.id != template_id))
        if clash:
            raise Conflict(f"A template named '{vals['name']}' already exists")
        changed = [f for f in FIELDS if getattr(t, f) != vals[f]]
        if not changed:
            return t
        for f in FIELDS:
            setattr(t, f, vals[f])
        t.version += 1
        t.updated_by = actor
        uow.session.flush()
        _version(uow, t, actor, data.get("note"))
        audit.record(uow, "email.template.update", "email_template", t.id, {"name": t.name, "version": t.version, "changed": changed}, actor=actor)
        uow.after_commit(lambda: cache.bump("email"))
        uow.session.flush()
        uow.session.refresh(t)
    return t


def restore(template_id: int, version: int, actor: str) -> EmailTemplate:
    with unit_of_work() as uow:
        v = uow.session.scalars(select(EmailTemplateVersion).where(EmailTemplateVersion.template_id == template_id,
                                                                   EmailTemplateVersion.version == version)).first()
        if v is None:
            raise NotFound(f"Version {version} of template {template_id} not found")
        data = {f: v.snapshot.get(f) for f in FIELDS}
    return update_template(template_id, data | {"note": f"Restored from v{version}"}, actor)


def activate(template_id: int, actor: str) -> EmailTemplate:
    with unit_of_work() as uow:
        t = get(uow, template_id)
        if t.active:
            return t
        prev = uow.session.scalars(select(EmailTemplate.id).where(EmailTemplate.active.is_(True))).first()
        uow.session.execute(update(EmailTemplate).where(EmailTemplate.id != template_id).values(active=False))
        uow.session.flush()
        t.active = True
        t.updated_by = actor
        uow.session.flush()
        audit.record(uow, "email.template.activate", "email_template", t.id, {"name": t.name, "version": t.version, "previous": prev}, actor=actor)
        uow.after_commit(lambda: cache.bump("email"))
        uow.session.flush()
        uow.session.refresh(t)
    return t


def delete_template(template_id: int, actor: str) -> None:
    with unit_of_work() as uow:
        t = get(uow, template_id)
        if t.active:
            raise Conflict("The active template cannot be deleted; activate another one first")
        audit.record(uow, "email.template.delete", "email_template", t.id, {"name": t.name, "version": t.version}, actor=actor)
        from app.services import soft_delete  # archived, never hard-deleted (versions first: they reference the template)

        soft_delete.archive(uow, EmailTemplateVersion, EmailTemplateVersion.template_id == t.id, actor=actor,
                            reason=f"template {t.id} deleted", record_audit=False)
        soft_delete.archive(uow, EmailTemplate, EmailTemplate.id == t.id, actor=actor, reason="template deleted", record_audit=False)
        uow.after_commit(lambda: cache.bump("email"))


def preview(data: dict[str, Any], payload: dict[str, Any] | None, *, with_ai: bool) -> dict[str, Any]:
    """Render a (possibly unsaved) template against a real digest or the sample. Optionally runs the AI."""
    from app.services import email_ai

    vals = _validate(data)
    payload = payload or SAMPLE_PAYLOAD
    ai_text, ai_error, ai_meta = "", None, None
    if vals["ai_enabled"]:
        if with_ai:
            try:
                r = email_ai.summarize(vals["ai_prompt"], vals["ai_max_words"], context(payload))
                ai_text, ai_meta = r.text, r.meta()
            except Exception as e:  # noqa: BLE001 - shown in the preview
                ai_error = str(e)[:500]
        else:
            ai_text = "[AI summary appears here. Tick 'Run AI' to generate a real one.]"
    try:
        out = render(vals, context(payload, ai_text))
    except TemplateError as e:
        raise ValidationFailed(f"Template error: {e}", code="template_error") from e
    return out | {"aiSummary": ai_text, "aiError": ai_error, "ai": ai_meta}


# --- Built-in default ------------------------------------------------------------------------------

# TTBS theme: primary #0072b1, brand orange #e8742a, ink #132235, muted #586777, border #e1e8ef, canvas #f5f8fb.
# Each account is one card with the same sections as the web app: Key signals (points), Opportunity,
# Recommended outreach, Sources. Inline styles and tables only (what email clients render reliably).
_SECTION = "margin-top:14px;padding-top:12px;border-top:1px solid #eef2f6"
_LABEL = "font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px"

_DEFAULT_HTML = """<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f8fb;font-family:Segoe UI,Arial,sans-serif;color:#132235">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8fb;padding:24px 0">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0"
  style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e1e8ef">
  <tr><td style="height:4px;line-height:4px;font-size:0;background:#e8742a">&nbsp;</td></tr>
  <tr><td style="padding:20px 28px;border-bottom:1px solid #e1e8ef">
    <div style="font-size:18px;font-weight:700;color:#0072b1">TTBS Signals</div>
    <div style="font-size:12px;color:#586777">News window {{ run.window_start }} to {{ run.window_end }}</div>
  </td></tr>
  <tr><td style="padding:24px 28px 8px;font-size:14px;line-height:1.6">
    <p style="margin:0 0 12px">Hi {{ pam.first_name }},</p>
    <p style="margin:0 0 12px">We researched <strong>{{ counts.total }}</strong> accounts you own.
    <strong>{{ counts.signals }}</strong> {{ 'has' if counts.signals == 1 else 'have' }} a TTBS-relevant trigger.</p>
    {% if ai_summary %}
    <div style="margin:16px 0;padding:14px 16px;background:#e9f3fa;border-left:4px solid #0072b1;border-radius:6px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#0072b1;text-transform:uppercase">Summary</div>
      <div style="margin-top:6px">{{ ai_summary }}</div>
    </div>
    {% endif %}
  </td></tr>
  {% for s in signals %}
  <tr><td style="padding:8px 28px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e8ef;border-radius:10px">
      <tr><td style="padding:16px 18px;font-size:14px;line-height:1.55">
        <div style="font-weight:700;font-size:15px">{{ s.company }}
          {% if s.category %}<span style="font-weight:600;font-size:11px;color:#0072b1;background:#e9f3fa;
            border-radius:999px;padding:2px 8px;margin-left:6px">{{ s.category }}</span>{% endif %}
        </div>
        {% if s.points %}
        <div style="margin-top:12px">
          <div style="FONT_LABEL;color:#c25e14">Key signals</div>
          <ul style="margin:0;padding-left:18px">
            {% for p in s.points %}<li style="margin:0 0 4px">{{ p | rich }}</li>{% endfor %}
          </ul>
        </div>
        {% endif %}
        {% if s.opportunity_text %}
        <div style="SECTION">
          <div style="FONT_LABEL;color:#0072b1">Opportunity</div>
          <div>{{ s.opportunity_text | rich }}</div>
        </div>
        {% endif %}
        {% if s.outreach_text %}
        <div style="SECTION">
          <div style="FONT_LABEL;color:#18865a">Recommended outreach</div>
          <div>{{ s.outreach_text | rich }}</div>
        </div>
        {% endif %}
        {% if s.links %}
        <div style="SECTION">
          <div style="FONT_LABEL;color:#586777">Sources</div>
          {% for l in s.links %}
          <div style="margin:0 0 2px;font-size:13px"><a href="{{ l.url }}" style="color:#0072b1;text-decoration:none">&#8599; {{ l.label }}</a></div>
          {% endfor %}
        </div>
        {% endif %}
      </td></tr>
    </table>
  </td></tr>
  {% endfor %}
  <tr><td style="padding:20px 28px 28px;font-size:12px;color:#586777">
    Sent automatically by TTBS Live News Feed{% if run.label %} · {{ run.label }}{% endif %}. Reply to this email if something looks wrong.
  </td></tr>
</table>
</td></tr></table>
</body></html>
""".replace("SECTION", _SECTION).replace("FONT_LABEL", _LABEL)

_DEFAULT_TEXT = """Hi {{ pam.first_name }},

{{ counts.signals }} of your {{ counts.total }} accounts have TTBS-relevant signals ({{ run.window_start }} to {{ run.window_end }}).
{% if ai_summary %}

Summary: {{ ai_summary }}
{% endif %}

{% for s in signals %}
== {{ s.company }}{% if s.category %} [{{ s.category }}]{% endif %} ==

{% if s.points %}
Key signals:
{% for p in s.points %}
  - {{ p | plain }}
{% endfor %}
{% endif %}
{% if s.opportunity_text %}
Opportunity: {{ s.opportunity_text | plain }}
{% endif %}
{% if s.outreach_text %}
Recommended outreach: {{ s.outreach_text | plain }}
{% endif %}
{% if s.links %}
Sources:
{% for l in s.links %}
  {{ l.label }}: {{ l.url }}
{% endfor %}
{% endif %}

{% endfor %}
"""


DEFAULT_TEMPLATE: dict[str, Any] = {
    "name": "PAM digest (default)",
    "description": "Built-in digest: greeting, optional AI summary, one card per account with its key signals, opportunity, outreach and sources.",
    "subject_tpl": "TTBS signals: {{ counts.signals }} of your {{ counts.total }} accounts need attention ({{ run.window_end }})",
    "html_tpl": _DEFAULT_HTML,
    "text_tpl": _DEFAULT_TEXT,
    "ai_enabled": False,
    "ai_prompt": None,
    "ai_max_words": 120,
    "ai_on_failure": "send_without",
}
