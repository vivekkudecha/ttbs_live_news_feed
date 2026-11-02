// Demo fixtures. Company names and news are FICTIONAL so the prototype can be shown
// to stakeholders without implying real news about real customers.
import type {
  Assignment,
  AuditEntry,
  Channel,
  Company,
  FinOpsSummary,
  ImportPreview,
  ImportRecord,
  Pam,
  PriorityAction,
  Provider,
  Region,
  ResearchResult,
  Run,
  Schedule,
  Segment,
  SignalCategory,
  Template,
  User,
} from "@/api/types"

export const pams: Pam[] = [
  { id: "p1", name: "Aarav Mehta", email: "aarav.mehta@ttbs.example", whatsapp: "+91 98100 11001", region: "North", segment: "Enterprise", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: true },
  { id: "p2", name: "Priya Nair", email: "priya.nair@ttbs.example", whatsapp: "+91 98450 22002", region: "South", segment: "Enterprise", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: true },
  { id: "p3", name: "Rohan Das", email: "rohan.das@ttbs.example", whatsapp: "+91 98300 33003", region: "East", segment: "Mid-market", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: true },
  { id: "p4", name: "Sneha Kulkarni", email: "sneha.kulkarni@ttbs.example", whatsapp: "+91 98200 44004", region: "West", segment: "Enterprise", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: false },
  { id: "p5", name: "Vikram Singh", email: "vikram.singh@ttbs.example", whatsapp: "+91 98110 55005", region: "North", segment: "Mid-market", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: true },
  { id: "p6", name: "Ananya Iyer", email: "ananya.iyer@ttbs.example", whatsapp: "+91 98400 66006", region: "South", segment: "Emerging", active: true, capacity: 10, notifyEmail: true, notifyWhatsapp: true },
  { id: "p7", name: "Karan Malhotra", email: "karan.malhotra@ttbs.example", whatsapp: "+91 98190 77007", region: "West", segment: "Mid-market", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: true },
  { id: "p8", name: "Meera Banerjee", email: "meera.banerjee@ttbs.example", whatsapp: "+91 98310 88008", region: "East", segment: "Enterprise", active: true, capacity: 12, notifyEmail: true, notifyWhatsapp: true },
]

const companySeed: [string, string, Region, Segment][] = [
  ["Aranya Logistics Pvt Ltd", "Logistics", "North", "Enterprise"],
  ["Bodhi Fincorp Ltd", "NBFC", "West", "Enterprise"],
  ["Chandrika Healthcare Pvt Ltd", "Healthcare", "East", "Enterprise"],
  ["Devika Retail Ventures Pvt Ltd", "Retail", "South", "Mid-market"],
  ["Ekam Steel & Power Ltd", "Manufacturing", "East", "Enterprise"],
  ["Falguni Foods Pvt Ltd", "FMCG", "North", "Mid-market"],
  ["Gaurang Infra Projects Ltd", "Infrastructure", "West", "Enterprise"],
  ["Hemadri Pharma Ltd", "Pharma", "South", "Enterprise"],
  ["Ishaan EdTech Pvt Ltd", "Education", "North", "Emerging"],
  ["Jaivardhan Auto Components Ltd", "Automotive", "West", "Mid-market"],
  ["Kaveri Payments Pvt Ltd", "Fintech", "South", "Emerging"],
  ["Lakshya Insurance Brokers Pvt Ltd", "Insurance", "North", "Mid-market"],
  ["Madhavi Hospitality Pvt Ltd", "Hospitality", "West", "Mid-market"],
  ["Nirmala Textiles Ltd", "Textiles", "South", "Mid-market"],
  ["Ojas Renewable Energy Pvt Ltd", "Energy", "North", "Enterprise"],
  ["Pranav Media Networks Pvt Ltd", "Media", "East", "Mid-market"],
  ["Quila Realty Developers Pvt Ltd", "Real Estate", "North", "Mid-market"],
  ["Rudra Cements Ltd", "Manufacturing", "East", "Enterprise"],
  ["Saanvi Diagnostics Ltd", "Healthcare", "South", "Mid-market"],
  ["Tanmay Software Labs Pvt Ltd", "IT Services", "South", "Emerging"],
  ["Udaan Air Cargo Services Pvt Ltd", "Logistics", "West", "Mid-market"],
  ["Vaidehi Microfinance Ltd", "NBFC", "East", "Mid-market"],
  ["Warrior Security Services Pvt Ltd", "Facility Services", "North", "Mid-market"],
  ["Yamuna Agro Industries Ltd", "Agri", "North", "Emerging"],
  ["Zenith Clean Mobility Pvt Ltd", "Automotive", "South", "Emerging"],
  ["Abhinav Cold Chain Pvt Ltd", "Logistics", "West", "Emerging"],
  ["Bhavya Housing Finance Ltd", "Housing Finance", "West", "Mid-market"],
  ["Charvi Fashion Retail Ltd", "Retail", "North", "Enterprise"],
  ["Dhruv Electronics Mfg Pvt Ltd", "Electronics", "South", "Enterprise"],
  ["Eshan Hospitals Pvt Ltd", "Healthcare", "North", "Enterprise"],
  ["Firoza Travel Tech Ltd", "Travel", "North", "Mid-market"],
  ["Girija Chemicals Ltd", "Chemicals", "West", "Mid-market"],
  ["Harini Contact Solutions Pvt Ltd", "BPO", "South", "Mid-market"],
  ["Indus Valley Ceramics Ltd", "Manufacturing", "West", "Mid-market"],
  ["Jyotsna University Trust", "Education", "East", "Mid-market"],
  ["Kalyani Small Finance Bank Ltd", "Banking", "East", "Enterprise"],
  ["Lavanya Cosmetics Pvt Ltd", "D2C", "North", "Emerging"],
  ["Mrinal Data Centres Pvt Ltd", "Data Centre", "South", "Enterprise"],
  ["Navya Warehousing Ltd", "Logistics", "East", "Mid-market"],
  ["Omkar Engineering Works Ltd", "Engineering", "West", "Enterprise"],
  ["Pallavi Securities Ltd", "Broking", "North", "Mid-market"],
  ["Rachit Quick Commerce Pvt Ltd", "E-commerce", "South", "Emerging"],
  ["Shaurya Defence Systems Ltd", "Defence", "South", "Enterprise"],
  ["Tejas Tyres India Pvt Ltd", "Automotive", "East", "Enterprise"],
  ["Urvi Wellness Clinics Pvt Ltd", "Healthcare", "West", "Emerging"],
  ["Vihaan Gaming Studios Pvt Ltd", "Media", "North", "Emerging"],
  ["Yashvi Co-working Spaces Pvt Ltd", "Real Estate", "South", "Mid-market"],
  ["Zoya Jewellery Retail Ltd", "Retail", "West", "Mid-market"],
]

