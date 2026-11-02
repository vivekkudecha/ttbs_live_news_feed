import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, Clock, Coins, Database, Mail, MessageCircle, RefreshCw, RotateCcw, Users, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useCompanies, usePams, useResend, useResults, useRun, useRuns } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { durationMin, fmtDate, fmtDateTime, fmtUsd, pct } from "@/lib/format"
import { NewRunDialog } from "./Schedules"

export function RunsList() {
  const { user } = useSession()
  const runs = useRuns()
  return (
    <div>
      <PageHeader
        title="Research runs"
        description="Every scheduled or ad-hoc run, split into one job per PAM. Each run records the template version and provider it used."
        actions={can.runJobs(user!.role) && <NewRunDialog />}
      />
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[52rem]">
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
                    <Link to={`/runs/${r.id}`} className="font-medium hover:text-primary hover:underline">
                      {r.id}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {r.label} · <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">{r.trigger}</Badge>
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {fmtDate(r.windowStart)} – {fmtDate(r.windowEnd)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="w-48">
                    <div className="flex items-center gap-2">
                      <Progress value={pct(r.done, r.companies)} className="h-1.5" />
                      <span className="tabular w-14 text-right text-xs text-muted-foreground">
                        {r.done}/{r.companies}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">{r.withSignal}</TableCell>
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

export function RunDetail() {
  const { id = "" } = useParams()
  const { user } = useSession()
  const run = useRun(id)
  const results = useResults(id)
  const pams = usePams()
  const companies = useCompanies()
  const resend = useResend()

  if (run.isLoading || !pams.data || !companies.data) return <Skeleton className="h-96" />
  if (!run.data) return <p className="text-sm text-muted-foreground">Run not found.</p>
  const r = run.data
  const pamName = (pid: string) => pams.data!.find((p) => p.id === pid)?.name ?? pid
  const failed = results.data?.filter((x) => x.status === "failed") ?? []
  const avgLatency = results.data?.length
    ? Math.round(results.data.filter((x) => x.latencyMs).reduce((s, x) => s + x.latencyMs, 0) / Math.max(1, results.data.filter((x) => x.latencyMs).length) / 1000)
    : 0
  const manage = can.runJobs(user!.role)

  return (
    <div className="space-y-8">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to="/runs">
            <ArrowLeft /> All runs
          </Link>
        </Button>
        <PageHeader
          title={`${r.id} · ${r.label}`}
          description={
            <>
              Window {fmtDate(r.windowStart)} – {fmtDate(r.windowEnd)} · {r.provider} <code className="text-xs">{r.model}</code> · template v{r.templateVersion} ·
              triggered by {r.triggeredBy}
            </>
          }
          actions={<StatusBadge status={r.status} className="h-6 px-2.5 text-sm" />}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
        <StatCard icon={Users} label="Companies researched" value={`${r.done}/${r.companies}`} hint={`${r.pamJobs.length} PAM jobs`} />
        <StatCard icon={Zap} tone="info" label="Actionable signals" value={r.withSignal} hint={`${pct(r.withSignal, Math.max(r.done, 1))}% hit rate · ${r.failed} failed`} />
        <StatCard icon={Coins} tone="warning" label="Cost" value={fmtUsd(r.cost)} hint={`Estimate was ${fmtUsd(r.estimatedCost)}`} />
        <StatCard icon={Database} tone="success" label="Cache hits" value={r.cacheHits} hint={`Avg latency ${avgLatency}s · ${durationMin(r.startedAt, r.finishedAt)}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Jobs by PAM</CardTitle>
          <CardDescription>Each PAM's digest is prioritized and delivered once their companies finish. Delivery uses a transactional outbox, so resends are safe.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
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
              {r.pamJobs.map((j) => (
                <TableRow key={j.pamId}>
                  <TableCell className="pl-6 font-medium">{pamName(j.pamId)}</TableCell>
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
                    {manage && (j.email === "sent" || j.email === "failed") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={resend.isPending}
                        onClick={async () => {
                          await resend.mutateAsync({ runId: r.id, pamId: j.pamId, actor: user!.username })
                          toast.success(`Digest re-sent to ${pamName(j.pamId)}`, { description: "Email + WhatsApp re-queued via outbox" })
                        }}
                      >
                        <RefreshCw /> Resend
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {failed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Failed companies</CardTitle>
            <CardDescription>Retried 5 times with exponential backoff before being marked failed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {failed.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
                <span className="font-medium">{companies.data!.find((c) => c.id === f.companyId)?.name}</span>
                <span className="text-muted-foreground">{f.error}</span>
                {manage && (
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => toast.success("Retry queued")}>
                    <RotateCcw /> Retry
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>How this run was processed</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            {[
              [Clock, "Dispatch", "Schedule picked up, budget pre-check passed, PAM assignments snapshotted"],
              [Zap, "Research", `${r.companies} companies through rate limiter (45 rps), retries with backoff`],
              [Users, "Prioritize", "One ranking pass per PAM on their signals only"],
              [Mail, "Email", "HTML digest + Excel attachment per PAM"],
              [MessageCircle, "WhatsApp", "Approved template + document header"],
            ].map(([Icon, title, text], i) => {
              const I = Icon as typeof Clock
              return (
                <li key={i} className="rounded-lg border p-3">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="tabular flex size-5 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">{i + 1}</span>
                    <I className="size-3.5 text-muted-foreground" /> {title as string}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{text as string}</p>
                </li>
              )
            })}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
