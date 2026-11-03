// Domain contracts shared by the mock client and (later) the FastAPI client.
// Shapes mirror the planned Postgres model so swapping the backend does not touch UI code.

export type Role = "admin" | "manager" | "pam" | "auditor"

export type Segment = "Enterprise" | "Mid-market" | "Emerging"

export interface User {
  id: string
  username: string
  name: string
  role: Role
  active: boolean
  lastLoginAt: string | null
  pamId?: string
}

export interface Pam {
  id: string
  name: string
  email: string
  whatsapp: string
  segment: Segment
  active: boolean
  capacity: number
  notifyEmail: boolean
  notifyWhatsapp: boolean
}

export interface Company {
  id: string
  name: string
  industry: string
  segment: Segment
  active: boolean
  pamId: string | null
}

export type AssignmentReason = "import" | "rebalance" | "manual"

export interface Assignment {
  id: string
  companyId: string
  pamId: string
  validFrom: string
  validTo: string | null
  reason: AssignmentReason
  actor: string
}

export type ResearchStatus = "signal" | "no_signal" | "failed" | "pending"

export interface Source {
  title: string
  url: string
}

export interface ResearchResult {
  id: string
  runId: string
  companyId: string
  pamId: string
  status: ResearchStatus
  category?: SignalCategory
  keySignals?: string
  opportunity?: string
  outreach?: string
  sources: Source[]
  offerings: string[]
  tokensIn: number
  tokensOut: number
  cost: number
  latencyMs: number
  cached: boolean
  error?: string
}

export type SignalCategory =
  | "Expansion"
  | "Funding"
  | "Leadership"
  | "Cybersecurity"
  | "Digital"
  | "Contract"

export interface PriorityAction {
  runId: string
  pamId: string
  companyId: string
  rank: number
  whyNow: string
  action: string
}

export type DeliveryStatus = "sent" | "pending" | "failed" | "skipped"
export type RunStatus = "scheduled" | "queued" | "running" | "completed" | "partial" | "failed" | "cancelled"

export interface PamJob {
  pamId: string
  status: RunStatus
  total: number
  done: number
  withSignal: number
  email: DeliveryStatus
  whatsapp: DeliveryStatus
}

export interface Run {
  id: string
  label: string
  trigger: "scheduled" | "adhoc"
  scheduleId?: string
  templateId: string
  templateVersion: number
  provider: string
  model: string
  windowStart: string
  windowEnd: string
  startedAt: string
  finishedAt: string | null
  status: RunStatus
  triggeredBy: string
  companies: number
  done: number
  withSignal: number
  failed: number
  cacheHits: number
  cost: number
  estimatedCost: number
  /** Per-PAM jobs are paged separately (5,000+ PAMs); these are the roll-ups. */
  pamJobsTotal: number
  pamJobsDone: number
  emailSent: number
  emailFailed: number
  whatsappSent: number
  whatsappEligible: number
  /** Completions per second while running (rolling), for ETA. */
  ratePerSec?: number
}

export interface OutputSection {
  key: string
  label: string
  instruction: string
}

export interface TemplateVersion {
  version: number
  createdAt: string
  createdBy: string
  note: string
  windowDays: number
  model: string
  preset: "fast" | "medium" | "high"
  ttbsContext: string
  researchPrompt: string
  relevanceRules: string
  sections: OutputSection[]
  priorityPrompt: string
  excelColumns: string[]
}

export interface Template {
  id: string
  name: string
  description: string
  activeVersion: number
  versions: TemplateVersion[]
}

export interface Schedule {
  id: string
  name: string
  intervalDays: number
  runAtTime: string
  timezone: string
  nextRunAt: string
  lastRunAt: string | null
  templateId: string
  providerKey: string
  scope: string
  /** Backend only: machine key behind the `scope` label (e.g. "segment:Enterprise"). */
  scopeKey?: string
  enabled: boolean
  budgetCap: number | null
  channels: ("email" | "whatsapp")[]
}

export interface Provider {
  key: string
  name: string
  kind: "llm"
  model: string
  status: "connected" | "not_configured" | "error"
  enabled: boolean
  isDefault: boolean
  rps: number
  priceInPer1k: number
  priceOutPer1k: number
  maskedKey: string | null
  note?: string
}

export interface Channel {
  key: string
  name: string
  type: "email" | "whatsapp"
  adapter: string
  status: "connected" | "not_configured" | "error"
  enabled: boolean
  details: Record<string, string>
}