const pamFor = (region: Region, segment: Segment, i: number): string => {
  const candidates = pams.filter((p) => p.region === region)
  const exact = candidates.find((p) => p.segment === segment)
  return (i % 3 === 0 ? candidates[candidates.length - 1] : exact ?? candidates[0]).id
}

export const companies: Company[] = companySeed.map(([name, industry, region, segment], i) => ({
  id: `c${i + 1}`,
  name,
  industry,
  region,
  segment,
  active: true,
  pamId: pamFor(region, segment, i),
}))

interface SignalTemplate {
  category: SignalCategory
  keySignals: (c: Company) => string
  opportunity: string
  outreach: string
  whyNow: string
  action: string
  offerings: string[]
}

const city = (r: Region) => ({ North: "Lucknow and Jaipur", South: "Coimbatore and Vizag", East: "Bhubaneswar and Guwahati", West: "Nagpur and Surat" })[r]

const signalPool: SignalTemplate[] = [
  {
    category: "Expansion",
    keySignals: (c) => `Announced **3 new regional hubs** in **${city(c.region)}**, going live next quarter; hiring **400+ operations staff**.`,
    opportunity: "**Multi-site connectivity**: **SD-WAN iFLX** with **Smart ILL** primary links and **Managed Wi-Fi** for new hubs.",
    outreach: "Approach **Head-IT / Infra** with a **multi-site SD-WAN design** and phased rollout aligned to hub go-live.",
    whyNow: "New hubs go live next quarter, so connectivity vendors get shortlisted in the next 4–6 weeks.",
    action: "Book a site-survey call with Head-IT; pitch SD-WAN iFLX + ILL bundle with Managed Wi-Fi.",
    offerings: ["SD-WAN iFLX", "Smart ILL", "Managed Wi-Fi"],
  },
  {
    category: "Funding",
    keySignals: () => "Raised **₹420 Cr Series C** to scale its **lending platform** and expand **customer support** to 3x volume.",
    opportunity: "**Smartflo CCaaS** + **WhatsApp Business** for scaled support; **Managed SOC** for RBI-aligned security posture.",
    outreach: "Engage **CTO and Head-CX** with a **CX stack consolidation** proposal and a security assessment offer.",
    whyNow: "Fresh funding earmarked for CX scale-up; platform decisions are being made now.",
    action: "Pitch Smartflo CCaaS + WhatsApp Business to Head-CX; offer complimentary VAPT to CTO.",
    offerings: ["Smartflo CCaaS", "WhatsApp Business", "Managed SOC", "VAPT"],
  },
  {
    category: "Leadership",
    keySignals: () => "Appointed a **new Chief Information Officer** with a stated mandate for **cloud migration** and **cost optimisation**.",
    opportunity: "**Azure migration** with **TTBS Smart Cloud** landing zone and **CloudMon** monitoring.",
    outreach: "Request an **intro meeting with the new CIO** within the first 90 days; lead with a **cloud cost assessment**.",
    whyNow: "New CIO is in the first-90-days window, when vendor strategy is reset.",
    action: "Send CIO congratulation note + cloud cost assessment offer; loop in Azure specialist.",
    offerings: ["Microsoft Azure", "Smart Cloud", "CloudMon"],
  },
  {
    category: "Cybersecurity",
    keySignals: () => "Reported a **phishing incident** affecting **employee mailboxes**; board has asked for a **security review**.",
    opportunity: "**Email security**, **endpoint security / EDR** and a **VAPT** engagement; **Vaultastic** for archiving.",
    outreach: "Reach **CISO / Head-IT** with a **rapid email-security hardening** offer and VAPT scoping.",
    whyNow: "Active incident plus board-mandated review creates urgent buying intent.",
    action: "Offer a 2-week email-security trial and VAPT scoping workshop to the CISO.",
    offerings: ["Email Security", "EDR", "VAPT", "Vaultastic"],
  },
  {
    category: "Expansion",
    keySignals: () => "Commissioned a **new manufacturing plant** with **₹650 Cr capex**; production starts in **Q4**.",
    opportunity: "**ILL + P2P Leased Line** from plant to HQ, **Managed Wi-Fi** on shop floor, **SIP Trunk** for plant telephony.",
    outreach: "Engage **Plant Head and Head-IT** with a **plant connectivity blueprint** before commissioning.",
    whyNow: "Plant commissioning in Q4. Connectivity must be live before production starts.",
    action: "Propose plant connectivity blueprint (ILL + P2P + Managed Wi-Fi) to Head-IT this week.",
    offerings: ["Smart ILL", "P2P Leased Line", "Managed Wi-Fi", "SIP Trunk"],
  },
  {
    category: "Digital",
    keySignals: () => "Launched a **GenAI customer-service programme** and an **ERP upgrade to SAP S/4HANA**.",
    opportunity: "**Smart Cloud / Azure** hosting for ERP, **Smartflo CPaaS** for AI-driven engagement, **CloudMon** for uptime.",
    outreach: "Position with **CDO / Head-Digital** as the **cloud + communications partner** for the transformation.",
    whyNow: "ERP and GenAI programmes are in vendor-selection phase.",
    action: "Share an ERP-on-Azure reference architecture and CPaaS demo with the CDO.",
    offerings: ["Microsoft Azure", "Smartflo CPaaS", "CloudMon"],
  },
  {
    category: "Contract",
    keySignals: () => "Won a **₹1,200 Cr state government contract** requiring **field teams across 6 states**.",
    opportunity: "**UCaaS** for field-force collaboration, **SD-WAN** for project sites, **Toll-Free** for citizen helpline.",
    outreach: "Approach **COO / Project Director** with a **project-site connectivity + helpline** bundle.",
    whyNow: "Contract mobilisation starts within 30 days; site connectivity is on the critical path.",
    action: "Meet Project Director with a mobilisation-ready bundle: SD-WAN, UCaaS, Toll-Free.",
    offerings: ["UCaaS", "SD-WAN iFLX", "Toll-Free"],
  },
  {
    category: "Expansion",
    keySignals: (c) => `Plans **40 new outlets** across **Tier-2 cities** including **${city(c.region)}** over the next 12 months.`,
    opportunity: "**SD-WAN** for store network, **WhatsApp Business** for customer engagement, **Managed Wi-Fi** in stores.",
    outreach: "Pitch a **retail store-in-a-box** connectivity package to **Head-Retail Ops and IT**.",
    whyNow: "Store rollout plan is approved; first wave opens next quarter.",
    action: "Present store-in-a-box (SD-WAN + Managed Wi-Fi + WhatsApp Business) to Retail Ops head.",
    offerings: ["SD-WAN iFLX", "Managed Wi-Fi", "WhatsApp Business"],
  },
]

