import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ChevronLeft, ChevronRight, Coins, Database, Radio, RefreshCw, Search, Users, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { LiveRunPanel } from "@/components/live/LiveRunPanel"
import { CompanyDrawer } from "@/components/companies/CompanyDrawer"
import { ReassignDialog } from "@/components/companies/ReassignDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePamJobs, useResend, useRun, useRuns } from "@/api/hooks"
import { useSession } from "@/context/session"
import { useDebounced } from "@/lib/use-debounced"
import { durationMin, fmtDate, fmtDateTime, fmtUsd, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import { NewRunDialog } from "./Schedules"

const n = (x: number) => x.toLocaleString("en-IN")

export function RunsList() {
  const runs = useRuns()
  return (
    <div>
      <PageHeader
        title="Research runs"
        description="Every scheduled or ad-hoc run. Results stream in logo by logo, and each PAM's digest goes out as soon as their logos finish."
        actions={<NewRunDialog />}
      />
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[56rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Run</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="text-right">Signals</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="pr-5">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5">
                    <Link to={`/runs/${r.id}`} className="font-medium hover:text-brand-blue hover:underline">
                      {r.id}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {r.label} ·{" "}
                      <Badge variant="outline" className="h-4 px-1.5 text-[11.5px] font-normal">
                        {r.trigger}
                      </Badge>
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {fmtDate(r.windowStart)} – {fmtDate(r.windowEnd)}
                  </TableCell>
                  <TableCell>
                    {r.status === "running" ? (
                      <Link to={`/runs/${r.id}`} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-blue hover:underline">
                        <Radio className="size-3.5" /> Watch live
                      </Link>
                    ) : (
                      <StatusBadge status={r.status} />
                    )}
                  </TableCell>
                  <TableCell className="w-56">
                    <div className="flex items-center gap-2">
                      <Progress value={pct(r.done, r.companies)} className="h-1.5" />
                      <span className="tabular w-24 text-right text-xs text-muted-foreground">
                        {n(r.done)}/{n(r.companies)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">{n(r.withSignal)}</TableCell>
                  <TableCell className="tabular text-right">{fmtUsd(r.cost)}</TableCell>
                  <TableCell className="pr-5 text-sm text-muted-foreground">
                    {fmtDateTime(r.startedAt)}
                    <p className="text-xs">by {r.triggeredBy}</p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

/** Per-PAM jobs, paged on the server (a run can span 5,000 PAMs). */
function PamJobsCard({ runId }: { runId: string }) {
  const { user } = useSession()
  const resend = useResend()
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<"all" | "attention" | "in_progress" | "done">("all")
  const [search, setSearch] = useState("")
  const q = useDebounced(search, 250)
  const jobs = usePamJobs(runId, { page, pageSize: 10, filter, search: q })
  const data = jobs.data
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jobs by PAM</CardTitle>
        <CardDescription>Each PAM's digest is prioritized and delivered as soon as their logos finish. Resends go through the outbox, so they are safe to repeat.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <div className="flex flex-col gap-3 px-6 sm:flex-row sm:items-center">
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
          <div className="relative sm:ml-auto sm:w-64">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search PAMs in this run"
              placeholder="Search PAM"
              className="h-9 pl-8"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
          </div>
        </div>
        <div className={cn("overflow-x-auto transition-opacity", jobs.isPlaceholderData && "opacity-60")}>
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">PAM</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="text-right">Signals</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead className="pr-6 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.map((j) => (
                <TableRow key={j.pamId}>
                  <TableCell className="pl-6">
                    <span className="font-medium">{j.pamName}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="w-44">
                    <div className="flex items-center gap-2">
                      <Progress value={pct(j.done, j.total)} className="h-1.5" />
                      <span className="tabular w-10 text-right text-xs text-muted-foreground">
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
                  <TableCell className="pr-6 text-right">
                    {(j.email === "sent" || j.email === "failed") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={resend.isPending}
                        onClick={async () => {
                          await resend.mutateAsync({ runId, pamId: j.pamId, actor: user!.username })
                          toast.success(`Digest re-sent to ${j.pamName}`, { description: "Email + WhatsApp re-queued via outbox" })
                        }}
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
                    No PAMs match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between px-6 text-[0.9375rem] text-muted-foreground">
          <span className="tabular">{data ? `${n(data.total)} PAMs` : "…"}</span>
          <div className="flex items-center gap-3">
            <span className="tabular">
              Page {n(page + 1)} of {n(pages)}
            </span>
            <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function RunDetail() {
  const { id = "" } = useParams()
  const run = useRun(id)
  const [openCompany, setOpenCompany] = useState<string | null>(null)
  const [reassign, setReassign] = useState<string[]>([])

  if (run.isLoading) return <Skeleton className="h-96" />
  if (!run.data) return <p className="text-sm text-muted-foreground">Run not found.</p>
  const r = run.data

  return (
    <div className="space-y-8">
      <PageHeader
        back={{ to: "/runs", label: "All runs" }}
        title={`${r.id} · ${r.label}`}
        description={
          <>
            Window {fmtDate(r.windowStart)} – {fmtDate(r.windowEnd)} · {r.provider} <code className="text-xs">{r.model}</code> · template v{r.templateVersion} · triggered by {r.triggeredBy}
          </>
        }
      />

      {/* While a run is live, the streamed panel below is the single source of truth for progress. */}
      {r.status !== "running" && (
        <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
          <StatCard icon={Users} label="Companies researched" value={`${n(r.done)}/${n(r.companies)}`} hint={`${n(r.pamJobsTotal)} PAM jobs · ${n(r.pamJobsDone)} done`} />
          <StatCard icon={Zap} tone="info" label="Actionable signals" value={n(r.withSignal)} hint={`${pct(r.withSignal, Math.max(r.done, 1))}% hit rate · ${n(r.failed)} failed`} />
          <StatCard icon={Coins} tone="warning" label="Cost" value={fmtUsd(r.cost)} hint={`Estimate was ${fmtUsd(r.estimatedCost)}`} />
          <StatCard icon={Database} tone="success" label="Cache hits" value={n(r.cacheHits)} hint={r.finishedAt ? `Took ${durationMin(r.startedAt, r.finishedAt)}` : "Still running"} />
        </div>
      )}

      <LiveRunPanel runId={r.id} finishedAt={r.finishedAt} onOpenCompany={setOpenCompany} />

      <PamJobsCard runId={r.id} />

      {r.failed > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Failed companies</CardTitle>
            <CardDescription>{n(r.failed)} logos failed after 5 retries with exponential backoff. They are retried automatically in the next cycle.</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" asChild>
                <Link to="/signals">Review in signals feed</Link>
              </Button>
            </CardAction>
          </CardHeader>
        </Card>
      )}

      <CompanyDrawer companyId={openCompany} onOpenChange={(o) => !o && setOpenCompany(null)} onReassign={(cid) => setReassign([cid])} />
      <ReassignDialog companyIds={reassign} open={reassign.length > 0} onOpenChange={(o) => !o && setReassign([])} />
    </div>
  )
}
