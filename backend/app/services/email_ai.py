"""AI summary for email digests, written by the active research AI (Perplexity or Gemini).

The template decides whether to use it (`ai_enabled`), what to ask (`ai_prompt`), how long it may
be (`ai_max_words`) and what happens when the AI fails (`ai_on_failure`: send without the summary,
or hold the email and retry later). The summary is produced once per email and stored with it, so
retries never pay twice. No web search is used: the AI only rewrites the research already done.
"""

import logging
import re
from dataclasses import asdict, dataclass
from typing import Any

from app.core.config import get_settings
from app.core.errors import ProviderError
from app.research import providers, ratelimit

log = logging.getLogger(__name__)

DEFAULT_PROMPT = (
    "Write a short executive summary for {pam_name}, a TTBS account manager, about this week's account signals. "
    "Name the 2-3 accounts to act on first and say why in one clause each, then one line on the overall theme. "
    "Plain sentences only, no headings, no bullet symbols, no markdown, at most {max_words} words."
)
SYSTEM = ("You are a concise B2B sales-intelligence assistant for Tata Tele Business Services (TTBS). "
          "Use only the facts given. Never invent companies, numbers or news.")


class AiUnavailable(ProviderError):
    """The AI summary could not be produced and the template says to hold the email (retryable)."""


@dataclass
class AiResult:
    text: str
    provider: str
    model: str
    tokens_in: int = 0
    tokens_out: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    usage: providers.Usage | None = None

    def meta(self) -> dict[str, Any]:
        return {"provider": self.provider, "model": self.model, "tokensIn": self.tokens_in, "tokensOut": self.tokens_out,
                "cost": self.cost, "latencyMs": self.latency_ms, "usage": asdict(self.usage) if self.usage else None}


def _facts(ctx: dict[str, Any], limit: int = 40) -> str:
    lines = [f"Accounts with signals: {ctx['counts']['signals']} of {ctx['counts']['total']} "
             f"(news window {ctx['run'].get('window_start')} to {ctx['run'].get('window_end')})."]
    for it in ctx["signals"][:limit]:
        plain = lambda s: re.sub(r"\*\*|https?://\S+", "", s or "").strip()  # noqa: E731
        lines.append(f"- {it['company']} [{it.get('category') or 'n/a'}]: {plain(it.get('key_signals'))} | "
                     f"Opportunity: {plain(it.get('opportunity'))} | Next step: {plain(it.get('outreach'))}")
    if len(ctx["signals"]) > limit:
        lines.append(f"...and {len(ctx['signals']) - limit} more accounts.")
    return "\n".join(lines)


def _trim_words(text: str, max_words: int) -> str:
    text = re.sub(r"[#*_`>]+", "", text).strip()
    words = text.split()
    if len(words) <= max_words:
        return text
    cut = " ".join(words[:max_words]).rstrip(",;:")
    return cut if cut.endswith((".", "!", "?")) else cut + "…"


def summarize(prompt_tpl: str | None, max_words: int, ctx: dict[str, Any]) -> AiResult:
    """Raises ProviderError (incl. providers.NotConfigured) when the AI cannot answer."""
    if not ctx["signals"]:
        return AiResult(text="", provider="none", model="")
    provider = providers.get_provider()
    if not hasattr(provider, "generate"):
        raise ProviderError(f"The active AI ({provider.key}) cannot write summaries")
    instruction = (prompt_tpl or DEFAULT_PROMPT).replace("{pam_name}", ctx["pam"]["first_name"] or "the PAM") \
        .replace("{max_words}", str(max_words))
    prompt = f"{instruction}\n\nFacts:\n{_facts(ctx)}"
    ratelimit.acquire()  # shares the research rate limit: summaries never starve or exceed it
    out = provider.generate(prompt, system=SYSTEM, max_tokens=get_settings().email_ai_max_output_tokens)
    return AiResult(text=_trim_words(out.text, max_words), provider=provider.key, model=provider.model,
                    tokens_in=out.tokens_in, tokens_out=out.tokens_out, cost=out.cost, latency_ms=out.latency_ms,
                    usage=out.usage)