const sourceFor = (c: Company, k: number) => [
  { title: `Press release · ${c.name.split(" ")[0]}`, url: `https://example.com/news/${c.id}-${k}` },
  { title: "Business daily (sample)", url: `https://example.com/business/${c.id}-${k}` },
]

// Deterministic pseudo-random so the demo looks identical on every load.
const rnd = (seed: number) => {
  const x = Math.sin(seed * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

export const runs: Run[] = []
export const results: ResearchResult[] = []
export const priorityActions: PriorityAction[] = []

const runDefs = [
  { id: "R-0013", label: "Ad-hoc: West region deep dive", trigger: "adhoc" as const, start: "2026-11-02T09:15:00+05:30", end: null, ws: "2026-10-23", we: "2026-11-02", status: "running" as const, by: "sneha.kulkarni" },
  { id: "R-0012", label: "10-day cycle · 22 Oct – 1 Nov", trigger: "scheduled" as const, start: "2026-11-01T06:00:00+05:30", end: "2026-11-01T06:42:10+05:30", ws: "2026-10-22", we: "2026-11-01", status: "completed" as const, by: "scheduler" },
  { id: "R-0011", label: "10-day cycle · 12 – 22 Oct", trigger: "scheduled" as const, start: "2026-10-22T06:00:00+05:30", end: "2026-10-22T06:39:44+05:30", ws: "2026-10-12", we: "2026-10-22", status: "completed" as const, by: "scheduler" },
  { id: "R-0010", label: "10-day cycle · 2 – 12 Oct", trigger: "scheduled" as const, start: "2026-10-12T06:00:00+05:30", end: "2026-10-12T06:47:02+05:30", ws: "2026-10-02", we: "2026-10-12", status: "partial" as const, by: "scheduler" },
]

runDefs.forEach((def, ri) => {
  const scope = def.trigger === "adhoc" ? companies.filter((c) => c.region === "West") : companies
  const runResults: ResearchResult[] = scope.map((c, ci) => {
    const r = rnd((ri + 1) * 100 + ci)
    const pending = def.status === "running" && ci >= Math.ceil(scope.length * 0.6)
    const failed = !pending && def.status === "partial" && ci % 11 === 4
    const hasSignal = !pending && !failed && r < 0.55
    const tpl = signalPool[Math.floor(rnd(ri * 7 + ci * 3) * signalPool.length)]
    const tokensIn = 6000 + Math.floor(r * 4000)
    const tokensOut = hasSignal ? 900 + Math.floor(r * 600) : 300
    const cached = !pending && ri === 0 && ci % 5 === 0
    return {
      id: `${def.id}-${c.id}`,
      runId: def.id,
      companyId: c.id,
      pamId: c.pamId ?? "p1",
      status: pending ? "pending" : failed ? "failed" : hasSignal ? "signal" : "no_signal",
      category: hasSignal ? tpl.category : undefined,
      keySignals: hasSignal ? tpl.keySignals(c) : undefined,
      opportunity: hasSignal ? tpl.opportunity : undefined,
      outreach: hasSignal ? tpl.outreach : undefined,
      sources: hasSignal ? sourceFor(c, ri) : [],
      offerings: hasSignal ? tpl.offerings : [],
      tokensIn: pending ? 0 : tokensIn,
      tokensOut: pending ? 0 : tokensOut,
      cost: pending || cached ? 0 : +(tokensIn * 0.0008 / 1000 + tokensOut * 0.004 / 1000 + 0.005).toFixed(4),
      latencyMs: pending ? 0 : 18000 + Math.floor(r * 40000),
      cached,
      error: failed ? "Provider timeout after 5 retries (HTTP 504)" : undefined,
    }
  })
  results.push(...runResults)

  // Priority actions: per PAM, ranked by category strength.
  const weight: Record<SignalCategory, number> = { Contract: 6, Funding: 5, Cybersecurity: 5, Expansion: 4, Leadership: 3, Digital: 3 }
  const byPam = new Map<string, ResearchResult[]>()
  runResults.filter((x) => x.status === "signal").forEach((x) => byPam.set(x.pamId, [...(byPam.get(x.pamId) ?? []), x]))
  byPam.forEach((list, pamId) => {
    list
      .sort((a, b) => weight[b.category!] - weight[a.category!])
      .forEach((x, idx) => {
        const tpl = signalPool.find((s) => s.opportunity === x.opportunity)!
        priorityActions.push({ runId: def.id, pamId, companyId: x.companyId, rank: idx + 1, whyNow: tpl.whyNow, action: tpl.action })
      })
  })

  const pamIds = [...new Set(scope.map((c) => c.pamId ?? "p1"))]
  const pamJobs = pamIds.map((pamId) => {
    const mine = runResults.filter((x) => x.pamId === pamId)
    const done = mine.filter((x) => x.status !== "pending").length
    const pam = pams.find((p) => p.id === pamId)!
    const finished = done === mine.length
    return {
      pamId,
      status: finished ? (mine.some((x) => x.status === "failed") ? "partial" : "completed") : "running",
      total: mine.length,
      done,
      withSignal: mine.filter((x) => x.status === "signal").length,
      email: finished ? (def.id === "R-0010" && pamId === "p3" ? "failed" : "sent") : "pending",
      whatsapp: !pam.notifyWhatsapp ? "skipped" : finished ? "sent" : "pending",
    } as Run["pamJobs"][number]
  })

  runs.push({
    id: def.id,
    label: def.label,
    trigger: def.trigger,
    scheduleId: def.trigger === "scheduled" ? "s1" : undefined,
    templateId: "t1",
    templateVersion: ri === 3 ? 2 : 3,
    provider: "Perplexity",
    model: "anthropic/claude-haiku-5-5",
    windowStart: def.ws,
    windowEnd: def.we,
    startedAt: def.start,
    finishedAt: def.end,
    status: def.status,
    triggeredBy: def.by,
    companies: scope.length,
    done: runResults.filter((x) => x.status !== "pending").length,
    withSignal: runResults.filter((x) => x.status === "signal").length,
    failed: runResults.filter((x) => x.status === "failed").length,
    cacheHits: runResults.filter((x) => x.cached).length,
    cost: +runResults.reduce((s, x) => s + x.cost, 0).toFixed(2),
    estimatedCost: +(scope.length * 0.036).toFixed(2),
    pamJobs,
  })
})

export const assignments: Assignment[] = companies.map((c, i) => ({
  id: `a${i + 1}`,
  companyId: c.id,
  pamId: c.pamId!,
  validFrom: "2026-08-01T10:00:00+05:30",
  validTo: null,
  reason: "import",
  actor: "admin",
}))
// Historical reassignment so the timeline shows a past PAM change.
assignments.unshift({ id: "a0", companyId: "c3", pamId: "p3", validFrom: "2026-05-10T10:00:00+05:30", validTo: "2026-08-01T10:00:00+05:30", reason: "import", actor: "admin" })

export const users: User[] = [
  { id: "u1", username: "admin", name: "Platform Admin", role: "admin", active: true, lastLoginAt: "2026-11-02T09:02:00+05:30" },
  { id: "u2", username: "sneha.kulkarni", name: "Sneha Kulkarni", role: "manager", active: true, lastLoginAt: "2026-11-02T09:10:00+05:30" },
  { id: "u3", username: "aarav.mehta", name: "Aarav Mehta", role: "pam", active: true, lastLoginAt: "2026-11-01T18:20:00+05:30", pamId: "p1" },
  { id: "u4", username: "priya.nair", name: "Priya Nair", role: "pam", active: true, lastLoginAt: "2026-11-01T11:45:00+05:30", pamId: "p2" },
  { id: "u5", username: "audit.team", name: "Internal Audit", role: "auditor", active: true, lastLoginAt: "2026-10-28T15:00:00+05:30" },
  { id: "u6", username: "rohan.das", name: "Rohan Das", role: "pam", active: true, lastLoginAt: null, pamId: "p3" },
]

const TTBS_CONTEXT = `Tata Tele Business Services (TTBS) offerings:
- Business communications: Smartflo CCaaS, CPaaS, UCaaS, SIP Trunk, Toll-Free, WhatsApp Business, Enterprise RCS
- Connectivity: Smart Internet Leased Line (ILL), SD-WAN iFLX, P2P Leased Line, Ultra-LOLA, Managed Wi-Fi
- Cloud: TTBS Smart Cloud, Microsoft Azure and migration, CloudMon monitoring
- Cybersecurity: Email security, endpoint security/EDR, DLP, Managed SOC, VAPT
- Productivity: SmartOffice, Vaultastic email archiving, Microsoft 365, Google Workspace`

const RELEVANCE = `INCLUDE only signals connected to:
- New offices, plants, warehouses, data centers, branches, stores, hospitals, campuses
- Funding, capex, acquisitions or contracts indicating operational or IT scale-up
- Leadership changes where the leader owns IT, digital, security or operations
- Cloud, ERP, CRM, AI/GenAI, modernisation, cybersecurity, network or contact-centre needs

EXCLUDE: share-price commentary, routine results, legal disputes, CSR/awards/PR,
non-India news, anything not aligned to TTBS offerings.`

const RESEARCH_PROMPT = `Research the company: {{company}}
Research window: {{window_start}} to {{window_end}} (previous {{window_days}} days, inclusive).

Focus only on: Financial updates, Expansion updates, Leadership changes (CIO/CTO/CISO/CDO…),
IT & Digital strategy. Apply the STRICT RELEVANCE FILTER before including any signal.
Research only credible news, filings, announcements and professional-platform updates.
Include source URLs for every non-empty section.`

const PRIORITY_PROMPT = `Create a prioritized TTBS sales action list for PAM {{pam_name}}.
Rank by strength and recency of trigger. Ignore companies with no signal.
For each: "Why now?" (1–2 lines) and "Action" (1–2 lines, stakeholder + TTBS offerings).`

export const templates: Template[] = [
  {
    id: "t1",
    name: "TTBS Sales Signals (standard)",
    description: "Default 10-day research format used for PAM digests. Ported from the original research script.",
    activeVersion: 3,
    versions: [3, 2, 1].map((v) => ({
      version: v,
      createdAt: v === 3 ? "2026-10-15T12:00:00+05:30" : v === 2 ? "2026-09-20T12:00:00+05:30" : "2026-08-01T12:00:00+05:30",
      createdBy: v === 1 ? "admin" : "sneha.kulkarni",
      note: v === 3 ? "Tightened relevance filter; added Contract category" : v === 2 ? "Added WhatsApp summary block" : "Initial version from research script",
      windowDays: 10,
      model: "anthropic/claude-haiku-5-5",
      preset: "high",
      ttbsContext: TTBS_CONTEXT,
      researchPrompt: RESEARCH_PROMPT,
      relevanceRules: RELEVANCE,
      sections: [
        { key: "key_signals", label: "Key signals", instruction: "1–2 short lines; only TTBS-relevant signals; bold main keywords" },
        { key: "opportunity", label: "Opportunity type", instruction: "1–2 short lines; TTBS offering alignment; bold main keywords" },
        { key: "outreach", label: "Recommended outreach approach", instruction: "1–2 short lines; specific sales action; bold main keywords" },
      ],
      priorityPrompt: PRIORITY_PROMPT,
      excelColumns: ["Company", "News Feed Results", "Priority Actions"],
    })),
  },
  {
    id: "t2",
    name: "Leadership & Security Watch",
    description: "Narrow format for CXO change and cybersecurity triggers only. Used for enterprise accounts.",
    activeVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: "2026-10-25T16:30:00+05:30",
        createdBy: "sneha.kulkarni",
        note: "First version",
        windowDays: 15,
        model: "anthropic/claude-haiku-5-5",
        preset: "medium",
        ttbsContext: TTBS_CONTEXT,
        researchPrompt: RESEARCH_PROMPT.replace("Financial updates, Expansion updates, ", ""),
        relevanceRules: "INCLUDE only CIO/CTO/CISO/CDO appointments and cybersecurity incidents, audits or compliance mandates.",
        sections: [
          { key: "trigger", label: "Trigger", instruction: "One line: who/what changed, with date" },
          { key: "risk_or_mandate", label: "Risk / mandate", instruction: "One line: security or transformation mandate" },
          { key: "play", label: "TTBS play", instruction: "One line: offering + first meeting ask" },
        ],
        priorityPrompt: PRIORITY_PROMPT,
        excelColumns: ["Company", "Trigger", "Risk / mandate", "TTBS play"],
      },
    ],
  },
]

