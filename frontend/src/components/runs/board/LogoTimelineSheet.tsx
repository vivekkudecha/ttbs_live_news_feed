/**
 * One logo, end to end, in a side sheet: its result, every step it went through in this run
 * (queued, each research attempt and retry, the PAM's digest), whether it made it into the
 * digest, and how it came out in earlier runs. Prev / next walk the logos shown in the table.
 */
import { Link } from "react-router-dom"
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  Inbox,
  Mail,
  MessageCircle,
  Play,
  RotateCcw,
  Sparkles,
  Timer,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLogoTimeline } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDate, fmtDateTime } from "@/lib/format"
import { fmtMs, kindLabel } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import type { LogoTimeline, ProcessEvent } from "@/api/types"
import { Avatar, Findings } from "./cells"

type Step = { id: string; ts: string; icon: LucideIcon; tone: string; title: string; detail?: string | null; meta: string[] }

const OUTCOME: Record<string, string> = { signal: "Signal found", no_signal: "No relevant news", failed: "Gave up" }

function stepOf(e: ProcessEvent): Step {
  const a = e.attrs as Record<string, unknown>
  const meta = [e.durationMs ? fmtMs(e.durationMs) : "", e.actor && e.actor !== "system" ? `by ${e.actor}` : ""].filter(Boolean)
  const base = { id: e.id, ts: e.ts, meta }
  if (e.kind === "research.attempt") {
    if (e.status === "retry") return { ...base, icon: RotateCcw, tone: "text-warning border-warning/50", title: `Attempt ${e.attempt ?? ""} hit a limit, retrying`, detail: e.message }
    if (e.status === "error") return { ...base, icon: XCircle, tone: "text-destructive border-destructive/40", title: `Attempt ${e.attempt ?? ""} failed`, detail: e.message }
    const outcome = String(a.outcome ?? "")
    return {
      ...base,
      icon: outcome === "signal" ? Zap : CheckCircle2,
      tone: outcome === "signal" ? "text-brand border-brand/40" : "text-success border-success/40",
      title: `${a.cached ? "Answer reused from cache" : `Researched${e.attempt && e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}`}: ${OUTCOME[outcome] ?? outcome}`,
      detail: a.category ? `Category: ${String(a.category)}` : null,
    }
  }
  if (e.kind.startsWith("notify.")) {
    const ch = String(a.channel ?? "")
    const Icon = ch === "whatsapp" ? MessageCircle : Mail
    const failed = e.status === "error"
    return {
      ...base,
      icon: Icon,
      tone: failed ? "text-destructive border-destructive/40" : e.status === "skipped" ? "text-muted-foreground" : "text-primary border-primary/40",
      title: `${kindLabel(e.kind)}${ch ? ` · ${ch}` : ""}`,
      detail: e.message,
    }
  }
  if (e.kind === "run.start") return { ...base, icon: Play, tone: "text-muted-foreground", title: "Run started", detail: null }
  if (e.kind === "run.finish") return { ...base, icon: Sparkles, tone: "text-muted-foreground", title: "Run finished", detail: e.message }
  if (e.kind.startsWith("run.retry")) return { ...base, icon: RotateCcw, tone: "text-primary border-primary/40", title: kindLabel(e.kind), detail: e.message }
  return { ...base, icon: Clock, tone: "text-muted-foreground", title: kindLabel(e.kind), detail: e.message }
}

