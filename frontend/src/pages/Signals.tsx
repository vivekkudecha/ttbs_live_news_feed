import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Download, Search, Sparkles, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge, SignalSections } from "@/components/common/SignalCard"
import { RichText } from "@/components/common/RichText"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCompanies, usePams, usePriority, useResults, useRuns } from "@/api/hooks"
import { useSession } from "@/context/session"
import { fmtDate } from "@/lib/format"

const categories = ["Expansion", "Funding", "Leadership", "Cybersecurity", "Digital", "Contract"]

export default function Signals() {
  const { user } = useSession()
  const isPam = user!.role === "pam"
  const runs = useRuns()
  const finished = runs.data?.filter((r) => r.status !== "queued") ?? []
  const [runId, setRunId] = useState<string>("")
  const activeRunId = runId || finished.find((r) => r.status === "completed")?.id || ""
  const [pamFilter, setPamFilter] = useState("all")
  const [category, setCategory] = useState("all")
  const [status, setStatus] = useState("signal")
  const [q, setQ] = useState("")

  const results = useResults(activeRunId)
  const priority = usePriority(activeRunId)
  const companies = useCompanies()
  const pams = usePams()
  const run = finished.find((r) => r.id === activeRunId)

  const rows = useMemo(() => {
    if (!results.data || !companies.data) return []
    return results.data
      .filter((r) => (isPam ? r.pamId === user!.pamId : pamFilter === "all" || r.pamId === pamFilter))
      .filter((r) => category === "all" || r.category === category)
      .filter((r) => status === "all" || r.status === status)
      .map((r) => ({
        r,
        company: companies.data!.find((c) => c.id === r.companyId)!,
        p: priority.data?.find((p) => p.companyId === r.companyId),
      }))
      .filter((x) => !q || x.company.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (a.p?.rank ?? 999) - (b.p?.rank ?? 999) || a.company.name.localeCompare(b.company.name))
  }, [results.data, companies.data, priority.data, isPam, user, pamFilter, category, status, q])

  const counts = useMemo(() => {
    const base = (results.data ?? []).filter((r) => (isPam ? r.pamId === user!.pamId : pamFilter === "all" || r.pamId === pamFilter))
    return {
      signal: base.filter((r) => r.status === "signal").length,
      no_signal: base.filter((r) => r.status === "no_signal").length,
      failed: base.filter((r) => r.status === "failed").length,
      all: base.length,
    }
  }, [results.data, isPam, user, pamFilter])

  const pamName = (id: string) => pams.data?.find((p) => p.id === id)?.name ?? ""

  return (
    <div>
      <PageHeader
        title={isPam ? "My signals" : "Signals feed"}
        description={
          run ? `${run.label} · window ${fmtDate(run.windowStart)} – ${fmtDate(run.windowEnd)} · template v${run.templateVersion}` : "Research results by logo"
        }
        actions={
          <Button variant="outline" onClick={() => toast.success("Excel export prepared", { description: "Columns: Company · News Feed Results · Priority Actions" })}>
            <Download /> Export Excel
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3">
        <Tabs value={status} onValueChange={setStatus}>
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="signal">Signals · {counts.signal}</TabsTrigger>
            <TabsTrigger value="no_signal">No signal · {counts.no_signal}</TabsTrigger>
            <TabsTrigger value="failed">Failed · {counts.failed}</TabsTrigger>
            <TabsTrigger value="all">All · {counts.all}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search company…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={activeRunId} onValueChange={setRunId}>
            <SelectTrigger className="w-full lg:w-56">
              <SelectValue placeholder="Run" />
            </SelectTrigger>
            <SelectContent>
              {finished.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.id} · {fmtDate(r.windowEnd)}
                  {r.status === "running" ? " (running)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isPam && (
            <Select value={pamFilter} onValueChange={setPamFilter}>
              <SelectTrigger className="w-full lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All PAMs</SelectItem>
                {pams.data?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All trigger types</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!results.data ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Zap} title="No results match these filters">
          Try another run, trigger type or status.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {rows.map(({ r, company, p }) => (
            <Card key={r.id} className="gap-0">
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {p && (
                    <Badge variant="secondary" className="tabular font-medium" title="Priority rank within this PAM's digest">
                      {isPam || pamFilter !== "all" ? `#${p.rank}` : `PAM rank #${p.rank}`}
                    </Badge>
                  )}
                  <Link to={`/companies/${company.id}`} className="font-semibold hover:text-primary hover:underline">
                    {company.name}
                  </Link>
                  <CategoryBadge category={r.category} />
                  {r.status !== "signal" && <StatusBadge status={r.status} />}
                  {r.cached && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      cached
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {company.industry} · {company.region}
                    {!isPam && ` · ${pamName(r.pamId)}`}
                  </span>
                </div>
                {r.status === "signal" ? (
                  <>
                    <SignalSections result={r} />
                    {p && (
                      <div className="space-y-1 rounded-lg bg-muted/60 px-4 py-3 text-sm leading-relaxed sm:ml-[12rem]">
                        <p className="eyebrow flex items-center gap-1.5">
                          <Sparkles className="size-3.5 text-brand" /> Priority action
                        </p>
                        <p className="mt-1">
                          <span className="font-medium">Why now?</span> <RichText text={p.whyNow} />
                        </p>
                        <p>
                          <span className="font-medium">Action:</span> <RichText text={p.action} />
                        </p>
                      </div>
                    )}
                  </>
                ) : r.status === "failed" ? (
                  <p className="text-sm text-destructive">{r.error} · will retry in next cycle or retry from the run page.</p>
                ) : r.status === "pending" ? (
                  <p className="text-sm text-muted-foreground">Research in progress…</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Details not found: no TTBS-relevant news in this window.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