export const schedules: Schedule[] = [
  { id: "s1", name: "All accounts · 10-day cycle", intervalDays: 10, runAtTime: "06:00", timezone: "Asia/Kolkata", nextRunAt: "2026-11-11T06:00:00+05:30", lastRunAt: "2026-11-01T06:00:00+05:30", templateId: "t1", providerKey: "perplexity", scope: "All active companies", enabled: true, budgetCap: 25, channels: ["email", "whatsapp"] },
  { id: "s2", name: "Enterprise · Leadership & Security", intervalDays: 15, runAtTime: "07:30", timezone: "Asia/Kolkata", nextRunAt: "2026-11-09T07:30:00+05:30", lastRunAt: null, templateId: "t2", providerKey: "perplexity", scope: "Segment = Enterprise", enabled: false, budgetCap: 10, channels: ["email"] },
]

export const providers: Provider[] = [
  { key: "perplexity", name: "Perplexity Agent API", kind: "llm", model: "anthropic/claude-haiku-5-5", status: "connected", enabled: true, isDefault: true, rps: 45, priceInPer1k: 0.0008, priceOutPer1k: 0.004, maskedKey: "pplx-••••••••••••3t" },
  { key: "gemini", name: "Google Gemini (Search grounding)", kind: "llm", model: "—", status: "not_configured", enabled: false, isDefault: false, rps: 0, priceInPer1k: 0, priceOutPer1k: 0, maskedKey: null, note: "Adapter slot ready. Add credentials to enable." },
  { key: "openai", name: "OpenAI (web search)", kind: "llm", model: "—", status: "not_configured", enabled: false, isDefault: false, rps: 0, priceInPer1k: 0, priceOutPer1k: 0, maskedKey: null, note: "Planned adapter" },
  { key: "anthropic", name: "Anthropic Claude (web search)", kind: "llm", model: "—", status: "not_configured", enabled: false, isDefault: false, rps: 0, priceInPer1k: 0, priceOutPer1k: 0, maskedKey: null, note: "Planned adapter" },
]

