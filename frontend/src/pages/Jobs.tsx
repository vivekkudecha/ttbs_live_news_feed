import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"
import { Ban, BellRing, CircleDollarSign, Database, ExternalLink, ListChecks, Loader2, RotateCcw, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { RichText, safeHref } from "@/components/common/RichText"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge, type AnyStatus } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { backendEnabled, errorMessage } from "@/api/http"
import { useCancelJob, useJob, useJobNotifications, useJobResults, useJobs, useQueues, useResendNotification, useRetryFailed } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDateTime, fmtUsd, pct } from "@/lib/format"
import type { Job, JobNotification, JobResult } from "@/api/types"

const ACTIVE = new Set(["scheduled", "queued", "running"])
const asStatus = (s: string): AnyStatus => (s === "sending" ? "running" : (s as AnyStatus))

function Disabled() {
  return (
    <EmptyState icon={Database} title="Backend not connected">
      Set <code>VITE_API_URL</code> in <code>frontend/.env.development</code> and start the API server to see real research jobs.
    </EmptyState>
  )
}

function JobProgress({ job }: { job: Job }) {
  const p = pct(job.done, job.companies)
  return (
    <div className="flex items-center gap-2">
      <Progress value={p} className="h-1.5 w-28" aria-label={`${p}% done`} />
      <span className="tabular text-xs text-muted-foreground">
        {job.done.toLocaleString("en-IN")}/{job.companies.toLocaleString("en-IN")}
      </span>
    </div>
  )
}

function QueueCard() {
  const q = useQueues()
  if (!q.data) return null
  const b = q.data.broker
  const items: [string, number | null][] = [
    ["Research queue", b.research],
    ["Notify queue", b.notify],
    ["Maintenance queue", b.maintenance],
    ["Companies pending", q.data.db.researchPending],
    ["In progress", q.data.db.researchRunning],
    ["Digests pending", q.data.db.notificationsPending],
  ]
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-sm">Queues</CardTitle>
        <CardDescription>Broker depth and outstanding work. Refreshes every 5 s.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {items.map(([label, v]) => (
            <div key={label} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="tabular text-lg font-semibold">{v === null ? "—" : v.toLocaleString("en-IN")}</dd>
            </div>
          ))}
        </dl>
        {b.research === null && <p className="mt-2 text-xs text-destructive">Broker unreachable: is Redis running?</p>}
      </CardContent>
    </Card>
  )
}