export function LogoTimelineSheet({
  runId,
  resultId,
  live,
  canManage,
  onClose,
  prev,
  next,
  onNavigate,
  onRetry,
  onOpenCompany,
  onOpenDigest,
}: {
  runId: string
  resultId: string | null
  live: boolean
  canManage: boolean
  onClose: () => void
  prev?: string
  next?: string
  onNavigate: (id: string) => void
  onRetry: (resultId: string) => void
  onOpenCompany: (companyId: string) => void
  onOpenDigest: (pamId: string) => void
}) {
  const tl = useLogoTimeline(runId, resultId, live)
  const d = tl.data
  return (
    <Sheet open={!!resultId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 pb-4 pt-5">
          <div className="flex items-start gap-3 pr-8">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Building2 className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-lg">{d?.logo.companyName ?? "Loading…"}</SheetTitle>
              <SheetDescription className="truncate">
                {d ? [d.logo.industry, d.logo.segment, d.logo.pamName ?? "Unassigned"].filter(Boolean).join(" · ") : "Logo timeline"}
              </SheetDescription>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {d && <StatusBadge status={d.logo.status === "running" ? "running" : d.logo.status} />}
            {d?.logo.category && <Badge variant="outline">{d.logo.category}</Badge>}
            {d?.logo.cached && <Badge variant="secondary">from cache</Badge>}
            <div className="ml-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" className="size-8" disabled={!prev} onClick={() => prev && onNavigate(prev)} aria-label="Previous logo">
                    <ChevronUp />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Previous logo</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" className="size-8" disabled={!next} onClick={() => next && onNavigate(next)} aria-label="Next logo">
                    <ChevronDown />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Next logo</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {tl.isError ? (
            <p className="p-5 text-sm text-destructive">{errorMessage(tl.error)}</p>
          ) : !d ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-24" />
              <Skeleton className="h-64" />
            </div>
          ) : (
            <Body key={d.logo.id} d={d} canManage={canManage} onRetry={onRetry} onOpenCompany={onOpenCompany} onOpenDigest={onOpenDigest} stale={tl.isPlaceholderData} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Body({
  d,
  canManage,
  onRetry,
  onOpenCompany,
  onOpenDigest,
  stale,
}: {
  d: LogoTimeline
  canManage: boolean
  onRetry: (id: string) => void
  onOpenCompany: (id: string) => void
  onOpenDigest: (pamId: string) => void
  stale: boolean
}) {
  const steps: Step[] = [
    ...(d.logo.enqueuedAt ? [{ id: "q", ts: d.logo.enqueuedAt, icon: Inbox, tone: "text-muted-foreground", title: "Queued for research", meta: [] } as Step] : []),
    ...d.events.map(stepOf),
  ].sort((a, b) => a.ts.localeCompare(b.ts))
  return (
    <div className={cn("space-y-6 p-5 transition-opacity animate-in fade-in-0 duration-300", stale && "opacity-60")}>
      <div className="flex flex-wrap gap-2">
        {canManage && d.logo.status === "failed" && (
          <Button size="sm" onClick={() => onRetry(d.logo.id)}>
            <RotateCcw /> Retry research
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => onOpenCompany(d.logo.companyId)}>
          <Building2 /> Company profile
        </Button>
        {d.logo.pamId && (
          <Button size="sm" variant="outline" onClick={() => onOpenDigest(d.logo.pamId!)}>
            <Eye /> {d.logo.pamName?.split(" ")[0] ?? "PAM"}'s digest
          </Button>
        )}
      </div>

      <section className="rounded-xl border bg-card p-4 text-sm">
        <h3 className="eyebrow mb-2">Result</h3>
        <Findings r={d.logo} full />
        <dl className="mt-3 grid grid-cols-3 gap-3 border-t pt-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Attempts</dt>
            <dd className="tabular mt-0.5 font-medium">{d.logo.attempts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Research time</dt>
            <dd className="tabular mt-0.5 font-medium">{fmtMs(d.logo.latencyMs)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Finished</dt>
            <dd className="tabular mt-0.5 font-medium">{d.logo.finishedAt ? fmtDateTime(d.logo.finishedAt) : "—"}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3 className="eyebrow mb-3">Timeline</h3>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has happened to this logo yet.</p>
        ) : (
          <ol>
            {steps.map((s, i) => (
              <li key={s.id} className="relative flex gap-3 pb-5 animate-in fade-in-0 slide-in-from-left-1" style={{ animationDelay: `${Math.min(i, 12) * 30}ms`, animationFillMode: "both" }}>
                {i < steps.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px bg-border" aria-hidden="true" />}
                <span className={cn("relative z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-card", s.tone)}>
                  <s.icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{s.title}</span>
                    <span className="tabular ml-auto text-xs text-muted-foreground">{fmtDateTime(s.ts)}</span>
                  </div>
                  {s.detail && <p className="mt-0.5 break-words text-sm text-muted-foreground">{s.detail}</p>}
                  {s.meta.length > 0 && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Timer className="size-3" /> {s.meta.join(" · ")}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3 className="eyebrow mb-3">In {d.logo.pamName ? `${d.logo.pamName}'s` : "the"} digest</h3>
        {d.digests.length === 0 ? (
          <p className="text-sm text-muted-foreground">The digest is built when the last of this PAM's logos is researched.</p>
        ) : (
          <div className="space-y-2">
            {d.digests.map((g) => {
              const Icon = g.channel === "whatsapp" ? MessageCircle : Mail
              return (
                <div key={g.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium capitalize">
                      {g.channel} · <span className="font-normal normal-case text-muted-foreground">{g.recipient ?? "no recipient"}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {g.status === "sent" ? `Sent ${fmtDateTime(g.sentAt)}` : (g.lastError ?? g.status)} · {g.signals ?? 0} signals
                    </p>
                  </div>
                  {g.includesLogo ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                      <CheckCircle2 className="size-3.5" /> Included
                    </span>
                  ) : d.logo.status === "signal" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
                          <AlertTriangle className="size-3.5" /> Missing
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>This signal arrived after the digest was built. Resend the digest to include it.</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not listed</span>
                  )}
                  <StatusBadge status={g.status === "sending" ? "running" : g.status} />
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h3 className="eyebrow mb-3">Earlier runs</h3>
        {d.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">First time this logo was researched.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {d.history.map((h) => (
              <li key={h.runId}>
                <Link to={`/runs/${h.runId}`} className="flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/60">
                  <Avatar name={h.label || h.runId} className="size-7 text-[10px]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">Run #{h.runId}</p>
                    <p className="truncate text-xs text-muted-foreground">{h.windowEnd ? `Window to ${fmtDate(h.windowEnd)}` : h.label}</p>
                  </div>
                  {h.category && <Badge variant="outline">{h.category}</Badge>}
                  <StatusBadge status={h.status === "running" ? "running" : h.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
