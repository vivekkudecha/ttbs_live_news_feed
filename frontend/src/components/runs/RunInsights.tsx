/**
 * Run detail tabs that show a run end to end:
 *   Timeline  - its upload, lifecycle, every PAM digest and every problem, plus per-minute throughput
 *   Events    - every process event (one per research / delivery attempt), filterable
 *   Audit     - the run's hash-chained audit trail
 * (Costs are reported only on the Costs (FinOps) page.)
 */
import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"
import { AlertTriangle, FileSpreadsheet, Info, Mail, MessageCircle, Play, RotateCcw, ShieldCheck, Sparkles, Timer, type LucideIcon } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { auditColumns } from "@/components/audit/columns"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useServerTable } from "@/components/data-table/useSmartTable"
import { EVENT_STATUS, eventColumns } from "@/components/telemetry/columns"
import { useRunTimeline } from "@/api/hooks"
import { backend, errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { fmtMs, kindLabel, timeOf } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import type { AuditEntry, EventStatus as EventStatusT, ProcessEvent } from "@/api/types"
import { Split } from "@/components/common/layout"
import { ChartCard } from "@/components/common/ChartCard"
import { chartTheme } from "@/components/common/chart-theme"

const n = (x: number) => x.toLocaleString("en-IN")

// ---- Shared bits (also used by the Telemetry page) -------------------------------------------

const STATUS = EVENT_STATUS

/** Status = icon + text, never colour alone. */
function EventStatus({ status }: { status: EventStatusT }) {
  const s = STATUS[status] ?? STATUS.info
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <s.icon className={cn("size-3.5", s.cls)} aria-hidden="true" />
      {s.label}
    </span>
  )
}

function kindIcon(e: ProcessEvent): LucideIcon {
  if (e.kind.startsWith("dataset.")) return FileSpreadsheet
  if (e.kind.startsWith("notify.")) return e.attrs.channel === "whatsapp" ? MessageCircle : Mail
  if (e.kind === "run.start" || e.kind === "run.queued" || e.kind === "run.scheduled") return Play
  if (e.kind === "run.finish") return Sparkles
  if (e.kind.startsWith("research.")) return e.status === "retry" ? RotateCcw : AlertTriangle
  return Info
}

// ---- Timeline -----------------------------------------------------------------------------------

