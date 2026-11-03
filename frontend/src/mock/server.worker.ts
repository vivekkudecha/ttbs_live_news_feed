/// <reference lib="webworker" />
/**
 * Mock API server, running in a Web Worker.
 *
 * It plays the role FastAPI + Postgres will play in production: the UI thread never
 * holds or scans the full dataset. Everything list-shaped is filtered, sorted, joined
 * and paged here, and only one page of rows crosses to the UI.
 *
 * Scale: 10,000 logos · 5,000 PAMs · 4+ research runs (40k+ results).
 * Storage is columnar (typed arrays per run), and result text is built only for the rows
 * actually returned — the same shape as a SQL query with LIMIT/OFFSET.
 *
 * Live runs are simulated at Perplexity's real rate limit (~45 completions/s) and
 * streamed to subscribers in 250 ms batches (SSE in production).
 */
import * as Comlink from "comlink"
import * as fx from "./fixtures"
import type {
  Assignment,
  AuditEntry,
  CompanyDetail,
  CompanyListRow,
  CompanyOption,
  CompanyPage,
  CompanyQuery,
  DashboardSummary,
  DigestData,
  ImportRecord,
  LatestStatus,
  LiveBatch,
  LiveItem,
  LiveSnapshot,
  Page,
  Pam,
  PamJob,
  PamJobRow,
  PamOption,
  PamPage,
  PamQuery,
  RebalanceResult,
  Region,
  ResearchResult,
  ResearchStatus,
  Role,
  Run,
  RunStatus,
  ScopeOption,
  Segment,
  SignalCategory,
  SignalPage,
  SignalQuery,
  SignalRow,
  User,
} from "@/api/types"

const N_COMPANIES = 10_000
const N_PAMS = 5_000
const LIVE_RATE = 45 // completions per second (Perplexity limit we stay under)
const TICK_MS = 250

// Live-stream state is declared before any run is created (a run can start live at module load).
type Listener = (b: LiveBatch) => void
const listeners = new Map<string, Map<number, Listener>>()
let nextSub = 1
let ticking = false

// ---------------------------------------------------------------------------------------
// Deterministic generation
// ---------------------------------------------------------------------------------------
const hash = (n: number) => {
  const x = Math.sin(n * 9301.17 + 49297.31) * 233280.7
  return x - Math.floor(x)
}
const REGIONS: Region[] = ["North", "South", "East", "West"]
const SEGMENTS: Segment[] = ["Enterprise", "Mid-market", "Emerging"]
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true })

const FIRST = ["Aditya", "Bhavna", "Chirag", "Deepa", "Eshan", "Farah", "Gautam", "Harini", "Ishaan", "Jyoti", "Kabir", "Lata", "Manav", "Nisha", "Omkar", "Pooja", "Rahul", "Sana", "Tarun", "Uma", "Varun", "Waheeda", "Yash", "Zoya", "Arjun", "Bela", "Chetan", "Divya", "Ekta", "Gopal", "Hema", "Imran", "Kavya", "Lokesh", "Meera", "Naveen", "Ojas", "Pallavi", "Rakesh", "Shreya"]
const LAST = ["Agarwal", "Bose", "Chopra", "Desai", "Gill", "Hegde", "Iyer", "Joshi", "Kapoor", "Kulkarni", "Menon", "Nair", "Patel", "Pillai", "Rao", "Reddy", "Saxena", "Sethi", "Shah", "Sharma", "Singh", "Thakur", "Trivedi", "Verma", "Bhat", "Chatterjee", "Dutta", "Ghosh", "Jain", "Khanna", "Mishra", "Mukherjee", "Naidu", "Pandey", "Rathore", "Sen", "Sinha", "Tiwari", "Yadav", "Banerjee"]
const PREFIX = ["Aadi", "Bhumi", "Chandan", "Dhara", "Ekagra", "Gagan", "Hiranya", "Indus", "Jalaj", "Kesar", "Lohit", "Megh", "Neel", "Oorja", "Prakash", "Rajat", "Sagar", "Tarang", "Utkarsh", "Vasudha", "Yatra", "Anant", "Bodh", "Charak", "Dev", "Gyan", "Himgiri", "Jeevan", "Kalpa", "Lakshmi", "Mayur", "Nalanda", "Pavan", "Ratna", "Sahyadri", "Trishul", "Udyog", "Vidya", "Akash", "Bharat", "Deccan", "Ganga", "Kaveri", "Konkan", "Malabar", "Narmada", "Sindhu", "Tapti", "Vindhya", "Aravali", "Satpura", "Nilgiri", "Mahanadi", "Godavari", "Krishna", "Brahma", "Pushpak", "Sarthi", "Swastik", "Tejasvi", "Uday", "Vikas", "Vistara", "Shakti", "Prithvi", "Agni", "Varun", "Surya", "Chandra", "Tara"]
const CORE: [string, string][] = [
  ["Logistics", "Logistics"], ["Fincorp", "NBFC"], ["Healthcare", "Healthcare"], ["Retail", "Retail"], ["Steel", "Manufacturing"],
  ["Foods", "FMCG"], ["Infra Projects", "Infrastructure"], ["Pharma", "Pharma"], ["EdTech", "Education"], ["Auto Components", "Automotive"],
  ["Payments", "Fintech"], ["Insurance Brokers", "Insurance"], ["Hospitality", "Hospitality"], ["Textiles", "Textiles"], ["Renewables", "Energy"],
  ["Media Networks", "Media"], ["Realty", "Real Estate"], ["Diagnostics", "Healthcare"], ["Software Labs", "IT Services"], ["Cold Chain", "Logistics"],
  ["Housing Finance", "Housing Finance"], ["Electronics", "Electronics"], ["Chemicals", "Chemicals"], ["Contact Solutions", "BPO"], ["Data Centres", "Data Centre"],
  ["Engineering", "Engineering"], ["Securities", "Broking"], ["Quick Commerce", "E-commerce"], ["Wellness", "Healthcare"], ["Warehousing", "Logistics"],
]
const LEGAL = ["Pvt Ltd", "Ltd", "Private Limited", "LLP", "Industries Ltd"]

interface CompanyRec {
  id: string
  name: string
  lower: string
  industry: string
  region: Region
  segment: Segment
  pam: number // index into pams, -1 = unassigned
}

