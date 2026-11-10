// Domain contracts shared with the FastAPI backend (/api/v1); shapes match backend/app/api/read_models.py.

export type Segment = "Enterprise" | "Mid-market" | "Emerging"

// ---- Identity & access (backend/app/services/auth.py) -------------------------------------
export type Role = "admin" | "member"
export type PermLevel = "view" | "manage"
/** Module keys (backend/app/core/permissions.py MODULES). */
export type ModuleKey =
  | "dashboard"
  | "signals"
  | "runs"
  | "companies"
  | "pams"
  | "imports"
  | "integrations"
  | "costs"
  | "telemetry"
  | "audit"

export interface User {
  id: string
  username: string
  name: string
  email: string | null
  role: Role
  /** Effective access: admins get "manage" on every module. */
  permissions: Partial<Record<ModuleKey, PermLevel>>
  /** First sign-in, admin reset or expired: nothing works until the password is changed. */
  mustChangePassword: boolean
  passwordExpiresAt: string | null
  lastLoginAt: string | null
}

export interface SessionInfo {
  user: User
  csrfToken: string
  expiresAt: string
  idleMinutes: number
}

export interface PasswordPolicy {
  minLength: number
  maxLength: number
  requireUpper: boolean
  requireLower: boolean
  requireDigit: boolean
  requireSymbol: boolean
  historyCount: number
  maxAgeDays: number
}

export interface ModuleInfo {
  key: ModuleKey
  label: string
  description: string
}

/** A user as an admin sees them (Users & access). */
export interface ManagedUser extends User {
  active: boolean
  locked: boolean
  lockedUntil: string | null
  failedLoginCount: number
  /** What an admin granted (members); `permissions` is the effective set. */
  grantedPermissions: Partial<Record<ModuleKey, PermLevel>>
  passwordChangedAt: string | null
  createdAt: string | null
  createdBy: string
}

export interface UserInput {
  username: string
  name: string
  email?: string | null
  role: Role
  permissions: Partial<Record<ModuleKey, PermLevel>>
}

export interface UserPatch {
  name?: string
  email?: string | null
  role?: Role
  permissions?: Partial<Record<ModuleKey, PermLevel>>
  active?: boolean
}

/** Returned once when an admin creates a user or resets a password. */
export interface IssuedPassword {
  user: ManagedUser
  temporaryPassword: string
}

