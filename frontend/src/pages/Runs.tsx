/**
 * Research runs (formerly "Jobs" + "Research runs"): one list and one detail page per run.
 *
 * List: queue health, status tabs with counts, search, rich rows with inline Cancel / Retry.
 * Detail: header actions, a progress hero (live rate + ETA), key numbers, and tabs for the live
 * grid, per-company results, per-PAM jobs and digest deliveries. The tab lives in the URL.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  Ban,
  BellRing,
  CalendarClock,
  DatabaseZap,
  Clock,
  ExternalLink,
  FileSpreadsheet,
  Gauge,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { RichText, safeHref } from "@/components/common/RichText"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge, type AnyStatus } from "@/components/common/StatusBadge"
import { LiveRunPanel } from "@/components/live/LiveRunPanel"
import { CompanyDrawer } from "@/components/companies/CompanyDrawer"
import { ReassignDialog } from "@/components/companies/ReassignDialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useServerTable } from "@/components/data-table/useSmartTable"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/api/client"
import { backend, errorMessage } from "@/api/http"
import {
  useCancelJob,
  useJob,
  useQueues,
  useResend,
  useResendNotification,
  useRetryFailed,
  useRun,
} from "@/api/hooks"
import { useDebounced } from "@/lib/use-debounced"
import { durationMin, fmtDate, fmtDateTime, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Job, JobNotification, JobPage, JobResult, JobResultPage, PamJobRow } from "@/api/types"
import { NewRunDialog } from "@/components/runs/NewRunDialog"
import { AuditTab, EventsTab, TimelineTab } from "@/components/runs/RunInsights"
import { Page, StatGrid } from "@/components/common/layout"
import { LiveDot } from "@/components/common/LiveDot"

const n = (x: number) => x.toLocaleString("en-IN")
const ACTIVE = new Set(["scheduled", "queued", "running"])
const asStatus = (s: string): AnyStatus => (s === "sending" ? "running" : (s as AnyStatus))
const TRIGGER: Record<Job["trigger"], { label: string; icon: typeof Play }> = {
  upload: { label: "New upload", icon: FileSpreadsheet },
  rerun: { label: "Re-run", icon: RotateCcw },
  // Runs from before every run started from an upload:
  import: { label: "Import", icon: FileSpreadsheet },
  scheduled: { label: "Scheduled", icon: CalendarClock },
  adhoc: { label: "Ad-hoc", icon: Play },
}

/** "in 5 min" / "3 h ago" for the recent past and near future; a date beyond a week. */
function relative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  if (abs > 7 * 86_400_000) return fmtDateTime(iso)
  const [v, u] = abs < 60_000 ? [0, ""] : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"]
  if (!u) return diff > 0 ? "in a moment" : "just now"
  return diff > 0 ? `in ${v} ${u}` : `${v} ${u} ago`
}

function eta(remaining: number, rate?: number | null): string | null {
  if (!rate || rate <= 0 || remaining <= 0) return null
  const s = remaining / rate
  return s < 90 ? `~${Math.ceil(s)} s left` : s < 5400 ? `~${Math.ceil(s / 60)} min left` : `~${(s / 3600).toFixed(1)} h left`
}

function TriggerBadge({ trigger }: { trigger: Job["trigger"] }) {
  const t = TRIGGER[trigger] ?? TRIGGER.adhoc
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <t.icon className="size-3" /> {t.label}
    </Badge>
  )
}

