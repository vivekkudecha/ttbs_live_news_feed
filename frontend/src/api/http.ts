/**
 * FastAPI backend client (/api/v1). The base URL comes from VITE_API_URL (see .env.development),
 * defaulting to http://localhost:8010.
 */
import type {
  Dataset,
  DatasetRow,
  DatasetRowPage,
  DatasetRowPatch,
  DatasetRowQuery,
  Job,
  JobNotification,
  JobPage,
  JobResultPage,
  AiProvider,
  LlmModelList,
  LlmSettings,
  ProcessEvent,
  QueueStats,
  RunCosts,
  RunTimeline,
  ScopeOption,
  TelemetrySummary,
  UploadPreview,
  AuditEntry,
  Page,
  DeliveryChannel,
} from "./types"

// VITE_API_URL="/" means same origin: the SPA and the API sit behind one reverse proxy (Docker/nginx).
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8010"
const BASE = (API_URL === "/" ? window.location.origin : API_URL).replace(/\/$/, "")

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
  // Datasets (uploaded Excel). Upload returns at once; rows are saved by a background job.
  uploadDataset: (file: File, label?: string) => {
    const fd = new FormData()
    fd.append("file", file)
    if (label?.trim()) fd.append("label", label.trim())
    return request<Dataset>("POST", "/imports", fd)
  },
  // Big uploads (≤ 1 GB): stageUpload (XHR, with progress) → poll getDataset while "analyzing"
  // → uploadPreview → saveUpload under a name (or discardUpload). The file is sent once.
  uploadPreview: (id: string) => request<UploadPreview>("GET", `/imports/${id}/preview`),
  saveUpload: (id: string, label: string) => request<Dataset>("POST", `/imports/${id}/save`, { label }),
  discardUpload: (id: string) => request<void>("DELETE", `/imports/${id}`),
  listDatasets: () => request<Dataset[]>("GET", "/imports"),
  getDataset: (id: string) => request<Dataset>("GET", `/imports/${id}`),
  renameDataset: (id: string, label: string) => request<Dataset>("PATCH", `/imports/${id}`, { label }),
  resumeDataset: (id: string) => request<Dataset>("POST", `/imports/${id}/resume`),
  datasetRows: (id: string, q: DatasetRowQuery) => request<DatasetRowPage>("GET", `/imports/${id}/rows${qs({ ...q, desc: q.desc ? "true" : undefined })}`),
  updateDatasetRow: (id: string, companyId: string, patch: DatasetRowPatch) => request<DatasetRow>("PATCH", `/imports/${id}/rows/${companyId}`, patch),
  deleteDatasetRows: (id: string, companyIds: string[]) => request<{ removed: number; stoppedTracking: number }>("POST", `/imports/${id}/rows/delete`, { companyIds }),

  // Runs (jobs). Every run researches one saved upload: its logos, for the PAMs it maps them to.
  scopes: () => request<ScopeOption[]>("GET", "/scopes"),
  startRun: (v: { importId: string; label?: string; templateId?: string; runAt?: string; channels?: DeliveryChannel[]; budgetCap?: number }) =>
    request<Job>("POST", "/runs", { ...v, importId: Number(v.importId) }),
  listJobs: (q: { page: number; pageSize: number; status?: string; q?: string }) => request<JobPage>("GET", `/runs${qs(q)}`),
  getJob: (id: string) => request<Job>("GET", `/runs/${id}`),
  jobResults: (id: string, q: { page: number; pageSize: number; status?: string; q?: string }) => request<JobResultPage>("GET", `/runs/${id}/results${qs(q)}`),
  jobNotifications: (id: string) => request<JobNotification[]>("GET", `/runs/${id}/notifications?pageSize=200`),
  cancelJob: (id: string) => request<Job>("POST", `/runs/${id}/cancel`),
  retryFailed: (id: string) => request<{ requeued: number }>("POST", `/runs/${id}/retry-failed`),
  resendNotification: (id: string) => request<JobNotification>("POST", `/notifications/${id}/resend`),
  queues: () => request<QueueStats>("GET", "/queues"),
  // A run end to end: timeline (upload → lifecycle → digests → problems), every event, audit trail, costs.
  runTimeline: (id: string) => request<RunTimeline>("GET", `/runs/${id}/timeline`),
  runEvents: (id: string, q: { page: number; pageSize: number; kind?: string; status?: string }) =>
    request<Page<ProcessEvent>>("GET", `/runs/${id}/events${qs(q)}`),
  runAudit: (id: string, q: { page: number; pageSize: number }) => request<Page<AuditEntry>>("GET", `/runs/${id}/audit${qs(q)}`),
  runCosts: (id: string) => request<RunCosts>("GET", `/runs/${id}/costs`),

  // Telemetry
  telemetrySummary: (hours: number) => request<TelemetrySummary>("GET", `/telemetry/summary?hours=${hours}`),
  telemetryEvents: (q: { page: number; pageSize: number; kind?: string; status?: string; runId?: string; importId?: string; hours?: number }) =>
    request<Page<ProcessEvent>>("GET", `/telemetry/events${qs(q)}`),

  // Research AI (provider + key + model; one active at a time). Keys are write-only.
  llmSettings: () => request<LlmSettings>("GET", "/settings/llm"),
  llmModels: (p: AiProvider, apiKey?: string) => request<LlmModelList>("POST", `/settings/llm/${p}/models`, apiKey ? { apiKey } : {}),
  saveLlmConfig: (p: AiProvider, v: { apiKey?: string; model: string }) => request<LlmSettings>("PUT", `/settings/llm/${p}`, v),
  activateLlm: (p: AiProvider) => request<LlmSettings>("POST", `/settings/llm/${p}/activate`),
  testLlmConfig: (p: AiProvider) => request<LlmSettings & { ok: boolean; error: string | null }>("POST", `/settings/llm/${p}/test`),
  removeLlmConfig: (p: AiProvider) => request<void>("DELETE", `/settings/llm/${p}`),
}

