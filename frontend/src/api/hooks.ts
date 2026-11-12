import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./client"
import { backend } from "./http"
import type {
  AiProvider,
  CompanyQuery,
  DatasetRowPatch,
  DeadLetterStatus,
  DeliveryChannel,
  DatasetRowQuery,
  EmailConnectionInput,
  EmailPolicy,
  EmailSettings,
  EmailTemplateInput,
  ResearchPromptInput,
  PamPatch,
  PamQuery,
  UserInput,
  UserPatch,
} from "./types"

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
export const useUpdatePam = () => {
  // PAM names and emails also show on Companies, pickers, run boards, digests and the logo drawer.
  const inv = useInvalidate([["pams"], ["pamSearch"], ["pamsById"], ["companies"], ["company"], ["board"], ["logoTimeline"], ["pamDigest"], ["audit"]])
  return useMutation({ mutationFn: (v: { id: string; patch: PamPatch }) => api.updatePam(v.id, v.patch), onSuccess: inv })
}

// ---- Runs & signals ---------------------------------------------------------------------
export const useRuns = () => useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns(), refetchInterval: 5_000 })
export const useRun = (id: string) => useQuery({ queryKey: ["run", id], queryFn: () => api.getRun(id), refetchInterval: (q) => (q.state.data?.status === "running" ? 2_000 : false) })
export const useDashboard = (pamId?: string) => useQuery({ queryKey: ["dashboard", pamId], queryFn: () => api.dashboard(pamId), refetchInterval: 10_000 })
export const useScopeOptions = () =>
  useQuery({ queryKey: ["scopes"], queryFn: () => backend.scopes(), staleTime: 10_000 })

// ---- Small resources --------------------------------------------------------------------
/** Reference data changes rarely (and mutations invalidate it): fresh for 5 minutes. */
const REFERENCE = 5 * 60_000
export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates(), staleTime: REFERENCE })
export const useChannels = () => useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels(), staleTime: REFERENCE })
export const useFinops = (range: { from?: string; to?: string } = {}) =>
  useQuery({ queryKey: ["finops", range], queryFn: () => api.finops(range), placeholderData: keepPreviousData, refetchInterval: 30_000 })

// ---- Mutations --------------------------------------------------------------------------
function useInvalidate(keys: string[][]) {
  const qc = useQueryClient()
  return () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })))
}

// ---- Users & access (admins) ------------------------------------------------------------
export const useModules = () => useQuery({ queryKey: ["modules"], queryFn: () => api.modules(), staleTime: Infinity })
export const usePasswordPolicy = () => useQuery({ queryKey: ["passwordPolicy"], queryFn: () => api.passwordPolicy(), staleTime: Infinity })
export const useCreateUser = () => {
  const inv = useInvalidate([["users"], ["audit"]])
  return useMutation({ mutationFn: (v: UserInput) => api.createUser(v), onSuccess: inv })
}
export const useUpdateUser = () => {
  const inv = useInvalidate([["users"], ["audit"]])
  return useMutation({ mutationFn: (v: { id: string; patch: UserPatch }) => api.updateUser(v.id, v.patch), onSuccess: inv })
}
export const useUserAction = () => {
  const inv = useInvalidate([["users"], ["audit"]])
  return useMutation({
    mutationFn: (v: { id: string; action: "reset" | "unlock" | "revoke" }): Promise<unknown> =>
      v.action === "reset" ? api.resetUserPassword(v.id) : v.action === "unlock" ? api.unlockUser(v.id) : api.revokeUserSessions(v.id),
    onSuccess: inv,
  })
}

export const useReassign = () => {
  const inv = useInvalidate([["companies"], ["company"], ["pams"], ["pamSearch"], ["audit"]])
  return useMutation({ mutationFn: (v: { companyIds: string[]; toPamId: string; actor: string }) => api.reassignCompanies(v.companyIds, v.toPamId), onSuccess: inv })
}
export const useResend = () => {
  const inv = useInvalidate([["pamJobs"], ["run"], ["dashboard"], ["audit"]])
  return useMutation({ mutationFn: (v: { runId: string; pamId: string; actor: string }) => api.resendDigest(v.runId, v.pamId), onSuccess: inv })
}

