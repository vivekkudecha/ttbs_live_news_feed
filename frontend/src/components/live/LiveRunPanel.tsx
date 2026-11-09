import { useEffect, useState } from "react"
import { CheckCircle2, MailCheck, Radio, Timer, Zap } from "lucide-react"
import { CategoryBadge } from "@/components/common/SignalCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { LiveGrid, LiveLegend } from "./LiveGrid"
import { useLiveRun } from "./useLiveRun"
import { cn } from "@/lib/utils"
import { Page, Split } from "@/components/common/layout"
import { LiveDot } from "@/components/common/LiveDot"

const n = (x: number) => Math.round(x).toLocaleString("en-IN")

function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 2 ? "now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
}
function fmtDuration(sec: number) {
  if (!isFinite(sec) || sec <= 0) return "—"
  const m = Math.floor(sec / 60),
    s = Math.round(sec % 60)
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`
}

/**
 * Logo-by-logo research progress. Results are usable the moment each logo finishes:
 * click any finished cell or feed row to open its result, and each PAM's digest is sent
 * as soon as that PAM's logos are done, without waiting for the whole run.
 */
export function LiveRunPanel({ runId, finishedAt, onOpenCompany }: { runId: string; finishedAt?: string | null; onOpenCompany: (companyId: string) => void }) {
  const live = useLiveRun(runId)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!live) return <Skeleton className="h-[28rem]" />

  const running = live.status === "running"
  const remaining = live.total - live.done
  const eta = running && live.ratePerSec > 0 ? remaining / live.ratePerSec : 0
  // Finished runs report their real duration; running ones count up.
  const elapsed = ((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(live.startedAt)) / 1000
  const percent = live.total ? (live.done / live.total) * 100 : 0

  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {running ? (
              <LiveDot />
            ) : (
              <CheckCircle2 className="size-4 text-success" />
            )}
            {running ? "Researching live" : "Research complete"}
          </CardTitle>
          <CardDescription>
            {running ? "Results appear logo by logo. You don't have to wait for the whole run." : "Every logo in this run has a result."}
          </CardDescription>
          <CardAction>
            <StatusBadge status={live.status} />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-baseline justify-between gap-4">
            <p className="tabular text-3xl font-medium tracking-tight">
              {n(live.done)}
              <span className="text-lg text-muted-foreground"> / {n(live.total)} logos</span>
            </p>
            <p className="tabular text-2xl font-medium text-muted-foreground">{percent.toFixed(percent < 10 ? 1 : 0)}%</p>
          </div>
          <Progress value={percent} className="h-2" />
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Zap className="size-3.5" /> Signals so far
              </dt>
              <dd className="tabular mt-1 text-lg font-medium">{n(live.signals)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Radio className="size-3.5" /> Throughput
              </dt>
              <dd className="tabular mt-1 text-lg font-medium">{running ? `${live.ratePerSec.toFixed(0)} / s` : "—"}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Timer className="size-3.5" /> {running ? "Time left" : "Took"}
              </dt>
              <dd className="tabular mt-1 text-lg font-medium">{running ? fmtDuration(eta) : fmtDuration(elapsed)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MailCheck className="size-3.5" /> PAM digests sent
              </dt>
              <dd className="tabular mt-1 text-lg font-medium">
                {n(live.pamsDone)}
                <span className="text-sm text-muted-foreground"> / {n(live.pamsTotal)}</span>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Split>
        <Card>
          <CardHeader>
            <CardTitle>Logo map</CardTitle>
            <CardDescription>One square per logo, grouped by PAM. Hover for details; click a finished logo to open its result.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <LiveGrid state={live} onSelect={onOpenCompany} />
            <LiveLegend />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="gap-0">
            <CardHeader className="pb-3">
              <CardTitle>Latest results</CardTitle>
              <CardDescription>{running ? "Newest first, as they finish" : "Last logos to finish"}</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {live.recent.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">{running ? "Waiting for the next logo to finish…" : "Open any cell in the logo map to see its result."}</p>
              ) : (
                <ul className="max-h-[26rem] overflow-y-auto" aria-label="Latest research results">
                  {live.recent.map((r) => (
                    <li key={`${r.i}-${r.at}`}>
                      <button
                        type="button"
                        onClick={() => onOpenCompany(live.companyIds[r.i])}
                        className={cn("flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors hover:bg-muted/60", now - r.at < 1500 && "bg-accent/60")}
                      >
                        <span className={cn("size-2 shrink-0 rounded-full", r.s === 1 ? "bg-brand" : r.s === 3 ? "bg-destructive" : "bg-chart-1")} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{r.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{r.pamName}</span>
                        </span>
                        {r.s === 1 ? <CategoryBadge category={r.category} /> : <span className="text-xs text-muted-foreground">{r.s === 3 ? "Failed" : "No signal"}</span>}
                        <span className="tabular w-12 shrink-0 text-right text-xs text-muted-foreground">{ago(r.at, now)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="gap-0">
            <CardHeader className="pb-3">
              <CardTitle>Digests sent early</CardTitle>
              <CardDescription>Each PAM gets their email and WhatsApp as soon as their logos finish</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {live.pamsCompleted.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">{running ? "The first digests go out as soon as a PAM's logos are all done." : `${n(live.pamsDone)} PAM digests were sent for this run.`}</p>
              ) : (
                <ul className="max-h-60 overflow-y-auto">
                  {live.pamsCompleted.map((p) => (
                    <li key={p.pamId} className="flex items-center gap-3 px-5 py-2 text-sm">
                      <MailCheck className="size-4 shrink-0 text-success" />
                      <span className="min-w-0 flex-1 truncate">{p.pamName}</span>
                      <span className="tabular text-xs text-muted-foreground">
                        {p.withSignal}/{p.total} signals
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </Split>
    </Page>
  )
}
