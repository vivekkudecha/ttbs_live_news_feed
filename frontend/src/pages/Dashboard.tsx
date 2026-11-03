import { Link } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ArrowRight, Building2, CalendarClock, Mail, MessageCircle, Radio, Wallet, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge } from "@/components/common/SignalCard"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useDashboard } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDate, fmtDateTime, fmtUsd, pct } from "@/lib/format"
import { NewRunDialog } from "./Schedules"

const n = (x: number) => x.toLocaleString("en-IN")

export default function Dashboard() {
  const { user } = useSession()
  const isPam = user!.role === "pam"
  // One summary call: the server aggregates 10k logos / 5k PAMs; the UI renders a handful of numbers.
  const dash = useDashboard(isPam ? user!.pamId : undefined)
  const d = dash.data

  if (!d) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  const latest = d.latestRun
  const live = d.recentRuns.find((r) => r.status === "running")
  const hour = new Date().getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${greeting}, ${user!.name.split(" ")[0]}`}
        description={
          <>
            Latest cycle: <span className="font-medium text-foreground">{latest.label}</span> · research window {fmtDate(latest.windowStart)} – {fmtDate(latest.windowEnd)}
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

      {live && !isPam && (
        <Link to={`/runs/${live.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-blue/25 bg-brand-blue/[0.06] px-4 py-3 text-sm transition-colors hover:bg-brand-blue/10">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-blue opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-brand-blue" />
          </span>
          <span className="font-medium">Research in progress: {live.label}</span>
          <span className="tabular text-muted-foreground">
            {n(live.done)} / {n(live.companies)} logos · {n(live.withSignal)} signals so far
          </span>
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-blue">
            <Radio className="size-4" /> Watch live
          </span>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
        <StatCard icon={Building2} label={isPam ? "My logos" : "Logos tracked"} value={n(d.logos)} hint={isPam ? "Assigned to you" : `${n(d.activePams)} active PAMs`} />
        <StatCard icon={Zap} tone="info" label="Actionable signals" value={n(d.signals)} hint={`${pct(d.signals, d.scoped)}% of logos had a TTBS-relevant trigger`} />
        <StatCard
          icon={Mail}
          tone="success"
          label={isPam ? "Digest delivery" : "Digests delivered"}
          value={isPam ? (d.emailSent ? "Delivered" : "Pending") : `${n(d.emailSent)}/${n(d.emailTotal)}`}
          hint={
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" /> WhatsApp {n(d.whatsappSent)}/{n(d.whatsappTotal)}
            </span>
          }
        />
        {isPam ? (
          <StatCard icon={CalendarClock} tone="warning" label="Next digest" value={d.nextSchedule ? fmtDate(d.nextSchedule.nextRunAt) : "—"} hint={d.nextSchedule ? `Every ${d.nextSchedule.intervalDays} days at ${d.nextSchedule.runAtTime} IST` : "No schedule"} />
        ) : (
          <StatCard icon={Wallet} tone="warning" label="Spend this month" value={fmtUsd(d.monthSpend)} hint={`${pct(d.monthSpend, d.monthBudget)}% of ${fmtUsd(d.monthBudget, 0)} budget`} />
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{isPam ? "Your priority actions" : "Top priority actions"}</CardTitle>
            <CardDescription>{isPam ? "Ranked by strength and recency of trigger" : "Strongest #1 action across all PAMs"} · {latest.id}</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/digest">
                  Digest <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="-mx-2 space-y-0.5">
            {d.topPriority.length === 0 && <p className="px-2 text-sm text-muted-foreground">No signals for your logos in this cycle.</p>}
            {d.topPriority.map((p, i) => (
              <Link key={`${p.pamId}-${p.companyId}`} to={`/companies?company=${p.companyId}`} className="group flex gap-4 rounded-lg px-3 py-3.5 transition-colors hover:bg-muted/60">
                <span className="tabular mt-0.5 w-5 shrink-0 text-right text-sm font-medium text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium group-hover:text-brand-blue">{p.companyName}</p>
                    <CategoryBadge category={p.category} />
                    {!isPam && <span className="text-xs text-muted-foreground">· {p.pamName}</span>}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    <span className="text-foreground/80">Why now?</span> {p.whyNow}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    <span className="text-foreground/80">Action:</span> {p.action}
                  </p>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Signals by trigger type</CardTitle>
            <CardDescription>
              {n(d.signals)} signals across {n(d.scoped)} logos
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64" role="img" aria-label={`Signals by trigger type: ${d.byCategory.map((x) => `${x.category} ${x.count}`).join(", ")}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.byCategory} layout="vertical" margin={{ left: 8, right: 40, top: 4, bottom: 4 }} barCategoryGap={6}>
                  <CartesianGrid horizontal={false} stroke="var(--border)" />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} tickFormatter={(v) => n(v)} />
                  <YAxis type="category" dataKey="category" width={96} tickLine={false} axisLine={false} tick={{ fill: "var(--foreground)", fontSize: 12 }} />
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.6 }}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }}
                    formatter={(v: number) => [`${n(v)} signals`, ""]}
                    separator=""
                  />
                  <Bar dataKey="count" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={22}>
                    <LabelList dataKey="count" position="right" formatter={(v: number) => n(v)} style={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
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
              <CardTitle>Delivery needing attention</CardTitle>
              <CardDescription>
                {latest.id} · {n(latest.emailSent)} of {n(latest.pamJobsTotal)} digests sent{latest.emailFailed ? ` · ${n(latest.emailFailed)} failed` : ""}
              </CardDescription>
              <CardAction>
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/runs/${latest.id}`}>
                    All {n(latest.pamJobsTotal)} PAMs <ArrowRight />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              {d.deliveryAttention.length === 0 ? (
                <p className="px-6 text-sm text-muted-foreground">Every digest in this cycle was delivered.</p>
              ) : (
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
                    {d.deliveryAttention.map((j) => (
                      <TableRow key={j.pamId}>
                        <TableCell className="pl-6 font-medium">{j.pamName}</TableCell>
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
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
              <CardDescription>Recent and upcoming research cycles</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {d.nextSchedule && (
                <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
                  <CalendarClock className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium">Next: {d.nextSchedule.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDateTime(d.nextSchedule.nextRunAt)} IST · every {d.nextSchedule.intervalDays} days
                    </p>
                  </div>
                </div>
              )}
              {d.recentRuns.map((r) => (
                <Link key={r.id} to={`/runs/${r.id}`} className="block rounded-lg p-2 hover:bg-muted/60">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">
                      <span className="text-muted-foreground">{r.id}</span> · {r.label}
                    </p>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <Progress value={pct(r.done, r.companies)} className="h-1.5" />
                    <span className="tabular w-32 shrink-0 text-right text-xs text-muted-foreground">
                      {n(r.done)}/{n(r.companies)} · {fmtUsd(r.cost)}
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
