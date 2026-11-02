import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Database, Gauge, PiggyBank, Target, TrendingUp } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useFinops, useRuns } from "@/api/hooks"
import { fmtDate, fmtUsd, pct } from "@/lib/format"

export default function Costs() {
  const f = useFinops()
  const runs = useRuns()
  if (!f.data || !runs.data) return <Skeleton className="h-96" />
  const d = f.data
  const used = pct(d.monthSpend, d.monthBudget)
  const total = d.byProvider.reduce((s, x) => s + x.cost, 0)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Costs (FinOps)"
        description="Every provider call is metered into a cost ledger. Budgets block new runs at the hard cap; caching and per-PAM prioritization keep cost per signal down."
      />
      <div className="grid grid-cols-2 gap-3 sm:gap-6 xl:grid-cols-4">
        <StatCard icon={Gauge} label="Month to date" value={fmtUsd(d.monthSpend)} hint={`${used}% of ${fmtUsd(d.monthBudget, 0)} budget`} />
        <StatCard icon={TrendingUp} tone="info" label="Month forecast" value={fmtUsd(d.forecast)} hint="3 scheduled cycles at current scope" />
        <StatCard icon={Target} tone="success" label="Cost per actionable signal" value={fmtUsd(d.costPerSignal, 3)} hint="Last completed run" />
        <StatCard icon={PiggyBank} tone="warning" label="Saved by cache" value={fmtUsd(d.cacheSavings)} hint="Duplicate company research avoided" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Monthly spend</CardTitle>
            <CardDescription>USD · research &amp; prioritization (LLM) vs WhatsApp messaging</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72" role="img" aria-label="Monthly spend chart; values listed in the table below">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.series} margin={{ left: -8, right: 8, top: 8 }} barCategoryGap="28%">
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.6 }}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }}
                    formatter={(v: number, name: string) => [fmtUsd(v), name]}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(value: string) => <span style={{ color: "var(--foreground)" }}>{value}</span>}
                  />
                  <Bar dataKey="llm" name="LLM research" stackId="a" fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
                  <Bar dataKey="messaging" name="WhatsApp messaging" stackId="a" fill="var(--chart-2)" stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Budget · November</CardTitle>
            <CardDescription>Soft alert at {d.softLimitPct}% · hard cap blocks new runs</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="mb-1.5 flex justify-between text-sm">
                <span className="tabular font-medium">{fmtUsd(d.monthSpend)}</span>
                <span className="text-muted-foreground">{fmtUsd(d.monthBudget, 0)}</span>
              </div>
              <div className="relative">
                <Progress value={used} className="h-2.5" />
                <span className="absolute -top-1 h-4.5 w-px bg-warning" style={{ left: `${d.softLimitPct}%` }} title="Soft alert" />
              </div>
            </div>
            <div className="space-y-2.5">
              {d.byProvider.map((p) => (
                <div key={p.name}>
                  <div className="flex justify-between text-sm">
                    <span>{p.name}</span>
                    <span className="tabular font-medium">{fmtUsd(p.cost)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted">
                    <div className="h-1.5 rounded-full bg-chart-1" style={{ width: `${pct(p.cost, total)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="flex items-start gap-1.5 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <Database className="mt-0.5 size-3.5 shrink-0" /> Cost levers: result cache per company &amp; window, alias de-duplication, per-template depth
              preset, and per-PAM (not global) prioritization prompts.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="py-0">
        <CardHeader className="pt-5">
          <CardTitle>Cost by run</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[40rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Run</TableHead>
                <TableHead>Window end</TableHead>
                <TableHead className="text-right">Companies</TableHead>
                <TableHead className="text-right">Estimate</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="pr-5 text-right">Per signal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5 font-medium">{r.id}</TableCell>
                  <TableCell>{fmtDate(r.windowEnd)}</TableCell>
                  <TableCell className="tabular text-right">{r.companies}</TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">{fmtUsd(r.estimatedCost)}</TableCell>
                  <TableCell className="tabular text-right">{fmtUsd(r.cost)}</TableCell>
                  <TableCell className="tabular pr-5 text-right">{r.withSignal ? fmtUsd(r.cost / r.withSignal, 3) : "—"}</TableCell>
                </TableRow>
              ))}
              {d.series.map((s) => (
                <TableRow key={s.month} className="sr-only">
                  <TableCell>
                    {s.month}: LLM {fmtUsd(s.llm)}, messaging {fmtUsd(s.messaging)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