export function JobsList() {
  const [page, setPage] = useState(0)
  const jobs = useJobs({ page, pageSize: 25 })
  if (!backendEnabled) return <Disabled />
  const total = jobs.data?.total ?? 0

  return (
    <div>
      <PageHeader title="Jobs" description="Research jobs on the live backend: queued, scheduled, running and finished." />
      <QueueCard />
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[56rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Signals</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Digests</TableHead>
                <TableHead className="pr-5 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.isError && (
                <TableRow>
                  <TableCell colSpan={7} className="pl-5 text-sm text-destructive">
                    {errorMessage(jobs.error)}
                  </TableCell>
                </TableRow>
              )}
              {jobs.data?.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="pl-5 text-sm text-muted-foreground">
                    No jobs yet. Commit an import with “Research these companies now”, or use Run now on Schedules.
                  </TableCell>
                </TableRow>
              )}
              {jobs.data?.rows.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="pl-5">
                    <Link to={`/jobs/${j.id}`} className="font-medium hover:underline">
                      #{j.id} · {j.label}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {j.status === "scheduled" ? `Scheduled for ${fmtDateTime(j.scheduledFor)}` : `Started ${fmtDateTime(j.startedAt ?? j.scheduledFor)}`} · by {j.triggeredBy}
                    </p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} />
                  </TableCell>
                  <TableCell>
                    <JobProgress job={j} />
                  </TableCell>
                  <TableCell className="tabular">{j.withSignal}</TableCell>
                  <TableCell className="tabular">{j.failed}</TableCell>
                  <TableCell className="tabular text-xs text-muted-foreground">
                    {j.notifications.sent} sent
                    {j.notifications.pending > 0 && ` · ${j.notifications.pending} pending`}
                    {j.notifications.failed > 0 && <span className="text-destructive"> · {j.notifications.failed} failed</span>}
                  </TableCell>
                  <TableCell className="tabular pr-5 text-right">{fmtUsd(j.cost, 3)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {total > 25 && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {page + 1} of {Math.ceil(total / 25)}
          </span>
          <Button variant="outline" size="sm" disabled={(page + 1) * 25 >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function ResultRow({ r }: { r: JobResult }) {
  return (
    <TableRow className="align-top">
      <TableCell className="pl-5">
        <span className="font-medium">{r.companyName}</span>
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
        {r.status === "signal" ? (
          <div className="space-y-1.5">
            <RichText text={r.keySignals ?? undefined} />
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
              <div className="flex flex-wrap gap-2 pt-0.5">
                {r.sources.map((s) => (
                  <a key={s.url} href={safeHref(s.url)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                    <ExternalLink className="size-3" /> {s.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : r.status === "failed" ? (
          <span className="text-destructive">{r.error}</span>
        ) : r.status === "no_signal" ? (
          <span className="text-muted-foreground">No TTBS-relevant news in the window.</span>
        ) : (
          <span className="text-muted-foreground">{r.error ? `Retrying: ${r.error}` : "Waiting in queue…"}</span>
        )}
      </TableCell>
      <TableCell className="tabular pr-5 text-right text-xs text-muted-foreground">
        {fmtUsd(r.cost, 4)}
        <p>{r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)} s` : ""}</p>
      </TableCell>
    </TableRow>
  )
}

function NotificationsTable({ jobId, live, editable }: { jobId: string; live: boolean; editable: boolean }) {
  const notes = useJobNotifications(jobId, live)
  const resend = useResendNotification()
  const rows: JobNotification[] = notes.data ?? []
  if (rows.length === 0)
    return <p className="px-5 py-6 text-sm text-muted-foreground">No digests yet. Each PAM's digest is queued as soon as all of their companies are researched.</p>
  return (
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
        {rows.map((n) => (
          <TableRow key={n.id}>
            <TableCell className="pl-5">
              <span className="font-medium">{n.pamName}</span>
              <p className="text-xs text-muted-foreground">{n.recipient}</p>
            </TableCell>
            <TableCell className="capitalize">{n.channel}</TableCell>
            <TableCell>
              <StatusBadge status={asStatus(n.status)} label={n.status} />
            </TableCell>
            <TableCell className="tabular">{n.attempts}</TableCell>
            <TableCell className="whitespace-normal text-xs text-muted-foreground">
              {n.status === "sent" ? `Sent ${fmtDateTime(n.sentAt)}` : n.lastError}
              {n.status === "pending" && n.nextAttemptAt && ` · next try ${fmtDateTime(n.nextAttemptAt)}`}
            </TableCell>
            <TableCell className="pr-5 text-right">
              {editable && (n.status === "failed" || n.status === "sent" || (n.status === "skipped" && n.recipient)) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={resend.isPending}
                  onClick={() =>
                    resend.mutate(n.id, {
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
  )
}

export function JobDetail() {
  const { id = "" } = useParams()
  const { user } = useSession()
  const editable = can.runJobs(user!.role)
  const job = useJob(id)
  const [tab, setTab] = useState("all")
  const [view, setView] = useState<"results" | "digests">("results")
  const [page, setPage] = useState(0)
  const live = !!job.data && ACTIVE.has(job.data.status)
  const results = useJobResults(id, { page, pageSize: 50, status: tab === "all" ? undefined : tab }, live)
  const cancel = useCancelJob()
  const retry = useRetryFailed()

  if (!backendEnabled) return <Disabled />
  if (job.isError) return <EmptyState icon={ListChecks} title="Job not available">{errorMessage(job.error)}</EmptyState>
  if (!job.data) return <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" />
  const j = job.data
  const counts = results.data?.counts ?? {}
  const total = results.data?.total ?? 0

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Job #${j.id}`}
        description={j.label}
        back={{ to: "/jobs", label: "All jobs" }}
        actions={
          editable && (
            <>
              {ACTIVE.has(j.status) && (
                <Button
                  variant="outline"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(j.id, { onSuccess: () => toast.success("Job cancelled"), onError: (e) => toast.error("Could not cancel", { description: errorMessage(e) }) })}
                >
                  <Ban /> Cancel
                </Button>
              )}
              {!ACTIVE.has(j.status) && j.failed > 0 && (
                <Button
                  disabled={retry.isPending}
                  onClick={() =>
                    retry.mutate(j.id, {
                      onSuccess: (r) => toast.success(`${r.requeued} companies re-queued`),
                      onError: (e) => toast.error("Could not retry", { description: errorMessage(e) }),
                    })
                  }
                >
                  <RotateCcw /> Retry {j.failed} failed
                </Button>
              )}
            </>
          )
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
          <StatusBadge status={j.status} />
          <JobProgress job={j} />
          <span className="text-muted-foreground">
            {j.status === "scheduled" ? `Scheduled for ${fmtDateTime(j.scheduledFor)}` : `Started ${fmtDateTime(j.startedAt)}`}
            {j.finishedAt && ` · finished ${fmtDateTime(j.finishedAt)}`}
          </span>
          {j.windowStart && (
            <span className="text-muted-foreground">
              News window {j.windowStart} → {j.windowEnd}
            </span>
          )}
          <span className="text-muted-foreground">
            {j.provider} · {j.model}
          </span>
          {j.error && <span className="text-destructive">{j.error}</span>}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Signals" value={j.withSignal.toLocaleString("en-IN")} hint={`of ${j.done.toLocaleString("en-IN")} researched`} icon={Zap} />
        <StatCard label="Failed" value={j.failed.toLocaleString("en-IN")} hint="after automatic retries" icon={Ban} />
        <StatCard label="Cost" value={fmtUsd(j.cost, 3)} hint={`${j.cacheHits} cache hits · est. ${fmtUsd(j.estimatedCost)}`} icon={CircleDollarSign} />
        <StatCard label="Digests sent" value={j.notifications.sent} hint={`${j.notifications.pending} pending · ${j.notifications.skipped} skipped · ${j.notifications.failed} failed`} icon={BellRing} />
      </div>

      <Card className="py-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 pt-5">
          <Tabs value={view} onValueChange={(v) => setView(v as "results" | "digests")}>
            <TabsList>
              <TabsTrigger value="results">Results</TabsTrigger>
              <TabsTrigger value="digests">Digests</TabsTrigger>
            </TabsList>
          </Tabs>
          {view === "results" && (
            <Tabs
              value={tab}
              onValueChange={(v) => {
                setTab(v)
                setPage(0)
              }}
            >
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="signal">Signals {counts.signal ? `(${counts.signal})` : ""}</TabsTrigger>
                <TabsTrigger value="no_signal">No signal {counts.no_signal ? `(${counts.no_signal})` : ""}</TabsTrigger>
                <TabsTrigger value="failed">Failed {counts.failed ? `(${counts.failed})` : ""}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {view === "digests" ? (
            <NotificationsTable jobId={j.id} live={live} editable={editable} />
          ) : (
            <Table className="min-w-[52rem]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64 pl-5">Company</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead>Findings</TableHead>
                  <TableHead className="w-24 pr-5 text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.data?.rows.map((r) => <ResultRow key={r.id} r={r} />)}
                {results.data?.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="pl-5 text-sm text-muted-foreground">
                      {j.status === "scheduled" ? "This job has not started yet." : "Nothing here."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {view === "results" && total > 50 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {page + 1} of {Math.ceil(total / 50)}
          </span>
          <Button variant="outline" size="sm" disabled={(page + 1) * 50 >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