export interface AuditEntry {
  id: string
  ts: string
  actor: string
  role: Role | "system"
  action: string
  entity: string
  detail: string
  ip: string
}

export interface CostPoint {
  month: string
  llm: number
  messaging: number
}

export interface FinOpsSummary {
  monthBudget: number
  monthSpend: number
  forecast: number
  softLimitPct: number
  costPerSignal: number
  cacheSavings: number
  series: CostPoint[]
  byProvider: { name: string; cost: number }[]
}

export interface ImportRowIssue {
  row: number
  company: string
  field: string
  message: string
  severity: "error" | "warning"
}

export interface ImportPreview {
  fileName: string
  rows: number
  newCompanies: number
  updatedCompanies: number
  newPams: number
  reassignments: number
  duplicatesMerged: number
  issues: ImportRowIssue[]
  sample: { company: string; pam: string; email: string; whatsapp: string; segment?: string | null; change: "new" | "updated" | "reassigned" | "unchanged" }[]
}

export interface ImportRecord {
  id: string
  fileName: string
  uploadedBy: string
  uploadedAt: string
  rows: number
  status: "committed" | "previewed" | "failed"
  summary: string
}

export interface RebalanceMove {
  companyId: string
  fromPamId: string
  toPamId: string
  reason: string
}

export interface RebalanceResult {
  pamId: string
  moves: RebalanceMove[]
}

// ---------------------------------------------------------------------------
// Scale contracts: everything list-shaped is paged, filtered, sorted and joined
// on the server. The UI never receives or scans the full 10k / 5k datasets.
// ---------------------------------------------------------------------------

export interface Page<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export type SortDir = { id: string; desc: boolean }
export type LatestStatus = ResearchStatus | "none"

export interface CompanyQuery {
  page: number
  pageSize: number
  search?: string
  segments?: string[]
  pamIds?: string[]
  latest?: LatestStatus[]
  sort?: SortDir
  /** Row-level scope: a PAM only ever receives their own logos. */
  scopePamId?: string
}

export interface CompanyListRow {
  id: string
  name: string
  industry: string
  segment: Segment
  pamId: string | null
  pamName: string
  latestStatus: LatestStatus
  latestCategory?: SignalCategory
  signals: number
  lastSignal: string | null
  cycles: { runId: string; status: ResearchStatus }[]
}

export interface CompanyPage extends Page<CompanyListRow> {
  facets: { segment: Record<string, number>; latest: Record<string, number> }
  tookMs: number
}

export interface PamOption {
  id: string
  name: string
  email: string
  segment: Segment
  active: boolean
  load: number
  capacity: number
}

export interface PamCard extends Pam {
  load: number
}

export interface CompanyOption {
  id: string
  name: string
  industry: string
}

export interface RunMeta {
  id: string
  windowStart: string
  windowEnd: string
  templateVersion: number
}

export interface CompanyDetail {
  company: CompanyListRow
  pam: PamOption | null
  cycles: { result: ResearchResult; run: RunMeta }[]
  assignments: (Assignment & { pamName: string })[]
}

export interface SignalRow extends ResearchResult {
  companyName: string
  industry: string
  pamName: string
  priority?: { rank: number; whyNow: string; action: string }
}

export interface SignalQuery {
  runId: string
  page: number
  pageSize: number
  status?: ResearchStatus | "all"
  category?: string
  pamId?: string
  search?: string
}

export interface SignalPage extends Page<SignalRow> {
  counts: { signal: number; no_signal: number; failed: number; pending: number; all: number }
}

export interface PamJobRow extends PamJob {
  pamName: string
}

export interface DashboardSummary {
  latestRun: Run
  logos: number
  activePams: number
  scoped: number
  signals: number
  emailSent: number
  emailTotal: number
  whatsappSent: number
  whatsappTotal: number
  topPriority: (PriorityAction & { companyName: string; category?: SignalCategory; pamName: string })[]
  byCategory: { category: string; count: number }[]
  deliveryAttention: PamJobRow[]
  recentRuns: Run[]
  nextSchedule: Schedule | null
  monthSpend: number
  monthBudget: number
}

export interface DigestData {
  run: Run
  pam: PamOption
  rows: SignalRow[]
  job: PamJob | null
}

/** Live research stream (SSE in production, Worker messages in the mock). */
export interface LiveSnapshot {
  runId: string
  /** Grid order: grouped by PAM so each PAM's logos sit together. */
  companyIds: string[]
  names: string[]
  pamNames: string[]
  /** 0 pending · 1 signal · 2 no signal · 3 failed */
  statuses: Uint8Array
  total: number
  done: number
  signals: number
  failed: number
  pamsTotal: number
  pamsDone: number
  startedAt: string
  status: RunStatus
}

