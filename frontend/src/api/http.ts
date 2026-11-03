/**
 * FastAPI backend client (/api/v1). The base URL comes from VITE_API_URL (see .env.development),
 * defaulting to http://localhost:8010.
 */
import type {
  BackendImportPreview,
  ImportRecord,
  Job,
  JobNotification,
  JobResultPage,
  AiProvider,
  LlmModelList,
  LlmSettings,
  Page,
  QueueStats,
  RunPlan,
  Schedule,
  ScheduleInput,
  ScopeOption,
  DeliveryChannel,
} from "./types"

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8010").replace(/\/$/, "")

/** Error with the backend's envelope: {"error": {code, message, details, request_id}}. */
export class ApiError extends Error {
  status: number
  code: string
  details?: unknown
  requestId?: string

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

function actor(): string | undefined {
  try {
    const raw = sessionStorage.getItem("ttbs-session")
    return raw ? (JSON.parse(raw).username as string) : undefined
  } catch {
    return undefined
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!BASE) throw new ApiError(0, "backend_disabled", "Backend is not configured (VITE_API_URL)")
  const headers: Record<string, string> = {}
  const who = actor()
  if (who) headers["X-Actor"] = who
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: payload })
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the backend. Is the API server running?")
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T
  let err: { code?: string; message?: string; details?: unknown; request_id?: string } = {}
  try {
    err = (await res.json()).error ?? {}
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(res.status, err.code ?? "http_error", err.message ?? `Request failed (${res.status})`, err.details, err.request_id)
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ""
}

export const backend = {
  // Imports
  uploadImport: (file: File) => {
    const fd = new FormData()
    fd.append("file", file)
    return request<BackendImportPreview>("POST", "/imports", fd)
  },
  commitImport: (id: string, schedule: RunPlan) => request<{ import: ImportRecord; run: Job | null }>("POST", `/imports/${id}/commit`, { schedule }),
  listImports: () => request<ImportRecord[]>("GET", "/imports"),

  // Runs (jobs)
  scopes: () => request<ScopeOption[]>("GET", "/scopes"),
  startRun: (v: { scopeKey: string; label?: string; templateId?: string; runAt?: string; channels?: DeliveryChannel[]; budgetCap?: number }) =>
    request<Job>("POST", "/runs", v),
  listJobs: (q: { page: number; pageSize: number; status?: string }) => request<Page<Job>>("GET", `/runs${qs(q)}`),
  getJob: (id: string) => request<Job>("GET", `/runs/${id}`),
  jobResults: (id: string, q: { page: number; pageSize: number; status?: string }) => request<JobResultPage>("GET", `/runs/${id}/results${qs(q)}`),
  jobNotifications: (id: string) => request<JobNotification[]>("GET", `/runs/${id}/notifications?pageSize=200`),
  cancelJob: (id: string) => request<Job>("POST", `/runs/${id}/cancel`),
  retryFailed: (id: string) => request<{ requeued: number }>("POST", `/runs/${id}/retry-failed`),
  resendNotification: (id: string) => request<JobNotification>("POST", `/notifications/${id}/resend`),
  queues: () => request<QueueStats>("GET", "/queues"),

  // Schedules
  listSchedules: () => request<Schedule[]>("GET", "/schedules"),
  createSchedule: (v: ScheduleInput) => request<Schedule>("POST", "/schedules", v),
  updateSchedule: (id: string, v: Partial<ScheduleInput>) => request<Schedule>("PATCH", `/schedules/${id}`, v),
  runScheduleNow: (id: string) => request<Job>("POST", `/schedules/${id}/run`),

  // Research AI (provider + key + model; one active at a time). Keys are write-only.
  llmSettings: () => request<LlmSettings>("GET", "/settings/llm"),
  llmModels: (p: AiProvider, apiKey?: string) => request<LlmModelList>("POST", `/settings/llm/${p}/models`, apiKey ? { apiKey } : {}),
  saveLlmConfig: (p: AiProvider, v: { apiKey?: string; model: string }) => request<LlmSettings>("PUT", `/settings/llm/${p}`, v),
  activateLlm: (p: AiProvider) => request<LlmSettings>("POST", `/settings/llm/${p}/activate`),
  testLlmConfig: (p: AiProvider) => request<LlmSettings & { ok: boolean; error: string | null }>("POST", `/settings/llm/${p}/test`),
  removeLlmConfig: (p: AiProvider) => request<void>("DELETE", `/settings/llm/${p}`),
}

/** Message for a toast from any thrown error. */
export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? `${e.message}${e.requestId ? ` (ref ${e.requestId.slice(0, 8)})` : ""}` : e instanceof Error ? e.message : "Something went wrong"
