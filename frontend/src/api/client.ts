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
  RebalanceResult,
  ResearchResult,
  Role,
  Run,
  Schedule,
  Template,
  User,
} from "./types"
import * as db from "@/mock/data"

/**
 * The single contract the UI depends on (Dependency Inversion).
 * `mockApi` implements it with in-memory fixtures; a FastAPI-backed `httpApi`
 * will implement the same interface later without changing any page.
 */
export interface NewsFeedApi {
  login(username: string, password: string, role: Role): Promise<User>
  listPams(): Promise<Pam[]>
  listCompanies(): Promise<Company[]>
  listAssignments(companyId?: string): Promise<Assignment[]>
  listRuns(): Promise<Run[]>
  getRun(id: string): Promise<Run | undefined>
  listResults(runId: string): Promise<ResearchResult[]>
  companyResults(companyId: string): Promise<ResearchResult[]>
  listAllResults(): Promise<ResearchResult[]>
  listPriority(runId: string, pamId?: string): Promise<PriorityAction[]>
  listTemplates(): Promise<Template[]>
  listSchedules(): Promise<Schedule[]>
  listProviders(): Promise<Provider[]>
  listChannels(): Promise<Channel[]>
  listUsers(): Promise<User[]>
  listAudit(): Promise<AuditEntry[]>
  finops(): Promise<FinOpsSummary>
  listImports(): Promise<ImportRecord[]>
  previewImport(fileName: string): Promise<ImportPreview>
  commitImport(fileName: string): Promise<ImportRecord>
  deactivatePam(pamId: string, actor: string): Promise<RebalanceResult>
  reassignCompanies(companyIds: string[], toPamId: string, actor: string): Promise<void>
  startRun(input: { label: string; templateId: string; scope: string; actor: string }): Promise<Run>
  resendDigest(runId: string, pamId: string, actor: string): Promise<void>
  toggleSchedule(id: string, enabled: boolean, actor: string): Promise<void>
}

const wait = <T,>(value: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(structuredClone(value)), ms))
const nowIso = () => new Date().toISOString()

function logAudit(actor: string, role: AuditEntry["role"], action: string, entity: string, detail: string) {
  db.audit.unshift({ id: `ev${Date.now()}`, ts: nowIso(), actor, role, action, entity, detail, ip: "10.20.1.5" })
}

/**
 * Automatic rebalancing: least-loaded active PAM, preferring same region, then
 * same segment, within capacity. Mirrors the backend algorithm in the plan.
 */
export function planRebalance(pamId: string, pams: Pam[], companies: Company[]): RebalanceResult {
  const leaving = pams.find((p) => p.id === pamId)!
  const load = new Map(pams.map((p) => [p.id, companies.filter((c) => c.pamId === p.id).length]))
  const pool = pams.filter((p) => p.active && p.id !== pamId)
  const moves = companies
    .filter((c) => c.pamId === pamId)
    .map((c) => {
      const score = (p: Pam) =>
        (p.region === c.region ? 0 : 1000) + (p.segment === c.segment ? 0 : 100) + (load.get(p.id)! / p.capacity) * 10
      const target = [...pool].filter((p) => load.get(p.id)! < p.capacity).sort((a, b) => score(a) - score(b))[0] ?? pool[0]
      load.set(target.id, load.get(target.id)! + 1)
      const reason =
        target.region === c.region
          ? `Same region (${c.region}), lowest load`
          : `No capacity in ${c.region}; least-loaded overall`
      return { companyId: c.id, fromPamId: leaving.id, toPamId: target.id, reason }
    })
  return { pamId, moves }
}