const pams: Pam[] = []
const pamLower: string[] = []
const pamLoad = new Int32Array(N_PAMS)
for (let i = 0; i < N_PAMS; i++) {
  let p: Pam
  if (i < fx.pams.length) p = { ...fx.pams[i], capacity: 6 }
  else {
    const first = FIRST[i % FIRST.length]
    const last = LAST[Math.floor(i / FIRST.length) % LAST.length]
    const initial = String.fromCharCode(65 + Math.floor(i / (FIRST.length * LAST.length)))
    const name = `${first} ${initial}. ${last}`
    p = {
      id: `p${i + 1}`,
      name,
      email: `${first}.${initial}${last}`.toLowerCase() + `@ttbs.example`,
      whatsapp: `+91 9${String(800000000 + i * 7919).slice(0, 4)} ${String(10000 + i).slice(-5)}`,
      region: REGIONS[i % 4],
      segment: SEGMENTS[i % 3],
      active: true,
      capacity: 6,
      notifyEmail: true,
      notifyWhatsapp: i % 7 !== 0,
    }
  }
  pams.push(p)
  pamLower.push(`${p.name} ${p.email} ${p.region}`.toLowerCase())
}
const pamIndex = new Map(pams.map((p, i) => [p.id, i]))
const pamsByRegion: Record<Region, number[]> = { North: [], South: [], East: [], West: [] }
pams.forEach((p, i) => pamsByRegion[p.region].push(i))

const companies: CompanyRec[] = []
const regionCursor: Record<Region, number> = { North: 0, South: 0, East: 0, West: 0 }
for (let i = 0; i < N_COMPANIES; i++) {
  let name: string, industry: string, region: Region, segment: Segment
  if (i < fx.companySeed.length) [name, industry, region, segment] = fx.companySeed[i]
  else {
    const j = i - fx.companySeed.length
    const core = CORE[Math.floor(j / PREFIX.length) % CORE.length]
    name = `${PREFIX[j % PREFIX.length]} ${core[0]} ${LEGAL[Math.floor(j / (PREFIX.length * CORE.length)) % LEGAL.length]}`
    industry = core[1]
    region = REGIONS[Math.floor(hash(i) * 4)]
    segment = SEGMENTS[Math.floor(hash(i + 0.5) * 3)]
  }
  // Seeded demo logos stay with the 8 named PAMs; the rest round-robin within their region.
  let pam: number
  if (i < fx.companySeed.length) {
    const named = pamsByRegion[region].filter((x) => x < fx.pams.length)
    pam = named[i % named.length]
  } else {
    const list = pamsByRegion[region]
    pam = list[regionCursor[region]++ % list.length]
  }
  pamLoad[pam]++
  companies.push({ id: `c${i + 1}`, name, lower: `${name} ${industry}`.toLowerCase(), industry, region, segment, pam })
}
const companyIndex = new Map(companies.map((c, i) => [c.id, i]))

/** PAM → its company indices (rebuilt on reassignment). */
let pamCompanies: number[][] = []
function rebuildPamIndex() {
  pamCompanies = Array.from({ length: N_PAMS }, () => [])
  companies.forEach((c, i) => c.pam >= 0 && pamCompanies[c.pam].push(i))
  pamLoad.fill(0)
  companies.forEach((c) => c.pam >= 0 && pamLoad[c.pam]++)
}
rebuildPamIndex()

// Assignment history: only companies whose owner changed carry explicit history.
const IMPORT_AT = "2026-08-01T10:00:00+05:30"
const history = new Map<number, Assignment[]>()
history.set(2, [
  { id: "a-c3-0", companyId: "c3", pamId: "p3", validFrom: "2026-05-10T10:00:00+05:30", validTo: IMPORT_AT, reason: "import", actor: "admin" },
  { id: "a-c3-1", companyId: "c3", pamId: pams[companies[2].pam].id, validFrom: IMPORT_AT, validTo: null, reason: "import", actor: "admin" },
])
function assignmentsOf(i: number): Assignment[] {
  const h = history.get(i)
  if (h) return h
  const c = companies[i]
  return c.pam < 0 ? [] : [{ id: `a-${c.id}`, companyId: c.id, pamId: pams[c.pam].id, validFrom: IMPORT_AT, validTo: null, reason: "import", actor: "admin" }]
}
function moveCompany(i: number, to: number, reason: Assignment["reason"], actor: string, ts: string) {
  const c = companies[i]
  if (c.pam === to) return
  const h = [...assignmentsOf(i)]
  const open = h.find((a) => a.validTo === null)
  if (open) open.validTo = ts
  h.push({ id: `a-${c.id}-${h.length}`, companyId: c.id, pamId: pams[to].id, validFrom: ts, validTo: null, reason, actor })
  history.set(i, h)
  c.pam = to
}

// ---------------------------------------------------------------------------------------
// Runs: columnar results. status code: 255 not in scope · 0 pending · 1 signal · 2 none · 3 failed
// ---------------------------------------------------------------------------------------
const CODE: ResearchStatus[] = ["pending", "signal", "no_signal", "failed"]
const CAT_WEIGHT: Record<SignalCategory, number> = { Contract: 6, Funding: 5, Cybersecurity: 5, Expansion: 4, Leadership: 3, Digital: 3 }

interface RunState {
  id: string
  label: string
  trigger: "scheduled" | "adhoc"
  templateId: string
  templateVersion: number
  windowStart: string
  windowEnd: string
  startedAt: string
  finishedAt: string | null
  status: RunStatus
  triggeredBy: string
  scope: Int32Array
  statuses: Uint8Array
  tpl: Uint8Array
  seed: number
  emailFailedPam?: Set<number>
  grid?: Int32Array
  gridIndexOf?: Int32Array
  live?: { order: Int32Array; pos: number; lastTick: number; rate: number; remainingByPam: Map<number, number>; pamsDone: number }
}
const runs: RunState[] = []

function outcome(seed: number, i: number, partialRun: boolean): number {
  if (partialRun && hash(seed * 31 + i) < 0.025) return 3
  return hash(seed * 100003 + i * 1.37) < 0.42 ? 1 : 2
}