// ---- Jobs, queues, schedules ------------------------------------------------------------------
const ACTIVE = new Set(["scheduled", "queued", "running"])

export const useJob = (id: string) =>
  useQuery({ queryKey: ["job", id], queryFn: () => backend.getJob(id), refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 2_000 : false) })
export const useQueues = () => useQuery({ queryKey: ["queues"], queryFn: () => backend.queues(), refetchInterval: 5_000 })

const useJobInvalidate = () => useInvalidate([["jobs"], ["job"], ["jobResults"], ["jobNotifications"], ["queues"], ["board"], ["run"], ["logoTimeline"]])
export const useCancelJob = () => useMutation({ mutationFn: (id: string) => backend.cancelJob(id), onSuccess: useJobInvalidate() })
export const useRetryFailed = () => useMutation({ mutationFn: (id: string) => backend.retryFailed(id), onSuccess: useJobInvalidate() })
export const useResendNotification = () => useMutation({ mutationFn: (id: string) => backend.resendNotification(id), onSuccess: useJobInvalidate() })

// ---- Run results board ---------------------------------------------------------------------------
export const useLogoTimeline = (runId: string, resultId: string | null, live: boolean) =>
  useQuery({
    queryKey: ["logoTimeline", runId, resultId],
    queryFn: () => backend.logoTimeline(runId, resultId!),
    enabled: !!runId && !!resultId,
    placeholderData: keepPreviousData,
    refetchInterval: live ? 4_000 : false,
  })
/** A logo's run timeline by company (the logo drawer). Polls while the logo is still being researched. */
export const useCompanyRunTimeline = (runId: string | undefined, companyId: string | null, enabled = true) =>
  useQuery({
    queryKey: ["logoTimeline", runId, "company", companyId],
    queryFn: () => backend.companyRunTimeline(runId!, companyId!),
    enabled: enabled && !!runId && !!companyId,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data && ["pending", "running"].includes(q.state.data.logo.status) ? 4_000 : false),
  })
export const usePamDigest = (runId: string, pamId: string | null) =>
  useQuery({ queryKey: ["pamDigest", runId, pamId], queryFn: () => backend.pamDigest(runId, pamId!), enabled: !!runId && !!pamId })
export const useBoardRetry = (runId: string) =>
  useMutation({ mutationFn: (b: { resultIds?: string[]; pamIds?: string[] }) => backend.boardRetry(runId, b), onSuccess: useJobInvalidate() })
export const useBoardResend = (runId: string) => {
  const inv = useJobInvalidate()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { pamIds: string[]; channel?: DeliveryChannel }) => backend.boardResend(runId, b),
    onSuccess: () => Promise.all([inv(), qc.invalidateQueries({ queryKey: ["pamDigest", runId] })]),
  })
}

// ---- Run timeline, audit, costs; telemetry ---------------------------------------------------
export const useRunTimeline = (id: string, live: boolean) =>
  useQuery({ queryKey: ["runTimeline", id], queryFn: () => backend.runTimeline(id), enabled: !!id, refetchInterval: live ? 4_000 : false })
export const useRunEvents = (id: string, q: { page: number; pageSize: number; kind?: string; status?: string }, live: boolean) =>
  useQuery({ queryKey: ["runEvents", id, q], queryFn: () => backend.runEvents(id, q), enabled: !!id, placeholderData: keepPreviousData, refetchInterval: live ? 4_000 : false })
export const useRunAudit = (id: string, q: { page: number; pageSize: number }, live: boolean) =>
  useQuery({ queryKey: ["runAudit", id, q], queryFn: () => backend.runAudit(id, q), enabled: !!id, placeholderData: keepPreviousData, refetchInterval: live ? 5_000 : false })
