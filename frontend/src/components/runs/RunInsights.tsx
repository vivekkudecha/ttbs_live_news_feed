/**
 * Run detail tabs that show a run end to end:
 *   Timeline  - its upload, lifecycle, every PAM digest and every problem, plus per-minute throughput
 *   Events    - every process event (one per research / delivery attempt), filterable
 *   Audit     - the run's hash-chained audit trail
 *   Costs     - what this run cost, split by PAM (from the FinOps ledger)
 */
import { useState } from "react"
import { Link } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  FileSpreadsheet,
  Info,
  Mail,
  MessageCircle,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Timer,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useRunAudit, useRunCosts, useRunEvents, useRunTimeline } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDateTime, fmtUsd } from "@/lib/format"
import { fmtMs, kindLabel, timeOf } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import type { EventStatus, ProcessEvent } from "@/api/types"

const n = (x: number) => x.toLocaleString("en-IN")

// ---- Shared bits (also used by the Telemetry page) -------------------------------------------

const STATUS: Record<EventStatus, { icon: LucideIcon; cls: string; label: string }> = {
  ok: { icon: CheckCircle2, cls: "text-success", label: "OK" },
  retry: { icon: RotateCcw, cls: "text-warning", label: "Retry" },
  error: { icon: XCircle, cls: "text-destructive", label: "Error" },
  skipped: { icon: CircleSlash, cls: "text-muted-foreground", label: "Skipped" },
  info: { icon: Info, cls: "text-info", label: "Info" },
}

/** Status = icon + text, never colour alone. */
export function EventStatus({ status }: { status: EventStatus }) {
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

export function MiniPager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <nav aria-label="Pagination" className="flex items-center justify-end gap-3 px-1 text-[0.8125rem] text-muted-foreground">
      <span className="tabular">
        {total ? `${n(page * pageSize + 1)}–${n(Math.min(total, (page + 1) * pageSize))} of ${n(total)}` : "0"}
      </span>
      <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>
        <ChevronLeft />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
        <ChevronRight />
      </Button>
    </nav>
  )
}

const tooltipStyle = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, color: "var(--popover-foreground)" }

// ---- Timeline -----------------------------------------------------------------------------------