function makeRun(def: Omit<RunState, "statuses" | "tpl" | "scope"> & { scope: number[] }, fill: "all" | number): RunState {
  const statuses = new Uint8Array(N_COMPANIES).fill(255)
  const tpl = new Uint8Array(N_COMPANIES)
  const scope = Int32Array.from(def.scope)
  for (const i of scope) {
    statuses[i] = 0
    tpl[i] = Math.floor(hash(def.seed * 7 + i * 3.1) * fx.signalPool.length)
  }
  const run: RunState = { ...def, scope, statuses, tpl }
  if (fill === "all") for (const i of scope) statuses[i] = outcome(def.seed, i, def.status === "partial")
  else startLive(run, fill)
  return run
}

const allIdx = companies.map((_, i) => i)
runs.push(
  makeRun({ id: "R-0010", label: "10-day cycle · 2 – 12 Oct", trigger: "scheduled", templateId: "t1", templateVersion: 2, windowStart: "2026-10-02", windowEnd: "2026-10-12", startedAt: "2026-10-12T06:00:00+05:30", finishedAt: "2026-10-12T10:07:02+05:30", status: "partial", triggeredBy: "scheduler", seed: 10, scope: allIdx, emailFailedPam: new Set([2]) }, "all"),
  makeRun({ id: "R-0011", label: "10-day cycle · 12 – 22 Oct", trigger: "scheduled", templateId: "t1", templateVersion: 3, windowStart: "2026-10-12", windowEnd: "2026-10-22", startedAt: "2026-10-22T06:00:00+05:30", finishedAt: "2026-10-22T09:52:44+05:30", status: "completed", triggeredBy: "scheduler", seed: 11, scope: allIdx }, "all"),
  makeRun({ id: "R-0012", label: "10-day cycle · 22 Oct – 1 Nov", trigger: "scheduled", templateId: "t1", templateVersion: 3, windowStart: "2026-10-22", windowEnd: "2026-11-01", startedAt: "2026-11-01T06:00:00+05:30", finishedAt: "2026-11-01T09:48:10+05:30", status: "completed", triggeredBy: "scheduler", seed: 12, scope: allIdx }, "all"),
)
// A West-region ad-hoc run is in progress when the app opens (35% done), so the live view has something to show.
runs.push(
  makeRun(
    { id: "R-0013", label: "Ad-hoc: West region deep dive", trigger: "adhoc", templateId: "t1", templateVersion: 3, windowStart: "2026-10-23", windowEnd: "2026-11-02", startedAt: new Date(Date.now() - 22_000).toISOString(), finishedAt: null, status: "running", triggeredBy: "sneha.kulkarni", seed: 13, scope: allIdx.filter((i) => companies[i].region === "West") },
    0.35,
  ),
)
const runById = (id: string) => runs.find((r) => r.id === id)
const lastCompleted = () => [...runs].reverse().find((r) => r.status === "completed")!

// ---------------------------------------------------------------------------------------
// Row materialisation (only for rows being returned)
// ---------------------------------------------------------------------------------------
function resultOf(run: RunState, i: number): ResearchResult {
  const c = companies[i]
  const code = run.statuses[i]
  const status = CODE[code] ?? "pending"
  const t = fx.signalPool[run.tpl[i]]
  const h = hash(run.seed * 13 + i)
  const signal = status === "signal"
  const cached = run.id === "R-0012" && h < 0.12
  const tokensIn = status === "pending" ? 0 : 6000 + Math.floor(h * 4000)
  const tokensOut = status === "pending" ? 0 : signal ? 900 + Math.floor(h * 600) : 300
  return {
    id: `${run.id}-${c.id}`,
    runId: run.id,
    companyId: c.id,
    pamId: c.pam >= 0 ? pams[c.pam].id : "",
    status,
    category: signal ? t.category : undefined,
    keySignals: signal ? t.keySignals(c) : undefined,
    opportunity: signal ? t.opportunity : undefined,
    outreach: signal ? t.outreach : undefined,
    sources: signal
      ? [
          { title: `Press release · ${c.name.split(" ")[0]}`, url: `https://example.com/news/${c.id}-${run.id}` },
          { title: "Business daily (sample)", url: `https://example.com/business/${c.id}-${run.id}` },
        ]
      : [],
    offerings: signal ? t.offerings : [],
    tokensIn,
    tokensOut,
    cost: status === "pending" || cached ? 0 : +((tokensIn * 0.0008) / 1000 + (tokensOut * 0.004) / 1000 + 0.005).toFixed(4),
    latencyMs: status === "pending" ? 0 : 18000 + Math.floor(h * 40000),
    cached,
    error: status === "failed" ? "Provider timeout after 5 retries (HTTP 504)" : undefined,
  }
}

const costOf = (run: RunState, i: number) => {
  const code = run.statuses[i]
  if (code === 0 || code === 255) return 0
  const h = hash(run.seed * 13 + i)
  if (run.id === "R-0012" && h < 0.12) return 0
  const tin = 6000 + Math.floor(h * 4000)
  const tout = code === 1 ? 900 + Math.floor(h * 600) : 300
  return (tin * 0.0008) / 1000 + (tout * 0.004) / 1000 + 0.005
}

/** Priority rank of company i within its PAM for a run (1 = act first). */
function rankOf(run: RunState, i: number): number | undefined {
  if (run.statuses[i] !== 1) return undefined
  const p = companies[i].pam
  if (p < 0) return undefined
  const mine = pamCompanies[p].filter((x) => run.statuses[x] === 1)
  mine.sort((a, b) => CAT_WEIGHT[fx.signalPool[run.tpl[b]].category] - CAT_WEIGHT[fx.signalPool[run.tpl[a]].category] || collator.compare(companies[a].name, companies[b].name))
  return mine.indexOf(i) + 1
}

function signalRow(run: RunState, i: number, withPriority = true): SignalRow {
  const c = companies[i]
  const r = resultOf(run, i)
  const rank = withPriority ? rankOf(run, i) : undefined
  const t = fx.signalPool[run.tpl[i]]
  return {
    ...r,
    companyName: c.name,
    industry: c.industry,
    region: c.region,
    pamName: c.pam >= 0 ? pams[c.pam].name : "Unassigned",
    priority: rank ? { rank, whyNow: t.whyNow, action: t.action } : undefined,
  }
}