export const channels: Channel[] = [
  { key: "smtp", name: "Corporate SMTP", type: "email", adapter: "SMTP (TLS)", status: "connected", enabled: true, details: { Host: "smtp.ttbs.example:587", Sender: "signals@ttbs.example", "Reply-to": "sales-ops@ttbs.example" } },
  { key: "graph", name: "Microsoft 365 (Graph)", type: "email", adapter: "MS Graph sendMail", status: "not_configured", enabled: false, details: { Tenant: "—", Mailbox: "—" } },
  { key: "meta_wa", name: "WhatsApp Cloud API", type: "whatsapp", adapter: "Meta Cloud API", status: "connected", enabled: true, details: { "WABA ID": "••••••4821", "Phone number": "+91 22 •••• 7700", Template: "pam_signal_digest_v2 (approved)" } },
]

export const audit: AuditEntry[] = [
  { id: "ev20", ts: "2026-11-02T09:15:04+05:30", actor: "sneha.kulkarni", role: "manager", action: "run.start", entity: "Run R-0013", detail: "Ad-hoc run on West region (13 companies) · template v3", ip: "10.20.4.18" },
  { id: "ev19", ts: "2026-11-02T09:10:12+05:30", actor: "sneha.kulkarni", role: "manager", action: "auth.login", entity: "User sneha.kulkarni", detail: "Successful login", ip: "10.20.4.18" },
  { id: "ev18", ts: "2026-11-02T09:02:40+05:30", actor: "admin", role: "admin", action: "auth.login", entity: "User admin", detail: "Successful login", ip: "10.20.1.5" },
  { id: "ev17", ts: "2026-11-02T08:55:01+05:30", actor: "unknown", role: "system", action: "auth.login_failed", entity: "User admin", detail: "Invalid password (attempt 2 of 5)", ip: "10.20.9.77" },
  { id: "ev16", ts: "2026-11-01T06:43:30+05:30", actor: "system", role: "system", action: "notify.whatsapp.sent", entity: "Run R-0012", detail: "7 WhatsApp digests delivered, 1 skipped (opted out)", ip: "—" },
  { id: "ev15", ts: "2026-11-01T06:43:12+05:30", actor: "system", role: "system", action: "notify.email.sent", entity: "Run R-0012", detail: "8 PAM digests sent with Excel attachment", ip: "—" },
  { id: "ev14", ts: "2026-11-01T06:42:10+05:30", actor: "system", role: "system", action: "run.complete", entity: "Run R-0012", detail: `${runs[1].companies} companies · ${runs[1].withSignal} signals · $${runs[1].cost.toFixed(2)}`, ip: "—" },
  { id: "ev13", ts: "2026-11-01T06:00:00+05:30", actor: "scheduler", role: "system", action: "run.start", entity: "Run R-0012", detail: "Schedule 'All accounts · 10-day cycle' fired", ip: "—" },
  { id: "ev12", ts: "2026-10-30T14:21:00+05:30", actor: "admin", role: "admin", action: "provider.update", entity: "Provider perplexity", detail: "API key rotated (old key revoked)", ip: "10.20.1.5" },
  { id: "ev11", ts: "2026-10-25T16:30:00+05:30", actor: "sneha.kulkarni", role: "manager", action: "template.create", entity: "Template t2 v1", detail: "Created 'Leadership & Security Watch'", ip: "10.20.4.18" },
  { id: "ev10", ts: "2026-10-15T12:00:00+05:30", actor: "sneha.kulkarni", role: "manager", action: "template.version", entity: "Template t1 v3", detail: "Tightened relevance filter; v3 activated", ip: "10.20.4.18" },
  { id: "ev9", ts: "2026-10-12T06:48:20+05:30", actor: "system", role: "system", action: "notify.email.failed", entity: "Run R-0010 · Rohan Das", detail: "SMTP 451 temporary failure; moved to retry queue", ip: "—" },
  { id: "ev8", ts: "2026-10-05T11:02:00+05:30", actor: "admin", role: "admin", action: "import.commit", entity: "Import #7", detail: "48 rows · 2 new companies · 1 reassignment", ip: "10.20.1.5" },
]

