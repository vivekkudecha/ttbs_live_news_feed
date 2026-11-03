import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./client"
import { backend } from "./http"
import type { AiProvider, CompanyQuery, DatasetRowPatch, DeliveryChannel, DatasetRowQuery, PamQuery, ScheduleInput, SignalQuery } from "./types"

/*
 * Data hooks. Rules that keep the UI smooth at 10k+ rows:
 *  - Lists are always server-paged; query keys include every filter, so pages cache independently.
 *  - `placeholderData: keepPreviousData` keeps the current page on screen while the next loads
 *    (no flash, no layout jump).
 *  - Search inputs are debounced by the caller before they reach a query key.
 *  - Always wrap API calls in an arrow (`() => api.x()`): React Query passes its own context as the first argument.
 */

const paged = { placeholderData: keepPreviousData, staleTime: 15_000 } as const

// ---- Companies --------------------------------------------------------------------------
export const useCompanyPage = (q: CompanyQuery) => useQuery({ queryKey: ["companies", q], queryFn: () => api.queryCompanies(q), ...paged })
export const useCompanyDetail = (id: string | null) => useQuery({ queryKey: ["company", id], queryFn: () => api.companyDetail(id!), enabled: !!id })
export const useCompanySearch = (q: string, enabled = true) =>
  useQuery({ queryKey: ["companySearch", q], queryFn: () => api.searchCompanies(q, 20), enabled, ...paged })

// ---- PAMs -------------------------------------------------------------------------------
export const usePamSearch = (q: string, opts: { activeOnly?: boolean; excludeId?: string } = {}, enabled = true) =>
  useQuery({ queryKey: ["pamSearch", q, opts], queryFn: () => api.searchPams(q, { limit: 30, ...opts }), enabled, ...paged })
export const usePamsById = (ids: string[]) =>
  useQuery({ queryKey: ["pamsById", [...ids].sort()], queryFn: () => api.getPams(ids), enabled: ids.length > 0, staleTime: 60_000 })
export const usePamPage = (q: PamQuery) => useQuery({ queryKey: ["pams", q], queryFn: () => api.queryPams(q), ...paged })

// ---- Runs & signals ---------------------------------------------------------------------
export const useRuns = () => useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns(), refetchInterval: 5_000 })
export const useRun = (id: string) => useQuery({ queryKey: ["run", id], queryFn: () => api.getRun(id), refetchInterval: (q) => (q.state.data?.status === "running" ? 2_000 : false) })
export const usePamJobs = (runId: string, q: Parameters<typeof api.pamJobs>[1]) =>
  useQuery({ queryKey: ["pamJobs", runId, q], queryFn: () => api.pamJobs(runId, q), enabled: !!runId, ...paged })
export const useSignalsInfinite = (q: Omit<SignalQuery, "page">) =>
  useInfiniteQuery({
    queryKey: ["signals", q],
    queryFn: ({ pageParam }) => api.querySignals({ ...q, page: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => ((last.page + 1) * last.pageSize < last.total ? last.page + 1 : undefined),
    enabled: !!q.runId,
    placeholderData: keepPreviousData,
  })
export const useDashboard = (pamId?: string) => useQuery({ queryKey: ["dashboard", pamId], queryFn: () => api.dashboard(pamId), refetchInterval: 10_000 })
export const useDigest = (runId: string, pamId: string) =>
  useQuery({ queryKey: ["digest", runId, pamId], queryFn: () => api.digest(runId, pamId), enabled: !!runId && !!pamId, ...paged })
export const useScopeOptions = () =>
  useQuery({ queryKey: ["scopes"], queryFn: () => backend.scopes(), staleTime: 10_000 })

// ---- Small resources --------------------------------------------------------------------
export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() })
export const useSchedules = () => useQuery({ queryKey: ["schedules"], queryFn: () => backend.listSchedules() })
export const useChannels = () => useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() })
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api.listUsers() })
export const useAudit = () => useQuery({ queryKey: ["audit"], queryFn: () => api.listAudit() })
export const useFinops = () => useQuery({ queryKey: ["finops"], queryFn: () => api.finops() })

