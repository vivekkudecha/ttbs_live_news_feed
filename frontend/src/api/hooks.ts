import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./client"
import type { CompanyQuery, PamQuery, SignalQuery } from "./types"

/*
 * Data hooks. Rules that keep the UI smooth at 10k+ rows:
 *  - Lists are always server-paged; query keys include every filter, so pages cache independently.
 *  - `placeholderData: keepPreviousData` keeps the current page on screen while the next loads
 *    (no flash, no layout jump).
 *  - Search inputs are debounced by the caller before they reach a query key.
 *  - Always wrap API calls in an arrow (`() => api.x()`): React Query passes a context with an
 *    AbortSignal as the first argument, which cannot be cloned across to the Worker.
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
export const useScopeOptions = () => useQuery({ queryKey: ["scopes"], queryFn: () => api.scopeOptions(), staleTime: 60_000 })

// ---- Small resources --------------------------------------------------------------------
export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() })
export const useSchedules = () => useQuery({ queryKey: ["schedules"], queryFn: () => api.listSchedules() })
export const useProviders = () => useQuery({ queryKey: ["providers"], queryFn: () => api.listProviders() })
export const useChannels = () => useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() })
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api.listUsers() })
export const useAudit = () => useQuery({ queryKey: ["audit"], queryFn: () => api.listAudit() })
export const useFinops = () => useQuery({ queryKey: ["finops"], queryFn: () => api.finops() })
export const useImports = () => useQuery({ queryKey: ["imports"], queryFn: () => api.listImports() })

// ---- Mutations --------------------------------------------------------------------------
function useInvalidate(keys: string[][]) {
  const qc = useQueryClient()
  return () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })))
}

export const useDeactivatePam = () => {
  const inv = useInvalidate([["pams"], ["pamSearch"], ["companies"], ["company"], ["audit"]])
  return useMutation({ mutationFn: (v: { pamId: string; actor: string }) => api.deactivatePam(v.pamId, v.actor), onSuccess: inv })
}
export const useReassign = () => {
  const inv = useInvalidate([["companies"], ["company"], ["pams"], ["pamSearch"], ["audit"]])
  return useMutation({ mutationFn: (v: { companyIds: string[]; toPamId: string; actor: string }) => api.reassignCompanies(v.companyIds, v.toPamId, v.actor), onSuccess: inv })
}
export const useStartRun = () => {
  const inv = useInvalidate([["runs"], ["audit"]])
  return useMutation({ mutationFn: (v: Parameters<typeof api.startRun>[0]) => api.startRun(v), onSuccess: inv })
}
export const useResend = () => {
  const inv = useInvalidate([["pamJobs"], ["run"], ["dashboard"], ["audit"]])
  return useMutation({ mutationFn: (v: { runId: string; pamId: string; actor: string }) => api.resendDigest(v.runId, v.pamId, v.actor), onSuccess: inv })
}
export const useToggleSchedule = () => {
  const inv = useInvalidate([["schedules"], ["audit"]])
  return useMutation({ mutationFn: (v: { id: string; enabled: boolean; actor: string }) => api.toggleSchedule(v.id, v.enabled, v.actor), onSuccess: inv })
}
export const useCommitImport = () => {
  const inv = useInvalidate([["imports"], ["audit"]])
  return useMutation({ mutationFn: (fileName: string) => api.commitImport(fileName), onSuccess: inv })
}
