import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { AlertTriangle, ArrowRightLeft, Building2, CircleSlash, FileSpreadsheet, MapPin, Play, Shuffle, UserRound, Zap } from "lucide-react"
import { Timeline, type TimelineItem } from "@/components/common/Timeline"
import { SignalSections } from "@/components/common/SignalCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAssignments, useCompanies, useCompanyResults, usePams, useRuns } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDate, fmtUsd, initials } from "@/lib/format"
import type { AssignmentReason } from "@/api/types"

const reasonLabel: Record<AssignmentReason, { label: string; icon: typeof Shuffle }> = {
  import: { label: "Excel/CSV import", icon: FileSpreadsheet },
  rebalance: { label: "Automatic rebalance", icon: Shuffle },
  manual: { label: "Manual reassignment", icon: ArrowRightLeft },
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular text-base font-medium leading-tight sm:text-lg">{value}</p>
    </div>
  )
}

export function CompanyDrawer({
  companyId,
  onOpenChange,
  onReassign,
}: {
  companyId: string | null
  onOpenChange: (open: boolean) => void
  onReassign: (companyId: string) => void
}) {
  const { user } = useSession()
  const navigate = useNavigate()
  const companies = useCompanies()
  const pams = usePams()
  const runs = useRuns()
  const results = useCompanyResults(companyId ?? "")
  const assignments = useAssignments(companyId ?? "")
  const manage = can.manageData(user!.role)

  const company = companies.data?.find((c) => c.id === companyId)
  const pam = pams.data?.find((p) => p.id === company?.pamId)
  const pamName = (id: string) => pams.data?.find((p) => p.id === id)?.name ?? id

  const cycles = useMemo(() => {
    if (!results.data || !runs.data) return []
    return results.data
      .filter((r) => r.status !== "pending")
      .map((r) => ({ r, run: runs.data!.find((x) => x.id === r.runId)! }))
      .sort((a, b) => b.run.windowEnd.localeCompare(a.run.windowEnd))
  }, [results.data, runs.data])

  const signals = cycles.filter((c) => c.r.status === "signal")
  const totalCost = cycles.reduce((s, c) => s + c.r.cost, 0)
  const totalTokens = cycles.reduce((s, c) => s + c.r.tokensIn + c.r.tokensOut, 0)
  const avgLatency = cycles.length ? Math.round(cycles.reduce((s, c) => s + c.r.latencyMs, 0) / cycles.length / 1000) : 0

  const newsItems: TimelineItem[] = cycles.map(({ r, run }) => ({
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
    meta: `${run.id} · template v${run.templateVersion} · PAM ${pamName(r.pamId)}`,
    time: `${fmtDate(run.windowStart).slice(0, 6)} – ${fmtDate(run.windowEnd)}`,
    detail:
      r.status === "signal" ? (
        <div className="rounded-lg border bg-card p-4">
          <SignalSections result={r} compact />
          <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
            {r.offerings.map((o) => (
              <Badge key={o} variant="secondary" className="font-normal text-muted-foreground">
                {o}
              </Badge>
            ))}
          </div>
        </div>
      ) : r.status === "failed" ? (
        <p className="text-sm text-destructive">{r.error}</p>
      ) : undefined,
  }))

  const history = [...(assignments.data ?? [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom))
  const ownershipItems: TimelineItem[] = history.map((a) => {
    const R = reasonLabel[a.reason]
    return {
      id: a.id,
      tone: a.validTo === null ? "info" : "neutral",
      icon: <R.icon />,
      title: (
        <span className="flex flex-wrap items-center gap-2">
          {pamName(a.pamId)}
          {a.validTo === null && <StatusBadge status="active" label="Current owner" />}
        </span>
      ),
      meta: `${R.label} · by ${a.actor}`,
      time: `${fmtDate(a.validFrom)} → ${a.validTo ? fmtDate(a.validTo) : "now"}`,
    }
  })

  const ready = company && cycles && assignments.data && pams.data
  const restricted = company && user!.role === "pam" && company.pamId !== user!.pamId

  return (
    <Sheet open={!!companyId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl">
        <div className="h-1 shrink-0 bg-brand-gradient" aria-hidden="true" />
        {!ready || restricted ? (
          <div className="space-y-4 p-6">
            <SheetTitle className="sr-only">Company details</SheetTitle>
            {restricted ? <p className="text-sm text-muted-foreground">You don't have access to this company.</p> : <Skeleton className="h-40" />}
          </div>
        ) : (
          <>
            <SheetHeader className="gap-4 border-b px-6 pb-6 pt-6">
              <div className="flex items-start gap-4 pr-8">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-base font-medium text-primary-foreground">
                  {initials(company.name)}
                </div>
                <div className="min-w-0 space-y-1.5">
                  <SheetTitle className="text-xl font-medium leading-tight tracking-tight">{company.name}</SheetTitle>
                  <SheetDescription asChild>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
                      <span className="inline-flex items-center gap-1.5">
                        <Building2 className="size-3.5" />
                        {company.industry}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin className="size-3.5" />
                        {company.region} · {company.segment}
                      </span>
                    </div>
                  </SheetDescription>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 rounded-lg bg-muted/50 px-4 py-3.5">
                <Stat label="Cycles researched" value={cycles.length} />
                <Stat label="Signals found" value={signals.length} />
                <Stat label="Last signal" value={signals[0] ? fmtDate(signals[0].run.windowEnd) : "—"} />
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Avatar className="size-7">
                  <AvatarFallback className="bg-accent text-[11px] font-medium text-accent-foreground">{pam ? initials(pam.name) : "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 leading-tight">
                  <p className="font-medium">{pam?.name ?? "Unassigned"}</p>
                  <p className="truncate text-xs text-muted-foreground">PAM · {pam?.email}</p>
                </div>
              </div>
            </SheetHeader>

            <Tabs defaultValue="timeline" className="min-h-0 flex-1 gap-0">
              <div className="border-b px-6 pt-3">
                <TabsList variant="line" className="h-10 gap-4 p-0">
                  <TabsTrigger value="timeline" className="px-0 after:bg-[image:var(--brand-gradient)] data-active:text-foreground">
                    News timeline
                  </TabsTrigger>
                  <TabsTrigger value="ownership" className="px-0 after:bg-[image:var(--brand-gradient)] data-active:text-foreground">
                    Ownership history
                  </TabsTrigger>
                  <TabsTrigger value="details" className="px-0 after:bg-[image:var(--brand-gradient)] data-active:text-foreground">
                    Details
                  </TabsTrigger>
                </TabsList>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <TabsContent value="timeline" className="px-6 py-6">
                  {newsItems.length ? (
                    <Timeline label={`News timeline for ${company.name}`} items={newsItems} defaultExpanded={signals[0] ? [signals[0].r.id] : []} />
                  ) : (
                    <p className="text-sm text-muted-foreground">Not researched yet. It will be included in the next cycle.</p>
                  )}
                </TabsContent>
                <TabsContent value="ownership" className="px-6 py-6">
                  <p className="mb-5 text-sm text-muted-foreground">Every change of PAM is kept. Results always stay with the company.</p>
                  <Timeline label={`Ownership history for ${company.name}`} items={ownershipItems} />
                </TabsContent>
                <TabsContent value="details" className="space-y-8 px-6 py-6">
                  <section className="space-y-3">
                    <h3 className="eyebrow">Profile</h3>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
                      {[
                        ["Legal name", company.name],
                        ["Industry", company.industry],
                        ["Region", company.region],
                        ["Segment", company.segment],
                        ["Tracking", company.active ? "Active" : "Paused"],
                        ["Company ID", company.id.toUpperCase()],
                      ].map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-xs text-muted-foreground">{k}</dt>
                          <dd className="mt-0.5 truncate">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                  <section className="space-y-3">
                    <h3 className="eyebrow">Research cost</h3>
                    <dl className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Total spend</dt>
                        <dd className="tabular mt-0.5">{fmtUsd(totalCost, 3)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Tokens</dt>
                        <dd className="tabular mt-0.5">{totalTokens.toLocaleString("en-IN")}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Avg. research time</dt>
                        <dd className="tabular mt-0.5">{avgLatency}s</dd>
                      </div>
                    </dl>
                  </section>
                  <section className="space-y-3">
                    <h3 className="eyebrow">TTBS offerings suggested</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {[...new Set(signals.flatMap((s) => s.r.offerings))].map((o) => (
                        <Badge key={o} variant="outline" className="font-normal">
                          {o}
                        </Badge>
                      ))}
                      {signals.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
                    </div>
                  </section>
                </TabsContent>
              </ScrollArea>
            </Tabs>

            <SheetFooter className="flex-row flex-wrap gap-2 border-t bg-card px-6 py-4">
              <Button variant="outline" size="sm" onClick={() => navigate("/signals")}>
                <Zap /> Signals feed
              </Button>
              {manage && (
                <>
                  <Button variant="outline" size="sm" onClick={() => onReassign(company.id)}>
                    <UserRound /> Reassign PAM
                  </Button>
                  <Button size="sm" className="ml-auto" onClick={() => toast.success(`Research queued for ${company.name}`, { description: "Results appear here in about a minute." })}>
                    <Play /> Research now
                  </Button>
                </>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