// ---- Mutations --------------------------------------------------------------------------
function useInvalidate(keys: string[][]) {
  const qc = useQueryClient()
  return () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })))
}

export const useDeactivatePam = () => {
  const inv = useInvalidate([["pams"], ["pamSearch"], ["companies"], ["company"], ["audit"]])
  return useMutation({ mutationFn: (v: { pamId: string; actor: string }) => api.deactivatePam(v.pamId), onSuccess: inv })
}
export const useReassign = () => {
  const inv = useInvalidate([["companies"], ["company"], ["pams"], ["pamSearch"], ["audit"]])
  return useMutation({ mutationFn: (v: { companyIds: string[]; toPamId: string; actor: string }) => api.reassignCompanies(v.companyIds, v.toPamId), onSuccess: inv })
}
export const useStartRun = () => {
  const inv = useInvalidate([["runs"], ["jobs"], ["schedules"], ["audit"]])
  return useMutation({
    mutationFn: (v: { label: string; templateId: string; scopeKey: string; actor?: string; runAt?: string; channels?: DeliveryChannel[] }): Promise<{ id: string }> =>
      backend.startRun({ scopeKey: v.scopeKey, label: v.label, templateId: v.templateId, runAt: v.runAt, channels: v.channels }),
    onSuccess: inv,
  })
}
export const useResend = () => {
  const inv = useInvalidate([["pamJobs"], ["run"], ["dashboard"], ["audit"]])
  return useMutation({ mutationFn: (v: { runId: string; pamId: string; actor: string }) => api.resendDigest(v.runId, v.pamId), onSuccess: inv })
}
export const useToggleSchedule = () => {
  const inv = useInvalidate([["schedules"], ["audit"]])
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean; actor: string }) => backend.updateSchedule(v.id, { enabled: v.enabled }),
    onSuccess: inv,
  })
}

// ---- Jobs, queues, schedules ------------------------------------------------------------------
const ACTIVE = new Set(["scheduled", "queued", "running"])

export const useJobs = (q: { page: number; pageSize: number; status?: string; q?: string }) =>
  useQuery({
    queryKey: ["jobs", q],
    queryFn: () => backend.listJobs(q),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.rows.some((r) => ACTIVE.has(r.status)) ? 3_000 : 15_000),
  })
export const useJob = (id: string) =>
  useQuery({ queryKey: ["job", id], queryFn: () => backend.getJob(id), refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 2_000 : false) })
export const useJobResults = (id: string, q: { page: number; pageSize: number; status?: string; q?: string }, live: boolean) =>
  useQuery({ queryKey: ["jobResults", id, q], queryFn: () => backend.jobResults(id, q), placeholderData: keepPreviousData, refetchInterval: live ? 3_000 : false })
export const useJobNotifications = (id: string, live: boolean) =>
  useQuery({ queryKey: ["jobNotifications", id], queryFn: () => backend.jobNotifications(id), refetchInterval: live ? 3_000 : false })
export const useQueues = () => useQuery({ queryKey: ["queues"], queryFn: () => backend.queues(), refetchInterval: 5_000 })

const useJobInvalidate = () => useInvalidate([["jobs"], ["job"], ["jobResults"], ["jobNotifications"], ["queues"]])
export const useCancelJob = () => useMutation({ mutationFn: (id: string) => backend.cancelJob(id), onSuccess: useJobInvalidate() })
export const useRetryFailed = () => useMutation({ mutationFn: (id: string) => backend.retryFailed(id), onSuccess: useJobInvalidate() })
export const useResendNotification = () => useMutation({ mutationFn: (id: string) => backend.resendNotification(id), onSuccess: useJobInvalidate() })
export const useCreateSchedule = () => {
  const inv = useInvalidate([["schedules"]])
  return useMutation({ mutationFn: (v: ScheduleInput) => backend.createSchedule(v), onSuccess: inv })
}
export const useRunScheduleNow = () => {
  const inv = useInvalidate([["jobs"], ["schedules"]])
  return useMutation({ mutationFn: (id: string) => backend.runScheduleNow(id), onSuccess: inv })
}