export const useRunCosts = (id: string, live: boolean) =>
  useQuery({ queryKey: ["runCosts", id], queryFn: () => backend.runCosts(id), enabled: !!id, refetchInterval: live ? 5_000 : false })
export const useTelemetrySummary = (hours: number) =>
  useQuery({ queryKey: ["telemetrySummary", hours], queryFn: () => backend.telemetrySummary(hours), placeholderData: keepPreviousData, refetchInterval: 15_000 })
export const useTelemetryEvents = (q: Parameters<typeof backend.telemetryEvents>[0]) =>
  useQuery({ queryKey: ["telemetryEvents", q], queryFn: () => backend.telemetryEvents(q), placeholderData: keepPreviousData, refetchInterval: 10_000 })

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
const SAVING = new Set(["analyzing", "queued", "processing"])

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
export const useUploadPreview = (id: string | null, ready: boolean) =>
  useQuery({ queryKey: ["uploadPreview", id], queryFn: () => backend.uploadPreview(id!), enabled: !!id && ready, staleTime: Infinity })
export const useSaveUpload = () => {
  const inv = useInvalidate([["datasets"], ["dataset"], ["audit"]])
  return useMutation({ mutationFn: (v: { id: string; label: string }) => backend.saveUpload(v.id, v.label), onSuccess: inv })
}
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

// ---- Email (Microsoft Graph) ------------------------------------------------------------
/** Settings + live quota; polls while the page is open so the bucket meters move. */
export const useEmailSettings = () => useQuery({ queryKey: ["emailSettings"], queryFn: () => backend.emailSettings(), refetchInterval: 15_000 })
function useEmailSettingsMutation<V, R extends EmailSettings = EmailSettings>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (s) => {
      qc.setQueryData(["emailSettings"], s)
      qc.invalidateQueries({ queryKey: ["channels"] })
    },
  })
}
export const useSaveEmailSettings = () => useEmailSettingsMutation((v: EmailConnectionInput) => backend.saveEmailSettings(v))
export const useTestEmailSettings = () => useEmailSettingsMutation(() => backend.testEmailSettings())
export const useSaveEmailLimits = () =>
  useEmailSettingsMutation((v: { perMinute: number; perHour: number; perDay: number; safetyMarginPct: number }) => backend.saveEmailLimits(v))
export const useSaveEmailPolicy = () => useEmailSettingsMutation((v: EmailPolicy) => backend.saveEmailPolicy(v))
export const useEnableEmail = () => useEmailSettingsMutation((enabled: boolean) => backend.enableEmail(enabled))
export const usePauseEmail = () => useEmailSettingsMutation((v: { minutes: number; reason?: string }) => backend.pauseEmail(v.minutes, v.reason))
export const useResumeEmail = () => useEmailSettingsMutation(() => backend.resumeEmail())
export const useSendTestEmail = () => {
  const inv = useInvalidate([["emailSettings"], ["audit"]])
  return useMutation({ mutationFn: (to: string) => backend.sendTestEmail(to), onSuccess: inv })
}
export const useRemoveEmailSettings = () => {
  const inv = useInvalidate([["emailSettings"], ["channels"]])
  return useMutation({ mutationFn: () => backend.removeEmailSettings(), onSuccess: inv })
}
export const useEmailEstimate = (importId: string, enabled: boolean) =>
  useQuery({ queryKey: ["emailEstimate", importId], queryFn: () => backend.emailEstimate(importId), enabled: enabled && !!importId, staleTime: 30_000, retry: false })

// ---- Research prompt --------------------------------------------------------------------
export const useResearchPrompt = (enabled = true) => useQuery({ queryKey: ["researchPrompt"], queryFn: () => backend.researchPrompt(), enabled, retry: false })
export const useResearchPromptVersion = (version: number | null) =>
  useQuery({ queryKey: ["researchPromptVersion", version], queryFn: () => backend.researchPromptVersion(version!), enabled: version != null, staleTime: Infinity })
