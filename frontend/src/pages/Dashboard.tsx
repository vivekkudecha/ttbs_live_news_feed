import { Link } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ArrowRight, Building2, CalendarClock, Mail, MessageCircle, Wallet, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge } from "@/components/common/SignalCard"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useCompanies, useFinops, usePams, usePriority, useResults, useRuns, useSchedules } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDate, fmtDateTime, fmtUsd, pct } from "@/lib/format"
import { NewRunDialog } from "./Schedules"

export default function Dashboard() {
  const { user } = useSession()
  const isPam = user!.role === "pam"
  const pamId = isPam ? user!.pamId : undefined
  const runs = useRuns()
  const latest = runs.data?.find((r) => r.status === "completed" || r.status === "partial")
  const results = useResults(latest?.id ?? "")
  const priority = usePriority(latest?.id ?? "", pamId)
  const companies = useCompanies()
  const pams = usePams()
  const finops = useFinops()
  const schedules = useSchedules()

  if (!latest || !results.data || !companies.data || !pams.data || !finops.data || !schedules.data || !priority.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  const scoped = results.data.filter((r) => !pamId || r.pamId === pamId)
  const signals = scoped.filter((r) => r.status === "signal")
  const myCompanies = companies.data.filter((c) => !pamId || c.pamId === pamId)
  const nameOf = (id: string) => companies.data!.find((c) => c.id === id)?.name ?? id
  const pamName = (id: string) => pams.data!.find((p) => p.id === id)?.name ?? id
  const jobs = latest.pamJobs.filter((j) => !pamId || j.pamId === pamId)
  const emailSent = jobs.filter((j) => j.email === "sent").length
  const waSent = jobs.filter((j) => j.whatsapp === "sent").length
  const next = schedules.data.filter((s) => s.enabled).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0]

  const byCategory = Object.entries(
    signals.reduce<Record<string, number>>((acc, r) => {
      acc[r.category!] = (acc[r.category!] ?? 0) + 1
      return acc
    }, {}),
  )
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)

  const hour = new Date().getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${greeting}, ${user!.name.split(" ")[0]}`}
        description={
          <>
            Latest cycle: <span className="font-medium text-foreground">{latest.label}</span> · research window {fmtDate(latest.windowStart)} –{" "}
            {fmtDate(latest.windowEnd)}
          </>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/signals">
                View signals <ArrowRight />
              </Link>
            </Button>
            {can.runJobs(user!.role) && <NewRunDialog />}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
        <StatCard icon={Building2} label={isPam ? "My logos" : "Logos tracked"} value={myCompanies.length} hint={isPam ? "Assigned to you" : `${pams.data.filter((p) => p.active).length} active PAMs`} />
        <StatCard
          icon={Zap}
          tone="info"
          label="Actionable signals"
          value={signals.length}
          hint={`${pct(signals.length, scoped.length)}% of logos had a TTBS-relevant trigger`}
        />
        <StatCard
          icon={Mail}
          tone="success"
          label={isPam ? "Digest delivery" : "Digests delivered"}
          value={isPam ? (emailSent ? "Delivered" : "Pending") : `${emailSent}/${jobs.length}`}
          hint={
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" /> WhatsApp {waSent}/{jobs.filter((j) => j.whatsapp !== "skipped").length}
            </span>
          }
        />
        {isPam ? (
          <StatCard icon={CalendarClock} tone="warning" label="Next digest" value={next ? fmtDate(next.nextRunAt) : "—"} hint={next ? `Every ${next.intervalDays} days at ${next.runAtTime} IST` : "No schedule"} />
        ) : (
          <StatCard
            icon={Wallet}
            tone="warning"
            label="Spend this month"
            value={fmtUsd(finops.data.monthSpend)}
            hint={`${pct(finops.data.monthSpend, finops.data.monthBudget)}% of ${fmtUsd(finops.data.monthBudget, 0)} budget`}
          />
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{isPam ? "Your priority actions" : "Top priority actions"}</CardTitle>
            <CardDescription>Ranked by strength and recency of trigger · {latest.id}</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/digest">
                  Digest <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="-mx-2 space-y-0.5">
            {priority.data.slice(0, 6).map((p, i) => {
              const r = scoped.find((x) => x.companyId === p.companyId)
              return (
                <Link
                  key={`${p.pamId}-${p.companyId}`}
                  to={`/companies/${p.companyId}`}
                  className="group flex gap-4 rounded-lg px-3 py-3.5 transition-colors hover:bg-muted/60"
                >
                  <span className="tabular mt-0.5 w-5 shrink-0 text-right text-sm font-medium text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium group-hover:text-brand-blue">{nameOf(p.companyId)}</p>
                      <CategoryBadge category={r?.category} />
                      {!isPam && <span className="text-xs text-muted-foreground">· {pamName(p.pamId)}</span>}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      <span className="text-foreground/80">Why now?</span> {p.whyNow}
                    </p>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      <span className="text-foreground/80">Action:</span> {p.action}
                    </p>
                  </div>
                </Link>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Signals by trigger type</CardTitle>
            <CardDescription>
              {signals.length} signals across {scoped.length} logos
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64" role="img" aria-label={`Signals by trigger type: ${byCategory.map((d) => `${d.category} ${d.count}`).join(", ")}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byCategory} layout="vertical" margin={{ left: 8, right: 28, top: 4, bottom: 4 }} barCategoryGap={6}>
                  <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="0" />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
                  <YAxis type="category" dataKey="category" width={96} tickLine={false} axisLine={false} tick={{ fill: "var(--foreground)", fontSize: 12 }} />
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.6 }}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }}
                    formatter={(v: number) => [`${v} signals`, ""]}
                    separator=""
                  />
                  <Bar dataKey="count" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={22}>
                    <LabelList dataKey="count" position="right" style={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {!isPam && (
        <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Delivery by PAM</CardTitle>
              <CardDescription>{latest.id} · email and WhatsApp digest status</CardDescription>
              <CardAction>
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/runs/${latest.id}`}>
                    Run details <ArrowRight />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">PAM</TableHead>
                    <TableHead>Signals</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="pr-6">WhatsApp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latest.pamJobs.map((j) => (
                    <TableRow key={j.pamId}>
                      <TableCell className="pl-6 font-medium">{pamName(j.pamId)}</TableCell>
                      <TableCell className="tabular">
                        {j.withSignal}/{j.total}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={j.email} />
                      </TableCell>
                      <TableCell className="pr-6">
                        <StatusBadge status={j.whatsapp} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
              <CardDescription>Recent and upcoming research cycles</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {next && (
                <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
                  <CalendarClock className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium">Next: {next.name}</p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(next.nextRunAt)} IST · every {next.intervalDays} days</p>
                  </div>
                </div>
              )}
              {runs.data!.slice(0, 4).map((r) => (
                <Link key={r.id} to={`/runs/${r.id}`} className="block rounded-lg p-2 hover:bg-muted/60">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">
                      <span className="text-muted-foreground">{r.id}</span> · {r.label}
                    </p>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <Progress value={pct(r.done, r.companies)} className="h-1.5" />
                    <span className="tabular w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {r.done}/{r.companies} · {fmtUsd(r.cost)}
                    </span>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