// ---- Research AI settings (live backend) ------------------------------------------------
export const useLlmSettings = () => useQuery({ queryKey: ["llmSettings"], queryFn: () => backend.llmSettings() })
/** Mutation (not a query): a typed key must never become part of a cache key. */
export const useLoadLlmModels = () =>
  useMutation({ mutationFn: (v: { provider: AiProvider; apiKey?: string }) => backend.llmModels(v.provider, v.apiKey) })
export const useSaveLlmConfig = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { provider: AiProvider; apiKey?: string; model: string }) => backend.saveLlmConfig(v.provider, { apiKey: v.apiKey, model: v.model }),
    onSuccess: (s) => qc.setQueryData(["llmSettings"], s),
  })
}
export const useActivateLlm = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (p: AiProvider) => backend.activateLlm(p), onSuccess: (s) => qc.setQueryData(["llmSettings"], s) })
}
export const useTestLlmConfig = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (p: AiProvider) => backend.testLlmConfig(p), onSuccess: () => qc.invalidateQueries({ queryKey: ["llmSettings"] }) })
}
export const useRemoveLlmConfig = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (p: AiProvider) => backend.removeLlmConfig(p), onSuccess: () => qc.invalidateQueries({ queryKey: ["llmSettings"] }) })
}
// ---- Datasets ------------------------------------------------------------------------------
const SAVING = new Set(["queued", "processing"])

/** All datasets; polls every 2 s while any is still being saved. */
export const useDatasets = () =>
  useQuery({
    queryKey: ["datasets"],
    queryFn: () => backend.listDatasets(),
    refetchInterval: (q) => (q.state.data?.some((d) => SAVING.has(d.status)) ? 2_000 : false),
  })
/** One dataset; polls every second while it is being saved (progress bar). */
export const useDataset = (id: string | null) =>
  useQuery({
    queryKey: ["dataset", id],
    queryFn: () => backend.getDataset(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && SAVING.has(q.state.data.status) ? 1_000 : false),
  })
export const useDatasetRows = (id: string | null, q: DatasetRowQuery) =>
  useQuery({ queryKey: ["datasetRows", id, q], queryFn: () => backend.datasetRows(id!, q), enabled: !!id, placeholderData: keepPreviousData })

const useDatasetInvalidate = () => useInvalidate([["datasets"], ["dataset"], ["datasetRows"], ["scopes"], ["companies"], ["pams"], ["audit"]])
export const useUploadDataset = () => {
  const inv = useInvalidate([["datasets"], ["audit"]])
  return useMutation({ mutationFn: (v: { file: File; label?: string }) => backend.uploadDataset(v.file, v.label), onSuccess: inv })
}
export const useRenameDataset = () => useMutation({ mutationFn: (v: { id: string; label: string }) => backend.renameDataset(v.id, v.label), onSuccess: useDatasetInvalidate() })
export const useResumeDataset = () => useMutation({ mutationFn: (id: string) => backend.resumeDataset(id), onSuccess: useDatasetInvalidate() })
export const useUpdateDatasetRow = () =>
  useMutation({ mutationFn: (v: { id: string; companyId: string; patch: DatasetRowPatch }) => backend.updateDatasetRow(v.id, v.companyId, v.patch), onSuccess: useDatasetInvalidate() })
export const useDeleteDatasetRows = () =>
  useMutation({ mutationFn: (v: { id: string; companyIds: string[] }) => backend.deleteDatasetRows(v.id, v.companyIds), onSuccess: useDatasetInvalidate() })
