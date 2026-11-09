/**
 * Telemetry: every pipeline step recorded as a process event (uploads, run lifecycle, each research
 * and delivery attempt, sweeper recoveries). Volume and error rate, research latency percentiles,
 * a per-step breakdown and the filterable event stream. Prometheus (/metrics) and OpenTelemetry
 * traces expose the same picture to external monitoring.
 */
import { useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts"
import { Activity, AlertTriangle, RotateCcw, Timer } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { EmptyState } from "@/components/common/EmptyState"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useClientTable, useServerTable } from "@/components/data-table/useSmartTable"
import { eventColumns } from "@/components/telemetry/columns"
import { fmtMs, kindLabel, timeOf } from "@/lib/telemetry"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useTelemetrySummary } from "@/api/hooks"
import { backend, errorMessage } from "@/api/http"
import type { ProcessEvent, TelemetrySummary } from "@/api/types"
import { cn } from "@/lib/utils"
import { Page, StatGrid, Split } from "@/components/common/layout"
import { ChartCard } from "@/components/common/ChartCard"
import { chartTheme } from "@/components/common/chart-theme"

const n = (x: number) => x.toLocaleString("en-IN")
type KindRow = TelemetrySummary["byKind"][number]

const WINDOWS: [string, string][] = [
  ["1", "Last hour"],
  ["24", "Last 24 hours"],
  ["168", "Last 7 days"],
  ["720", "Last 30 days"],
]
const KINDS: [string, string][] = [
  ["all", "All steps"],
  ["dataset.", "Uploads"],
  ["run.", "Run lifecycle"],
  ["research.", "Research"],
  ["notify.", "Digests"],
  ["sweeper.", "Recovery"],
]

