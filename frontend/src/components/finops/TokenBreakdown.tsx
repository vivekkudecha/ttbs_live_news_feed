/**
 * Click a token total to see how the provider counted it: input (with cache read / write), output
 * (with reasoning), tool calls and the cost of each part. Only the fields the provider reports are
 * listed; anything else non-zero is shown too.
 */
import type { ReactNode } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { CostRow } from "@/api/types"
import { fmtUsd } from "@/lib/format"
import { providerLabel } from "@/lib/models"

const n = (x: number) => x.toLocaleString("en-IN")
const usd = (v: number) => fmtUsd(v, v >= 1 ? 2 : 4)

type Field = "cacheRead" | "cacheWrite" | "reasoning" | "toolCalls"
/** What each provider's usage report contains (research/providers.py, research/gemini.py). */
const REPORTS: Record<string, Field[]> = {
  perplexity: ["cacheRead", "cacheWrite", "toolCalls"],
  gemini: ["cacheRead", "reasoning", "toolCalls"],
}

function Line({ label, value, sub, strong }: { label: string; value: ReactNode; sub?: boolean; strong?: boolean }) {
  return (
    <div className={sub ? "flex justify-between gap-6 pl-3 text-xs text-muted-foreground" : "flex justify-between gap-6"}>
      <dt className={strong ? "font-medium" : undefined}>{sub ? `↳ ${label}` : label}</dt>
      <dd className={strong ? "tabular font-semibold" : "tabular"}>{value}</dd>
    </div>
  )
}

export function TokenBreakdown({ row, provider, children }: { row: CostRow; provider?: string | null; children: ReactNode }) {
  const u = row.usage
  const total = row.tokensIn + row.tokensOut
  if (!u || total === 0) return <>{children}</>
  const reports = provider ? REPORTS[provider] : undefined
  const show = (f: Field) => u[f] > 0 || !!reports?.includes(f)
  const parts = u.inputCost + u.outputCost + u.cacheCost + u.toolCost
  const unitemised = Math.max(row.llm - parts, 0)
  const source = provider ? providerLabel(provider) : "the provider"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="tabular cursor-pointer rounded underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:text-primary hover:decoration-primary"
          aria-label={`Token breakdown: ${n(total)} tokens`}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="font-medium">Token usage</p>
          <p className="text-xs text-muted-foreground">
            {n(row.calls)} paid {row.calls === 1 ? "call" : "calls"} · as reported by {source}
            {row.cacheHits > 0 && ` · ${n(row.cacheHits)} from cache used none`}
          </p>
        </div>

        <dl className="space-y-1">
          <Line label="Input" value={n(row.tokensIn)} />
          {show("cacheRead") && <Line sub label="cache read" value={n(u.cacheRead)} />}
          {show("cacheWrite") && <Line sub label="cache write" value={n(u.cacheWrite)} />}
          <Line label="Output" value={n(row.tokensOut)} />
          {show("reasoning") && <Line sub label="reasoning (thinking)" value={n(u.reasoning)} />}
          <div className="border-t pt-1">
            <Line strong label="Total tokens" value={n(total)} />
          </div>
          {show("toolCalls") && <Line label="Tool calls (web search)" value={n(u.toolCalls)} />}
        </dl>

        <dl className="space-y-1 rounded-md bg-muted/50 p-2.5">
          <Line label="Input cost" value={usd(u.inputCost)} />
          <Line label="Output cost" value={usd(u.outputCost)} />
          {(u.cacheCost > 0 || show("cacheRead")) && <Line label="Cache cost" value={usd(u.cacheCost)} />}
          {(u.toolCost > 0 || show("toolCalls")) && <Line label="Tool cost" value={usd(u.toolCost)} />}
          {unitemised >= 0.00005 && <Line label={u.untrackedCalls > 0 ? "Not itemised" : "Other"} value={usd(unitemised)} />}
          <div className="border-t pt-1">
            <Line strong label="AI cost" value={usd(row.llm)} />
          </div>
        </dl>

        {(u.untrackedCalls > 0 || u.estimatedCost > 0) && (
          <p className="text-xs text-muted-foreground">
            {u.untrackedCalls > 0 && `${n(u.untrackedCalls)} calls were recorded before the breakdown was tracked: their totals only. `}
            {u.estimatedCost > 0 && `${usd(u.estimatedCost)} is estimated from price settings (the provider sends no cost).`}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
