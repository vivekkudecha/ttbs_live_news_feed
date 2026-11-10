/**
 * Research runs (formerly "Jobs" + "Research runs"): one list and one detail page per run.
 *
 * List: queue health, status tabs with counts, search, rich rows with inline Cancel / Retry.
 * Detail: header actions, a progress hero (live rate + ETA), key numbers, and tabs: Overview (live
 * grid + run timeline), Results (one board for logos, PAMs, digests and logo timelines), Events and
 * the audit trail. The tab lives in the URL.
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
  FileSpreadsheet,
  Gauge,
  Loader2,
  Play,
  Radio,
  RotateCcw,
  Search,
  Table2,
  Sparkles,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
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
import { backend, errorMessage } from "@/api/http"
import {
  useCancelJob,
  useJob,
  useQueues,
  useRetryFailed,
  useRun,
} from "@/api/hooks"
import { useDebounced } from "@/lib/use-debounced"
import { durationMin, fmtDate, fmtDateTime, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Job, JobPage } from "@/api/types"
import { NewRunDialog } from "@/components/runs/NewRunDialog"
import { AuditTab, EventsTab, TimelineTab } from "@/components/runs/RunInsights"
import { RunBoard } from "@/components/runs/board/RunBoard"
import { Page, StatGrid } from "@/components/common/layout"
import { LiveDot } from "@/components/common/LiveDot"

const n = (x: number) => x.toLocaleString("en-IN")
const ACTIVE = new Set(["scheduled", "queued", "running"])
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

type DetailTab = "live" | "results" | "events" | "audit"
/** Tabs merged into the results board (old links keep working). */
const MERGED: Record<string, DetailTab> = { pams: "results", digests: "results" }

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
  const rawTab = params.get("tab")
  const tab: DetailTab = rawTab === "timeline" ? (started ? "live" : "results") : ((MERGED[rawTab ?? ""] ?? rawTab ?? fallback) as DetailTab)

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
          <TabsTrigger value="results" className="gap-1.5">
            <Table2 /> Results
            <span className="tabular rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{n(j.companies)}</span>
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="audit">Audit trail</TabsTrigger>
        </TabsList>
        {started && (
          <TabsContent value="live" className="mt-4">
            <div className="space-y-6">
              <LiveRunPanel runId={j.id} finishedAt={j.finishedAt} onOpenCompany={setOpenCompany} />
              <TimelineTab runId={j.id} live={live} />
            </div>
          </TabsContent>
        )}
        <TabsContent value="results" className="mt-4">
          <RunBoard runId={j.id} live={live} onOpenCompany={setOpenCompany} onReassign={setReassign} />
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
