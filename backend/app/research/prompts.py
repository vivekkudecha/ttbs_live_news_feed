"""Research prompt, ported from test.py. Bump PROMPT_VERSION whenever the wording changes:
it is part of the result-cache key, so old cached answers are not reused for a new prompt."""

PROMPT_VERSION = 1

TTBS_CONTEXT = """
Tata Tele Business Services (TTBS) offerings:
- Business communications: Smartflo CCaaS, CPaaS, UCaaS, SIP Trunk, Toll-Free, WhatsApp Business, Enterprise RCS
- Connectivity: Smart Internet Leased Line (ILL), SD-WAN iFLX, P2P Leased Line, Ultra-LOLA, Managed Wi-Fi
- Cloud: TTBS Smart Cloud, Microsoft Azure and migration, CloudMon monitoring
- Cybersecurity: Email security, endpoint security/EDR, DLP, Managed SOC, VAPT
- Productivity: SmartOffice, Vaultastic email archiving, Microsoft 365, Google Workspace
"""

CATEGORIES = ("Expansion", "Funding", "Leadership", "Cybersecurity", "Digital", "Contract")

OUTPUT_RULES = f"""
Return ONLY this exact format for the company:

COMPANY NAME
Category: <one of: {", ".join(CATEGORIES)}; or None when no qualifying news>
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


def build_prompt(company: str, start_date: str, end_date: str) -> str:
    return f"""
Research the company: {company}

Research window: {start_date} to {end_date} (inclusive).

Business context:
Identify only the operational, technology, expansion and security context needed to assess TTBS relevance.

TTBS context:
{TTBS_CONTEXT}

Focus only on these indicators:
1. Financial Updates: investments, funding, acquisitions, major contracts, capex and financial developments that indicate operational or IT scale-up.
2. Expansion Updates: new locations, plants, facilities, branches, warehouses, data centers, partnerships, capacity expansion and growth initiatives.
3. Leadership Changes: only appointments or movements of CIO, CTO, CDO, CISO, Head-IT, Head-Digital, Head-Transformation or technology/security/operations leaders.
4. IT & Digital Strategy: cloud, AI/GenAI, cybersecurity, data, digital transformation, application modernization, ERP/CRM, network modernization and major technology initiatives.

Apply the STRICT RELEVANCE FILTER before including any signal.

{OUTPUT_RULES}
"""