// ---------------------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------------------
interface PamAgg {
  total: number
  done: number
  withSignal: number
}
function pamAggs(run: RunState): Map<number, PamAgg> {
  const m = new Map<number, PamAgg>()
  for (const i of run.scope) {
    const p = companies[i].pam
    if (p < 0) continue
    let a = m.get(p)
    if (!a) m.set(p, (a = { total: 0, done: 0, withSignal: 0 }))
    a.total++
    const s = run.statuses[i]
    if (s !== 0) a.done++
    if (s === 1) a.withSignal++
  }
  return m
}
function jobOf(run: RunState, p: number, a: PamAgg): PamJob {
  const finished = a.done === a.total
  const pam = pams[p]
  return {
    pamId: pam.id,
    status: finished ? (run.status === "partial" && a.withSignal < a.total * 0.3 ? "partial" : "completed") : a.done > 0 ? "running" : "queued",
    total: a.total,
    done: a.done,
    withSignal: a.withSignal,
    email: !finished ? "pending" : run.emailFailedPam?.has(p) ? "failed" : "sent",
    whatsapp: !pam.notifyWhatsapp ? "skipped" : finished ? "sent" : "pending",
  }
}

function runSummary(run: RunState): Run {
  let done = 0,
    withSignal = 0,
    failed = 0,
    cacheHits = 0,
    cost = 0
  for (const i of run.scope) {
    const s = run.statuses[i]
    if (s !== 0) done++
    if (s === 1) withSignal++
    if (s === 3) failed++
    if (run.id === "R-0012" && hash(run.seed * 13 + i) < 0.12) cacheHits++
    cost += costOf(run, i)
  }
  const aggs = pamAggs(run)
  let pamDone = 0,
    emailSent = 0,
    emailFailed = 0,
    waSent = 0,
    waEligible = 0
  aggs.forEach((a, p) => {
    const j = jobOf(run, p, a)
    if (a.done === a.total) pamDone++
    if (j.email === "sent") emailSent++
    if (j.email === "failed") emailFailed++
    if (j.whatsapp !== "skipped") waEligible++
    if (j.whatsapp === "sent") waSent++
  })
  return {
    id: run.id,
    label: run.label,
    trigger: run.trigger,
    scheduleId: run.trigger === "scheduled" ? "s1" : undefined,
    templateId: run.templateId,
    templateVersion: run.templateVersion,
    provider: "Perplexity",
    model: "anthropic/claude-haiku-5-5",
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    triggeredBy: run.triggeredBy,
    companies: run.scope.length,
    done,
    withSignal,
    failed,
    cacheHits,
    cost: +cost.toFixed(2),
    estimatedCost: +(run.scope.length * 0.0125).toFixed(2),
    pamJobsTotal: aggs.size,
    pamJobsDone: pamDone,
    emailSent,
    emailFailed,
    whatsappSent: waSent,
    whatsappEligible: waEligible,
    ratePerSec: run.live && run.status === "running" ? run.live.rate : undefined,
  }
}

function latestOf(i: number): { status: LatestStatus; category?: SignalCategory } {
  const run = lastCompleted()
  const s = run.statuses[i]
  if (s === 255) return { status: "none" }
  return { status: CODE[s], category: s === 1 ? fx.signalPool[run.tpl[i]].category : undefined }
}
function cyclesOf(i: number) {
  const out: { runId: string; status: ResearchStatus }[] = []
  for (const r of runs) {
    const s = r.statuses[i]
    if (s !== 255 && s !== 0) out.push({ runId: r.id, status: CODE[s] })
  }
  return out
}
function companyRow(i: number): CompanyListRow {
  const c = companies[i]
  const latest = latestOf(i)
  const cycles = cyclesOf(i)
  let lastSignal: string | null = null
  let signals = 0
  for (const r of runs)
    if (r.statuses[i] === 1) {
      signals++
      if (!lastSignal || r.windowEnd > lastSignal) lastSignal = r.windowEnd
    }
  return {
    id: c.id,
    name: c.name,
    industry: c.industry,
    region: c.region,
    segment: c.segment,
    pamId: c.pam >= 0 ? pams[c.pam].id : null,
    pamName: c.pam >= 0 ? pams[c.pam].name : "Unassigned",
    latestStatus: latest.status,
    latestCategory: latest.category,
    signals,
    lastSignal,
    cycles,
  }
}
const pamOption = (p: number): PamOption => ({ id: pams[p].id, name: pams[p].name, email: pams[p].email, region: pams[p].region, segment: pams[p].segment, active: pams[p].active, load: pamLoad[p], capacity: pams[p].capacity })

const tokens = (q?: string) => (q ?? "").toLowerCase().split(/\s+/).filter(Boolean)
const matchAll = (hay: string, toks: string[]) => toks.every((t) => hay.includes(t))
function paginate<T>(rows: T[], page: number, pageSize: number): Page<T> {
  const total = rows.length
  const start = page * pageSize
  return { rows: rows.slice(start, start + pageSize), total, page, pageSize }
}

// ---------------------------------------------------------------------------------------
// Live simulation (stands in for workers + Redis pub/sub + SSE)
// ---------------------------------------------------------------------------------------

/** Grid order for the live view: grouped by PAM (alphabetical) so each PAM's logos sit together. */
function ensureGrid(run: RunState) {
  if (run.grid) return
  const grid = Int32Array.from(run.scope).sort(
    (a, b) => collator.compare(pams[companies[a].pam]?.name ?? "", pams[companies[b].pam]?.name ?? "") || collator.compare(companies[a].name, companies[b].name),
  )
  const gridIndexOf = new Int32Array(N_COMPANIES).fill(-1)
  grid.forEach((ci, k) => (gridIndexOf[ci] = k))
  run.grid = grid
  run.gridIndexOf = gridIndexOf
}

function startLive(run: RunState, preDone: number) {
  ensureGrid(run)
  // Workers finish in arbitrary order (concurrency), so completion order is shuffled.
  const order = Int32Array.from(run.scope)
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(hash(run.seed * 977 + k) * (k + 1))
    ;[order[k], order[j]] = [order[j], order[k]]
  }
  const remainingByPam = new Map<number, number>()
  for (const i of run.scope) remainingByPam.set(companies[i].pam, (remainingByPam.get(companies[i].pam) ?? 0) + 1)
  run.live = { order, pos: 0, lastTick: performance.now(), rate: LIVE_RATE, remainingByPam, pamsDone: 0 }
  const pre = Math.floor(order.length * preDone)
  for (let k = 0; k < pre; k++) complete(run, null)
  run.status = "running"
  if (!ticking) {
    ticking = true
    setInterval(tick, TICK_MS)
  }
}