export interface Pam {
  id: string
  name: string
  email: string
  whatsapp: string
  /** Majority segment of the PAM's companies (null when they own none). */
  segment: Segment | null
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

/** How a run was started. "upload": first run of an upload; "rerun": an earlier upload run again.
 *  "scheduled" / "adhoc" / "import" only appear on runs from before every run started from an upload. */
export type RunTrigger = "upload" | "rerun" | "scheduled" | "adhoc" | "import"

export interface Run {
  id: string
  label: string
  trigger: RunTrigger
  scheduleId?: string
  importId?: string | null
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
  action: string
  entity: string
  detail: string
  ip: string
  requestId?: string | null
}

// ---- FinOps (USD; every figure comes from the cost ledger) ---------------------------------------
/** One cost cut: spend split, volume and unit economics. */
export interface CostRow {
  llm: number
  messaging: number
  total: number
  /** Paid LLM calls (cache misses). */
  calls: number
  cacheHits: number
  /** Estimated USD avoided by cache hits. */
  saved: number
  tokensIn: number
  tokensOut: number
  signals: number
  messages: number
  costPerCompany: number | null
  costPerSignal: number | null
  cacheRate: number
}

export interface FinOpsReport {
  currency: "USD"
  from: string
  to: string
  totals: CostRow & { failedCost: number; failedCalls: number }
  budget: { monthly: number; monthSpend: number; forecast: number; softLimitPct: number; hardCap: boolean; usedPct: number }
  prices: { emailPerMessage: number; whatsappPerMessage: number }
  series: { date: string; llm: number; messaging: number; saved: number }[]
  byRun: (CostRow & { id: string; label: string; status: RunStatus | null; importId: string | null; startedAt: string | null; companies: number | null })[]
  byUpload: (CostRow & { id: string; label: string; fileName: string | null })[]
  byPam: (CostRow & { id: string; name: string; email: string | null })[]
  topCompanies: (CostRow & { id: string; name: string })[]
  byModel: (CostRow & { category: "llm" | "messaging"; provider: string; model: string | null })[]
}

export interface RunCosts {
  totals: CostRow
  byPam: (CostRow & { id: string; name: string })[]
}

// ---- Telemetry (process events) ------------------------------------------------------------------
export type EventStatus = "ok" | "retry" | "error" | "skipped" | "info"

export interface ProcessEvent {
  id: string
  ts: string
  /** "dataset.upload" | "dataset.chunk" | "run.start" | "research.attempt" | "notify.attempt" | … */
  kind: string
  status: EventStatus
  message: string | null
  runId: string | null
  importId: string | null
  companyId: string | null
  pamId: string | null
  notificationId: string | null
  attempt: number | null
  durationMs: number | null
  provider: string | null
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  cost: number | null
  actor: string | null
  requestId: string | null
  traceId: string | null
  attrs: Record<string, unknown>
}

export interface RunTimeline {
  events: ProcessEvent[]
  throughput: { minute: string; ok: number; error: number; retry: number; cached: number }[]
  research: { attempts: number; retries: number; errors: number; avgLatencyMs: number | null; maxLatencyMs: number | null }
}

export interface TelemetrySummary {
  hours: number
  total: number
  errors: number
  retries: number
  errorRate: number
  research: { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; samples: number }
  byKind: { kind: string; total: number; ok: number; retry: number; error: number; skipped: number; avgMs: number | null }[]
  hourly: { hour: string; ok: number; problem: number }[]
  tracing: boolean
}

export interface ImportRowIssue {
  row: number
  company: string
  field: string
  message: string
  severity: "error" | "warning"
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
  segment: Segment | null
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
  segment: Segment | null
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
  /** Latest finished run (or the latest run); null before the first run. */
  latestRun: Run | null
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
  /** The next upload set to run at a later time, if any. */
  nextRun: { id: string; label: string; scheduledFor: string; companies: number; importId: string | null } | null
  monthSpend: number
  monthBudget: number
}

export interface DigestData {
  run: Run
  pam: PamOption
  rows: SignalRow[]
  job: PamJob | null
}

/** Live research stream (polled from /run-summaries/{id}/live). */
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

/** A saved upload a run can use ("import:<id>"), with how often it has been run. */
export interface ScopeOption {
  key: string
  label: string
  count: number
  runs: number
  lastRunAt: string | null
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

export interface Job {
  id: string
  label: string
  trigger: RunTrigger
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
  pamName: string | null
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
/** Runs list page with per-group counts for the status tabs. */
export interface JobPage extends Page<Job> {
  groups: { all: number; active: number; finished: number; attention: number }
}

// ---- Uploaded datasets (Excel → saved in the background, resumable) -------------------------------
/** analyzing → previewed (checked, not saved) → queued → processing → completed | failed; or discarded. */
export type DatasetStatus = "analyzing" | "previewed" | "discarded" | "queued" | "processing" | "completed" | "failed"

export interface Dataset {
  id: string
  label: string
  /** "Nov logos · 03 Nov 2026, 14:20" (IST) */
  displayLabel: string
  fileName: string
  uploadedBy: string
  uploadedAt: string
  status: DatasetStatus
  rowsTotal: number
  validRows: number
  errorRows: number
  /** Valid rows saved so far (the resumable cursor). */
  saved: number
  progress: number
  companies: number | null
  newCompanies: number
  updatedCompanies: number
  reassignments: number
  newPams: number
  duplicatesMerged: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  summary: string
  /** The original file is kept on the server (download from the Uploads page). */
  hasFile?: boolean
  /** While analyzing: rows read so far; progress is the share of the file read (null if unknown). */
  rowsRead?: number
  sizeBytes?: number | null
  /** Rows whose logo and PAM were already known and unchanged (de-duplicated, not re-created). */
  unchanged: number
  /** Research runs of this upload, the latest one, and their total cost (USD). Lists only. */
  runs: number
  lastRunAt: string | null
  researchCost: number
  issues?: ImportRowIssue[]
}

/** A file checked before saving: nothing is written until the user saves it under a name. */
export interface UploadPreview {
  id: string
  status: DatasetStatus
  fileName: string
  sizeBytes: number
  rowsTotal: number
  validRows: number
  errorRows: number
  duplicatesMerged: number
  newCompanies: number
  updatedCompanies: number
  reassignments: number
  unchanged: number
  newPams: number
  pams: number
  issues: ImportRowIssue[]
  /** First rows (up to 200), with what saving would do to each logo. */
  rows: {
    row: number
    company: string
    industry: string | null
    segment: Segment | null
    pamName: string
    pamEmail: string
    pamWhatsapp: string
    change: "new" | "updated" | "reassigned" | "unchanged"
    currentPam: string | null
  }[]
  rowsShown: number
}

export interface DatasetRow {
  companyId: string
  rowNo: number
  company: string
  industry: string
  segment: Segment | null
  active: boolean
  pamId: string | null
  pamName: string
  pamEmail: string
  pamWhatsapp: string
}

export interface DatasetRowPage extends Page<DatasetRow> {
  facets: { segment: Record<string, number>; pams: { id: string; name: string; count: number }[] }
}

export interface DatasetRowQuery {
  page: number
  pageSize: number
  q?: string
  segment?: string
  pamId?: string
  sort?: "company" | "pam" | "segment" | "industry" | "row"
  desc?: boolean
}

/** Only the fields sent change; edits update the real company / PAM records. */
export type DatasetRowPatch = Partial<Pick<DatasetRow, "company" | "industry" | "pamName" | "pamEmail" | "pamWhatsapp">> & { segment?: string | null }

// ---- Email delivery (Microsoft Graph, app-to-app) ---------------------------------------------------
export interface EmailLimits {
  perMinute: number
  perHour: number
  perDay: number
  safetyMarginPct: number
  /** Limits actually enforced (configured minus the safety margin). */
  effective: { perMinute: number; perHour: number; perDay: number }
}

export interface EmailPolicy {
  maxAttempts: number
  backoffBaseS: number
  backoffCapS: number
  sendWhenNoSignals: boolean
}

export interface EmailConnection {
  tenantId: string
  clientId: string
  secretHint: string
  senderAddress: string
  senderName: string | null
  replyTo: string | null
  saveToSent: boolean
}

/** console = nothing saved (dev: logged, not sent); disabled = saved but switched off (emails wait). */
export type EmailMode = "console" | "disabled" | "paused" | "active"

export interface EmailQuota {
  mode: EmailMode
  pausedUntil: string | null
  pauseReason: string | null
  limits: { configured: { minute: number; hour: number; day: number }; effective: { minute: number; hour: number; day: number }; safetyMarginPct: number }
  /** Rolling windows: this minute, the last 60 minutes, the last 24 hours. */
  used: { minute: number; hour: number; day: number }
  capacityNow: number
  backlog: { pending: number; due: number; reserved: number; sending: number; oldestQueuedAt: string | null }
  nextFreeAt: string | null
  drainEta: string | null
  beyondHorizon: number
  hourly: { hour: string; sent: number }[]
  now: string
}

export interface EmailSettings {
  configured: boolean
  enabled: boolean
  pausedUntil?: string | null
  pauseReason?: string | null
  connection: EmailConnection | null
  check?: { verifiedAt: string | null; ok: boolean; error: string | null; latencyMs: number | null }
  limits: EmailLimits
  policy: EmailPolicy
  updatedAt?: string | null
  updatedBy?: string | null
  quota: EmailQuota
}

export interface EmailConnectionInput {
  tenantId: string
  clientId: string
  clientSecret?: string
  senderAddress: string
  senderName?: string
  replyTo?: string
  saveToSent: boolean
  enabled?: boolean
}

export type AiOnFailure = "send_without" | "hold"

export interface EmailTemplateInput {
  name: string
  description?: string | null
  subjectTpl: string
  htmlTpl: string
  textTpl: string
  aiEnabled: boolean
  aiPrompt?: string | null
  aiMaxWords: number
  aiOnFailure: AiOnFailure
  note?: string
}

export interface EmailTemplate extends EmailTemplateInput {
  id: string
  active: boolean
  version: number
  updatedAt: string | null
  updatedBy: string
}

export interface EmailTemplateVersion {
  version: number
  note: string | null
  createdAt: string | null
  createdBy: string
  subjectTpl: string | null
  aiEnabled: boolean | null
}

export interface EmailPreview {
  subject: string
  html: string
  text: string
  aiSummary: string
  aiError: string | null
  ai: { provider: string; model: string; tokensIn: number; tokensOut: number; cost: number; latencyMs: number } | null
  sample: boolean
}

export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "skipped"

export interface OutboxRow extends Omit<JobNotification, "status"> {
  status: OutboxStatus
  createdAt: string | null
  reservedAt: string | null
  templateVersion: number | null
}

export interface OutboxPage extends Page<OutboxRow> {
  counts: Partial<Record<OutboxStatus, number>>
}

export interface DeliveryAttempt {
  attempt: number
  startedAt: string | null
  durationMs: number
  outcome: "sent" | "retry" | "failed"
  adapter: string | null
  httpStatus: number | null
  errorCode: string | null
  error: string | null
  retryable: boolean | null
  providerRequestId: string | null
}

export interface NotificationDetail extends OutboxRow {
  history: DeliveryAttempt[]
  rendered: { subject: string | null; html: string | null; text: string | null; aiSummary: string | null; aiError: string | null } | null
  body: string | null
}

export type DeadLetterStatus = "open" | "requeued" | "discarded"

export interface DeadLetter {
  id: string
  notificationId: string
  runId: string | null
  pamId: string | null
  channel: DeliveryChannel
  recipient: string | null
  subject: string | null
  reason: "permanent" | "exhausted"
  attempts: number
  lastError: string | null
  status: DeadLetterStatus
  createdAt: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  resolutionNote: string | null
  history: { attempt: number; at: string | null; outcome: string; httpStatus: number | null; errorCode: string | null; error: string }[]
}

export interface DeadLetterPage extends Page<DeadLetter> {
  counts: Partial<Record<DeadLetterStatus, number>>
}

export interface EmailEstimate {
  emails: number
  queuedAhead: number
  remainingToday: number
  perDay: number
  drainEta: string | null
}

// ---- Research prompt (editable, versioned, one active) ----------------------------------------
export interface ResearchPromptInput {
  systemInstruction: string
  researchPrompt: string
  ttbsContext: string
  outputRules: string
  categories: string[]
  windowDays: number
  note?: string
}

export interface ResearchPromptVersionSummary {
  version: number
  active: boolean
  note: string | null
  createdAt: string
  createdBy: string
  activatedAt: string | null
  activatedBy: string | null
  windowDays: number
  categories: string[]
}

export type ResearchPromptVersion = ResearchPromptVersionSummary & Omit<ResearchPromptInput, "note">

export interface ResearchPromptState {
  active: ResearchPromptVersion
  versions: ResearchPromptVersionSummary[]
  placeholders: { key: string; description: string; required: boolean }[]
  requiredLabels: string[]
  limits: { windowDays: [number, number]; maxCategories: number }
  defaults: Omit<ResearchPromptInput, "note">
}

export interface ResearchPromptPreview {
  system: string
  prompt: string
  windowStart: string
  windowEnd: string
  characters: number
  approxTokens: number
}

// ---- Run results board (one table: logos, PAM groups, digests, timelines) ------------------------

export type BoardDigestStatus = "pending" | "sending" | "sent" | "failed" | "skipped"

export interface BoardDigest {
  id: string
  status: BoardDigestStatus
  recipient: string | null
  attempts: number
  lastError: string | null
  sentAt: string | null
  /** Signals in the digest as built (may be stale, see `outdated`). */
  signals: number | null
  /** Built before a retry changed this PAM's signals: resend to bring it up to date. */
  outdated: boolean
}

export interface BoardPam {
  kind: "pam"
  id: string
  pamId: string | null
  pamName: string
  pamEmail: string | null
  /** Counts over the logos matching the current filters. */
  logos: number
  signal: number
  noSignal: number
  failed: number
  pending: number
  finishedAt: string | null
  /** The PAM's whole share of the run. */
  totalAll: number
  doneAll: number
  signalAll: number
  digests: Partial<Record<DeliveryChannel, BoardDigest>>
}

export interface BoardLogo {
  kind: "logo"
  id: string
  companyId: string
  companyName: string
  industry: string | null
  segment: string | null
  pamId: string | null
  pamName: string | null
  status: ResearchStatus | "running"
  category: string | null
  keySignals: string | null
  opportunity: string | null
  outreach: string | null
  sources: Source[]
  attempts: number
  cached: boolean
  error: string | null
  finishedAt: string | null
  /** The PAM's email digest status for this run ("none" before it is queued). */
  digest: BoardDigestStatus | "none"
}

export interface BoardFacetOption {
  value: string
  label?: string
  count: number
}

export interface BoardFacets {
  status: Partial<Record<"signal" | "no_signal" | "failed" | "pending", number>>
  all: number
  categories: BoardFacetOption[]
  pams: BoardFacetOption[]
  digest: BoardFacetOption[]
}

export interface LogoTimeline {
  logo: BoardLogo & { enqueuedAt: string | null; startedAt: string | null; latencyMs: number | null }
  run: { id: string; label: string; status: RunStatus; windowStart: string | null; windowEnd: string | null }
  events: ProcessEvent[]
  digests: { id: string; channel: DeliveryChannel; status: BoardDigestStatus; sentAt: string | null; recipient: string | null; lastError: string | null; includesLogo: boolean; signals: number | null }[]
  history: { runId: string; label: string; windowEnd: string | null; status: ResearchStatus | "running"; category: string | null; finishedAt: string | null }[]
}

export interface DigestRender {
  subject: string
  html: string
  text: string
  asSent: boolean
  sentAt: string | null
  status: BoardDigestStatus | "none"
  recipient: string | null
}