export default function Telemetry() {
  const [hours, setHours] = useState("24")
  const [kind, setKind] = useState("all")
  const sum = useTelemetrySummary(Number(hours))
  const s = sum.data
  const eventCols = useMemo(() => eventColumns(true), [])
  const events = useServerTable<ProcessEvent>({
    id: "events",
    columns: eventCols,
    queryKey: ["telemetryEvents", hours, kind],
    fetcher: (q) => backend.telemetryEvents({ ...q, hours: Number(hours), kind: kind === "all" ? undefined : kind }),
    pageSize: 25,
    getRowId: (e) => e.id,
    refetchInterval: 10_000,
  })
  const stepCols = useMemo<ColumnDef<KindRow, unknown>[]>(
    () => [
      {
        id: "kind",
        accessorFn: (k) => kindLabel(k.kind),
        meta: { label: "Step", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Step" />,
        cell: ({ row }) => <span className="text-sm font-medium">{kindLabel(row.original.kind)}</span>,
      },
      {
        id: "total",
        accessorKey: "total",
        sortDescFirst: true,
        meta: { label: "Total", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Total" align="right" />,
        cell: ({ row }) => <span className="tabular">{n(row.original.total)}</span>,
      },
      {
        id: "retry",
        accessorKey: "retry",
        sortDescFirst: true,
        meta: { label: "Retry", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Retry" align="right" />,
        cell: ({ row }) => <span className="tabular">{row.original.retry ? n(row.original.retry) : "—"}</span>,
      },
      {
        id: "error",
        accessorKey: "error",
        sortDescFirst: true,
        meta: { label: "Error", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Error" align="right" />,
        cell: ({ row }) => <span className={cn("tabular", row.original.error > 0 && "font-medium text-destructive")}>{row.original.error ? n(row.original.error) : "—"}</span>,
      },
      {
        id: "avgMs",
        accessorKey: "avgMs",
        meta: { label: "Avg", align: "right", filter: { type: "range", unit: "ms" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Avg" align="right" />,
        cell: ({ row }) => <span className="tabular text-muted-foreground">{fmtMs(row.original.avgMs)}</span>,
      },
    ],
    [],
  )
  const steps = useClientTable<KindRow>({ id: "steps", data: s?.byKind, columns: stepCols, defaultSort: { id: "total", desc: true }, pageSize: 10, getRowId: (k) => k.kind })

  return (
    <div>
      <PageHeader title="Telemetry" description="Every upload, run, research attempt and delivery is recorded as an event. Use it to see what happened, when, how long it took and what failed." />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select value={hours} onValueChange={setHours}>
          <SelectTrigger className="w-44" aria-label="Time window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {s && (
          <span className="ml-auto text-xs text-muted-foreground">
            Prometheus: <code>/metrics</code> · Traces: {s.tracing ? "exporting to OTLP" : "off (set OTEL_EXPORTER_OTLP_ENDPOINT)"}
          </span>
        )}
      </div>

      {sum.isError ? (
        <p className="text-sm text-destructive">{errorMessage(sum.error)}</p>
      ) : !s ? (
        <Skeleton className="h-72" />
      ) : (
        <Page className={cn("transition-opacity", sum.isPlaceholderData && "opacity-60")}>
          <StatGrid>
            <StatCard icon={Activity} label="Events" value={n(s.total)} hint={`${WINDOWS.find(([v]) => v === hours)?.[1].toLowerCase()}`} />
            <StatCard icon={AlertTriangle} label="Problem rate" value={`${s.errorRate}%`} hint={`${n(s.errors)} errors · ${n(s.retries)} retries`} />
            <StatCard icon={Timer} label="Research latency p50 / p95" value={`${fmtMs(s.research.p50Ms)} / ${fmtMs(s.research.p95Ms)}`} hint={`p99 ${fmtMs(s.research.p99Ms)} · ${n(s.research.samples)} calls`} />
            <StatCard icon={RotateCcw} label="Retries" value={n(s.retries)} hint="Rate limits, timeouts and 5xx, retried with backoff" />
          </StatGrid>

          <Split ratio="1.2fr 1fr">
            <ChartCard title="Events per hour" description="Problems are retries and errors (IST)" label="Events per hour; the per-step table lists the totals">
              <BarChart data={s.hourly.map((h) => ({ ...h, label: timeOf(h.hour).slice(0, 5) }))} margin={{ left: -12, right: 8, top: 8 }} barCategoryGap="20%">
                <CartesianGrid vertical={false} {...chartTheme.grid} />
                <XAxis dataKey="label" {...chartTheme.axis} minTickGap={20} />
                <YAxis allowDecimals={false} {...chartTheme.axis} />
                <Tooltip {...chartTheme.tooltip} />
                <Legend {...chartTheme.legend} />
                <Bar dataKey="ok" name="OK" stackId="a" fill="var(--chart-1)" {...chartTheme.bar} />
                <Bar dataKey="problem" name="Problems" stackId="a" fill="var(--destructive)" {...chartTheme.bar} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ChartCard>

            <Card className="gap-4 pb-0">
              <CardHeader>
                <CardTitle>By step</CardTitle>
                <CardDescription>Outcome counts and average duration</CardDescription>
              </CardHeader>
              <CardContent className="pb-5">
                <SmartTable
                  state={steps}
                  minWidth="26rem"
                  empty={<p className="text-sm text-muted-foreground">Nothing recorded in this window.</p>}
                />
              </CardContent>
            </Card>
          </Split>
        </Page>
      )}

      <section className="mt-8 space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-semibold">Event stream</h2>
          <span className="text-sm text-muted-foreground">refreshes every 10 s · sort or filter any column from its header</span>
        </div>
        <SmartTable
          state={events}
          pageSizes={[25, 50, 100]}
          toolbar={
            <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger className="w-40" aria-label="Step type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                {KINDS.map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                    {l}
                      </SelectItem>
                ))}
                  </SelectContent>
                </Select>
          }
          empty={
            <EmptyState icon={Activity} title="No events match">
              Widen the time window, pick another step type or clear a filter.
            </EmptyState>
          }
        />
      </section>
    </div>
  )
}