export interface LiveItem {
  /** Index into the snapshot grid. */
  i: number
  s: 1 | 2 | 3
  category?: SignalCategory
  at: number
}

export interface LiveBatch {
  runId: string
  items: LiveItem[]
  pamsCompleted: { pamId: string; pamName: string; withSignal: number; total: number }[]
  done: number
  signals: number
  failed: number
  pamsDone: number
  ratePerSec: number
  status: RunStatus
}

export interface ScopeOption {
  key: string
  label: string
  count: number
}

export interface PamQuery {
  page: number
  pageSize: number
  search?: string
  segments?: string[]
  status?: ("active" | "inactive")[]
  sort?: SortDir
}

export interface PamPage extends Page<PamCard> {
  facets: { segment: Record<string, number>; status: Record<string, number> }
  activeTotal: number
  tookMs: number
}

// ---------------------------------------------------------------------------
// FastAPI backend contracts (/api/v1). Used when VITE_API_URL is set.
// ---------------------------------------------------------------------------

export type DeliveryChannel = "email" | "whatsapp"

/** How research is scheduled after an import commit. */
export interface RunPlan {
  mode: "none" | "now" | "at"
  runAt?: string
  channels: DeliveryChannel[]
}

export interface BackendImportPreview extends ImportPreview {
  id: string
  validRows: number
  errorRows: number
}

export interface Job {
  id: string
  label: string
  trigger: "adhoc" | "scheduled" | "import"
  scheduleId: string | null
  importId: string | null
  scopeKey: string
  templateId: string
  channels: DeliveryChannel[]
  provider: string
  model: string
  status: RunStatus
  scheduledFor: string | null
  startedAt: string | null
  finishedAt: string | null
  windowStart: string | null
  windowEnd: string | null
  triggeredBy: string
  companies: number
  done: number
  withSignal: number
  failed: number
  cacheHits: number
  cost: number
  estimatedCost: number
  budgetCap: number | null
  error: string | null
  notifications: { pending: number; sent: number; failed: number; skipped: number }
}

export interface JobResult {
  id: string
  runId: string
  companyId: string
  companyName: string
  pamId: string | null
  status: ResearchStatus | "running"
  category: SignalCategory | null
  keySignals: string | null
  opportunity: string | null
  outreach: string | null
  sources: Source[]
  tokensIn: number
  tokensOut: number
  cost: number
  latencyMs: number
  cached: boolean
  attempts: number
  error: string | null
  finishedAt: string | null
}

export interface JobResultPage extends Page<JobResult> {
  counts: Partial<Record<JobResult["status"], number>>
}

export interface JobNotification {
  id: string
  runId: string
  pamId: string
  pamName: string | null
  channel: DeliveryChannel
  recipient: string | null
  status: "pending" | "sending" | "sent" | "failed" | "skipped"
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
  sentAt: string | null
  subject: string | null
}

export interface ScheduleInput {
  name: string
  intervalDays: number
  runAtTime: string
  scopeKey: string
  channels: DeliveryChannel[]
  budgetCap?: number | null
  enabled?: boolean
}

export interface QueueStats {
  broker: { research: number | null; notify: number | null; maintenance: number | null }
  db: { runsActive: number; researchPending: number; researchRunning: number; notificationsPending: number }
}

// ---- Research AI settings (live backend) ----------------------------------------------------
export type AiProvider = "perplexity" | "gemini"

/** One saved AI provider. The API key itself is never returned, only `keyHint`. */
export interface LlmConfig {
  provider: AiProvider
  label: string
  configured: boolean
  active: boolean // exactly one provider is active; research runs use it
  keyHint: string | null
  model: string | null
  modelProvider: string | null
  verifiedAt: string | null
  lastCheckOk: boolean | null
  lastCheckError: string | null
  lastCheckLatencyMs: number | null
  updatedAt: string | null
  updatedBy: string | null
}

export interface LlmSettings {
  mode: "perplexity" | "fake" // server LLM_PROVIDER: "fake" = offline dev mode
  active: AiProvider | null
  providers: LlmConfig[]
}

export interface LlmModel {
  id: string // "anthropic/claude-sonnet-5" | "gemini-3.6-flash"
  provider: string // model owner, e.g. "anthropic", "google"
  name: string
}

export interface LlmModelList {
  models: LlmModel[]
  providers: { key: string; count: number }[]
}