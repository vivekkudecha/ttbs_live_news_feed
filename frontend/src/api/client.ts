/**
 * The API contract the pages depend on, backed by the FastAPI backend (/api/v1) and its database.
 * Lists are paged, filtered, sorted and joined server-side; the UI only ever holds one page.
 */
import { request } from "./http"
import type {
  Channel,
  CompanyDetail,
  CompanyOption,
  CompanyPage,
  CompanyQuery,
  DashboardSummary,
  DigestData,
  FinOpsReport,
  LiveBatch,
  LiveSnapshot,
  Page,
  PamJobRow,
  PamOption,
  PamPage,
  PamQuery,
  RebalanceResult,
  Run,
  RunStatus,
  SignalCategory,
  SignalPage,
  SignalQuery,
  Template,
  IssuedPassword,
  ManagedUser,
  ModuleInfo,
  PasswordPolicy,
  SessionInfo,
  UserInput,
  UserPatch,
} from "./types"

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ""
}

type LiveSnapshotWire = Omit<LiveSnapshot, "statuses"> & { statuses: number[]; serverTime: string }

export const api = {
  // ---- Session (HttpOnly cookie + CSRF token; see http.ts) ----------------------------------
  login: (username: string, password: string) => request<SessionInfo>("POST", "/auth/login", { username, password }),
  logout: () => request<void>("POST", "/auth/logout"),
  me: () => request<SessionInfo>("GET", "/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<SessionInfo>("POST", "/auth/change-password", { currentPassword, newPassword }),
  passwordPolicy: () => request<PasswordPolicy>("GET", "/auth/password-policy"),
  modules: () => request<ModuleInfo[]>("GET", "/auth/modules"),

  // ---- Users & access (admins only) -------------------------------------------------------
  createUser: (v: UserInput) => request<IssuedPassword>("POST", "/users", v),
  updateUser: (id: string, v: UserPatch) => request<ManagedUser>("PATCH", `/users/${id}`, v),
  resetUserPassword: (id: string) => request<IssuedPassword>("POST", `/users/${id}/reset-password`),
  unlockUser: (id: string) => request<ManagedUser>("POST", `/users/${id}/unlock`),
  revokeUserSessions: (id: string) => request<{ revoked: number }>("POST", `/users/${id}/revoke-sessions`),

  // ---- Companies -------------------------------------------------------------------------
  queryCompanies: (q: CompanyQuery) => request<CompanyPage>("POST", "/companies/query", q),
  searchCompanies: (q: string, limit = 20) => request<CompanyOption[]>("GET", `/companies/search${qs({ q, limit })}`),
  companyDetail: (id: string) => request<CompanyDetail | null>("GET", `/companies/${id}`),
  reassignCompanies: (companyIds: string[], toPamId: string) => request<{ moved: number }>("POST", "/companies/reassign", { companyIds, toPamId }),

  // ---- PAMs ------------------------------------------------------------------------------
  queryPams: (q: PamQuery) => request<PamPage>("POST", "/pams/query", q),
  searchPams: (q: string, opts: { limit?: number; activeOnly?: boolean; excludeId?: string } = {}) =>
    request<PamOption[]>("GET", `/pams/search${qs({ q, limit: opts.limit ?? 20, activeOnly: opts.activeOnly, excludeId: opts.excludeId })}`),
  getPams: (ids: string[]) => request<PamOption[]>("GET", `/pams/by-ids${qs({ ids: ids.join(",") })}`),
  previewRebalance: (pamId: string) => request<RebalanceResult & { names: Record<string, string> }>("GET", `/pams/${pamId}/rebalance-plan`),
  deactivatePam: (pamId: string) => request<RebalanceResult>("POST", `/pams/${pamId}/deactivate`),

  // ---- Runs, signals, digest -------------------------------------------------------------
  dashboard: (pamId?: string) => request<DashboardSummary>("GET", `/dashboard${qs({ pamId })}`),
  listRuns: () => request<Run[]>("GET", "/run-summaries"),
  getRun: (id: string) => request<Run>("GET", `/run-summaries/${id}`),
  pamJobs: (
    runId: string,
    q: { page: number; pageSize: number; search?: string; filter?: "all" | "attention" | "done" | "in_progress"; sort?: string; desc?: boolean; columnFilter?: string },
  ) => request<Page<PamJobRow>>("GET", `/run-summaries/${runId}/pam-jobs${qs({ ...q, desc: q.sort ? String(!!q.desc) : undefined })}`),
  querySignals: (q: SignalQuery) => request<SignalPage>("POST", "/signals/query", q),
  digest: (runId: string, pamId: string) => request<DigestData | null>("GET", `/digest${qs({ runId, pamId })}`),
  resendDigest: (runId: string, pamId: string) => request<{ requeued: number }>("POST", `/run-summaries/${runId}/pams/${pamId}/resend`),
  liveSnapshot: async (runId: string): Promise<LiveSnapshot | null> => {
    const w = await request<LiveSnapshotWire>("GET", `/run-summaries/${runId}/live`)
    return { ...w, statuses: Uint8Array.from(w.statuses) }
  },

  // ---- Small resources --------------------------------------------------------------------
  listTemplates: () => request<Template[]>("GET", "/templates"),
  listChannels: () => request<Channel[]>("GET", "/channels"),
  /** Cost analysis for an IST date range (inclusive, YYYY-MM-DD); default this month. USD. */
  finops: (range: { from?: string; to?: string } = {}) => {
    const p = new URLSearchParams()
    if (range.from) p.set("from", range.from)
    if (range.to) p.set("to", range.to)
    return request<FinOpsReport>("GET", `/finops${p.size ? `?${p}` : ""}`)
  },
}

export type NewsFeedApi = typeof api

// ---- Live run stream ------------------------------------------------------------------------

interface LiveChanges {
  items: { companyId: string; s: 0 | 1 | 2 | 3; category: SignalCategory | null; at: number }[]
  done: number
  signals: number
  failed: number
  pamsDone: number
  ratePerSec: number
  status: RunStatus
  serverTime: string
}

const POLL_MS = 1500
const TERMINAL = new Set<RunStatus>(["completed", "partial", "failed", "cancelled"])

/**
 * Subscribe to a run's live progress. Polls the backend for results finished since the last
 * poll (server clock) and emits LiveBatch events; stops once the run is finished.
 * Returns an unsubscribe function.
 */
export function subscribeRun(runId: string, onBatch: (b: LiveBatch) => void): () => void {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let since: string | undefined
  // Grid bookkeeping to map companies to cells and detect PAMs that just finished.
  let indexOf: Map<string, number> | null = null
  let state: Uint8Array | null = null
  let pamOf: string[] = []
  const remaining = new Map<string, number>()
  const signalsByPam = new Map<string, number>()
  const totalByPam = new Map<string, number>()

  const init = async () => {
    const snap = await request<LiveSnapshotWire>("GET", `/run-summaries/${runId}/live`)
    indexOf = new Map(snap.companyIds.map((id, i) => [id, i]))
    state = Uint8Array.from(snap.statuses)
    pamOf = snap.pamNames
    pamOf.forEach((p, i) => {
      totalByPam.set(p, (totalByPam.get(p) ?? 0) + 1)
      if (state![i] === 0) remaining.set(p, (remaining.get(p) ?? 0) + 1)
      if (state![i] === 1) signalsByPam.set(p, (signalsByPam.get(p) ?? 0) + 1)
    })
    since = snap.serverTime
  }

  const poll = async () => {
    if (closed) return
    try {
      if (!indexOf) await init()
      const ch = await request<LiveChanges>("GET", `/run-summaries/${runId}/live/changes${qs({ since })}`)
      since = ch.serverTime
      const batch: LiveBatch = { runId, items: [], pamsCompleted: [], done: ch.done, signals: ch.signals, failed: ch.failed, pamsDone: ch.pamsDone, ratePerSec: ch.ratePerSec, status: ch.status }
      for (const it of ch.items) {
        const i = indexOf!.get(it.companyId)
        if (i === undefined || it.s === 0 || state![i] === it.s) continue // unknown or already applied
        const pam = pamOf[i]
        if (state![i] === 0) {
          const left = (remaining.get(pam) ?? 1) - 1
          remaining.set(pam, left)
          if (it.s === 1) signalsByPam.set(pam, (signalsByPam.get(pam) ?? 0) + 1)
          if (left === 0) batch.pamsCompleted.push({ pamId: pam, pamName: pam, withSignal: signalsByPam.get(pam) ?? 0, total: totalByPam.get(pam) ?? 0 })
        }
        state![i] = it.s
        batch.items.push({ i, s: it.s, category: it.category ?? undefined, at: it.at })
      }
      if (!closed) onBatch(batch)
      if (TERMINAL.has(ch.status)) return
    } catch {
      /* transient (network / server restart): keep polling */
    }
    if (!closed) timer = setTimeout(poll, POLL_MS)
  }

  timer = setTimeout(poll, 0)
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
  }
}