export function TimelineTab({ runId, live }: { runId: string; live: boolean }) {
  const tl = useRunTimeline(runId, live)
  if (tl.isLoading) return <Skeleton className="h-96" />
  if (tl.isError) return <p className="text-sm text-destructive">{errorMessage(tl.error)}</p>
  const d = tl.data!
  const series = d.throughput.map((b) => ({ ...b, label: timeOf(b.minute) }))

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
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
                        {e.cost != null && e.cost > 0 && <span className="tabular">{fmtUsd(e.cost, 4)}</span>}
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
        <Card>
          <CardHeader>
            <CardTitle>Logos finished per minute</CardTitle>
            <CardDescription>Including cache hits; retries shown separately</CardDescription>
          </CardHeader>
          <CardContent>
            {series.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing researched yet.</p>
            ) : (
              <div className="h-48" role="img" aria-label={`Throughput by minute: ${series.map((s) => `${s.label} ${s.ok} done`).join(", ")}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ left: -20, right: 4, top: 4 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} minTickGap={24} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
                    <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} contentStyle={tooltipStyle} />
                    <Bar dataKey="ok" name="Finished" stackId="a" fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
                    <Bar dataKey="error" name="Failed" stackId="a" fill="var(--destructive)" stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
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
  const [page, setPage] = useState(0)
  const [kind, setKind] = useState("all")
  const [status, setStatus] = useState("all")
  const ev = useRunEvents(runId, { page, pageSize: 25, kind: kind === "all" ? undefined : kind, status: status === "all" ? undefined : status }, live)
  const rows = ev.data?.rows ?? []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(v) => (setKind(v), setPage(0))}>
          <SelectTrigger className="w-44" aria-label="Step type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_FILTERS.map(([v, l]) => (
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
            {(Object.keys(STATUS) as EventStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">{ev.data && <MiniPager page={page} pageSize={25} total={ev.data.total} onPage={setPage} />}</div>
      </div>
      <Card className="py-0">
        <CardContent className={cn("overflow-x-auto p-0 transition-opacity", ev.isPlaceholderData && "opacity-60")}>
          <EventTable rows={rows} loading={ev.isLoading} showRun={false} />
        </CardContent>
      </Card>
    </div>
  )
}

export function EventTable({ rows, loading, showRun }: { rows: ProcessEvent[]; loading?: boolean; showRun: boolean }) {
  return (
    <Table className="min-w-[56rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-5">Time (IST)</TableHead>
          <TableHead>Step</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Detail</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="pr-5 text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="tabular pl-5 text-sm text-muted-foreground">{fmtDateTime(e.ts)}</TableCell>
            <TableCell>
              <span className="font-medium">{kindLabel(e.kind)}</span>
              <p className="text-xs text-muted-foreground">
                {showRun && e.runId ? (
                  <Link to={`/runs/${e.runId}?tab=timeline`} className="hover:underline">
                    Run #{e.runId}
                  </Link>
                ) : null}
                {showRun && e.runId && (e.companyId || e.attempt) ? " · " : null}
                {e.companyId ? `logo ${e.companyId}` : null}
                {e.attempt ? ` · attempt ${e.attempt}` : null}
                {!showRun && !e.companyId && e.attrs.channel ? String(e.attrs.channel) : null}
              </p>
            </TableCell>
            <TableCell>
              <EventStatus status={e.status} />
            </TableCell>
            <TableCell className="max-w-md whitespace-normal break-words text-sm text-muted-foreground">
              {e.message ?? (e.attrs.cached ? "Answer reused from cache" : e.attrs.outcome ? String(e.attrs.outcome).replace("_", " ") : "—")}
            </TableCell>
            <TableCell className="tabular text-right text-sm">{fmtMs(e.durationMs)}</TableCell>
            <TableCell className="tabular text-right text-sm text-muted-foreground">
              {e.tokensIn || e.tokensOut ? `${n(e.tokensIn ?? 0)} / ${n(e.tokensOut ?? 0)}` : "—"}
            </TableCell>
            <TableCell className="tabular pr-5 text-right text-sm">{e.cost ? fmtUsd(e.cost, 4) : "—"}</TableCell>
          </TableRow>
        ))}
        {!loading && rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
              No events match.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

// ---- Audit trail ----------------------------------------------------------------------------------

export function AuditTab({ runId, live }: { runId: string; live: boolean }) {
  const [page, setPage] = useState(0)
  const a = useRunAudit(runId, { page, pageSize: 50 }, live)
  if (a.isLoading) return <Skeleton className="h-64" />
  const rows = a.data?.rows ?? []
  if (rows.length === 0)
    return (
      <EmptyState icon={ShieldCheck} title="No audit entries yet">
        Entries appear as the run is queued, started, delivers digests and finishes.
      </EmptyState>
    )
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" /> Append-only and hash-chained: any edit or deletion breaks the chain (check it on the Audit log page).
        </p>
        <div className="ml-auto">{a.data && <MiniPager page={page} pageSize={50} total={a.data.total} onPage={setPage} />}</div>
      </div>
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[48rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Time (IST)</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead className="pr-5">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="tabular pl-5 text-sm text-muted-foreground">{fmtDateTime(r.ts)}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.action}</code>
                  </TableCell>
                  <TableCell className="text-sm">{r.entity}</TableCell>
                  <TableCell className="text-sm">{r.actor}</TableCell>
                  <TableCell className="max-w-lg whitespace-normal break-words pr-5 text-xs text-muted-foreground">{r.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// ---- Costs ----------------------------------------------------------------------------------------

export function CostsTab({ runId, live }: { runId: string; live: boolean }) {
  const c = useRunCosts(runId, live)
  if (c.isLoading) return <Skeleton className="h-64" />
  if (c.isError) return <p className="text-sm text-destructive">{errorMessage(c.error)}</p>
  const { totals: t, byPam } = c.data!
  const tiles: [string, string, string][] = [
    ["Total", fmtUsd(t.total, 4), `research ${fmtUsd(t.llm, 4)} · messaging ${fmtUsd(t.messaging, 4)}`],
    ["Per logo researched", t.costPerCompany != null ? fmtUsd(t.costPerCompany, 4) : "—", `${n(t.calls)} paid calls · ${n(t.cacheHits)} from cache`],
    ["Per signal", t.costPerSignal != null ? fmtUsd(t.costPerSignal, 4) : "—", `${n(t.signals)} signals`],
    ["Saved by cache", fmtUsd(t.saved, 4), `${t.cacheRate}% of logos reused a fresh answer`],
  ]
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
        {tiles.map(([label, value, hint]) => (
          <Card key={label} className="gap-0">
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="tabular text-2xl font-medium">{value}</p>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <CostTable
        title="By PAM"
        description="What each PAM's logos and digests cost in this run"
        rows={byPam.map((p) => ({ ...p, key: p.id, name: p.name }))}
      />
    </div>
  )
}

/** Unit-economics table used by run costs and the FinOps page. */
export function CostTable({
  title,
  description,
  rows,
  extra,
}: {
  title: string
  description?: string
  rows: ({ key: string; name: React.ReactNode; sub?: React.ReactNode } & import("@/api/types").CostRow)[]
  extra?: React.ReactNode
}) {
  return (
    <Card className="py-0">
      <CardHeader className="pt-5">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {extra}
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table className="min-w-[60rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Name</TableHead>
              <TableHead className="text-right">Research</TableHead>
              <TableHead className="text-right">Messaging</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid calls</TableHead>
              <TableHead className="text-right">Cache</TableHead>
              <TableHead className="text-right">Tokens in / out</TableHead>
              <TableHead className="text-right">Signals</TableHead>
              <TableHead className="text-right">Per logo</TableHead>
              <TableHead className="pr-5 text-right">Per signal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="max-w-72 pl-5">
                  <span className="block truncate font-medium">{r.name}</span>
                  {r.sub && <span className="block truncate text-xs text-muted-foreground">{r.sub}</span>}
                </TableCell>
                <TableCell className="tabular text-right">{fmtUsd(r.llm, 4)}</TableCell>
                <TableCell className="tabular text-right">{fmtUsd(r.messaging, 4)}</TableCell>
                <TableCell className="tabular text-right font-medium">{fmtUsd(r.total, 4)}</TableCell>
                <TableCell className="tabular text-right">{n(r.calls)}</TableCell>
                <TableCell className="tabular text-right">{r.cacheRate}%</TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {n(r.tokensIn)} / {n(r.tokensOut)}
                </TableCell>
                <TableCell className="tabular text-right">{n(r.signals)}</TableCell>
                <TableCell className="tabular text-right">{r.costPerCompany != null ? fmtUsd(r.costPerCompany, 4) : "—"}</TableCell>
                <TableCell className="tabular pr-5 text-right">{r.costPerSignal != null ? fmtUsd(r.costPerSignal, 4) : "—"}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="h-20 text-center text-sm text-muted-foreground">
                  No spend recorded.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