function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label={label} placeholder={placeholder} className="h-9 pl-8" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/** Cancel (active) or Retry failed (finished with failures): shared by the list rows and the detail header. */
function RunActions({ job, size = "default" }: { job: Job; size?: "sm" | "default" }) {
  const cancel = useCancelJob()
  const retry = useRetryFailed()
  if (ACTIVE.has(job.status))
    return (
      <Button
        variant="outline"
        size={size}
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate(job.id, {
            onSuccess: () => toast.success(`Run #${job.id} cancelled`, { description: "Companies already researched keep their results." }),
            onError: (e) => toast.error("Could not cancel", { description: errorMessage(e) }),
          })
        }
      >
        {cancel.isPending ? <Loader2 className="animate-spin" /> : <Ban />} Cancel
      </Button>
    )
  if (job.failed > 0)
    return (
      <Button
        variant={size === "sm" ? "outline" : "default"}
        size={size}
        disabled={retry.isPending}
        onClick={() =>
          retry.mutate(job.id, {
            onSuccess: (r) => toast.success(`${n(r.requeued)} companies re-queued`),
            onError: (e) => toast.error("Could not retry", { description: errorMessage(e) }),
          })
        }
      >
        {retry.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry {n(job.failed)} failed
      </Button>
    )
  return null
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

function QueueStrip() {
  const q = useQueues()
  if (!q.data) return <Skeleton className="mb-6 h-14" />
  const { broker, db } = q.data
  const down = broker.research === null
  const busy = db.researchPending + db.researchRunning + db.notificationsPending > 0
  const items: [string, number][] = [
    ["Waiting", db.researchPending],
    ["Researching", db.researchRunning],
    ["Digests waiting", db.notificationsPending],
  ]
  return (
    <Card className="mb-6 py-0">
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 py-3.5">
        <div className="flex items-center gap-2.5">
          <LiveDot tone={down ? "danger" : busy ? "info" : "success"} pulse={busy && !down} />
          <span className="font-medium">{down ? "Queue offline" : busy ? "Workers busy" : "Queue idle"}</span>
        </div>
        {items.map(([label, v]) => (
          <div key={label} className="flex items-baseline gap-1.5 text-sm">
            <span className="tabular text-base font-semibold">{n(v)}</span>
            <span className="text-muted-foreground">{label.toLowerCase()}</span>
          </div>
        ))}
        <span className="text-xs text-muted-foreground sm:ml-auto">{down ? "Redis is unreachable: start Redis and the worker." : "Refreshes every 5 s"}</span>
      </CardContent>
    </Card>
  )
}

type Group = "all" | "active" | "finished" | "attention"

const RUN_STATUS_OPTIONS = ["scheduled", "queued", "running", "completed", "partial", "failed", "cancelled"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))
const TRIGGER_OPTIONS = (["upload", "rerun"] as const).map((v) => ({ value: v, label: TRIGGER[v].label }))