const usePromptInvalidate = () => useInvalidate([["researchPrompt"], ["templates"]])
export const useSaveResearchPrompt = () => {
  const inv = usePromptInvalidate()
  return useMutation({ mutationFn: (v: ResearchPromptInput & { activate: boolean }) => backend.saveResearchPrompt(v), onSuccess: inv })
}
export const useActivateResearchPrompt = () => {
  const inv = usePromptInvalidate()
  return useMutation({ mutationFn: (version: number) => backend.activateResearchPrompt(version), onSuccess: inv })
}
export const usePreviewResearchPrompt = () =>
  useMutation({ mutationFn: (v: { company: string; draft?: ResearchPromptInput; version?: number }) => backend.previewResearchPrompt(v) })

// ---- Email templates --------------------------------------------------------------------
export const useEmailTemplates = () => useQuery({ queryKey: ["emailTemplates"], queryFn: () => backend.emailTemplates(), retry: false })
export const useEmailTemplateVersions = (id: string | null) =>
  useQuery({ queryKey: ["emailTemplateVersions", id], queryFn: () => backend.emailTemplateVersions(id!), enabled: !!id })
const useTemplatesInvalidate = () => useInvalidate([["emailTemplates"], ["emailTemplateVersions"]])
export const useSaveEmailTemplate = () => {
  const inv = useTemplatesInvalidate()
  return useMutation({
    mutationFn: (v: { id?: string; data: EmailTemplateInput }) => (v.id ? backend.updateEmailTemplate(v.id, v.data) : backend.createEmailTemplate(v.data)),
    onSuccess: inv,
  })
}
export const useActivateEmailTemplate = () => {
  const inv = useTemplatesInvalidate()
  return useMutation({ mutationFn: (id: string) => backend.activateEmailTemplate(id), onSuccess: inv })
}
export const useDeleteEmailTemplate = () => {
  const inv = useTemplatesInvalidate()
  return useMutation({ mutationFn: (id: string) => backend.deleteEmailTemplate(id), onSuccess: inv })
}
export const useRestoreEmailTemplate = () => {
  const inv = useTemplatesInvalidate()
  return useMutation({ mutationFn: (v: { id: string; version: number }) => backend.restoreEmailTemplate(v.id, v.version), onSuccess: inv })
}
/** Mutation, not a query: a preview with AI is a real (billable) call and must only run on demand. */
export const usePreviewEmailTemplate = () =>
  useMutation({ mutationFn: (v: EmailTemplateInput & { runId?: number; pamId?: number; withAi?: boolean }) => backend.previewEmailTemplate(v) })

// ---- Outbox & dead-letter queue ---------------------------------------------------------
export const useNotificationDetail = (id: string | null) =>
  useQuery({ queryKey: ["notificationDetail", id], queryFn: () => backend.notificationDetail(id!), enabled: !!id })
export const useDeadLetters = (q: { page: number; pageSize: number; status?: DeadLetterStatus | ""; channel?: string }) =>
  useQuery({ queryKey: ["deadLetters", q], queryFn: () => backend.deadLetters(q), ...paged, refetchInterval: 15_000 })
const useOutboxInvalidate = () => useInvalidate([["outbox"], ["deadLetters"], ["emailSettings"], ["notificationDetail"]])
export const useRequeueDeadLetters = () => {
  const inv = useOutboxInvalidate()
  return useMutation({ mutationFn: (ids: string[]) => backend.requeueDeadLetters(ids), onSuccess: inv })
}
export const useDiscardDeadLetter = () => {
  const inv = useOutboxInvalidate()
  return useMutation({ mutationFn: (v: { id: string; note: string }) => backend.discardDeadLetter(v.id, v.note), onSuccess: inv })
}
