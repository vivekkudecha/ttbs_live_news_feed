/**
 * FinOps: every figure comes from the cost ledger (one row per LLM call, cache hit and delivered
 * message, each tagged with its run, upload, PAM and logo). USD, IST dates.
 */
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts"
import { AlertTriangle, Ban, Download, Gauge, Info, PiggyBank, Target, TrendingUp, Wallet } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CostTable } from "@/components/runs/RunInsights"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useFinops } from "@/api/hooks"
import { errorMessage, ledgerCsvUrl } from "@/api/http"
import { fmtDate, fmtUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Page, StatGrid, Split } from "@/components/common/layout"
import { ChartCard } from "@/components/common/ChartCard"
import { chartTheme } from "@/components/common/chart-theme"

const n = (x: number) => x.toLocaleString("en-IN")
type Preset = "month" | "30" | "90" | "custom"

/** Today's date in IST as YYYY-MM-DD. */
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
const minusDays = (d: string, days: number) => {
  const x = new Date(`${d}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() - days)
  return x.toISOString().slice(0, 10)
}

function rangeFor(p: Preset, custom: { from: string; to: string }) {
  const today = istToday()
  if (p === "month") return { from: `${today.slice(0, 8)}01`, to: today }
  if (p === "30") return { from: minusDays(today, 29), to: today }
  if (p === "90") return { from: minusDays(today, 89), to: today }
  return custom
}

const usd = (v: number) => (v >= 1 ? fmtUsd(v, 2) : fmtUsd(v, 4))

export default function Costs() {
  const [preset, setPreset] = useState<Preset>("month")
  const [custom, setCustom] = useState(() => ({ from: minusDays(istToday(), 6), to: istToday() }))
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom])
  const f = useFinops(range)

  const filters = (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
        <SelectTrigger className="w-44" aria-label="Date range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="month">This month</SelectItem>
          <SelectItem value="30">Last 30 days</SelectItem>
          <SelectItem value="90">Last 90 days</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>
      {preset === "custom" && (
        <>
          <Input type="date" aria-label="From" className="w-40" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          <span className="text-sm text-muted-foreground">to</span>
          <Input type="date" aria-label="To" className="w-40" value={custom.to} min={custom.from} max={istToday()} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
        </>
      )}
      <span className="text-sm text-muted-foreground">
        {fmtDate(range.from)} – {fmtDate(range.to)} · USD
      </span>
      <Button variant="outline" className="ml-auto" asChild>
        <a href={ledgerCsvUrl(range)} download>
          <Download /> Export ledger (CSV)
        </a>
      </Button>
    </div>
  )

  return (
    <div>
      <PageHeader title="Costs (FinOps)" description="Every research call, cache hit and delivered message is metered into a cost ledger, tagged with its run, upload, PAM and logo." />
      {filters}
      {f.isError ? (
        <p className="text-sm text-destructive">{errorMessage(f.error)}</p>
      ) : !f.data ? (
        <Skeleton className="h-96" />
      ) : (
        <Report d={f.data} stale={f.isPlaceholderData} />
      )}
    </div>
  )
}

function Report({ d, stale }: { d: NonNullable<ReturnType<typeof useFinops>["data"]>; stale: boolean }) {
  const t = d.totals
  const b = d.budget
  const series = d.series.map((p) => ({ ...p, label: new Date(`${p.date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }) }))
  const unpriced = d.prices.whatsappPerMessage === 0 || d.prices.emailPerMessage === 0

  return (
    <Page className={cn("transition-opacity", stale && "opacity-60")}>
      <StatGrid>
        <StatCard icon={Wallet} label="Spend in range" value={usd(t.total)} hint={`research ${usd(t.llm)} · messaging ${usd(t.messaging)}`} />
        <StatCard icon={Target} label="Cost per actionable signal" value={t.costPerSignal != null ? usd(t.costPerSignal) : "—"} hint={`${n(t.signals)} signals · ${t.costPerCompany != null ? `${usd(t.costPerCompany)} per logo` : "no logos researched"}`} />
        <StatCard icon={PiggyBank} label="Saved by cache" value={usd(t.saved)} hint={`${n(t.cacheHits)} of ${n(t.calls + t.cacheHits)} logos reused a fresh answer (${t.cacheRate}%)`} />
        <StatCard icon={Ban} label="Spent on failed research" value={usd(t.failedCost)} hint={`${n(t.failedCalls)} billed calls ended in failure`} />
      </StatGrid>

      <Split ratio="1.5fr 1fr">
        <ChartCard
          title="Daily spend"
          description="USD per day (IST): research (LLM) and digest messaging"
          label="Daily spend chart; totals by run, upload and PAM are in the tables below"
          height="h-72 3xl:h-96"
        >
          <BarChart data={series} margin={{ left: -4, right: 8, top: 8 }} barCategoryGap="24%">
            <CartesianGrid vertical={false} {...chartTheme.grid} />
            <XAxis dataKey="label" {...chartTheme.axis} minTickGap={16} />
            <YAxis {...chartTheme.axis} tickFormatter={(v: number) => `$${v}`} />
            <Tooltip {...chartTheme.tooltip} formatter={(v: number, name: string) => [usd(v), name]} />
            <Legend {...chartTheme.legend} />
            <Bar dataKey="llm" name="Research (LLM)" stackId="a" fill="var(--chart-1)" {...chartTheme.bar} />
            <Bar dataKey="messaging" name="Messaging" stackId="a" fill="var(--chart-2)" {...chartTheme.bar} radius={[6, 6, 0, 0]} />
          </BarChart>
        </ChartCard>

        <Card>
          <CardHeader>
            <CardTitle>Monthly budget</CardTitle>
            <CardDescription>
              Alert at {b.softLimitPct}% · {b.hardCap ? "new runs are blocked at 100%" : "hard cap is off"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="mb-1.5 flex justify-between text-sm">
                <span className="tabular font-medium">{fmtUsd(b.monthSpend)} spent</span>
                <span className="text-muted-foreground">of {fmtUsd(b.monthly, 0)}</span>
              </div>
              <div className="relative">
                <Progress value={Math.min(100, b.usedPct)} className="h-2.5" aria-label={`${b.usedPct}% of the monthly budget used`} />
                <span className="absolute -top-1 h-4.5 w-px bg-foreground/50" style={{ left: `${b.softLimitPct}%` }} title="Alert threshold" />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{b.usedPct}% used this month</p>
            </div>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <TrendingUp className="size-3.5" /> Month forecast
                </dt>
                <dd className="tabular mt-1 text-lg font-medium">{fmtUsd(b.forecast)}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Gauge className="size-3.5" /> Tokens in / out
                </dt>
                <dd className="tabular mt-1 text-lg font-medium">
                  {n(t.tokensIn)} / {n(t.tokensOut)}
                </dd>
              </div>
            </dl>
            {b.forecast > b.monthly && b.monthly > 0 && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                At the current rate this month's spend will exceed the budget.
              </p>
            )}
            {unpriced && (
              <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Per-message prices are not set ({d.prices.whatsappPerMessage === 0 ? "WhatsApp" : ""}
                {d.prices.whatsappPerMessage === 0 && d.prices.emailPerMessage === 0 ? ", " : ""}
                {d.prices.emailPerMessage === 0 ? "email" : ""}), so messages are counted at $0. Set NOTIFY_PRICE_WHATSAPP_USD / NOTIFY_PRICE_EMAIL_USD from your rate cards.
              </p>
            )}
          </CardContent>
        </Card>
      </Split>

      <Tabs defaultValue="runs">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="runs">By run</TabsTrigger>
          <TabsTrigger value="uploads">By upload</TabsTrigger>
          <TabsTrigger value="pams">By PAM</TabsTrigger>
          <TabsTrigger value="models">By model &amp; channel</TabsTrigger>
          <TabsTrigger value="logos">Top logos</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="mt-4">
          <CostTable
            title="Cost by run"
            description="Each research run in the range, most expensive first"
            rows={d.byRun.map((r) => ({
              key: r.id,
              name: (
                <Link to={`/runs/${r.id}?tab=costs`} className="hover:underline">
                  #{r.id} {r.label}
                </Link>
              ),
              sub: (
                <span className="inline-flex items-center gap-2">
                  {r.status && <StatusBadge status={r.status} />} {r.companies != null && `${n(r.companies)} logos`} {r.startedAt && `· ${fmtDate(r.startedAt)}`}
                </span>
              ),
              ...r,
            }))}
          />
        </TabsContent>
        <TabsContent value="uploads" className="mt-4">
          <CostTable
            title="Cost by upload"
            description="All runs of each upload, including re-runs"
            rows={d.byUpload.map((u) => ({
              key: u.id,
              name: (
                <Link to={`/imports?open=${u.id}`} className="hover:underline">
                  {u.label}
                </Link>
              ),
              sub: u.fileName,
              ...u,
            }))}
          />
        </TabsContent>
        <TabsContent value="pams" className="mt-4">
          <CostTable title="Cost by PAM" description="Research of each PAM's logos plus their digests" rows={d.byPam.map((p) => ({ ...p, key: p.id, name: p.name, sub: p.email }))} />
        </TabsContent>
        <TabsContent value="models" className="mt-4">
          <CostTable
            title="Cost by model and channel"
            description="Research AI models and delivery channels"
            rows={d.byModel.map((m) => ({
              key: `${m.category}-${m.provider}-${m.model}`,
              name: m.category === "llm" ? `${m.provider} · ${m.model ?? "—"}` : `${m.provider === "whatsapp" ? "WhatsApp" : "Email"} messages`,
              sub: m.category === "llm" ? "Research (LLM)" : `${n(m.messages)} sent via ${m.model ?? "adapter"}`,
              ...m,
            }))}
          />
        </TabsContent>
        <TabsContent value="logos" className="mt-4">
          <CostTable title="Most expensive logos" description="Top 25 logos by research spend in the range" rows={d.topCompanies.map((c) => ({ ...c, key: c.id, name: c.name }))} />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
