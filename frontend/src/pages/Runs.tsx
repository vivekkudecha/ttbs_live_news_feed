/**
 * Research runs (formerly "Jobs" + "Research runs"): one list and one detail page per run.
 *
 * List: queue health, status tabs with counts, search, rich rows with inline Cancel / Retry.
 * Detail: header actions, a progress hero (live rate + ETA), key numbers, and tabs for the live
 * grid, per-company results, per-PAM jobs and digest deliveries. The tab lives in the URL.
 */
import { useEffect, useState, type ReactNode } from "react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  Ban,
  BellRing,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { errorMessage } from "@/api/http"
import {
  useCancelJob,
  useJob,
  useJobNotifications,
  useJobResults,
  useJobs,
  usePamJobs,
  useQueues,
  useResend,
  useResendNotification,
  useRetryFailed,
  useRun,
} from "@/api/hooks"
import { useDebounced } from "@/lib/use-debounced"
import { durationMin, fmtDate, fmtDateTime, fmtUsd, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Job, JobNotification, JobResult } from "@/api/types"
import { NewRunDialog } from "./Schedules"

const n = (x: number) => x.toLocaleString("en-IN")
const ACTIVE = new Set(["scheduled", "queued", "running"])
const asStatus = (s: string): AnyStatus => (s === "sending" ? "running" : (s as AnyStatus))
const TRIGGER: Record<Job["trigger"], { label: string; icon: typeof Play }> = {
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

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return null
  const pages = Math.ceil(total / pageSize)
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span className="tabular">
        {n(page * pageSize + 1)}–{n(Math.min(total, (page + 1) * pageSize))} of {n(total)}
      </span>
      <div className="flex items-center gap-2">
        <span className="tabular">
          Page {page + 1} of {pages}
        </span>
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </Button>
      </div>
    </div>
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
          <span className="relative flex size-2.5">
            {busy && !down && <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" />}
            <span className={cn("relative inline-flex size-2.5 rounded-full", down ? "bg-destructive" : busy ? "bg-info" : "bg-success")} />
          </span>
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

function RunRow({ j }: { j: Job }) {
  const p = pct(j.done, j.companies)
  const active = ACTIVE.has(j.status)
  const digestsTotal = j.notifications.sent + j.notifications.pending + j.notifications.failed
  return (
    <div className="group relative flex flex-col gap-4 px-5 py-4 transition-colors hover:bg-muted/50 lg:flex-row lg:items-center lg:gap-6">
      <Link to={`/runs/${j.id}`} className="absolute inset-0" aria-label={`Open run #${j.id}: ${j.label}`} />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={j.status} />
          <span className="truncate font-medium group-hover:text-brand-blue">
            <span className="text-muted-foreground">#{j.id}</span> {j.label}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <TriggerBadge trigger={j.trigger} />
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" />
            {j.status === "scheduled" ? `Starts ${relative(j.scheduledFor)}` : j.finishedAt ? `Finished ${relative(j.finishedAt)}` : `Started ${relative(j.startedAt ?? j.scheduledFor)}`}
          </span>
          <span>by {j.triggeredBy}</span>
        </div>
      </div>

      <div className="w-full shrink-0 space-y-1.5 lg:w-56">
        <div className="flex items-center justify-between text-sm">
          <span className="tabular font-medium">{j.status === "scheduled" ? "Not started" : `${p}%`}</span>
          <span className="tabular text-muted-foreground">
            {n(j.done)} / {n(j.companies)}
          </span>
        </div>
        <Progress value={p} className={cn("h-1.5", active && "[&>div]:bg-info")} aria-label={`${p}% researched`} />
      </div>

      <dl className="grid shrink-0 grid-cols-4 gap-4 text-sm lg:w-80">
        <div>
          <dt className="text-xs text-muted-foreground">Signals</dt>
          <dd className="tabular font-semibold">{n(j.withSignal)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Failed</dt>
          <dd className={cn("tabular font-semibold", j.failed > 0 && "text-destructive")}>{n(j.failed)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Digests</dt>
          <dd className={cn("tabular font-semibold", j.notifications.failed > 0 && "text-destructive")}>
            {n(j.notifications.sent)}
            <span className="font-normal text-muted-foreground">/{n(digestsTotal)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cost</dt>
          <dd className="tabular font-semibold">{fmtUsd(j.cost, 2)}</dd>
        </div>
      </dl>

      <div className="relative z-10 flex shrink-0 justify-end lg:w-40">
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
    </div>
  )
}

type Group = "all" | "active" | "finished" | "attention"

export function RunsList() {
  const [group, setGroup] = useState<Group>("all")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const q = useDebounced(search, 250)
  const runs = useJobs({ page, pageSize: 20, status: group === "all" ? undefined : group, q: q || undefined })
  const groups = runs.data?.groups
  const nothingYet = runs.isSuccess && groups?.all === 0 && !q

  const tabs: [Group, string][] = [
    ["all", "All"],
    ["active", "Active"],
    ["finished", "Finished"],
    ["attention", "Needs attention"],
  ]

  return (
    <div>
      <PageHeader
        title="Research runs"
        description="Every research run, from an import, a schedule or started by hand. Results arrive company by company, and each PAM's digest goes out as soon as their companies are done."
        actions={<NewRunDialog />}
      />
      <QueueStrip />

      {nothingYet ? (
        <EmptyState icon={Sparkles} title="No research runs yet">
          <p>Upload the company → PAM Excel and choose “research now”, or start a run for companies already imported.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="outline" asChild>
              <Link to="/imports">
                <FileSpreadsheet /> Upload Excel
              </Link>
            </Button>
            <NewRunDialog />
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              value={group}
              onValueChange={(v) => {
                setGroup(v as Group)
                setPage(0)
              }}
            >
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
            <SearchBox
              value={search}
              onChange={(v) => {
                setSearch(v)
                setPage(0)
              }}
              placeholder="Search runs by name"
              label="Search runs"
            />
          </div>

          <Card className={cn("py-0 transition-opacity", runs.isPlaceholderData && "opacity-60")}>
            <CardContent className="divide-y p-0">
              {runs.isLoading &&
                [0, 1, 2].map((i) => (
                  <div key={i} className="px-5 py-4">
                    <Skeleton className="h-12" />
                  </div>
                ))}
              {runs.isError && <p className="px-5 py-6 text-sm text-destructive">{errorMessage(runs.error)}</p>}
              {runs.data?.rows.length === 0 && (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">{q ? `No runs match “${q}”.` : "No runs in this view."}</p>
              )}
              {runs.data?.rows.map((j) => <RunRow key={j.id} j={j} />)}
            </CardContent>
          </Card>
          {runs.data && <Pager page={page} pageSize={20} total={runs.data.total} onPage={setPage} />}
        </div>
      )}
    </div>
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
          {j.budgetCap !== null && <Badge variant="outline" className="font-normal">Budget cap {fmtUsd(j.budgetCap)}</Badge>}
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

function ResultsTab({ j, live, onOpenCompany }: { j: Job; live: boolean; onOpenCompany: (id: string) => void }) {
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const q = useDebounced(search, 250)
  const results = useJobResults(j.id, { page, pageSize: 50, status: status === "all" ? undefined : status, q: q || undefined }, live)
  const c = results.data?.counts ?? {}
  const pending = (c.pending ?? 0) + (c.running ?? 0)
  const filters: [string, string, number][] = [
    ["all", "All", j.companies],
    ["signal", "Signals", c.signal ?? 0],
    ["no_signal", "No signal", c.no_signal ?? 0],
    ["failed", "Failed", c.failed ?? 0],
    ["pending", "Pending", pending],
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={status}
          onValueChange={(v) => {
            setStatus(v)
            setPage(0)
          }}
        >
          <TabsList>
            {filters.map(([key, label, count]) => (
              <TabsTrigger key={key} value={key} className="gap-1.5">
                {label}
                <span className="tabular rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{n(count)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v)
            setPage(0)
          }}
          placeholder="Search companies"
          label="Search companies in this run"
        />
      </div>
      <Card className={cn("py-0 transition-opacity", results.isPlaceholderData && "opacity-60")}>
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[52rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-64 pl-5">Company</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead>Findings</TableHead>
                <TableHead className="w-28 pr-5 text-right">Cost · time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.data?.rows.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="pl-5">
                    <button type="button" onClick={() => onOpenCompany(r.companyId)} className="text-left font-medium hover:text-brand-blue hover:underline">
                      {r.companyName}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {r.category && <Badge variant="outline">{r.category}</Badge>}
                      {r.cached && <Badge variant="secondary">cached</Badge>}
                      {r.attempts > 1 && <Badge variant="secondary">{r.attempts} attempts</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={asStatus(r.status)} />
                  </TableCell>
                  <TableCell className="whitespace-normal text-sm">
                    <Findings r={r} />
                  </TableCell>
                  <TableCell className="tabular pr-5 text-right text-xs text-muted-foreground">
                    {fmtUsd(r.cost, 4)}
                    <p>{r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)} s` : ""}</p>
                  </TableCell>
                </TableRow>
              ))}
              {results.data?.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 whitespace-normal text-center text-sm text-muted-foreground">
                    {j.status === "scheduled" ? "This run has not started yet." : q ? `No companies match “${q}”.` : "Nothing in this view."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {results.data && <Pager page={page} pageSize={50} total={results.data.total} onPage={setPage} />}
    </div>
  )
}

/** Per-PAM progress and delivery, paged on the server. */
function PamsTab({ runId }: { runId: string }) {
  const resend = useResend()
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<"all" | "attention" | "in_progress" | "done">("all")
  const [search, setSearch] = useState("")
  const q = useDebounced(search, 250)
  const jobs = usePamJobs(runId, { page, pageSize: 20, filter, search: q })
  const data = jobs.data

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={filter}
          onValueChange={(v) => {
            setFilter(v as typeof filter)
            setPage(0)
          }}
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="attention">Needs attention</TabsTrigger>
            <TabsTrigger value="in_progress">In progress</TabsTrigger>
            <TabsTrigger value="done">Done</TabsTrigger>
          </TabsList>
        </Tabs>
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v)
            setPage(0)
          }}
          placeholder="Search PAMs"
          label="Search PAMs in this run"
        />
      </div>
      <Card className={cn("py-0 transition-opacity", jobs.isPlaceholderData && "opacity-60")}>
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">PAM</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="text-right">Signals</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead className="pr-5 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.map((j) => (
                <TableRow key={j.pamId}>
                  <TableCell className="pl-5 font-medium">{j.pamName}</TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="w-44">
                    <div className="flex items-center gap-2">
                      <Progress value={pct(j.done, j.total)} className="h-1.5" />
                      <span className="tabular w-12 text-right text-xs text-muted-foreground">
                        {j.done}/{j.total}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">{j.withSignal}</TableCell>
                  <TableCell>
                    <StatusBadge status={j.email} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={j.whatsapp} />
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    {(j.email === "failed" || j.whatsapp === "failed") && (
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
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data && data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                    No PAMs in this view.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {data && <Pager page={page} pageSize={20} total={data.total} onPage={setPage} />}
    </div>
  )
}

function DigestsTab({ runId, live }: { runId: string; live: boolean }) {
  const notes = useJobNotifications(runId, live)
  const resend = useResendNotification()
  const rows: JobNotification[] = notes.data ?? []
  if (notes.isLoading) return <Skeleton className="h-40" />
  if (rows.length === 0)
    return (
      <EmptyState icon={BellRing} title="No digests yet">
        Each PAM's digest is queued the moment all of their companies are researched.
      </EmptyState>
    )
  return (
    <Card className="py-0">
      <CardContent className="overflow-x-auto p-0">
        <Table className="min-w-[48rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">PAM</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead className="pr-5" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((x) => (
              <TableRow key={x.id}>
                <TableCell className="pl-5">
                  <span className="font-medium">{x.pamName}</span>
                  <p className="text-xs text-muted-foreground">{x.recipient}</p>
                </TableCell>
                <TableCell className="capitalize">{x.channel}</TableCell>
                <TableCell>
                  <StatusBadge status={asStatus(x.status)} label={x.status} />
                </TableCell>
                <TableCell className="tabular">{x.attempts}</TableCell>
                <TableCell className="whitespace-normal text-sm text-muted-foreground">
                  {x.status === "sent" ? `Sent ${fmtDateTime(x.sentAt)}` : x.lastError}
                  {x.status === "pending" && x.nextAttemptAt && ` · next try ${fmtDateTime(x.nextAttemptAt)}`}
                </TableCell>
                <TableCell className="pr-5 text-right">
                  {(x.status === "failed" || x.status === "sent" || (x.status === "skipped" && x.recipient)) && (
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
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

type DetailTab = "live" | "results" | "pams" | "digests"

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
    <div className="space-y-6">
      <PageHeader title={`Run #${j.id}`} description={j.label} back={{ to: "/runs", label: "All research runs" }} actions={<RunActions job={j} />} />

      <ProgressHero j={j} rate={s?.ratePerSec} />

      <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
        <StatCard icon={Zap} tone="info" label="Signals" value={n(j.withSignal)} hint={`${pct(j.withSignal, Math.max(j.done, 1))}% of ${n(j.done)} researched`} />
        <StatCard icon={Ban} tone={j.failed ? "warning" : undefined} label="Failed" value={n(j.failed)} hint={j.failed ? "after automatic retries" : "none so far"} />
        <StatCard icon={BellRing} tone="success" label="Digests sent" value={`${n(j.notifications.sent)}/${n(digestsTotal)}`} hint={`${n(j.notifications.pending)} pending · ${n(j.notifications.failed)} failed${s ? ` · ${n(s.pamJobsTotal)} PAMs` : ""}`} />
        <StatCard icon={CircleDollarSign} tone="warning" label="Cost" value={fmtUsd(j.cost, 2)} hint={`est. ${fmtUsd(j.estimatedCost)} · ${n(j.cacheHits)} cache hits`} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setParams(v === fallback ? {} : { tab: v }, { replace: true })}>
        <TabsList>
          {started && (
            <TabsTrigger value="live" className="gap-1.5">
              {live ? <Radio className="text-info" /> : <Gauge />} {live ? "Live" : "Overview"}
            </TabsTrigger>
          )}
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="pams">PAMs</TabsTrigger>
          <TabsTrigger value="digests">Digests</TabsTrigger>
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
      </Tabs>

      <CompanyDrawer companyId={openCompany} onOpenChange={(o) => !o && setOpenCompany(null)} onReassign={(cid) => setReassign([cid])} />
      <ReassignDialog companyIds={reassign} open={reassign.length > 0} onOpenChange={(o) => !o && setReassign([])} />
    </div>
  )
}

/** Old /jobs and /jobs/:id links land on the merged runs pages. */
export function JobsRedirect() {
  const { id } = useParams()
  return <Navigate to={id ? `/runs/${id}` : "/runs"} replace />
}
