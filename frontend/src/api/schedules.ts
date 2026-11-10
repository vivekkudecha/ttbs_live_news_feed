/**
 * Recurring research schedules (backend: services/schedules.py). Types, calls and hooks for the
 * feature live together here. Every firing creates an ordinary run, so run views need no changes.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { request } from "./http"
import type { DeliveryChannel, Job, RunStatus } from "./types"

export type Frequency = "interval" | "weekly" | "monthly"
export type ScheduleTarget = "upload" | "latest"
export type ScheduleOutcome = "started" | "skipped" | "failed"

/** The repeat rule. Weekdays: 0 = Monday. Times are wall-clock in `timezone` (IST by default). */
export interface RepeatRule {
  frequency: Frequency
  intervalDays: number
  weekdays: number[]
  monthDay: number | null
  runAtTime: string
  endsOn: string | null
}

export interface ScheduleInput extends RepeatRule {
  name: string
  target: ScheduleTarget
  importId?: string
  /** Empty = research only: results are kept, no digests are sent. */
  channels: DeliveryChannel[]
  enabled?: boolean
}

export interface Schedule extends RepeatRule {
  id: string
  name: string
  timezone: string
  summary: string
  target: ScheduleTarget
  importId: string | null
  targetLabel: string
  channels: DeliveryChannel[]
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastOutcome: ScheduleOutcome | null
  lastError: string | null
  lastRun: { id: string; status: RunStatus } | null
  createdBy: string
  /** Research runs this schedule has started. */
  runs: number
  /** Next fire times (single-schedule reads only; empty while paused). */
  upcoming?: string[]
}

/** The schedule page's dashboard (GET /schedules/{id|unscheduled}/stats). */
export interface ScheduleStats {
  totals: { runs: number; logos: number; signals: number; failed: number; cost: number; cacheHits: number; avgDurationS: number | null }
  byStatus: Partial<Record<RunStatus, number>>
  /** Latest runs, oldest first. */
  recent: { id: string; label: string; status: RunStatus; at: string; logos: number; done: number; signals: number; failed: number; cost: number }[]
}

export interface ScheduleList {
  rows: Schedule[]
  /** Runs no schedule started (from before every run came from one). */
  unscheduled: number
}

export const DEFAULT_RULE: RepeatRule = { frequency: "interval", intervalDays: 10, weekdays: [0], monthDay: 1, runAtTime: "06:00", endsOn: null }

const wire = (v: Partial<ScheduleInput>) => ({ ...v, importId: v.importId ? Number(v.importId) : undefined })

const schedulesApi = {
  list: () => request<ScheduleList>("GET", "/schedules"),
  get: (id: string) => request<Schedule>("GET", `/schedules/${id}`),
  stats: (ref: string) => request<ScheduleStats>("GET", `/schedules/${ref}/stats`),
  create: (v: ScheduleInput) => request<Schedule>("POST", "/schedules", wire(v)),
  update: (id: string, v: Partial<ScheduleInput>) => request<Schedule>("PATCH", `/schedules/${id}`, wire(v)),
  remove: (id: string) => request<void>("DELETE", `/schedules/${id}`),
  runNow: (id: string) => request<Job>("POST", `/schedules/${id}/run`),
  preview: (rule: RepeatRule) => request<{ summary: string; upcoming: string[] }>("POST", "/schedules/preview", rule),
}

/** Refreshes while anything is due within the hour, so countdowns and outcomes stay live. */
/** One schedule (its page header). Shares the "schedules" key, so every schedule change refreshes it. */
export const useSchedule = (id: string | undefined) =>
  useQuery({ queryKey: ["schedules", "one", id], queryFn: () => schedulesApi.get(id!), enabled: !!id, refetchInterval: 30_000 })

/** Dashboard numbers for a schedule (or "unscheduled"); refreshes fast while one of its runs is active. */
export const useScheduleStats = (ref: string) =>
  useQuery({
    queryKey: ["schedules", "stats", ref],
    queryFn: () => schedulesApi.stats(ref),
    refetchInterval: (q) => (q.state.data?.recent.some((r) => ["scheduled", "queued", "running"].includes(r.status)) ? 4_000 : 30_000),
  })

export const useSchedules = () =>
  useQuery({
    queryKey: ["schedules"],
    queryFn: schedulesApi.list,
    refetchInterval: (q) => {
      const soon = Date.now() + 3_600_000
      const due = (q.state.data?.rows ?? []).map((s) => s.nextRunAt)
      return due.some((t) => t && new Date(t).getTime() < soon) ? 15_000 : 60_000
    },
  })

/** Plain-language summary + next fire times for the rule being edited (rule fields only: the
 *  caller may pass a whole form value, and the API rejects unknown fields). */
export const useSchedulePreview = ({ frequency, intervalDays, weekdays, monthDay, runAtTime, endsOn }: RepeatRule) => {
  const rule: RepeatRule = { frequency, intervalDays, weekdays, monthDay, runAtTime, endsOn }
  return useQuery({ queryKey: ["schedules", "preview", rule], queryFn: () => schedulesApi.preview(rule), placeholderData: keepPreviousData, staleTime: 60_000 })
}

function useScheduleMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    // A schedule change can start a run: refresh everything a new run shows up in.
    onSuccess: () => ["schedules", "runs", "jobs", "scopes", "datasets", "audit", "finops"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

export const useCreateSchedule = () => useScheduleMutation(schedulesApi.create)
export const useUpdateSchedule = () =>
  useScheduleMutation(({ id, ...changes }: { id: string } & Partial<ScheduleInput>) => schedulesApi.update(id, changes))
export const useDeleteSchedule = () => useScheduleMutation(schedulesApi.remove)
export const useRunScheduleNow = () => useScheduleMutation(schedulesApi.runNow)
