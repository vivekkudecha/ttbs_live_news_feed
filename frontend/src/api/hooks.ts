import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./client"

export const usePams = () => useQuery({ queryKey: ["pams"], queryFn: api.listPams })
export const useCompanies = () => useQuery({ queryKey: ["companies"], queryFn: api.listCompanies })
export const useAssignments = (companyId?: string) =>
  useQuery({ queryKey: ["assignments", companyId], queryFn: () => api.listAssignments(companyId) })
export const useRuns = () => useQuery({ queryKey: ["runs"], queryFn: api.listRuns })
export const useRun = (id: string) => useQuery({ queryKey: ["run", id], queryFn: () => api.getRun(id) })
export const useResults = (runId: string) =>
  useQuery({ queryKey: ["results", runId], queryFn: () => api.listResults(runId), enabled: !!runId })
export const useCompanyResults = (companyId: string) =>
  useQuery({ queryKey: ["companyResults", companyId], queryFn: () => api.companyResults(companyId) })
export const usePriority = (runId: string, pamId?: string) =>
  useQuery({ queryKey: ["priority", runId, pamId], queryFn: () => api.listPriority(runId, pamId), enabled: !!runId })
export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: api.listTemplates })
export const useSchedules = () => useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules })
export const useProviders = () => useQuery({ queryKey: ["providers"], queryFn: api.listProviders })
export const useChannels = () => useQuery({ queryKey: ["channels"], queryFn: api.listChannels })
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: api.listUsers })
export const useAudit = () => useQuery({ queryKey: ["audit"], queryFn: api.listAudit })
export const useFinops = () => useQuery({ queryKey: ["finops"], queryFn: api.finops })
export const useImports = () => useQuery({ queryKey: ["imports"], queryFn: api.listImports })

function useInvalidateAll() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries()
}

export const useDeactivatePam = () => {
  const inv = useInvalidateAll()
  return useMutation({
    mutationFn: (v: { pamId: string; actor: string }) => api.deactivatePam(v.pamId, v.actor),
    onSuccess: inv,
  })
}

export const useStartRun = () => {
  const inv = useInvalidateAll()
  return useMutation({ mutationFn: api.startRun, onSuccess: inv })
}

export const useResend = () => {
  const inv = useInvalidateAll()
  return useMutation({
    mutationFn: (v: { runId: string; pamId: string; actor: string }) => api.resendDigest(v.runId, v.pamId, v.actor),
    onSuccess: inv,
  })
}

export const useToggleSchedule = () => {
  const inv = useInvalidateAll()
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean; actor: string }) => api.toggleSchedule(v.id, v.enabled, v.actor),
    onSuccess: inv,
  })
}

export const useCommitImport = () => {
  const inv = useInvalidateAll()
  return useMutation({ mutationFn: (fileName: string) => api.commitImport(fileName), onSuccess: inv })
}