export const finops: FinOpsSummary = {
  monthBudget: 120,
  monthSpend: 4.38,
  forecast: 14.6,
  softLimitPct: 80,
  costPerSignal: 0.045,
  cacheSavings: 0.62,
  series: [
    { month: "Jun", llm: 38.2, messaging: 4.1 },
    { month: "Jul", llm: 41.7, messaging: 4.4 },
    { month: "Aug", llm: 52.9, messaging: 5.2 },
    { month: "Sep", llm: 47.3, messaging: 5.0 },
    { month: "Oct", llm: 44.8, messaging: 4.9 },
    { month: "Nov", llm: 4.38, messaging: 0.5 },
  ],
  byProvider: [
    { name: "Perplexity · research", cost: 3.71 },
    { name: "Perplexity · prioritisation", cost: 0.67 },
    { name: "WhatsApp messaging", cost: 0.5 },
  ],
}

export const imports: ImportRecord[] = [
  { id: "imp7", fileName: "ttbs_logos_pam_mapping_oct.xlsx", uploadedBy: "admin", uploadedAt: "2026-10-05T11:02:00+05:30", rows: 48, status: "committed", summary: "2 new companies · 1 reassignment" },
  { id: "imp6", fileName: "pam_mapping_sep.csv", uploadedBy: "admin", uploadedAt: "2026-09-02T10:15:00+05:30", rows: 46, status: "committed", summary: "4 new companies · 3 aliases merged" },
  { id: "imp5", fileName: "logos_draft.xlsx", uploadedBy: "sneha.kulkarni", uploadedAt: "2026-09-01T17:40:00+05:30", rows: 51, status: "failed", summary: "Rejected: 6 rows with invalid WhatsApp numbers" },
]

