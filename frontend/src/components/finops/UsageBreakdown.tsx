/**
 * Usage as billed: every paid LLM call's own usage report from the provider (tokens, cache, tool calls
 * and the cost split), added up. Day by day in UTC or IST, so it lines up with the provider console.
 */
import { useState, type ReactNode } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { UsageDay, UsageRow } from "@/api/types"
import { fmtDate, fmtUsd } from "@/lib/format"

const n = (x: number) => x.toLocaleString("en-IN")
const usd = (v: number) => fmtUsd(v, v >= 1 ? 2 : 4)
type Zone = "utc" | "ist"

function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 text-base font-medium">{value}</dd>
      {hint && <dd className="text-2xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

/** Where the amount came from: the provider's own figure, our price estimate, or calls from before tracking. */
function Source({ r }: { r: UsageRow }) {
  const parts = [
    r.providerCost > 0 && "provider-reported",
    r.estimatedCost > 0 && "estimated",
    r.untrackedCalls > 0 && `${n(r.untrackedCalls)} not itemised`,
  ].filter(Boolean)
  return <span className="text-xs text-muted-foreground">{parts.join(" · ") || "—"}</span>
}

/** The cost split under an amount: input · output · cache · tools (· other). */
function CostParts({ r }: { r: UsageRow }) {
  const parts: [string, number][] = [
    ["in", r.inputCost],
    ["out", r.outputCost],
    ["cache", r.cacheCost],
    ["tools", r.toolCost],
    ["other", r.otherCost],
  ]
  return <span className="block text-2xs text-muted-foreground">{parts.filter(([, v]) => v > 0).map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}</span>
}

const COLS: [string, (r: UsageRow) => ReactNode][] = [
  ["Calls", (r) => n(r.calls)],
  ["Input", (r) => n(r.tokensIn)],
  ["Cache read", (r) => n(r.cacheRead)],
  ["Cache write", (r) => n(r.cacheWrite)],
  ["Output", (r) => n(r.tokensOut)],
  ["Total tokens", (r) => <span className="font-medium">{n(r.totalTokens)}</span>],
  ["Tool calls", (r) => n(r.toolCalls)],
]

function Cells({ r }: { r: UsageRow }) {
  return (
    <>
      {COLS.map(([label, f]) => (
        <TableCell key={label} className="tabular text-right">
          {f(r)}
        </TableCell>
      ))}
      <TableCell className="tabular text-right">
        <span className="font-medium">{usd(r.cost)}</span>
        <CostParts r={r} />
      </TableCell>
      <TableCell>
        <Source r={r} />
      </TableCell>
    </>
  )
}

export function UsageBreakdown({ totals: t, daily }: { totals: UsageRow; daily: Record<Zone, UsageDay[]> }) {
  const [zone, setZone] = useState<Zone>("utc")
  const rows = daily[zone]

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Usage as billed</CardTitle>
          <CardDescription>
            Each paid research and AI-summary call, exactly as the provider's response reported it. Cache hits spend nothing and are not included.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-label="Tokens">
            <p className="eyebrow mb-2">Tokens</p>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Input" value={n(t.tokensIn)} hint={`${n(t.calls)} calls`} />
              <Figure label="Cache read" value={n(t.cacheRead)} hint={t.cacheWrite ? `${n(t.cacheWrite)} written` : undefined} />
              <Figure label="Output" value={n(t.tokensOut)} hint={t.reasoning ? `${n(t.reasoning)} reasoning` : undefined} />
              <Figure label="Total" value={n(t.totalTokens)} hint={`${n(t.toolCalls)} tool calls`} />
            </dl>
          </section>
          <section aria-label="Amount">
            <p className="eyebrow mb-2">Amount (USD)</p>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Input" value={usd(t.inputCost)} />
              <Figure label="Output" value={usd(t.outputCost)} />
              <Figure label="Cache + tools" value={usd(t.cacheCost + t.toolCost)} hint={`cache ${usd(t.cacheCost)} · tools ${usd(t.toolCost)}`} />
              <Figure
                label="Charged"
                value={<span className="text-primary">{usd(t.cost)}</span>}
                hint={t.otherCost > 0 || t.untrackedCost > 0 ? `incl. ${usd(t.otherCost + t.untrackedCost)} not itemised` : "sum of each call's total"}
              />
            </dl>
          </section>
        </div>

        <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {usd(t.providerCost)} reported by the provider · {usd(t.estimatedCost)} estimated from price settings (providers that send no cost)
          {t.untrackedCalls > 0 && ` · ${n(t.untrackedCalls)} calls (${usd(t.untrackedCost)}) recorded before the breakdown was tracked: totals only`}
        </p>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">By day and model</p>
            <ToggleGroup type="single" variant="outline" size="sm" value={zone} onValueChange={(v) => v && setZone(v as Zone)} aria-label="Day boundaries">
              <ToggleGroupItem value="utc">UTC days</ToggleGroupItem>
              <ToggleGroupItem value="ist">IST days</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <Table containerClassName="rounded-lg border">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Model</TableHead>
                {COLS.map(([label]) => (
                  <TableHead key={label} className="text-right">
                    {label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLS.length + 4} className="py-6 text-center text-sm text-muted-foreground">
                    No paid AI calls in this range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={`${r.date}-${r.provider}-${r.model}`}>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.date)}</TableCell>
                    <TableCell>
                      <span className="block">{r.model ?? "—"}</span>
                      <span className="text-2xs text-muted-foreground">{r.provider}</span>
                    </TableCell>
                    <Cells r={r} />
                  </TableRow>
                ))
              )}
            </TableBody>
            {rows.length > 1 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="font-medium">
                    Total
                  </TableCell>
                  <Cells r={t} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
          <p className="text-xs text-muted-foreground">
            Compare a day with the provider's usage page using the same day boundaries (provider consoles usually use UTC). In UTC view the first and last day
            may be partial, because the range is chosen in IST.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