function runColumns(): ColumnDef<Job, unknown>[] {
  return [
    {
      id: "label",
      accessorKey: "label",
      enableHiding: false,
      meta: { label: "Run", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
      cell: ({ row }) => {
        const j = row.original
        return (
          <div className="min-w-0 space-y-1">
            <Link to={`/runs/${j.id}`} className="block max-w-[26rem] truncate font-semibold hover:text-brand-blue hover:underline" onClick={(e) => e.stopPropagation()}>
              <span className="text-muted-foreground">#{j.id}</span> {j.label}
            </Link>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <TriggerBadge trigger={j.trigger} />
              <span>by {j.triggeredBy}</span>
            </div>
          </div>
        )
      },
    },
    {
      id: "status",
      accessorKey: "status",
      meta: { label: "Status", filter: { type: "enum", options: RUN_STATUS_OPTIONS } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "done",
      accessorKey: "done",
      size: 200,
      meta: { label: "Progress", filter: { type: "range" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Progress" />,
      cell: ({ row }) => {
        const j = row.original
        const p = pct(j.done, j.companies)
        return (
          <div className="w-44 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="tabular font-medium">{j.status === "scheduled" ? "Not started" : `${p}%`}</span>
              <span className="tabular text-muted-foreground">
                {n(j.done)}/{n(j.companies)}
              </span>
            </div>
            <Progress value={p} className={cn("h-1.5", ACTIVE.has(j.status) && "[&>div]:bg-info")} aria-label={`${p}% researched`} />
          </div>
        )
      },
    },
    {
      id: "withSignal",
      accessorKey: "withSignal",
      meta: { label: "Signals", align: "right", filter: { type: "range" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Signals" align="right" />,
      cell: ({ row }) => <span className="tabular font-semibold">{n(row.original.withSignal)}</span>,
    },
    {
      id: "failed",
      accessorKey: "failed",
      meta: { label: "Failed", align: "right", filter: { type: "range" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Failed" align="right" />,
      cell: ({ row }) => <span className={cn("tabular font-semibold", row.original.failed > 0 && "text-destructive")}>{n(row.original.failed)}</span>,
    },
    {
      id: "digests",
      enableSorting: false,
      meta: { label: "Digests", align: "right" },
      header: () => <span className="block text-right">Digests</span>,
      cell: ({ row }) => {
        const x = row.original.notifications
        return (
          <span className={cn("tabular font-semibold", x.failed > 0 && "text-destructive")}>
            {n(x.sent)}
            <span className="font-normal text-muted-foreground">/{n(x.sent + x.pending + x.failed)}</span>
          </span>
        )
      },
    },
    {
      id: "startedAt",
      accessorKey: "startedAt",
      meta: { label: "When", filter: { type: "date" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="When" />,
      cell: ({ row }) => {
        const j = row.original
        return (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-sm text-muted-foreground">
            <Clock className="size-3.5" />
            {j.status === "scheduled" ? `Starts ${relative(j.scheduledFor)}` : j.finishedAt ? `Finished ${relative(j.finishedAt)}` : `Started ${relative(j.startedAt ?? j.scheduledFor)}`}
          </span>
        )
      },
    },
    {
      id: "trigger",
      accessorKey: "trigger",
      meta: { label: "Trigger", filter: { type: "enum", options: TRIGGER_OPTIONS } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Trigger" />,
      cell: ({ row }) => <TriggerBadge trigger={row.original.trigger} />,
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const j = row.original
        return (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            {j.status === "running" ? (
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/runs/${j.id}?tab=live`}>
                  <Radio /> Watch live
                </Link>
              </Button>
            ) : (
              <RunActions job={j} size="sm" />
            )}
          </div>
        )
      },
    },
  ]
}

export function RunsList() {
  const navigate = useNavigate()
  const [urlParams, setUrlParams] = useSearchParams()
  const group = (urlParams.get("group") as Group | null) ?? "all"
  const [search, setSearch] = useState(() => urlParams.get("q") ?? "") // e.g. from an upload's "runs" link
  const q = useDebounced(search, 250)
  const columns = useMemo(runColumns, [])
  const state = useServerTable<Job, JobPage>({
    id: "runs",
    columns,
    queryKey: ["jobs", { group, q }],
    fetcher: (t) => backend.listJobs({ ...t, status: group === "all" ? undefined : group, q: q || undefined }),
    defaultSort: { id: "id", desc: true },
    defaultHidden: ["trigger"],
    getRowId: (j) => j.id,
    refetchInterval: (d) => (d?.rows.some((r) => ACTIVE.has(r.status)) || (d?.groups.active ?? 0) > 0 ? 3_000 : 15_000),
  })
  const groups = state.data?.groups
  const nothingYet = !state.loading && groups?.all === 0 && !q
  const setGroup = (g: Group) =>
    setUrlParams(
      (p) => {
        if (g === "all") p.delete("group")
        else p.set("group", g)
        p.delete("runs.page")
        return p
      },
      { replace: true },
    )

  const tabs: [Group, string][] = [
    ["all", "All"],
    ["active", "Active"],
    ["finished", "Finished"],
    ["attention", "Needs attention"],
  ]

  return (
    <Page>
      <PageHeader
        title="Research runs"
        description="Every run researches one upload: its logos, for the PAMs it maps them to. Results arrive logo by logo, and each PAM's digest goes out as soon as their logos are done."
        actions={<NewRunDialog />}
      />
      <QueueStrip />

      {nothingYet ? (
        <EmptyState icon={Sparkles} title="No research runs yet">
          <p>Each run starts from an upload: the Excel/CSV of logos and their PAMs for that run.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <NewRunDialog label="Upload & run" />
          </div>
        </EmptyState>
      ) : (
        <SmartTable
          state={state}
          onRowClick={(j) => navigate(`/runs/${j.id}`)}
          minWidth="64rem"
          toolbar={
            <>
              <Tabs value={group} onValueChange={(v) => setGroup(v as Group)}>
                <TabsList>
                  {tabs.map(([key, label]) => (
                    <TabsTrigger key={key} value={key} className="gap-1.5">
                      {label}
                      {groups && groups[key] > 0 && (
                        <span className={cn("tabular rounded-full px-1.5 text-xs", key === "attention" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                          {n(groups[key])}
                        </span>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <SearchBox value={search} onChange={setSearch} placeholder="Search runs by name" label="Search runs" />
            </>
          }
          empty={
            <EmptyState icon={Search} title={q ? `No runs match “${q}”` : "No runs in this view"}>
              Try another tab, search or column filter.
            </EmptyState>
          }
        />
      )}
    </Page>
  )
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

function Meta({ icon: Icon, children }: { icon: typeof Clock; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0" />
      {children}
    </span>
  )
}

function ProgressHero({ j, rate }: { j: Job; rate?: number | null }) {
  const p = pct(j.done, j.companies)
  const running = j.status === "running" || j.status === "queued"
  const left = eta(j.companies - j.done, rate)
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={j.status} />
          <TriggerBadge trigger={j.trigger} />
          {j.channels.map((c) => (
            <Badge key={c} variant="secondary" className="font-normal capitalize">
              {c}
            </Badge>
          ))}
        </div>

        {j.status === "scheduled" ? (
          <div className="flex items-center gap-3 rounded-lg border border-dashed p-4">
            <CalendarClock className="size-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Starts {relative(j.scheduledFor)}</p>
              <p className="text-sm text-muted-foreground">
                {fmtDateTime(j.scheduledFor)} IST · {n(j.companies)} companies in scope
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-2xl font-semibold tabular">
                {p}% <span className="text-base font-normal text-muted-foreground">researched</span>
              </p>
              <p className="tabular text-sm text-muted-foreground">
                {n(j.done)} of {n(j.companies)} companies
                {running && rate ? ` · ${rate.toFixed(1)}/s` : ""}
                {running && left ? ` · ${left}` : ""}
              </p>
            </div>
            <Progress value={p} className={cn("h-2.5", running && "[&>div]:bg-info")} aria-label={`${p}% researched`} />
          </div>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {j.windowStart && (
            <Meta icon={CalendarClock}>
              News {fmtDate(j.windowStart)} – {fmtDate(j.windowEnd)}
            </Meta>
          )}
          <Meta icon={Sparkles}>
            {j.provider} · <code className="text-xs">{j.model}</code>
          </Meta>
          {j.startedAt && (
            <Meta icon={Clock}>
              Started {fmtDateTime(j.startedAt)}
              {j.finishedAt && ` · took ${durationMin(j.startedAt, j.finishedAt)}`}
            </Meta>
          )}
          <Meta icon={Users}>by {j.triggeredBy}</Meta>
        </div>

        {j.error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{j.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function Findings({ r }: { r: JobResult }) {
  const [open, setOpen] = useState(false)
  if (r.status === "failed") return <span className="text-destructive">{r.error ?? "Failed"}</span>
  if (r.status === "no_signal") return <span className="text-muted-foreground">No TTBS-relevant news in the window.</span>
  if (r.status !== "signal")
    return <span className="text-muted-foreground">{r.status === "running" ? "Researching now…" : r.error ? `Retrying: ${r.error}` : "Waiting in queue…"}</span>
  return (
    <div className="space-y-1.5">
      <div className={cn(!open && "line-clamp-2")}>
        <RichText text={r.keySignals ?? undefined} />
      </div>
      {open && (
        <>
          {r.opportunity && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Opportunity: </span>
              <RichText text={r.opportunity} />
            </p>
          )}
          {r.outreach && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Outreach: </span>
              <RichText text={r.outreach} />
            </p>
          )}
          {r.sources.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
              {r.sources.map((s) => (
                <a key={s.url} href={safeHref(s.url)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  <ExternalLink className="size-3" /> {s.title}
                </a>
              ))}
            </div>
          )}
        </>
      )}
      <button type="button" className="text-xs font-medium text-brand-blue hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? "Show less" : `Show opportunity, outreach${r.sources.length ? ` & ${r.sources.length} source${r.sources.length === 1 ? "" : "s"}` : ""}`}
      </button>
    </div>
  )
}

const RESULT_STATUS = [
  { value: "signal", label: "Signal" },
  { value: "no_signal", label: "No signal" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Researching" },
]

function ResultsTab({ j, live, onOpenCompany }: { j: Job; live: boolean; onOpenCompany: (id: string) => void }) {
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const q = useDebounced(search, 250)
  const columns = useMemo<ColumnDef<JobResult, unknown>[]>(
    () => [
      {
        id: "companyName",
        accessorKey: "companyName",
        enableHiding: false,
        size: 280,
        meta: { label: "Company", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Company" />,
        cell: ({ row }) => {
          const r = row.original
          return (
            <div>
              <button type="button" onClick={() => onOpenCompany(r.companyId)} className="text-left font-semibold hover:text-brand-blue hover:underline">
                {r.companyName}
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {r.category && <Badge variant="outline">{r.category}</Badge>}
                {r.cached && <Badge variant="secondary">cached</Badge>}
                {r.attempts > 1 && <Badge variant="secondary">{r.attempts} attempts</Badge>}
              </div>
            </div>
          )
        },
      },
      {
        id: "status",
        accessorKey: "status",
        size: 120,
        meta: { label: "Status", filter: { type: "enum", options: RESULT_STATUS } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <StatusBadge status={asStatus(row.original.status)} />,
      },
      {
        id: "keySignals",
        accessorKey: "keySignals",
        enableSorting: false,
        meta: { label: "Findings", filter: { type: "text", placeholder: "Words in the findings" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Findings" />,
        cell: ({ row }) => (
          <div className="whitespace-normal text-sm">
            <Findings r={row.original} />
          </div>
        ),
      },
      {
        id: "latencyMs",
        accessorKey: "latencyMs",
        size: 90,
        meta: { label: "Time", align: "right", filter: { type: "range", unit: "ms" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Time" align="right" />,
        cell: ({ row }) => <span className="tabular text-xs text-muted-foreground">{row.original.latencyMs ? `${(row.original.latencyMs / 1000).toFixed(1)} s` : "—"}</span>,
      },
      {
        id: "finishedAt",
        accessorKey: "finishedAt",
        meta: { label: "Finished", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Finished" />,
        cell: ({ row }) => <span className="tabular whitespace-nowrap text-xs text-muted-foreground">{row.original.finishedAt ? fmtDateTime(row.original.finishedAt) : "—"}</span>,
      },
    ],
    [onOpenCompany],
  )
  const state = useServerTable<JobResult, JobResultPage>({
    id: "results",
    columns,
    queryKey: ["jobResults", j.id, { status, q }],
    fetcher: (t) => backend.jobResults(j.id, { ...t, status: status === "all" ? undefined : status, q: q || undefined }),
    pageSize: 50,
    defaultHidden: ["finishedAt"],
    getRowId: (r) => r.id,
    refetchInterval: live ? 3_000 : false,
  })
  const c = state.data?.counts ?? {}
  const pending = (c.pending ?? 0) + (c.running ?? 0)
  const filters: [string, string, number][] = [
    ["all", "All", j.companies],
    ["signal", "Signals", c.signal ?? 0],
    ["no_signal", "No signal", c.no_signal ?? 0],
    ["failed", "Failed", c.failed ?? 0],
    ["pending", "Pending", pending],
  ]

  return (
    <SmartTable
      state={state}
      pageSizes={[25, 50, 100]}
      toolbar={
        <>
          <Tabs value={status} onValueChange={setStatus}>
            <TabsList>
              {filters.map(([key, label, count]) => (
                <TabsTrigger key={key} value={key} className="gap-1.5">
                  {label}
                  <span className="tabular rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{n(count)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <SearchBox value={search} onChange={setSearch} placeholder="Search companies" label="Search companies in this run" />
        </>
      }
      empty={
        <EmptyState icon={Search} title={j.status === "scheduled" ? "Not started yet" : "Nothing in this view"}>
          {j.status === "scheduled" ? "This run has not started yet." : q ? `No companies match “${q}”.` : "Try another tab or filter."}
        </EmptyState>
      }
    />
  )
}

const DELIVERY = ["sent", "pending", "sending", "failed", "skipped", "none"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))

/** Per-PAM progress and delivery, paged, sorted and filtered on the server. */
function PamsTab({ runId }: { runId: string }) {
  const resend = useResend()
  const [filter, setFilter] = useState<"all" | "attention" | "in_progress" | "done">("all")
  const [search, setSearch] = useState("")
  const q = useDebounced(search, 250)
  const columns = useMemo<ColumnDef<PamJobRow, unknown>[]>(
    () => [
      {
        id: "pamName",
        accessorKey: "pamName",
        enableHiding: false,
        meta: { label: "PAM", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => <span className="font-semibold">{row.original.pamName}</span>,
      },
      {
        id: "status",
        accessorKey: "status",
        meta: { label: "Status", filter: { type: "enum", options: RUN_STATUS_OPTIONS } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "done",
        accessorKey: "done",
        meta: { label: "Progress", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Progress" />,
        cell: ({ row }) => (
          <div className="flex w-44 items-center gap-2">
            <Progress value={pct(row.original.done, row.original.total)} className="h-1.5" />
            <span className="tabular w-12 text-right text-xs text-muted-foreground">
              {row.original.done}/{row.original.total}
            </span>
          </div>
        ),
      },
      {
        id: "withSignal",
        accessorKey: "withSignal",
        meta: { label: "Signals", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Signals" align="right" />,
        cell: ({ row }) => <span className="tabular font-semibold">{row.original.withSignal}</span>,
      },
      {
        id: "email",
        accessorKey: "email",
        meta: { label: "Email", filter: { type: "enum", options: DELIVERY } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
        cell: ({ row }) => <StatusBadge status={row.original.email} />,
      },
      {
        id: "whatsapp",
        accessorKey: "whatsapp",
        meta: { label: "WhatsApp", filter: { type: "enum", options: DELIVERY } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="WhatsApp" />,
        cell: ({ row }) => <StatusBadge status={row.original.whatsapp} />,
      },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const j = row.original
          return (
            j.email === "failed" || j.whatsapp === "failed" ? (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={resend.isPending}
                  onClick={() =>
                    resend.mutate(
                      { runId, pamId: j.pamId, actor: "" },
                      {
                        onSuccess: () => toast.success(`Digest re-queued for ${j.pamName}`),
                        onError: (e) => toast.error("Could not resend", { description: errorMessage(e) }),
                      },
                    )
                  }
                >
                  <RefreshCw /> Resend
                </Button>
              </div>
            ) : null
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, resend.isPending],
  )
  const state = useServerTable<PamJobRow>({
    id: "pams",
    columns,
    queryKey: ["pamJobs", runId, { filter, q }],
    fetcher: (t) => api.pamJobs(runId, { page: t.page, pageSize: t.pageSize, filter, search: q, sort: t.sort, desc: t.desc, columnFilter: t.filter }),
    getRowId: (r) => r.pamId,
  })

  return (
    <SmartTable
      state={state}
      toolbar={
        <>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="attention">Needs attention</TabsTrigger>
              <TabsTrigger value="in_progress">In progress</TabsTrigger>
              <TabsTrigger value="done">Done</TabsTrigger>
            </TabsList>
          </Tabs>
          <SearchBox value={search} onChange={setSearch} placeholder="Search PAMs" label="Search PAMs in this run" />
        </>
      }
      empty={
        <EmptyState icon={Users} title="No PAMs in this view">
          Try another tab or filter.
        </EmptyState>
      }
    />
  )
}

const NOTE_STATUS = ["sent", "pending", "sending", "failed", "skipped"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))

function DigestsTab({ runId, live }: { runId: string; live: boolean }) {
  const resend = useResendNotification()
  const columns = useMemo<ColumnDef<JobNotification, unknown>[]>(
    () => [
      {
        id: "pamName",
        accessorKey: "pamName",
        enableHiding: false,
        meta: { label: "PAM", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => (
          <div>
            <span className="font-semibold">{row.original.pamName}</span>
            <p className="text-xs text-muted-foreground">{row.original.recipient}</p>
          </div>
        ),
      },
      {
        id: "channel",
        accessorKey: "channel",
        meta: { label: "Channel", filter: { type: "enum", options: [{ value: "email", label: "Email" }, { value: "whatsapp", label: "WhatsApp" }] } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Channel" />,
        cell: ({ row }) => <span className="capitalize">{row.original.channel}</span>,
      },
      {
        id: "status",
        accessorKey: "status",
        meta: { label: "Status", filter: { type: "enum", options: NOTE_STATUS } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <StatusBadge status={asStatus(row.original.status)} label={row.original.status} />,
      },
      {
        id: "attempts",
        accessorKey: "attempts",
        meta: { label: "Attempts", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Attempts" align="right" />,
        cell: ({ row }) => <span className="tabular">{row.original.attempts}</span>,
      },
      {
        id: "sentAt",
        accessorKey: "sentAt",
        meta: { label: "Detail", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Detail" />,
        cell: ({ row }) => {
          const x = row.original
          return (
            <span className="whitespace-normal text-sm text-muted-foreground">
              {x.status === "sent" ? `Sent ${fmtDateTime(x.sentAt)}` : x.lastError}
              {x.status === "pending" && x.nextAttemptAt && ` · next try ${fmtDateTime(x.nextAttemptAt)}`}
            </span>
          )
        },
      },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const x = row.original
          return x.status === "failed" || x.status === "sent" || (x.status === "skipped" && x.recipient) ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                disabled={resend.isPending}
                onClick={() =>
                  resend.mutate(x.id, {
                    onSuccess: () => toast.success("Digest re-queued"),
                    onError: (e) => toast.error("Could not resend", { description: errorMessage(e) }),
                  })
                }
              >
                <RotateCcw /> Resend
              </Button>
            </div>
          ) : null
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resend.isPending],
  )
  const state = useServerTable<JobNotification>({
    id: "digests",
    columns,
    queryKey: ["jobNotifications", runId],
    fetcher: (t) => backend.jobNotifications(runId, t),
    pageSize: 50,
    getRowId: (x) => x.id,
    refetchInterval: live ? 3_000 : false,
  })
  if (!state.loading && state.total === 0 && state.table.getState().columnFilters.length === 0)
    return (
      <EmptyState icon={BellRing} title="No digests yet">
        Each PAM's digest is queued the moment all of their companies are researched.
      </EmptyState>
    )
  return (
    <SmartTable
      state={state}
      pageSizes={[25, 50, 100]}
      empty={
        <EmptyState icon={BellRing} title="No digests match">
          Clear a filter to see every digest.
        </EmptyState>
      }
    />
  )
}

type DetailTab = "live" | "results" | "pams" | "digests" | "timeline" | "events" | "audit"

export function RunDetail() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const job = useJob(id)
  const summary = useRun(id) // per-PAM roll-ups + live completion rate
  const [openCompany, setOpenCompany] = useState<string | null>(null)
  const [reassign, setReassign] = useState<string[]>([])

  const j = job.data
  const started = !!j && j.status !== "scheduled"
  const live = !!j && ACTIVE.has(j.status)
  const fallback: DetailTab = live && started ? "live" : "results"
  const tab = (params.get("tab") as DetailTab | null) ?? fallback

  // The live grid only exists once a run has started.
  useEffect(() => {
    if (j && !started && tab === "live") setParams({}, { replace: true })
  }, [j, started, tab, setParams])

  if (job.isError)
    return (
      <EmptyState icon={TriangleAlert} title="Run not available">
        <p>{errorMessage(job.error)}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/runs")}>
          Back to all runs
        </Button>
      </EmptyState>
    )
  if (!j)
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-28" />
        <Skeleton className="h-80" />
      </div>
    )

  const s = summary.data
  const digestsTotal = j.notifications.sent + j.notifications.pending + j.notifications.failed + j.notifications.skipped

  return (
    <Page>
      <PageHeader
        title={`Run #${j.id}`}
        description={
          <>
            {j.label}
            {j.importId && (
              <>
                {" · "}
                <Link to={`/imports?open=${j.importId}`} className="underline-offset-2 hover:underline">
                  upload #{j.importId}
                </Link>
              </>
            )}
            {" · "}
            {j.provider} {j.model}
          </>
        }
        back={{ to: "/runs", label: "All research runs" }}
        actions={<RunActions job={j} />}
      />

      <ProgressHero j={j} rate={s?.ratePerSec} />

      <StatGrid>
        <StatCard icon={Zap} tone="info" label="Signals" value={n(j.withSignal)} hint={`${pct(j.withSignal, Math.max(j.done, 1))}% of ${n(j.done)} researched`} />
        <StatCard icon={Ban} tone={j.failed ? "warning" : undefined} label="Failed" value={n(j.failed)} hint={j.failed ? "after automatic retries" : "none so far"} />
        <StatCard icon={BellRing} tone="success" label="Digests sent" value={`${n(j.notifications.sent)}/${n(digestsTotal)}`} hint={`${n(j.notifications.pending)} pending · ${n(j.notifications.failed)} failed${s ? ` · ${n(s.pamJobsTotal)} PAMs` : ""}`} />
        <StatCard icon={DatabaseZap} tone="primary" label="From cache" value={n(j.cacheHits)} hint="fresh answers reused from an earlier run" />
      </StatGrid>

      <Tabs value={tab} onValueChange={(v) => setParams(v === fallback ? {} : { tab: v }, { replace: true })}>
        <TabsList className="h-auto flex-wrap">
          {started && (
            <TabsTrigger value="live" className="gap-1.5">
              {live ? <Radio className="text-info" /> : <Gauge />} {live ? "Live" : "Overview"}
            </TabsTrigger>
          )}
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="pams">PAMs</TabsTrigger>
          <TabsTrigger value="digests">Digests</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="audit">Audit trail</TabsTrigger>
        </TabsList>
        {started && (
          <TabsContent value="live" className="mt-4">
            <LiveRunPanel runId={j.id} finishedAt={j.finishedAt} onOpenCompany={setOpenCompany} />
          </TabsContent>
        )}
        <TabsContent value="results" className="mt-4">
          <ResultsTab j={j} live={live} onOpenCompany={setOpenCompany} />
        </TabsContent>
        <TabsContent value="pams" className="mt-4">
          <PamsTab runId={j.id} />
        </TabsContent>
        <TabsContent value="digests" className="mt-4">
          <DigestsTab runId={j.id} live={live} />
        </TabsContent>
        <TabsContent value="timeline" className="mt-4">
          <TimelineTab runId={j.id} live={live} />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventsTab runId={j.id} live={live} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab runId={j.id} live={live} />
        </TabsContent>
      </Tabs>

      <CompanyDrawer companyId={openCompany} onOpenChange={(o) => !o && setOpenCompany(null)} onReassign={(cid) => setReassign([cid])} />
      <ReassignDialog companyIds={reassign} open={reassign.length > 0} onOpenChange={(o) => !o && setReassign([])} />
    </Page>
  )
}

/** Old /jobs and /jobs/:id links land on the merged runs pages. */
export function JobsRedirect() {
  const { id } = useParams()
  return <Navigate to={id ? `/runs/${id}` : "/runs"} replace />
}
