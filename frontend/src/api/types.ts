// Domain contracts shared by the mock client and (later) the FastAPI client.
// Shapes mirror the planned Postgres model so swapping the backend does not touch UI code.

export type Role = "admin" | "manager" | "pam" | "auditor"

export type Region = "North" | "South" | "East" | "West"
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
  region: Region
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
  region: Region
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
export type RunStatus = "queued" | "running" | "completed" | "partial" | "failed"

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
  pamJobs: PamJob[]
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
  enabled: boolean
  budgetCap: number
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
  sample: { company: string; pam: string; email: string; whatsapp: string; region: string; change: "new" | "updated" | "reassigned" | "unchanged" }[]
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