function complete(run: RunState, batch: LiveBatch | null) {
  const L = run.live!
  const i = L.order[L.pos++]
  const s = outcome(run.seed, i, false)
  run.statuses[i] = s
  const p = companies[i].pam
  const left = (L.remainingByPam.get(p) ?? 1) - 1
  L.remainingByPam.set(p, left)
  if (left === 0) L.pamsDone++
  if (batch) {
    const item: LiveItem = { i: run.gridIndexOf![i], s: s as 1 | 2 | 3, at: Date.now() }
    if (s === 1) item.category = fx.signalPool[run.tpl[i]].category
    batch.items.push(item)
    if (left === 0) {
      const a = pamAggs({ ...run, scope: Int32Array.from(pamCompanies[p].filter((x) => run.statuses[x] !== 255)) })
      const agg = a.get(p)!
      batch.pamsCompleted.push({ pamId: pams[p].id, pamName: pams[p].name, withSignal: agg.withSignal, total: agg.total })
    }
  }
}

function tick() {
  const now = performance.now()
  for (const run of runs) {
    const L = run.live
    if (!L || run.status !== "running") continue
    const dt = (now - L.lastTick) / 1000
    L.lastTick = now
    // Rate wobbles around the limit like real provider latency does.
    L.rate = Math.max(30, Math.min(LIVE_RATE, LIVE_RATE * (0.86 + hash(now) * 0.14)))
    const n = Math.min(Math.round(L.rate * dt), L.order.length - L.pos)
    const batch: LiveBatch = { runId: run.id, items: [], pamsCompleted: [], done: 0, signals: 0, failed: 0, pamsDone: 0, ratePerSec: L.rate, status: run.status }
    for (let k = 0; k < n; k++) complete(run, batch)
    if (L.pos >= L.order.length) {
      run.status = "completed"
      run.finishedAt = new Date().toISOString()
      logAudit("system", "system", "run.complete", `Run ${run.id}`, `${run.scope.length.toLocaleString("en-IN")} companies researched`)
    }
    const subs = listeners.get(run.id)
    if (!subs?.size) continue
    let signals = 0,
      failed = 0
    for (const i of run.scope) {
      const s = run.statuses[i]
      if (s === 1) signals++
      else if (s === 3) failed++
    }
    Object.assign(batch, { done: L.pos, signals, failed, pamsDone: L.pamsDone, status: run.status })
    subs.forEach((cb) => {
      try {
        cb(batch)
      } catch {
        /* subscriber gone */
      }
    })
  }
}

