/**
 * The logo drawer: everything about one logo in one wide side panel, opened from anywhere a logo
 * is clicked (run results, live grid, companies, signals, dashboard).
 *
 *   Run #N      this run's result, its step-by-step timeline, and whether it made the PAM's digest
 *   Digest      the PAM's email for that run (as sent, or rendered now from the current results)
 *   History     every research cycle of the logo
 *   Ownership   every PAM it has had
 *   Details     profile and research totals
 *
 * Mounted once by <LogoDrawerProvider> (AppShell); the open logo is in the URL.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  AlertTriangle,
  ArrowRightLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock,
  ExternalLink,
  FileSpreadsheet,
  Inbox,
  Mail,
  MapPin,
  MessageCircle,
  Play,
  RotateCcw,
  Send,
  Shuffle,
  Sparkles,
  Timer,
  UserRound,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { ResultSections } from "@/components/common/ResultSections"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Timeline, type TimelineItem } from "@/components/common/Timeline"
import { ReassignDialog } from "@/components/companies/ReassignDialog"
import { Avatar } from "@/components/runs/board/cells"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useBoardResend, useBoardRetry, useCompanyDetail, useCompanyRunTimeline, usePamDigest } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { useSession } from "@/context/session"
import { can } from "@/lib/access"
import { fmtDate, fmtDateTime, initials } from "@/lib/format"
import { fmtMs, kindLabel } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import type { AssignmentReason, CompanyDetail, LogoTimeline, ProcessEvent } from "@/api/types"
import { LogoDrawerContext, type LogoDrawerApi, type LogoTarget } from "./logo-drawer-context"

// ---- Provider ---------------------------------------------------------------------------------------

export function LogoDrawerProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const [siblings, setSiblings] = useState<LogoTarget[]>([])
  const [reassign, setReassign] = useState<string[]>([])
  const companyId = params.get("logo")
  const runId = params.get("logoRun") ?? undefined
  const current = useMemo(() => (companyId ? { companyId, runId } : null), [companyId, runId])

  const show = useCallback(
    (t: LogoTarget | null, replace: boolean) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete("logo")
          next.delete("logoRun")
          if (t) {
            next.set("logo", t.companyId)
            if (t.runId) next.set("logoRun", t.runId)
          }
          return next
        },
        { replace },
      ),
    [setParams],
  )
  const api: LogoDrawerApi = useMemo(
    () => ({
      open: ({ siblings: sib, ...t }) => {
        setSiblings(sib ?? [])
        show(t, !!current) // the first open is a history entry (Back closes); stepping between logos is not
      },
      close: () => show(null, true),
      current,
    }),
    [show, current],
  )
  const idx = current ? siblings.findIndex((s) => s.companyId === current.companyId && (s.runId ?? null) === (current.runId ?? null)) : -1

  return (
    <LogoDrawerContext.Provider value={api}>
      {children}
      <LogoDrawer
        target={current}
        onClose={api.close}
        prev={idx > 0 ? siblings[idx - 1] : undefined}
        next={idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : undefined}
        onNavigate={(t) => show(t, true)}
        onReassign={(id) => setReassign([id])}
      />
      <ReassignDialog companyIds={reassign} open={reassign.length > 0} onOpenChange={(o) => !o && setReassign([])} />
    </LogoDrawerContext.Provider>
  )
}

// ---- Drawer -------------------------------------------------------------------------------------------

function LogoDrawer({
  target,
  onClose,
  prev,
  next,
  onNavigate,
  onReassign,
}: {
  target: LogoTarget | null
  onClose: () => void
  prev?: LogoTarget
  next?: LogoTarget
  onNavigate: (t: LogoTarget) => void
  onReassign: (companyId: string) => void
}) {
  const { user } = useSession()
  const canRuns = can(user, "runs")
  const companyId = target?.companyId ?? null
  const detail = useCompanyDetail(companyId)
  const d = detail.data ?? undefined
  // Without a run, show the logo's latest one.
  const runId = target?.runId ?? d?.cycles[0]?.run.id
  const tl = useCompanyRunTimeline(runId, companyId, canRuns)
  const t = tl.data && tl.data.logo.companyId === companyId ? tl.data : undefined
  const [tab, setTab] = useState("run")
  const hasRun = canRuns && !!runId && !tl.isError
  const activeTab = !hasRun && (tab === "run" || tab === "digest") ? "history" : tab

  const name = d?.company.name ?? t?.logo.companyName
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        // Focus the panel itself, not its first button (that would pop the "Previous / Next logo" tooltip).
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
        className="flex flex-col gap-0 p-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[min(64rem,94vw)]"
      >
        <div className="h-1 shrink-0 bg-brand-gradient" aria-hidden="true" />
        <SheetHeader className="gap-4 border-b px-6 pb-4 pt-5">
          <div className="flex items-start gap-4 pr-10">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-base font-semibold text-primary-foreground">
              {name ? initials(name) : <Building2 className="size-5" />}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <SheetTitle className="text-xl font-semibold leading-tight tracking-tight">{name ?? "Loading…"}</SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  {(d?.company.industry || t?.logo.industry) && (
                    <span className="inline-flex items-center gap-1.5">
                      <Building2 className="size-3.5" /> {d?.company.industry || t?.logo.industry}
                    </span>
                  )}
                  {(d?.company.segment || t?.logo.segment) && (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="size-3.5" /> {d?.company.segment || t?.logo.segment}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <UserRound className="size-3.5" /> {d?.pam?.name ?? t?.logo.pamName ?? "Unassigned"}
                  </span>
                </div>
              </SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <NavButton label="Previous logo" target={prev} onNavigate={onNavigate} icon={ChevronUp} />
              <NavButton label="Next logo" target={next} onNavigate={onNavigate} icon={ChevronDown} />
            </div>
          </div>
          <Stats d={d} t={t} />
        </SheetHeader>

        {detail.isError && !t ? (
          <p className="p-6 text-sm text-destructive">{errorMessage(detail.error)}</p>
        ) : !d && !t ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-64" />
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
            <div className="border-b px-6 pt-2">
              <TabsList variant="line" className="h-10 gap-5 p-0">
                {hasRun && <DrawerTab value="run">Run #{runId}</DrawerTab>}
                {hasRun && t?.logo.pamId && <DrawerTab value="digest">Digest</DrawerTab>}
                <DrawerTab value="history">
                  History
                  {d ? <span className="tabular ml-1 text-muted-foreground">{d.cycles.length}</span> : null}
                </DrawerTab>
                <DrawerTab value="ownership">Ownership</DrawerTab>
                <DrawerTab value="details">Details</DrawerTab>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {hasRun && (
                <TabsContent value="run" className="lg:h-full lg:overflow-hidden">
                  {t ? <RunTab t={t} stale={tl.isPlaceholderData} /> : <Skeleton className="m-6 h-80" />}
                </TabsContent>
              )}
              {hasRun && t?.logo.pamId && (
                <TabsContent value="digest" className="p-6">
                  <DigestTab runId={runId!} pamId={t.logo.pamId} pamName={t.logo.pamName} active={activeTab === "digest"} />
                </TabsContent>
              )}
              <TabsContent value="history" className="p-6">
                {d ? <HistoryTab d={d} /> : <Skeleton className="h-64" />}
              </TabsContent>
              <TabsContent value="ownership" className="p-6">
                {d ? <OwnershipTab d={d} /> : <Skeleton className="h-40" />}
              </TabsContent>
              <TabsContent value="details" className="p-6">
                {d ? <DetailsTab d={d} /> : <Skeleton className="h-40" />}
              </TabsContent>
            </div>
          </Tabs>
        )}

        <Footer t={t} runId={runId} companyId={companyId} onReassign={onReassign} />
      </SheetContent>
    </Sheet>
  )
}

function DrawerTab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsTrigger value={value} className="px-0 after:bg-[image:var(--brand-gradient)] data-active:text-foreground">
      {children}
    </TabsTrigger>
  )
}

function NavButton({ label, target, onNavigate, icon: Icon }: { label: string; target?: LogoTarget; onNavigate: (t: LogoTarget) => void; icon: LucideIcon }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" className="size-8" disabled={!target} onClick={() => target && onNavigate(target)} aria-label={label}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Stats({ d, t }: { d?: CompanyDetail; t?: LogoTimeline }) {
  const signals = d?.cycles.filter((c) => c.result.status === "signal") ?? []
  const cell = (label: string, value: ReactNode) => (
    <div className="min-w-0 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="tabular text-base font-semibold leading-tight">{value}</div>
    </div>
  )
  return (
    <div className="grid grid-cols-2 gap-4 rounded-xl bg-muted/50 px-4 py-3 sm:grid-cols-4">
      {cell(
        t ? `Run #${t.run.id}` : "Latest run",
        t ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={t.logo.status === "running" ? "running" : t.logo.status} />
            {t.logo.category && <Badge variant="outline">{t.logo.category}</Badge>}
          </span>
        ) : (
          "—"
        ),
      )}
      {cell("Cycles researched", d ? d.cycles.length : "—")}
      {cell("Signals found", d ? signals.length : "—")}
      {cell("Last signal", signals[0] ? fmtDate(signals[0].run.windowEnd) : "—")}
    </div>
  )
}

// ---- Run tab: result + digest inclusion (left), step-by-step timeline (right) --------------------------------

type Step = {
  id: string
  ts: string
  icon: LucideIcon
  tone: string
  title: string
  detail?: string | null
  meta: string[]
}
const OUTCOME: Record<string, string> = {
  signal: "Signal found",
  no_signal: "No relevant news",
  failed: "Gave up",
}

function stepOf(e: ProcessEvent): Step {
  const a = e.attrs as Record<string, unknown>
  const meta = [e.durationMs ? fmtMs(e.durationMs) : "", e.actor && e.actor !== "system" ? `by ${e.actor}` : ""].filter(Boolean)
  const base = { id: e.id, ts: e.ts, meta }
  if (e.kind === "research.attempt") {
    if (e.status === "retry")
      return {
        ...base,
        icon: RotateCcw,
        tone: "text-warning border-warning/50",
        title: `Attempt ${e.attempt ?? ""} hit a limit, retrying`,
        detail: e.message,
      }
    if (e.status === "error")
      return {
        ...base,
        icon: XCircle,
        tone: "text-destructive border-destructive/40",
        title: `Attempt ${e.attempt ?? ""} failed`,
        detail: e.message,
      }
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
    return {
      ...base,
      icon: ch === "whatsapp" ? MessageCircle : Mail,
      tone:
        e.status === "error" ? "text-destructive border-destructive/40" : e.status === "skipped" ? "text-muted-foreground" : "text-primary border-primary/40",
      title: `${kindLabel(e.kind)}${ch ? ` · ${ch}` : ""}`,
      detail: e.message,
    }
  }
  if (e.kind === "run.start")
    return {
      ...base,
      icon: Play,
      tone: "text-muted-foreground",
      title: "Run started",
      detail: null,
    }
  if (e.kind === "run.finish")
    return {
      ...base,
      icon: Sparkles,
      tone: "text-muted-foreground",
      title: "Run finished",
      detail: e.message,
    }
  if (e.kind.startsWith("run.retry"))
    return {
      ...base,
      icon: RotateCcw,
      tone: "text-primary border-primary/40",
      title: kindLabel(e.kind),
      detail: e.message,
    }
  return {
    ...base,
    icon: Clock,
    tone: "text-muted-foreground",
    title: kindLabel(e.kind),
    detail: e.message,
  }
}

function RunTab({ t, stale }: { t: LogoTimeline; stale: boolean }) {
  const steps: Step[] = [
    ...(t.logo.enqueuedAt
      ? [
          {
            id: "q",
            ts: t.logo.enqueuedAt,
            icon: Inbox,
            tone: "text-muted-foreground",
            title: "Queued for research",
            meta: [],
          } as Step,
        ]
      : []),
    ...t.events.map(stepOf),
  ].sort((a, b) => a.ts.localeCompare(b.ts))
  return (
    // Two panes on laptop and up: the result stays in place, only the timeline scrolls.
    <div
      className={cn("grid transition-opacity animate-in fade-in-0 duration-300 lg:h-full lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]", stale && "opacity-60")}
    >
      <div className="min-w-0 space-y-6 p-6 lg:overflow-y-auto lg:border-r">
        <section className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="eyebrow">Result</h3>
            <Link to={`/runs/${t.run.id}?tab=results`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Run #{t.run.id} results <ExternalLink className="size-3" />
            </Link>
          </div>
          {t.logo.status === "signal" ? (
            <ResultSections keySignals={t.logo.keySignals} opportunity={t.logo.opportunity} outreach={t.logo.outreach} sources={t.logo.sources} />
          ) : (
            <div
              className={cn(
                "wrap-anywhere rounded-lg border p-3 text-sm",
                t.logo.status === "failed" ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/40 text-muted-foreground",
              )}
            >
              {t.logo.status === "failed"
                ? (t.logo.error ?? "Research failed")
                : t.logo.status === "no_signal"
                  ? "No TTBS-relevant news in the window."
                  : t.logo.status === "running"
                    ? "Researching now…"
                    : t.logo.error
                      ? `Retrying: ${t.logo.error}`
                      : "Waiting in queue…"}
            </div>
          )}
          <dl className="grid grid-cols-3 gap-3 rounded-lg bg-muted/40 px-3 py-2.5 text-xs">
            <div>
              <dt className="text-muted-foreground">Attempts</dt>
              <dd className="tabular mt-0.5 font-medium">{t.logo.attempts}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">News window</dt>
              <dd className="tabular mt-0.5 font-medium">
                {t.run.windowEnd ? `${fmtDate(t.run.windowStart ?? "").slice(0, 6)} – ${fmtDate(t.run.windowEnd)}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Finished</dt>
              <dd className="tabular mt-0.5 font-medium">{t.logo.finishedAt ? fmtDateTime(t.logo.finishedAt) : "—"}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="min-w-0 lg:overflow-y-auto">
        <h3 className="eyebrow sticky top-0 z-10 border-b bg-background/95 px-6 py-3 backdrop-blur-sm">Digest &amp; timeline</h3>
        <div className="px-6 pt-4">
          <section className="mb-6">
            <h3 className="eyebrow mb-3">In {t.logo.pamName ? `${t.logo.pamName}'s` : "the"} digest</h3>
            {t.digests.length === 0 ? (
              <p className="text-sm text-muted-foreground">The digest is built when the last of this PAM's logos is researched.</p>
            ) : (
              <div className="space-y-2">
                {t.digests.map((g) => {
                  const Icon = g.channel === "whatsapp" ? MessageCircle : Mail
                  return (
                    <div key={g.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium capitalize">
                          {g.channel} · <span className="break-all font-normal normal-case text-muted-foreground">{g.recipient ?? "no recipient"}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {g.status === "sent" ? `Sent ${fmtDateTime(g.sentAt)}` : (g.lastError ?? g.status)} · {g.signals ?? 0} signals
                        </p>
                      </div>
                      {g.includesLogo ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                          <CheckCircle2 className="size-3.5" /> Included
                        </span>
                      ) : t.logo.status === "signal" ? (
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
          <h3 className="eyebrow mb-3">Steps</h3>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has happened to this logo yet.</p>
          ) : (
            <ol>
              {steps.map((s, i) => (
                <li
                  key={s.id}
                  className="relative flex gap-3 pb-5 animate-in fade-in-0 slide-in-from-left-1"
                  style={{
                    animationDelay: `${Math.min(i, 12) * 30}ms`,
                    animationFillMode: "both",
                  }}
                >
                  {i < steps.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px bg-border" aria-hidden="true" />}
                  <span className={cn("relative z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-card", s.tone)}>
                    <s.icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{s.title}</span>
                      <span className="tabular ml-auto text-xs text-muted-foreground">{fmtDateTime(s.ts)}</span>
                    </div>
                    {s.detail && <p className="mt-0.5 wrap-anywhere text-sm text-muted-foreground">{s.detail}</p>}
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
        </div>
      </section>
    </div>
  )
}

// ---- Digest tab ------------------------------------------------------------------------------------------------

function DigestTab({ runId, pamId, pamName, active }: { runId: string; pamId: string; pamName: string | null; active: boolean }) {
  const { user } = useSession()
  const q = usePamDigest(runId, active ? pamId : null)
  const resend = useBoardResend(runId)
  const d = q.data
  if (q.isError) return <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
  if (!d) return <Skeleton className="h-[28rem]" />
  return (
    <div className="space-y-4 animate-in fade-in-0 duration-300">
      <div className="flex flex-wrap items-start gap-3 rounded-xl bg-muted/50 px-4 py-3 text-sm">
        <div className="min-w-0 flex-1 space-y-1">
          <p>
            <span className="inline-block w-16 text-muted-foreground">To</span> <span className="break-all">{d.recipient ?? "—"}</span>
          </p>
          <p>
            <span className="inline-block w-16 text-muted-foreground">Subject</span> <span className="font-medium">{d.subject}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {d.asSent ? `Exactly as sent ${fmtDateTime(d.sentAt)}.` : "Not sent in this form: rendered now from the current results."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {d.status === "none" ? (
            <span className="text-xs text-muted-foreground">Not queued yet</span>
          ) : (
            <StatusBadge status={d.status === "sending" ? "running" : d.status} />
          )}
          {can(user, "runs", "manage") && d.status !== "none" && d.status !== "pending" && d.status !== "sending" && (
            <Button
              size="sm"
              disabled={resend.isPending}
              onClick={() =>
                resend.mutate(
                  { pamIds: [pamId] },
                  {
                    onSuccess: () => toast.success(`Digest re-queued for ${pamName ?? "the PAM"}`, { description: "Rebuilt from the current results." }),
                    onError: (e) =>
                      toast.error("Could not resend", {
                        description: errorMessage(e),
                      }),
                  },
                )
              }
            >
              <Send /> Resend
            </Button>
          )}
        </div>
      </div>
      {d.html ? (
        <iframe title="Digest email" sandbox="" srcDoc={d.html} className="h-[60vh] w-full rounded-xl border bg-white" />
      ) : (
        <pre className="whitespace-pre-wrap rounded-xl border p-4 text-sm">{d.text}</pre>
      )}
    </div>
  )
}

// ---- Company tabs ------------------------------------------------------------------------------------------------

const reasonLabel: Record<AssignmentReason, { label: string; icon: typeof Shuffle }> = {
  import: { label: "Excel/CSV import", icon: FileSpreadsheet },
  rebalance: { label: "Automatic rebalance", icon: Shuffle },
  manual: { label: "Manual reassignment", icon: ArrowRightLeft },
}

function pamNames(d: CompanyDetail) {
  const names = new Map(d.assignments.map((a) => [a.pamId, a.pamName]))
  return (id: string) => names.get(id) ?? (d.pam?.id === id ? d.pam.name : id)
}

function HistoryTab({ d }: { d: CompanyDetail }) {
  const pamName = pamNames(d)
  const items: TimelineItem[] = d.cycles.map(({ result: r, run }) => ({
    id: r.id,
    tone: r.status === "signal" ? "brand" : r.status === "failed" ? "danger" : "neutral",
    icon: r.status === "signal" ? <Zap /> : r.status === "failed" ? <AlertTriangle /> : <CircleSlash />,
    title:
      r.status === "signal" ? (
        <span className="flex flex-wrap items-center gap-2">
          {r.category} signal
          {r.cached && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              cached
            </Badge>
          )}
        </span>
      ) : r.status === "failed" ? (
        "Research failed"
      ) : (
        "No qualifying news"
      ),
    meta: (
      <>
        <Link to={`/runs/${run.id}?tab=results`} className="hover:underline">
          Run #{run.id}
        </Link>{" "}
        · PAM {pamName(r.pamId)}
      </>
    ),
    time: `${fmtDate(run.windowStart).slice(0, 6)} – ${fmtDate(run.windowEnd)}`,
    detail:
      r.status === "signal" ? (
        <div className="min-w-0">
          <ResultSections keySignals={r.keySignals} opportunity={r.opportunity} outreach={r.outreach} sources={r.sources} />
        </div>
      ) : r.status === "failed" ? (
        <p className="text-sm text-destructive">{r.error}</p>
      ) : undefined,
  }))
  const firstSignal = d.cycles.find((c) => c.result.status === "signal")
  return items.length ? (
    <Timeline label={`Research history for ${d.company.name}`} items={items} defaultExpanded={firstSignal ? [firstSignal.result.id] : []} />
  ) : (
    <p className="text-sm text-muted-foreground">Not researched yet. It will be included in the next run of its upload.</p>
  )
}

function OwnershipTab({ d }: { d: CompanyDetail }) {
  const pamName = pamNames(d)
  const items: TimelineItem[] = [...d.assignments]
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    .map((a) => {
      const R = reasonLabel[a.reason]
      return {
        id: a.id,
        tone: a.validTo === null ? "info" : "neutral",
        icon: <R.icon />,
        title: (
          <span className="flex flex-wrap items-center gap-2">
            <Avatar name={pamName(a.pamId)} className="size-6 text-[10px]" />
            {pamName(a.pamId)}
            {a.validTo === null && <StatusBadge status="active" label="Current owner" />}
          </span>
        ),
        meta: `${R.label} · by ${a.actor}`,
        time: `${fmtDate(a.validFrom)} → ${a.validTo ? fmtDate(a.validTo) : "now"}`,
      }
    })
  return (
    <>
      <p className="mb-5 text-sm text-muted-foreground">Every change of PAM is kept. Results always stay with the company.</p>
      <Timeline label={`Ownership history for ${d.company.name}`} items={items} />
    </>
  )
}

function DetailsTab({ d }: { d: CompanyDetail }) {
  const signals = d.cycles.filter((c) => c.result.status === "signal")
  const offerings = [...new Set(signals.flatMap((s) => s.result.offerings))]
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="space-y-3">
        <h3 className="eyebrow">Profile</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          {[
            ["Legal name", d.company.name],
            ["Industry", d.company.industry || "—"],
            ["Segment", d.company.segment || "—"],
            ["PAM", d.pam ? `${d.pam.name} · ${d.pam.email}` : "Unassigned"],
            ["Company ID", d.company.id],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="space-y-3">
        <h3 className="eyebrow">TTBS offerings suggested</h3>
        <div className="flex flex-wrap gap-1.5">
          {offerings.map((o) => (
            <Badge key={o} variant="outline" className="font-normal">
              {o}
            </Badge>
          ))}
          {offerings.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
        </div>
      </section>
    </div>
  )
}

// ---- Footer actions -------------------------------------------------------------------------------------------------

function Footer({ t, runId, companyId, onReassign }: { t?: LogoTimeline; runId?: string; companyId: string | null; onReassign: (id: string) => void }) {
  const { user } = useSession()
  const navigate = useNavigate()
  const retry = useBoardRetry(runId ?? "")
  if (!companyId) return null
  return (
    <div className="flex flex-wrap items-center gap-2 border-t bg-card px-6 py-3">
      <Button variant="outline" size="sm" onClick={() => navigate("/signals")}>
        <Zap /> Signals feed
      </Button>
      {can(user, "companies", "manage") && (
        <Button variant="outline" size="sm" onClick={() => onReassign(companyId)}>
          <UserRound /> Reassign PAM
        </Button>
      )}
      {t && runId && can(user, "runs", "manage") && t.logo.status === "failed" && (
        <Button
          size="sm"
          className="ml-auto"
          disabled={retry.isPending}
          onClick={() =>
            retry.mutate(
              { resultIds: [t.logo.id] },
              {
                onSuccess: (r) => toast.success(r.requeued ? "Research re-queued" : "Nothing to retry"),
                onError: (e) =>
                  toast.error("Could not retry", {
                    description: errorMessage(e),
                  }),
              },
            )
          }
        >
          <RotateCcw /> Retry research
        </Button>
      )}
    </div>
  )
}
