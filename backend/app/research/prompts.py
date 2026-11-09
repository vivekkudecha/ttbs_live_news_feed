"""Built-in research prompt (ported from test.py) and the PromptSpec that renders it.

The live prompt is edited from the UI (Output templates → Research prompt) and stored as immutable
versions in `research_prompt_versions` (services/research_prompts.py). The constants here are the
built-in default, seeded as version 1. The version number is part of the result-cache key, so
answers cached under an older prompt are never reused for a newer one."""

import re
from dataclasses import dataclass

PROMPT_VERSION = 1  # version number of the built-in default below

TTBS_CONTEXT = """
Tata Tele Business Services (TTBS) offerings:
- Business communications: Smartflo CCaaS, CPaaS, UCaaS, SIP Trunk, Toll-Free, WhatsApp Business, Enterprise RCS
- Connectivity: Smart Internet Leased Line (ILL), SD-WAN iFLX, P2P Leased Line, Ultra-LOLA, Managed Wi-Fi
- Cloud: TTBS Smart Cloud, Microsoft Azure and migration, CloudMon monitoring
- Cybersecurity: Email security, endpoint security/EDR, DLP, Managed SOC, VAPT
- Productivity: SmartOffice, Vaultastic email archiving, Microsoft 365, Google Workspace
"""

CATEGORIES = ("Expansion", "Funding", "Leadership", "Cybersecurity", "Digital", "Contract")

OUTPUT_RULES = """
Return ONLY this exact format for the company:

COMPANY NAME
Category: <one of: {categories}; or None when no qualifying news>
Key signals: <1-2 short lines; only TTBS-relevant signals and which TTBS offering they align with; bold main keywords>
Opportunity type: <1-2 short lines; only TTBS-relevant opportunity; bold main keywords>
Recommended outreach approach: <1-2 short lines; only TTBS-relevant sales action; bold main keywords>

STRICT RELEVANCE FILTER:
Include a news item ONLY if it creates a clear, direct business need for one or more TTBS offerings.

INCLUDE only signals connected to:
- New offices, plants, warehouses, data centers, branches, retail stores, hospitals, campuses or remote sites
- Manufacturing, mining, logistics, multi-location or distributed-workforce expansion
- Funding, capex, acquisitions or contracts that indicate operational or IT scale-up but not stock market performance, investment commentary or general financial results
- Leadership changes only when the new leader explicitly owns IT, digital, transformation, security, operations
- Cloud, ERP, CRM, data platform, AI/GenAI, application modernization, VDI or digital transformation
- Cybersecurity, data protection, compliance, audit, SOC, VAPT, ransomware, phishing or data-loss risk
- Network performance, uptime, branch connectivity, remote-site access, SD-WAN, leased line or Wi-Fi needs
- Customer support, contact center, field-force communication, WhatsApp/RCS engagement or unified collaboration
- Determine expansion or transformation needs from credible news, filings, announcements, interviews, hiring, recruitment and professional-platform updates

EXCLUDE these unless they have a direct TTBS connection:
- Routine share-price movement, daily stock commentary or technical analysis
- General financial results without an IT, connectivity, expansion or transformation implication
- Court cases, legal notices, regulatory disputes, penalties or tax matters
- CSR, advertising campaigns, awards, sponsorships, product launches or PR activity
- Routine news bulletins, content publication, hiring alone, or general business commentary
- Leadership appointments unrelated to technology, digital, security, operations or transformation
- News from outside India
- Anything that does not or cannot align with Tata Tele Business Services (TTBS) offerings

RELEVANCE TEST:
Before including any signal, ask:
"Does this news create a clear opportunity for TTBS to sell connectivity, cloud, cybersecurity, communications, monitoring or workplace productivity?"
If the answer is NO, exclude it.

If no qualifying news is found in the research window, return exactly:
Category: None
Key signals: Details not found
Opportunity type: Details not found
Recommended outreach approach: Details not found

Other rules:
1. Research only credible news, filings, announcements, interviews and professional-platform updates from the research window.
2. Keep every section short, factual and direct.
3. Include source URLs inline in each non-empty section.
4. Do not add explanations, headings, tables or extra commentary.
"""

INSTRUCTIONS = (
    "You are a precise B2B sales-intelligence researcher for Tata Tele Business Services. "
    "Research only credible public sources. Use web search for recent news and follow the "
    "requested output format exactly."
)


RESEARCH_PROMPT = """Research the company: {company}

Research window: {window_start} to {window_end} (inclusive).

Business context:
Identify only the operational, technology, expansion and security context needed to assess TTBS relevance.

TTBS context:
{ttbs_context}

Focus only on these indicators:
1. Financial Updates: investments, funding, acquisitions, major contracts, capex and financial developments that indicate operational or IT scale-up.
2. Expansion Updates: new locations, plants, facilities, branches, warehouses, data centers, partnerships, capacity expansion and growth initiatives.
3. Leadership Changes: only appointments or movements of CIO, CTO, CDO, CISO, Head-IT, Head-Digital, Head-Transformation or technology/security/operations leaders.
4. IT & Digital Strategy: cloud, AI/GenAI, cybersecurity, data, digital transformation, application modernization, ERP/CRM, network modernization and major technology initiatives.

Apply the STRICT RELEVANCE FILTER before including any signal.

{output_rules}
"""


# Tokens a prompt may use. {output_rules} and {ttbs_context} are filled first, so they may use the others.
PLACEHOLDERS = {
    "company": "Company being researched",
    "window_start": "First day of the research window (YYYY-MM-DD)",
    "window_end": "Last day of the research window (YYYY-MM-DD)",
    "ttbs_context": "The TTBS context text",
    "output_rules": "The output format & relevance rules text",
    "categories": "The category names, comma-separated",
}
REQUIRED_PLACEHOLDERS = ("company", "window_start", "window_end")
# The parser reads these lines from every answer, so the rendered prompt must ask for all of them.
REQUIRED_LABELS = ("Category:", "Key signals:", "Opportunity type:", "Recommended outreach approach:")
TOKEN = re.compile(r"\{([a-z_]+)\}")


@dataclass(frozen=True)
class PromptSpec:
    version: int
    system: str
    research_prompt: str
    ttbs_context: str
    output_rules: str
    categories: tuple[str, ...]
    window_days: int

    def render(self, company: str, window_start: str, window_end: str) -> str:
        values = {"ttbs_context": self.ttbs_context.strip(), "output_rules": self.output_rules.strip(),
                  "categories": ", ".join(self.categories), "window_start": window_start, "window_end": window_end}
        text = self.research_prompt
        for key in ("output_rules", "ttbs_context", "categories", "window_start", "window_end"):
            text = text.replace("{" + key + "}", values[key])
        # Company last, so a name that happens to contain "{...}" is never expanded.
        return text.replace("{company}", company)


def default_spec(window_days: int | None = None) -> PromptSpec:
    if window_days is None:
        from app.core.config import get_settings

        window_days = get_settings().research_window_days
    return PromptSpec(version=PROMPT_VERSION, system=INSTRUCTIONS, research_prompt=RESEARCH_PROMPT.strip(),
                      ttbs_context=TTBS_CONTEXT.strip(), output_rules=OUTPUT_RULES.strip(), categories=CATEGORIES,
                      window_days=window_days)


def build_prompt(company: str, start_date: str, end_date: str, spec: PromptSpec | None = None) -> str:
    return (spec or default_spec()).render(company, start_date, end_date)