// ---------------------------------------------------------------------------------------
// Small fixture-backed state
// ---------------------------------------------------------------------------------------
const audit: AuditEntry[] = fx.audit.map((e) => ({ ...e }))
{
  const s = runSummary(runById("R-0012")!)
  const e = audit.find((x) => x.id === "ev14")
  if (e) e.detail = `${s.companies.toLocaleString("en-IN")} companies · ${s.withSignal.toLocaleString("en-IN")} signals · $${s.cost.toFixed(2)}`
}
const imports: ImportRecord[] = fx.imports.map((x) => ({ ...x }))
const schedules = fx.schedules.map((x) => ({ ...x }))
function logAudit(actor: string, role: AuditEntry["role"], action: string, entity: string, detail: string) {
  audit.unshift({ id: `ev${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), actor, role, action, entity, detail, ip: "10.20.1.5" })
}

function scopeIndices(key: string): number[] {
  if (key === "all") return allIdx
  const [kind, value] = key.split(":")
  if (kind === "region") return allIdx.filter((i) => companies[i].region === value)
  if (kind === "segment") return allIdx.filter((i) => companies[i].segment === value)
  if (kind === "pam") return pamCompanies[pamIndex.get(value) ?? -1] ?? []
  return []
}

// ---------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------
const server = {
  async login(username: string, _password: string, role: Role): Promise<User> {
    const found = fx.users.find((u) => u.username === username)
    const user: User = found ? { ...found, role } : { id: "demo", username, name: username, role, active: true, lastLoginAt: new Date().toISOString() }
    if (role === "pam" && !user.pamId) user.pamId = "p1"
    logAudit(username, role, "auth.login", `User ${username}`, "Successful login (demo)")
    return user
  },

  stats() {
    return { companies: N_COMPANIES, pams: N_PAMS, results: runs.reduce((s, r) => s + r.scope.length, 0) }
  },

  // ---- Companies -----------------------------------------------------------------------
  queryCompanies(q: CompanyQuery): CompanyPage {
    const t0 = performance.now()
    const toks = tokens(q.search)
    const scopeP = q.scopePamId ? (pamIndex.get(q.scopePamId) ?? -2) : -1
    const regions = q.regions?.length ? new Set(q.regions) : null
    const segments = q.segments?.length ? new Set(q.segments) : null
    const pamSet = q.pamIds?.length ? new Set(q.pamIds.map((id) => pamIndex.get(id) ?? -2)) : null
    const latestSet = q.latest?.length ? new Set(q.latest) : null
    const latestRun = lastCompleted()
    const facets = { region: {} as Record<string, number>, segment: {} as Record<string, number>, latest: {} as Record<string, number> }
    const hits: number[] = []
    for (let i = 0; i < companies.length; i++) {
      const c = companies[i]
      if (scopeP !== -1 && c.pam !== scopeP) continue
      if (toks.length && !matchAll(c.lower + " " + (c.pam >= 0 ? pamLower[c.pam] : ""), toks)) continue
      if (pamSet && !pamSet.has(c.pam)) continue
      const code = latestRun.statuses[i]
      const latest: LatestStatus = code === 255 ? "none" : CODE[code]
      const mR = !regions || regions.has(c.region)
      const mS = !segments || segments.has(c.segment)
      const mL = !latestSet || latestSet.has(latest)
      // Faceting: each facet counts rows matching every *other* filter.
      if (mS && mL) facets.region[c.region] = (facets.region[c.region] ?? 0) + 1
      if (mR && mL) facets.segment[c.segment] = (facets.segment[c.segment] ?? 0) + 1
      if (mR && mS) facets.latest[latest] = (facets.latest[latest] ?? 0) + 1
      if (mR && mS && mL) hits.push(i)
    }
    const sort = q.sort ?? { id: "name", desc: false }
    const dir = sort.desc ? -1 : 1
    if (sort.id === "signals" || sort.id === "lastSignal") {
      const key = new Float64Array(companies.length)
      for (const i of hits) {
        let n = 0,
          last = 0
        for (const r of runs)
          if (r.statuses[i] === 1) {
            n++
            last = Math.max(last, Date.parse(r.windowEnd))
          }
        key[i] = sort.id === "signals" ? n : last
      }
      hits.sort((a, b) => (key[a] - key[b]) * dir || collator.compare(companies[a].name, companies[b].name))
    } else if (sort.id === "pam") hits.sort((a, b) => collator.compare(pams[companies[a].pam]?.name ?? "", pams[companies[b].pam]?.name ?? "") * dir)
    else if (sort.id === "region") hits.sort((a, b) => collator.compare(companies[a].region, companies[b].region) * dir || collator.compare(companies[a].name, companies[b].name))
    else hits.sort((a, b) => collator.compare(companies[a].name, companies[b].name) * dir)
    const page = paginate(hits, q.page, q.pageSize)
    return { ...page, rows: page.rows.map(companyRow), facets, tookMs: +(performance.now() - t0).toFixed(1) }
  },

  searchCompanies(q: string, limit = 20): CompanyOption[] {
    const toks = tokens(q)
    const out: CompanyOption[] = []
    for (const c of companies) {
      if (toks.length && !matchAll(c.lower, toks)) continue
      out.push({ id: c.id, name: c.name, industry: c.industry })
      if (out.length >= limit) break
    }
    return out
  },

  companyDetail(id: string): CompanyDetail | null {
    const i = companyIndex.get(id)
    if (i === undefined) return null
    const c = companies[i]
    return {
      company: companyRow(i),
      pam: c.pam >= 0 ? pamOption(c.pam) : null,
      cycles: runs
        .filter((r) => r.statuses[i] !== 255 && r.statuses[i] !== 0)
        .map((r) => ({ result: resultOf(r, i), run: { id: r.id, windowStart: r.windowStart, windowEnd: r.windowEnd, templateVersion: r.templateVersion } }))
        .reverse(),
      assignments: assignmentsOf(i).map((a) => ({ ...a, pamName: pams[pamIndex.get(a.pamId) ?? 0].name })),
    }
  },

  reassignCompanies(companyIds: string[], toPamId: string, actor: string) {
    const to = pamIndex.get(toPamId)
    if (to === undefined) throw new Error("Unknown PAM")
    const ts = new Date().toISOString()
    for (const id of companyIds) {
      const i = companyIndex.get(id)
      if (i !== undefined) moveCompany(i, to, "manual", actor, ts)
    }
    rebuildPamIndex()
    logAudit(actor, "admin", "company.reassign", `${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"}`, `Manually reassigned to ${pams[to].name}`)
  },

  // ---- PAMs ----------------------------------------------------------------------------
  searchPams(q: string, opts: { limit?: number; activeOnly?: boolean; excludeId?: string } = {}): PamOption[] {
    const toks = tokens(q)
    const out: PamOption[] = []
    for (let p = 0; p < pams.length; p++) {
      if (opts.activeOnly && !pams[p].active) continue
      if (opts.excludeId && pams[p].id === opts.excludeId) continue
      if (toks.length && !matchAll(pamLower[p], toks)) continue
      out.push(pamOption(p))
      if (out.length >= (opts.limit ?? 20)) break
    }
    return out
  },

  getPams(ids: string[]): PamOption[] {
    return ids.map((id) => pamIndex.get(id)).filter((p): p is number => p !== undefined).map(pamOption)
  },

  queryPams(q: PamQuery): PamPage {
    const t0 = performance.now()
    const toks = tokens(q.search)
    const regions = q.regions?.length ? new Set(q.regions) : null
    const segments = q.segments?.length ? new Set(q.segments) : null
    const statusSet = q.status?.length ? new Set(q.status) : null
    const facets = { region: {} as Record<string, number>, segment: {} as Record<string, number>, status: {} as Record<string, number> }
    const hits: number[] = []
    let activeTotal = 0
    for (let p = 0; p < pams.length; p++) {
      const x = pams[p]
      const st = x.active ? "active" : "inactive"
      if (x.active) activeTotal++
      if (toks.length && !matchAll(pamLower[p], toks)) continue
      const mR = !regions || regions.has(x.region)
      const mS = !segments || segments.has(x.segment)
      const mT = !statusSet || statusSet.has(st)
      // Each facet counts rows matching every *other* filter.
      if (mS && mT) facets.region[x.region] = (facets.region[x.region] ?? 0) + 1
      if (mR && mT) facets.segment[x.segment] = (facets.segment[x.segment] ?? 0) + 1
      if (mR && mS) facets.status[st] = (facets.status[st] ?? 0) + 1
      if (mR && mS && mT) hits.push(p)
    }
    const sort = q.sort ?? { id: "name", desc: false }
    const dir = sort.desc ? -1 : 1
    const byName = (a: number, b: number) => collator.compare(pams[a].name, pams[b].name)
    if (sort.id === "load") hits.sort((a, b) => (pamLoad[a] / pams[a].capacity - pamLoad[b] / pams[b].capacity) * dir || byName(a, b))
    else if (sort.id === "region") hits.sort((a, b) => collator.compare(pams[a].region, pams[b].region) * dir || byName(a, b))
    else if (sort.id === "status") hits.sort((a, b) => (Number(pams[b].active) - Number(pams[a].active)) * dir || byName(a, b))
    else hits.sort((a, b) => byName(a, b) * dir)
    const page = paginate(hits, q.page, q.pageSize)
    return { ...page, rows: page.rows.map((p) => ({ ...pams[p], load: pamLoad[p] })), facets, activeTotal, tookMs: +(performance.now() - t0).toFixed(1) }
  },

  previewRebalance(pamId: string): RebalanceResult & { names: Record<string, string> } {
    const leaving = pamIndex.get(pamId)!
    const load = Int32Array.from(pamLoad)
    const moves: RebalanceResult["moves"] = []
    const names: Record<string, string> = {}
    for (const i of pamCompanies[leaving]) {
      const c = companies[i]
      // Least-loaded active PAM in the same region (prefer same segment), within capacity.
      let best = -1,
        bestScore = Infinity
      for (const p of pamsByRegion[c.region]) {
        if (p === leaving || !pams[p].active || load[p] >= pams[p].capacity) continue
        const score = (pams[p].segment === c.segment ? 0 : 100) + (load[p] / pams[p].capacity) * 10
        if (score < bestScore) {
          bestScore = score
          best = p
        }
      }
      let reason = `Same region (${c.region}), lowest load`
      if (best < 0) {
        for (let p = 0; p < pams.length; p++)
          if (p !== leaving && pams[p].active && (best < 0 || load[p] < load[best])) best = p
        reason = `No capacity in ${c.region}; least-loaded overall`
      }
      load[best]++
      moves.push({ companyId: c.id, fromPamId: pamId, toPamId: pams[best].id, reason })
      names[c.id] = c.name
      names[pams[best].id] = pams[best].name
    }
    return { pamId, moves, names }
  },

  deactivatePam(pamId: string, actor: string): RebalanceResult {
    const plan = server.previewRebalance(pamId)
    const p = pamIndex.get(pamId)!
    pams[p].active = false
    const ts = new Date().toISOString()
    for (const m of plan.moves) moveCompany(companyIndex.get(m.companyId)!, pamIndex.get(m.toPamId)!, "rebalance", actor, ts)
    rebuildPamIndex()
    logAudit(actor, "admin", "pam.deactivate", `PAM ${pams[p].name}`, `Deactivated; ${plan.moves.length} companies auto-rebalanced`)
    return { pamId, moves: plan.moves }
  },

  // ---- Runs & signals --------------------------------------------------------------------
  listRuns(): Run[] {
    return [...runs].reverse().map(runSummary)
  },
  getRun(id: string): Run | null {
    const r = runById(id)
    return r ? runSummary(r) : null
  },

  pamJobs(runId: string, q: { page: number; pageSize: number; search?: string; filter?: "all" | "attention" | "done" | "in_progress" }): Page<PamJobRow> {
    const run = runById(runId)
    if (!run) return { rows: [], total: 0, page: 0, pageSize: q.pageSize }
    const toks = tokens(q.search)
    const rows: PamJobRow[] = []
    pamAggs(run).forEach((a, p) => {
      if (toks.length && !matchAll(pamLower[p], toks)) return
      const j = jobOf(run, p, a)
      const attention = j.email === "failed" || j.status === "partial"
      if (q.filter === "attention" && !attention) return
      if (q.filter === "done" && a.done !== a.total) return
      if (q.filter === "in_progress" && a.done === a.total) return
      rows.push({ ...j, pamName: pams[p].name, region: pams[p].region })
    })
    rows.sort((a, b) => Number(b.email === "failed") - Number(a.email === "failed") || collator.compare(a.pamName, b.pamName))
    return paginate(rows, q.page, q.pageSize)
  },

  querySignals(q: SignalQuery): SignalPage {
    const run = runById(q.runId)
    const counts = { signal: 0, no_signal: 0, failed: 0, pending: 0, all: 0 }
    if (!run) return { rows: [], total: 0, page: 0, pageSize: q.pageSize, counts }
    const toks = tokens(q.search)
    const pamFilter = q.pamId ? (pamIndex.get(q.pamId) ?? -2) : -1
    const hits: number[] = []
    for (const i of run.scope) {
      const c = companies[i]
      if (pamFilter !== -1 && c.pam !== pamFilter) continue
      if (toks.length && !matchAll(c.lower, toks)) continue
      const code = run.statuses[i]
      if (q.category && q.category !== "all" && (code !== 1 || fx.signalPool[run.tpl[i]].category !== q.category)) continue
      counts.all++
      counts[CODE[code] as keyof typeof counts]++
      if (q.status && q.status !== "all" && CODE[code] !== q.status) continue
      hits.push(i)
    }
    // Strongest triggers first, then alphabetical. Weight is cheap; full per-PAM rank is computed for the page only.
    hits.sort(
      (a, b) =>
        (run.statuses[b] === 1 ? CAT_WEIGHT[fx.signalPool[run.tpl[b]].category] : 0) - (run.statuses[a] === 1 ? CAT_WEIGHT[fx.signalPool[run.tpl[a]].category] : 0) ||
        collator.compare(companies[a].name, companies[b].name),
    )
    const page = paginate(hits, q.page, q.pageSize)
    return { ...page, rows: page.rows.map((i) => signalRow(run, i)), counts }
  },

  digest(runId: string, pamId: string): DigestData | null {
    const run = runById(runId)
    const p = pamIndex.get(pamId)
    if (!run || p === undefined) return null
    const mine = pamCompanies[p].filter((i) => run.statuses[i] !== 255)
    const rows = mine.map((i) => signalRow(run, i)).sort((a, b) => (a.priority?.rank ?? 999) - (b.priority?.rank ?? 999) || collator.compare(a.companyName, b.companyName))
    const agg = pamAggs({ ...run, scope: Int32Array.from(mine) }).get(p)
    return { run: runSummary(run), pam: pamOption(p), rows, job: agg ? jobOf(run, p, agg) : null }
  },

  dashboard(pamId?: string): DashboardSummary {
    const run = lastCompleted()
    const summary = runSummary(run)
    const p = pamId ? pamIndex.get(pamId) : undefined
    const scope = p !== undefined ? pamCompanies[p].filter((i) => run.statuses[i] !== 255) : Array.from(run.scope)
    let signals = 0
    const byCat: Record<string, number> = {}
    const top: number[] = []
    for (const i of scope) {
      if (run.statuses[i] !== 1) continue
      signals++
      const cat = fx.signalPool[run.tpl[i]].category
      byCat[cat] = (byCat[cat] ?? 0) + 1
      top.push(i)
    }
    top.sort((a, b) => CAT_WEIGHT[fx.signalPool[run.tpl[b]].category] - CAT_WEIGHT[fx.signalPool[run.tpl[a]].category] || collator.compare(companies[a].name, companies[b].name))
    const topRows = (p !== undefined ? top : top.filter((i) => rankOf(run, i) === 1)).slice(0, 6).map((i) => {
      const t = fx.signalPool[run.tpl[i]]
      return { runId: run.id, pamId: pams[companies[i].pam].id, companyId: companies[i].id, rank: rankOf(run, i) ?? 1, whyNow: t.whyNow, action: t.action, companyName: companies[i].name, category: t.category, pamName: pams[companies[i].pam].name }
    })
    let jobs: PamJobRow[]
    if (p !== undefined) {
      const agg = pamAggs({ ...run, scope: Int32Array.from(scope) }).get(p)
      jobs = agg ? [{ ...jobOf(run, p, agg), pamName: pams[p].name, region: pams[p].region }] : []
    } else jobs = server.pamJobs(run.id, { page: 0, pageSize: 6, filter: "attention" }).rows
    const next = schedules.filter((s) => s.enabled).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0] ?? null
    const jobsForEmail = p !== undefined ? jobs : null
    return {
      latestRun: summary,
      logos: p !== undefined ? pamCompanies[p].length : N_COMPANIES,
      activePams: pams.filter((x) => x.active).length,
      scoped: scope.length,
      signals,
      emailSent: jobsForEmail ? jobsForEmail.filter((j) => j.email === "sent").length : summary.emailSent,
      emailTotal: jobsForEmail ? jobsForEmail.length : summary.pamJobsTotal,
      whatsappSent: jobsForEmail ? jobsForEmail.filter((j) => j.whatsapp === "sent").length : summary.whatsappSent,
      whatsappTotal: jobsForEmail ? jobsForEmail.filter((j) => j.whatsapp !== "skipped").length : summary.whatsappEligible,
      topPriority: topRows,
      byCategory: Object.entries(byCat)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      deliveryAttention: jobs,
      recentRuns: server.listRuns().slice(0, 4),
      nextSchedule: next,
      monthSpend: fx.finops.monthSpend,
      monthBudget: fx.finops.monthBudget,
    }
  },

  scopeOptions(): ScopeOption[] {
    const count = (k: string) => scopeIndices(k).length
    return [
      { key: "all", label: "All active companies", count: N_COMPANIES },
      ...REGIONS.map((r) => ({ key: `region:${r}`, label: `Region = ${r}`, count: count(`region:${r}`) })),
      { key: "segment:Enterprise", label: "Segment = Enterprise", count: count("segment:Enterprise") },
      { key: "pam:p1", label: `PAM = ${pams[0].name}`, count: count("pam:p1") },
    ]
  },

  startRun(input: { label: string; templateId: string; scopeKey: string; actor: string }): Run {
    const n = runs.length + 10
    const run = makeRun(
      {
        id: `R-${String(n).padStart(4, "0")}`,
        label: input.label,
        trigger: "adhoc",
        templateId: input.templateId,
        templateVersion: input.templateId === "t2" ? 1 : 3,
        windowStart: "2026-10-23",
        windowEnd: "2026-11-02",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running",
        triggeredBy: input.actor,
        seed: n,
        scope: scopeIndices(input.scopeKey),
      },
      0,
    )
    runs.push(run)
    logAudit(input.actor, "manager", "run.start", `Run ${run.id}`, `Ad-hoc run queued · ${input.label} · ${run.scope.length.toLocaleString("en-IN")} companies`)
    return runSummary(run)
  },

  /** Grid snapshot for the live view. Statuses travel as a transferable buffer (no copy). */
  liveSnapshot(runId: string): LiveSnapshot | null {
    const run = runById(runId)
    if (!run) return null
    ensureGrid(run)
    const grid = run.grid!
    const statuses = new Uint8Array(grid.length)
    let done = 0,
      signals = 0,
      failed = 0
    grid.forEach((ci, k) => {
      const s = run.statuses[ci]
      statuses[k] = s
      if (s !== 0) done++
      if (s === 1) signals++
      if (s === 3) failed++
    })
    const aggs = pamAggs(run)
    let pamsDone = 0
    aggs.forEach((a) => a.done === a.total && pamsDone++)
    const snap: LiveSnapshot = {
      runId,
      companyIds: Array.from(grid, (ci) => companies[ci].id),
      names: Array.from(grid, (ci) => companies[ci].name),
      pamNames: Array.from(grid, (ci) => pams[companies[ci].pam]?.name ?? ""),
      statuses,
      total: grid.length,
      done,
      signals,
      failed,
      pamsTotal: aggs.size,
      pamsDone,
      startedAt: run.startedAt,
      status: run.status,
    }
    return Comlink.transfer(snap, [statuses.buffer])
  },

  subscribeRun(runId: string, cb: Listener): number {
    const id = nextSub++
    if (!listeners.has(runId)) listeners.set(runId, new Map())
    listeners.get(runId)!.set(id, cb)
    return id
  },
  unsubscribe(id: number) {
    listeners.forEach((m) => m.delete(id))
  },

  resendDigest(runId: string, pamId: string, actor: string) {
    const run = runById(runId)
    const p = pamIndex.get(pamId)
    if (run && p !== undefined) run.emailFailedPam?.delete(p)
    logAudit(actor, "admin", "notify.resend", `Run ${runId} · ${p !== undefined ? pams[p].name : pamId}`, "Digest re-queued via outbox")
  },

  // ---- Small, unpaged resources (tens of rows) ----------------------------------------
  listTemplates: () => fx.templates,
  listSchedules: () => schedules,
  listProviders: () => fx.providers,
  listChannels: () => fx.channels,
  listUsers: () => fx.users,
  listAudit: () => audit.slice(0, 500),
  finops: () => fx.finops,
  listImports: () => imports,
  previewImport: (fileName: string) => ({ ...fx.importPreview, fileName }),
  commitImport(fileName: string): ImportRecord {
    const rec: ImportRecord = { id: `imp${imports.length + 5}`, fileName, uploadedBy: "admin", uploadedAt: new Date().toISOString(), rows: fx.importPreview.rows - 1, status: "committed", summary: "3 new companies · 2 reassignments · 1 alias merged · 1 row rejected" }
    imports.unshift(rec)
    logAudit("admin", "admin", "import.commit", `Import ${rec.id}`, rec.summary)
    return rec
  },
  toggleSchedule(id: string, enabled: boolean, actor: string) {
    const s = schedules.find((x) => x.id === id)
    if (s) s.enabled = enabled
    logAudit(actor, "admin", enabled ? "schedule.enable" : "schedule.disable", `Schedule ${s?.name}`, "")
  },
}

export type MockServer = typeof server
Comlink.expose(server)
