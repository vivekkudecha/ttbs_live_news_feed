/**
 * Telemetry: every pipeline step recorded as a process event (uploads, run lifecycle, each research
 * and delivery attempt, sweeper recoveries). Volume and error rate, research latency percentiles,
 * a per-step breakdown and the filterable event stream. Prometheus (/metrics) and OpenTelemetry
 * traces expose the same picture to external monitoring.
 */
import { useState } from "react"
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts"
import { Activity, AlertTriangle, RotateCcw, Timer } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { EventTable, MiniPager } from "@/components/runs/RunInsights"
import { fmtMs, kindLabel, timeOf } from "@/lib/telemetry"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useTelemetryEvents, useTelemetrySummary } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { cn } from "@/lib/utils"
import { Page, StatGrid, Split } from "@/components/common/layout"
import { ChartCard } from "@/components/common/ChartCard"
import { chartTheme } from "@/components/common/chart-theme"

const n = (x: number) => x.toLocaleString("en-IN")

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
  const [status, setStatus] = useState("all")
  const [page, setPage] = useState(0)
  const sum = useTelemetrySummary(Number(hours))
  const ev = useTelemetryEvents({ page, pageSize: 25, hours: Number(hours), kind: kind === "all" ? undefined : kind, status: status === "all" ? undefined : status })
  const s = sum.data

  return (
    <div>
      <PageHeader title="Telemetry" description="Every upload, run, research attempt and delivery is recorded as an event. Use it to see what happened, when, how long it took and what failed." />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select value={hours} onValueChange={(v) => (setHours(v), setPage(0))}>
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
        <Select value={kind} onValueChange={(v) => (setKind(v), setPage(0))}>
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
        <Select value={status} onValueChange={(v) => (setStatus(v), setPage(0))}>
          <SelectTrigger className="w-36" aria-label="Outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any outcome</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="retry">Retry</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
            <SelectItem value="info">Info</SelectItem>
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

            <Card className="py-0">
              <CardHeader className="pt-5">
                <CardTitle>By step</CardTitle>
                <CardDescription>Outcome counts and average duration</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table className="min-w-[26rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Step</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Retry</TableHead>
                      <TableHead className="text-right">Error</TableHead>
                      <TableHead className="pr-5 text-right">Avg</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.byKind.map((k) => (
                      <TableRow key={k.kind}>
                        <TableCell className="pl-5 text-sm font-medium">{kindLabel(k.kind)}</TableCell>
                        <TableCell className="tabular text-right">{n(k.total)}</TableCell>
                        <TableCell className="tabular text-right">{k.retry ? n(k.retry) : "—"}</TableCell>
                        <TableCell className={cn("tabular text-right", k.error > 0 && "font-medium text-destructive")}>{k.error ? n(k.error) : "—"}</TableCell>
                        <TableCell className="tabular pr-5 text-right text-muted-foreground">{fmtMs(k.avgMs)}</TableCell>
                      </TableRow>
                    ))}
                    {s.byKind.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                          Nothing recorded in this window.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </Split>
        </Page>
      )}

      <div className="mt-8 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium">Event stream</h2>
          <span className="text-sm text-muted-foreground">newest first, refreshes every 10 s</span>
          <div className="ml-auto">{ev.data && <MiniPager page={page} pageSize={25} total={ev.data.total} onPage={setPage} />}</div>
        </div>
        <Card className="py-0">
          <CardContent className={cn("overflow-x-auto p-0 transition-opacity", ev.isPlaceholderData && "opacity-60")}>
            <EventTable rows={ev.data?.rows ?? []} loading={ev.isLoading} showRun />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