/**
 * Send a file to the server with upload progress (fetch cannot report upload progress).
 * Resolves with the staged upload ("analyzing"); `abort()` cancels the transfer.
 */
export function stageUpload(file: File, onProgress: (sent: number, total: number) => void): { promise: Promise<Dataset>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<Dataset>((resolve, reject) => {
    xhr.open("POST", `${BASE}/api/v1/imports/stage`)
    const who = actor()
    if (who) xhr.setRequestHeader("X-Actor", who)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total)
    xhr.onload = () => {
      let body: { error?: { code?: string; message?: string; details?: unknown; request_id?: string } } & Partial<Dataset> = {}
      try {
        body = JSON.parse(xhr.responseText || "{}")
      } catch {
        /* non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Dataset)
      else {
        const err: { code?: string; message?: string; details?: unknown; request_id?: string } = body.error ?? {}
        reject(new ApiError(xhr.status, err.code ?? "http_error", err.message ?? `Upload failed (${xhr.status})`, err.details, err.request_id))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, "network_error", "The upload was interrupted. Check the connection and try again."))
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled"))
    const fd = new FormData()
    fd.append("file", file)
    xhr.send(fd)
  })
  return { promise, abort: () => xhr.abort() }
}

/** The original uploaded file, as kept on the server. */
export const datasetFileUrl = (id: string) => `${BASE}/api/v1/imports/${id}/file`

/** Download URL for the cost ledger as CSV (opens in Excel). */
export const ledgerCsvUrl = (range: { from?: string; to?: string }) => `${BASE}/api/v1/finops/ledger.csv${qs(range)}`

/** Message for a toast from any thrown error. */
export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? `${e.message}${e.requestId ? ` (ref ${e.requestId.slice(0, 8)})` : ""}` : e instanceof Error ? e.message : "Something went wrong"
