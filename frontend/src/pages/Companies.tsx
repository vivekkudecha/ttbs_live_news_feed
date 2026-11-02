import { useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Building2, History, Search, UserRound } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge, SignalSections } from "@/components/common/SignalCard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAssignments, useCompanies, useCompanyResults, usePams, useResults, useRuns } from "@/api/hooks"
import { useSession } from "@/context/session"
import { fmtDate } from "@/lib/format"

export function CompaniesList() {
  const { user } = useSession()
  const isPam = user!.role === "pam"
  const companies = useCompanies()
  const pams = usePams()
  const runs = useRuns()
  const latest = runs.data?.find((r) => r.status === "completed")
  const results = useResults(latest?.id ?? "")
  const [q, setQ] = useState("")
  const [region, setRegion] = useState("all")
  const [pam, setPam] = useState("all")

  const rows = useMemo(
    () =>
      (companies.data ?? [])
        .filter((c) => (isPam ? c.pamId === user!.pamId : pam === "all" || c.pamId === pam))
        .filter((c) => region === "all" || c.region === region)
        .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.industry.toLowerCase().includes(q.toLowerCase())),
    [companies.data, isPam, user, pam, region, q],
  )
  const pamName = (id: string | null) => pams.data?.find((p) => p.id === id)?.name ?? "Unassigned"

  return (
    <div>
      <PageHeader
        title={isPam ? "My companies" : "Companies (Logos)"}
        description="Master list from Excel/CSV imports. Each logo has exactly one active PAM; full ownership history is kept."
        actions={
          !isPam && (
            <Button variant="outline" asChild>
              <Link to="/imports">Import Excel / CSV</Link>
            </Button>
          )
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search name or industry…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={region} onValueChange={setRegion}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All regions</SelectItem>
            {["North", "South", "East", "West"].map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isPam && (
          <Select value={pam} onValueChange={setPam}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All PAMs</SelectItem>
              {pams.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {!p.active && " (inactive)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Company</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Region · Segment</TableHead>
                {!isPam && <TableHead>PAM</TableHead>}
                <TableHead className="pr-5">Latest cycle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const r = results.data?.find((x) => x.companyId === c.id)
                return (
                  <TableRow key={c.id}>
                    <TableCell className="pl-5">
                      <Link to={`/companies/${c.id}`} className="font-medium hover:text-primary hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.industry}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.region} · {c.segment}
                    </TableCell>
                    {!isPam && <TableCell>{pamName(c.pamId)}</TableCell>}
                    <TableCell className="pr-5">
                      <div className="flex items-center gap-1.5">
                        {r ? <StatusBadge status={r.status} /> : <span className="text-muted-foreground">—</span>}
                        <CategoryBadge category={r?.category} />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <div className="p-6">
              <EmptyState icon={Building2} title="No companies match" />
            </div>
          )}
        </CardContent>
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">
        {rows.length} of {isPam ? rows.length : companies.data?.length} companies
      </p>
    </div>
  )
}

export function CompanyDetail() {
  const { id = "" } = useParams()
  const { user } = useSession()
  const companies = useCompanies()
  const pams = usePams()
  const runs = useRuns()
  const results = useCompanyResults(id)
  const assignments = useAssignments(id)

  const c = companies.data?.find((x) => x.id === id)
  if (!companies.data || !pams.data || !runs.data || !results.data || !assignments.data) return <Skeleton className="h-96" />
  // Row-level access: a PAM can only open logos they own (the API enforces the same rule).
  if (!c || (user!.role === "pam" && c.pamId !== user!.pamId)) return <p className="text-sm text-muted-foreground">Company not found.</p>
  const pamName = (pid: string | null) => pams.data!.find((p) => p.id === pid)?.name ?? "Unassigned"
  const timeline = results.data
    .filter((r) => r.status !== "pending")
    .map((r) => ({ r, run: runs.data!.find((x) => x.id === r.runId)! }))
    .sort((a, b) => b.run.windowEnd.localeCompare(a.run.windowEnd))
  const history = [...assignments.data].sort((a, b) => b.validFrom.localeCompare(a.validFrom))

  return (
    <div className="space-y-8">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to="/companies">
            <ArrowLeft /> Companies
          </Link>
        </Button>
        <PageHeader
          title={c.name}
          description={
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{c.industry}</Badge>
              <Badge variant="outline">{c.region}</Badge>
              <Badge variant="outline">{c.segment}</Badge>
              <span className="ml-1 inline-flex items-center gap-1">
                <UserRound className="size-3.5" /> PAM: <span className="font-medium text-foreground">{pamName(c.pamId)}</span>
              </span>
            </span>
          }
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle>News timeline</CardTitle>
            <CardDescription>Every research cycle is preserved, including cycles with no qualifying news.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-6 border-l pl-5">
              {timeline.map(({ r, run }) => (
                <li key={r.id} className="relative">
                  <span className={`absolute -left-[1.6rem] top-1 size-3 rounded-full border-2 border-background ${r.status === "signal" ? "bg-brand" : "bg-muted-foreground/40"}`} />
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">
                      {fmtDate(run.windowStart)} – {fmtDate(run.windowEnd)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.id} · template v{run.templateVersion}
                    </span>
                    <StatusBadge status={r.status} />
                    <CategoryBadge category={r.category} />
                  </div>
                  {r.status === "signal" ? (
                    <SignalSections result={r} />
                  ) : r.status === "failed" ? (
                    <p className="text-sm text-destructive">{r.error}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No TTBS-relevant news in this window.</p>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4" /> Ownership history
            </CardTitle>
            <CardDescription>Reassignments never lose past results.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {history.map((a) => (
                <li key={a.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{pamName(a.pamId)}</span>
                    {a.validTo === null ? <StatusBadge status="active" label="Current" /> : <Badge variant="outline">Past</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {fmtDate(a.validFrom)} → {a.validTo ? fmtDate(a.validTo) : "now"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    via <span className="font-medium">{a.reason}</span> · {a.actor}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