export function TimelineTab({ runId, live }: { runId: string; live: boolean }) {
  const tl = useRunTimeline(runId, live)
  if (tl.isLoading) return <Skeleton className="h-96" />
  if (tl.isError) return <p className="text-sm text-destructive">{errorMessage(tl.error)}</p>
  const d = tl.data!
  const series = d.throughput.map((b) => ({ ...b, label: timeOf(b.minute) }))

  return (
    <Split>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>From the upload to the last digest, in IST. Successful research is summarised on the right; retries, failures and skips are listed here.</CardDescription>
        </CardHeader>
        <CardContent>
          {d.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="relative space-y-0">
              {d.events.map((e, i) => {
                const Icon = kindIcon(e)
                return (
                  <li key={e.id} className="relative flex gap-3 pb-5">
                    {i < d.events.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px bg-border" aria-hidden="true" />}
                    <span
                      className={cn(
                        "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-card",
                        e.status === "error" && "border-destructive/40",
                        e.status === "retry" && "border-warning/50",
                      )}
                    >
                      <Icon className={cn("size-4", STATUS[e.status]?.cls ?? "text-muted-foreground")} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1 pt-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-medium">{kindLabel(e.kind)}</span>
                        {e.attrs.channel ? <span className="text-xs capitalize text-muted-foreground">{String(e.attrs.channel)}</span> : null}
                        <span className="tabular ml-auto text-xs text-muted-foreground">{fmtDateTime(e.ts)}</span>
                      </div>
                      {e.message && <p className="mt-0.5 break-words text-sm text-muted-foreground">{e.message}</p>}
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <EventStatus status={e.status} />
                        {e.durationMs != null && (
                          <span className="inline-flex items-center gap-1">
                            <Timer className="size-3" /> {fmtMs(e.durationMs)}
                          </span>
                        )}
                        {e.attempt != null && <span>attempt {e.attempt}</span>}
                        {e.actor && <span>by {e.actor}</span>}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Research attempts</CardTitle>
            <CardDescription>Every call to the research AI in this run</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              {[
                ["Attempts", n(d.research.attempts)],
                ["Retries", n(d.research.retries)],
                ["Failed", n(d.research.errors)],
                ["Avg latency", fmtMs(d.research.avgLatencyMs)],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="tabular mt-1 text-lg font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <ChartCard
          title="Logos finished per minute"
          description="Including cache hits; retries shown separately"
          label={`Throughput by minute: ${series.map((s) => `${s.label} ${s.ok} done`).join(", ")}`}
          height="h-48 3xl:h-64"
          empty={series.length === 0 && "Nothing researched yet."}
        >
          <BarChart data={series} margin={{ left: -20, right: 4, top: 4 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} {...chartTheme.grid} />
            <XAxis dataKey="label" {...chartTheme.axis} minTickGap={24} />
            <YAxis allowDecimals={false} {...chartTheme.axis} />
            <Tooltip {...chartTheme.tooltip} />
            <Bar dataKey="ok" name="Finished" stackId="a" fill="var(--chart-1)" {...chartTheme.bar} />
            <Bar dataKey="error" name="Failed" stackId="a" fill="var(--destructive)" {...chartTheme.bar} radius={[6, 6, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>
    </Split>
  )
}

// ---- Event log ----------------------------------------------------------------------------------

const KIND_FILTERS: [string, string][] = [
  ["all", "All steps"],
  ["research.", "Research"],
  ["notify.", "Digests"],
  ["run.", "Run lifecycle"],
]

export function EventsTab({ runId, live }: { runId: string; live: boolean }) {
  const [kind, setKind] = useState("all")
  const columns = useMemo(() => eventColumns(false), [])
  const state = useServerTable<ProcessEvent>({
    id: "events",
    columns,
    queryKey: ["runEvents", runId, kind],
    fetcher: (q) => backend.runEvents(runId, { ...q, kind: kind === "all" ? undefined : kind }),
    pageSize: 25,
    defaultHidden: ["actor"],
    getRowId: (e) => e.id,
    refetchInterval: live ? 4_000 : false,
  })
  return (
    <SmartTable
      state={state}
      pageSizes={[25, 50, 100]}
      toolbar={
        <Tabs value={kind} onValueChange={setKind}>
          <TabsList>
            {KIND_FILTERS.map(([v, l]) => (
              <TabsTrigger key={v} value={v}>
                {l}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
      empty={
        <EmptyState icon={Info} title="No events match">
          Try another step type or clear a filter.
        </EmptyState>
      }
    />
  )
}

// ---- Audit trail ----------------------------------------------------------------------------------

export function AuditTab({ runId, live }: { runId: string; live: boolean }) {
  const columns = useMemo(() => auditColumns().filter((c) => c.id !== "ip"), [])
  const state = useServerTable<AuditEntry>({
    id: "runaudit",
    columns,
    queryKey: ["runAudit", runId],
    fetcher: (q) => backend.runAudit(runId, q),
    pageSize: 50,
    getRowId: (a) => a.id,
    refetchInterval: live ? 5_000 : false,
  })
  if (!state.loading && state.total === 0 && state.table.getState().columnFilters.length === 0)
    return (
      <EmptyState icon={ShieldCheck} title="No audit entries yet">
        Entries appear as the run is queued, started, delivers digests and finishes.
      </EmptyState>
    )
  return (
    <SmartTable
      state={state}
      pageSizes={[25, 50, 100]}
      toolbar={
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" /> Append-only and hash-chained: any edit or deletion breaks the chain.
        </p>
      }
      empty={
        <EmptyState icon={ShieldCheck} title="No entries match">
          Clear a filter to see the whole trail.
        </EmptyState>
      }
    />
  )
}