export const importPreview: ImportPreview = {
  fileName: "ttbs_logos_pam_mapping_nov.xlsx",
  rows: 52,
  newCompanies: 3,
  updatedCompanies: 2,
  newPams: 0,
  reassignments: 2,
  duplicatesMerged: 1,
  issues: [
    { row: 14, company: "Kaveri Payments Pvt. Ltd.", field: "Company", message: "Matches existing 'Kaveri Payments Pvt Ltd'; will merge as alias", severity: "warning" },
    { row: 31, company: "Sunrise Agritech LLP", field: "PAM WhatsApp", message: "'98400 1234' is not a valid E.164 number", severity: "error" },
    { row: 47, company: "Nexus Freight Pvt Ltd", field: "PAM Email", message: "PAM email domain is not on the allow-list", severity: "warning" },
  ],
  sample: [
    { company: "Sunrise Agritech LLP", pam: "Vikram Singh", email: "vikram.singh@ttbs.example", whatsapp: "98400 1234", region: "North", change: "new" },
    { company: "Nexus Freight Pvt Ltd", pam: "Karan Malhotra", email: "karan.m@partner.example", whatsapp: "+91 98190 77007", region: "West", change: "new" },
    { company: "Orchid Diagnostics Ltd", pam: "Ananya Iyer", email: "ananya.iyer@ttbs.example", whatsapp: "+91 98400 66006", region: "South", change: "new" },
    { company: "Ishaan EdTech Pvt Ltd", pam: "Vikram Singh", email: "vikram.singh@ttbs.example", whatsapp: "+91 98110 55005", region: "North", change: "reassigned" },
    { company: "Rudra Cements Ltd", pam: "Meera Banerjee", email: "meera.banerjee@ttbs.example", whatsapp: "+91 98310 88008", region: "East", change: "reassigned" },
    { company: "Bodhi Fincorp Ltd", pam: "Sneha Kulkarni", email: "sneha.kulkarni@ttbs.example", whatsapp: "+91 98200 44004", region: "West", change: "updated" },
    { company: "Aranya Logistics Pvt Ltd", pam: "Aarav Mehta", email: "aarav.mehta@ttbs.example", whatsapp: "+91 98100 11001", region: "North", change: "unchanged" },
  ],
}