export const mockApi: NewsFeedApi = {
  async login(username, _password, role) {
    const found = db.users.find((u) => u.username === username)
    const user: User = found
      ? { ...found, role }
      : { id: "demo", username, name: username, role, active: true, lastLoginAt: nowIso(), pamId: role === "pam" ? "p1" : undefined }
    if (role === "pam" && !user.pamId) user.pamId = "p1"
    logAudit(username, role, "auth.login", `User ${username}`, "Successful login (demo)")
    return wait(user, 500)
  },
  listPams: () => wait(db.pams),
  listCompanies: () => wait(db.companies),
  listAssignments: (companyId) => wait(companyId ? db.assignments.filter((a) => a.companyId === companyId) : db.assignments),
  listRuns: () => wait(db.runs),
  getRun: (id) => wait(db.runs.find((r) => r.id === id)),
  listResults: (runId) => wait(db.results.filter((r) => r.runId === runId)),
  companyResults: (companyId) => wait(db.results.filter((r) => r.companyId === companyId)),
  listAllResults: () => wait(db.results),
  listPriority: (runId, pamId) =>
    wait(db.priorityActions.filter((p) => p.runId === runId && (!pamId || p.pamId === pamId)).sort((a, b) => a.rank - b.rank)),
  listTemplates: () => wait(db.templates),
  listSchedules: () => wait(db.schedules),
  listProviders: () => wait(db.providers),
  listChannels: () => wait(db.channels),
  listUsers: () => wait(db.users),
  listAudit: () => wait(db.audit),
  finops: () => wait(db.finops),
  listImports: () => wait(db.imports),
  previewImport: (fileName) => wait({ ...db.importPreview, fileName }, 900),
  async commitImport(fileName) {
    const rec: ImportRecord = {
      id: `imp${db.imports.length + 5}`,
      fileName,
      uploadedBy: "admin",
      uploadedAt: nowIso(),
      rows: db.importPreview.rows - 1,
      status: "committed",
      summary: "3 new companies · 2 reassignments · 1 alias merged · 1 row rejected",
    }
    db.imports.unshift(rec)
    logAudit("admin", "admin", "import.commit", `Import ${rec.id}`, rec.summary)
    return wait(rec, 700)
  },
  async deactivatePam(pamId, actor) {
    const result = planRebalance(pamId, db.pams, db.companies)
    // Single "transaction": deactivate, close assignments, open new ones.
    const pam = db.pams.find((p) => p.id === pamId)!
    pam.active = false
    const ts = nowIso()
    result.moves.forEach((m) => {
      const company = db.companies.find((c) => c.id === m.companyId)!
      company.pamId = m.toPamId
      const open = db.assignments.find((a) => a.companyId === m.companyId && a.validTo === null)
      if (open) open.validTo = ts
      db.assignments.push({ id: `a${Date.now()}${m.companyId}`, companyId: m.companyId, pamId: m.toPamId, validFrom: ts, validTo: null, reason: "rebalance", actor })
    })
    logAudit(actor, "admin", "pam.deactivate", `PAM ${pam.name}`, `Deactivated; ${result.moves.length} companies auto-rebalanced`)
    return wait(result, 800)
  },
  async reassignCompanies(companyIds, toPamId, actor) {
    // One transaction: close each open assignment and open a manual one for the new PAM.
    const ts = nowIso()
    const pam = db.pams.find((p) => p.id === toPamId)!
    companyIds.forEach((id) => {
      const company = db.companies.find((c) => c.id === id)
      if (!company || company.pamId === toPamId) return
      const open = db.assignments.find((a) => a.companyId === id && a.validTo === null)
      if (open) open.validTo = ts
      db.assignments.push({ id: `a${Date.now()}${id}`, companyId: id, pamId: toPamId, validFrom: ts, validTo: null, reason: "manual", actor })
      company.pamId = toPamId
    })
    logAudit(actor, "admin", "company.reassign", `${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"}`, `Manually reassigned to ${pam.name}`)
    return wait(undefined, 500)
  },
  async startRun({ label, templateId, scope, actor }) {
    const id = `R-00${14 + db.runs.filter((r) => r.trigger === "adhoc").length - 1}`
    const run: Run = {
      ...db.runs[0],
      id,
      label,
      templateId,
      trigger: "adhoc",
      status: "queued",
      startedAt: nowIso(),
      finishedAt: null,
      triggeredBy: actor,
      done: 0,
      withSignal: 0,
      failed: 0,
      cacheHits: 0,
      cost: 0,
      pamJobs: db.runs[0].pamJobs.map((j) => ({ ...j, status: "queued", done: 0, withSignal: 0, email: "pending", whatsapp: "pending" })),
    }
    db.runs.unshift(run)
    logAudit(actor, "manager", "run.start", `Run ${id}`, `Ad-hoc run queued · scope: ${scope}`)
    return wait(run, 600)
  },
  async resendDigest(runId, pamId, actor) {
    const run = db.runs.find((r) => r.id === runId)
    const job = run?.pamJobs.find((j) => j.pamId === pamId)
    if (job) job.email = "sent"
    const pam = db.pams.find((p) => p.id === pamId)
    logAudit(actor, "admin", "notify.resend", `Run ${runId} · ${pam?.name}`, "Digest re-queued via outbox")
    return wait(undefined, 500)
  },
  async toggleSchedule(id, enabled, actor) {
    const s = db.schedules.find((x) => x.id === id)
    if (s) s.enabled = enabled
    logAudit(actor, "admin", enabled ? "schedule.enable" : "schedule.disable", `Schedule ${s?.name}`, "")
    return wait(undefined, 300)
  },
}

export const api: NewsFeedApi = mockApi
