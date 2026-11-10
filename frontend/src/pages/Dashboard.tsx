import { Link } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from "recharts"
import { useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowRight, BellRing, Building2, CalendarClock, CheckCircle2, Mail, MessageCircle, Radio, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge } from "@/components/common/SignalCard"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useClientTable } from "@/components/data-table/useSmartTable"
import type { PamJobRow } from "@/api/types"
import { useDashboard } from "@/api/hooks"
import { useSession } from "@/context/session"
import { fmtDate, fmtDateTime, pct } from "@/lib/format"
import { NewRunDialog } from "@/components/runs/NewRunDialog"
import { Page, StatGrid, Split } from "@/components/common/layout"
import { LiveDot } from "@/components/common/LiveDot"
import { ChartCard } from "@/components/common/ChartCard"
import { chartTheme } from "@/components/common/chart-theme"

const n = (x: number) => x.toLocaleString("en-IN")

/** Before the first research run: what to do next, in order. */
function GettingStarted({ greeting, logos }: { greeting: string; logos: number }) {
  const steps = [
    { done: false, title: "Connect a research AI", hint: "Providers & channels → Perplexity or Gemini key + model", to: "/integrations" },
    { done: logos > 0, title: "Upload this run's logos", hint: logos > 0 ? `${n(logos)} logos known so far` : "Excel/CSV: Company, PAM Name, PAM Email, PAM WhatsApp", to: "/imports" },
    { done: false, title: "Run research", hint: "Research the upload now or at a set time; each PAM gets their own results", to: "/runs" },
  ]
  return (
    <Page>
      <PageHeader title={greeting} description="No research has run yet. Results, signals and digests appear here after the first run." actions={<NewRunDialog />} />
      <Card>
          <CardHeader>
            <CardTitle>Get started</CardTitle>
            <CardDescription>Three steps to the first signals</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {steps.map((s, i) => (
              <Link key={s.title} to={s.to} className="flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/60">
                <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-medium ${s.done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
                  {s.done ? <CheckCircle2 className="size-4" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground">{s.hint}</p>
                </div>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            ))}
          </CardContent>
        </Card>
    </Page>
  )
}

const DELIVERY_OPTS = ["sent", "pending", "sending", "failed", "skipped", "none"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))

/** PAMs whose digest failed or is still waiting in the latest cycle (sortable / filterable). */
function DeliveryAttention({ rows }: { rows: PamJobRow[] }) {
  const columns = useMemo<ColumnDef<PamJobRow, unknown>[]>(
    () => [
      {
        id: "pamName",
        accessorKey: "pamName",
        meta: { label: "PAM", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => <span className="font-medium">{row.original.pamName}</span>,
      },
      {
        id: "withSignal",
        accessorKey: "withSignal",
        meta: { label: "Signals", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Signals" />,
        cell: ({ row }) => (
          <span className="tabular">
            {row.original.withSignal}/{row.original.total}
          </span>
        ),
      },
      {
        id: "email",
        accessorKey: "email",
        meta: { label: "Email", filter: { type: "enum", options: DELIVERY_OPTS } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
        cell: ({ row }) => <StatusBadge status={row.original.email} />,
      },
      {
        id: "whatsapp",
        accessorKey: "whatsapp",
        meta: { label: "WhatsApp", filter: { type: "enum", options: DELIVERY_OPTS } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="WhatsApp" />,
        cell: ({ row }) => <StatusBadge status={row.original.whatsapp} />,
      },
    ],
    [],
  )
  const state = useClientTable<PamJobRow>({ id: "dash-attention", data: rows, columns, pageSize: 8, getRowId: (r) => r.pamId })
  return (
    <div className="px-6">
      <SmartTable state={state} minWidth="28rem" pageSizes={[8, 20, 50]} empty={<p className="text-sm text-muted-foreground">No PAMs match.</p>} />
    </div>
  )
}

export default function Dashboard() {
  const { user } = useSession()
  // One summary call: the server aggregates 10k logos / 5k PAMs; the UI renders a handful of numbers.
  const dash = useDashboard()
  const d = dash.data

  if (!d) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <StatGrid>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </StatGrid>
        <Skeleton className="h-80" />
      </div>
    )
  }

  const latest = d.latestRun
  const live = d.recentRuns.find((r) => r.status === "running")
  const hour = new Date().getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"

  if (!latest) return <GettingStarted greeting={`${greeting}, ${user!.name.split(" ")[0]}`} logos={d.logos} />

  return (
    <Page>
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
            <NewRunDialog />
          </>
        }
      />

      {live && (
        <Link to={`/runs/${live.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-blue/25 bg-brand-blue/[0.06] px-4 py-3 text-sm transition-colors hover:bg-brand-blue/10">
          <LiveDot />
          <span className="font-medium">Research in progress: {live.label}</span>
          <span className="tabular text-muted-foreground">
            {n(live.done)} / {n(live.companies)} logos · {n(live.withSignal)} signals so far
          </span>
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-blue">
            <Radio className="size-4" /> Watch live
          </span>
        </Link>
      )}

      <StatGrid>
        <StatCard icon={Building2} label="Logos tracked" value={n(d.logos)} hint={`${n(d.activePams)} active PAMs`} />
        <StatCard icon={Zap} tone="info" label="Actionable signals" value={n(d.signals)} hint={`${pct(d.signals, d.scoped)}% of logos had a TTBS-relevant trigger`} />
        <StatCard
          icon={Mail}
          tone="success"
          label="Digests delivered"
          value={`${n(d.emailSent)}/${n(d.emailTotal)}`}
          hint={
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" /> WhatsApp {n(d.whatsappSent)}/{n(d.whatsappTotal)}
            </span>
          }
        />
        <StatCard
          icon={BellRing}
          tone={d.deliveryAttention.length ? "warning" : "success"}
          label="Delivery issues"
          value={n(d.deliveryAttention.length)}
          hint={d.deliveryAttention.length ? "PAMs whose digest failed or is still waiting" : "every digest in this cycle went out"}
        />
      </StatGrid>

      <Split ratio="1.35fr 1fr">
        <Card>
          <CardHeader>
            <CardTitle>Top priority actions</CardTitle>
            <CardDescription>Strongest #1 action across all PAMs · {latest.id}</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/digest">
                  Digest <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="-mx-2 space-y-0.5">
            {d.topPriority.length === 0 && <p className="px-2 text-sm text-muted-foreground">No signals in this cycle.</p>}
            {d.topPriority.map((p, i) => (
              <Link key={`${p.pamId}-${p.companyId}`} to={{ search: `?logo=${p.companyId}&logoRun=${p.runId}` }} className="group flex gap-4 rounded-lg px-3 py-3.5 transition-colors hover:bg-muted/60">
                <span className="tabular mt-0.5 w-5 shrink-0 text-right text-sm font-medium text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium group-hover:text-brand-blue">{p.companyName}</p>
                    <CategoryBadge category={p.category} />
                    <span className="text-xs text-muted-foreground">· {p.pamName}</span>
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

        <ChartCard
          title="Signals by trigger type"
          description={`${n(d.signals)} signals across ${n(d.scoped)} logos`}
          label={`Signals by trigger type: ${d.byCategory.map((x) => `${x.category} ${x.count}`).join(", ")}`}
        >
          <BarChart data={d.byCategory} layout="vertical" margin={{ left: 8, right: 40, top: 4, bottom: 4 }} barCategoryGap={6}>
            <CartesianGrid horizontal={false} {...chartTheme.grid} />
            <XAxis type="number" allowDecimals={false} {...chartTheme.axis} tickFormatter={(v) => n(v)} />
            <YAxis type="category" dataKey="category" width={96} {...chartTheme.axis} tick={{ fill: "var(--foreground)", fontSize: 13 }} />
            <Tooltip {...chartTheme.tooltip} formatter={(v: number) => [`${n(v)} signals`, ""]} separator="" />
            <Bar dataKey="count" fill="var(--chart-1)" radius={[0, 6, 6, 0]} maxBarSize={22}>
              <LabelList dataKey="count" position="right" formatter={(v: number) => n(v)} style={{ fill: "var(--muted-foreground)", fontSize: 13 }} />
            </Bar>
          </BarChart>
        </ChartCard>
      </Split>

      {(
        <Split ratio="1.35fr 1fr">
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
                <DeliveryAttention rows={d.deliveryAttention} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
              <CardDescription>Recent and upcoming research cycles</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {d.nextRun && (
                <Link to={`/runs/${d.nextRun.id}`} className="flex items-center gap-3 rounded-lg border border-dashed p-3 hover:bg-muted/60">
                  <CalendarClock className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">Next: {d.nextRun.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDateTime(d.nextRun.scheduledFor)} IST · {n(d.nextRun.companies)} logos
                    </p>
                  </div>
                </Link>
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
                      {n(r.done)}/{n(r.companies)} logos
                    </span>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </Split>
      )}
    </Page>
  )
}
