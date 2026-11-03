import { ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { RichText, safeHref } from "./RichText"
import type { ResearchResult } from "@/api/types"
import { cn } from "@/lib/utils"

// One quiet dot per trigger type; the text label carries the meaning.
const categoryDot: Record<string, string> = {
  Expansion: "bg-chart-1",
  Funding: "bg-chart-4",
  Leadership: "bg-chart-5",
  Cybersecurity: "bg-destructive",
  Digital: "bg-chart-3",
  Contract: "bg-brand",
}

export function SignalSections({ result, compact = false }: { result: ResearchResult; compact?: boolean }) {
  const rows: [string, string | undefined][] = [
    ["Key signals", result.keySignals],
    ["Opportunity type", result.opportunity],
    ["Recommended outreach", result.outreach],
  ]
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed text-foreground/85", compact && "space-y-1.5")}>
      {rows.map(([label, text]) => (
        <div key={label} className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-4">
          <span className="text-[0.9375rem] text-muted-foreground">{label}</span>
          <span>
            <RichText text={text} />
          </span>
        </div>
      ))}
      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5 pt-2 sm:pl-[12rem]">
          {result.offerings.map((o) => (
            <Badge key={o} variant="secondary" className="font-normal text-muted-foreground">
              {o}
            </Badge>
          ))}
          <span className="mx-1.5 hidden h-3.5 w-px bg-border sm:inline-block" />
          {result.sources.map((s) => {
            const href = safeHref(s.url)
            return href ? (
              <a
                key={s.url}
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-xs text-brand-blue underline-offset-2 hover:underline"
              >
                <ExternalLink className="size-3" />
                {s.title}
              </a>
            ) : null
          })}
        </div>
      )}
    </div>
  )
}

export function CategoryBadge({ category }: { category?: string }) {
  if (!category) return null
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-foreground/80">
      <span className={cn("size-1.5 rounded-full", categoryDot[category])} aria-hidden="true" />
      {category}
    </Badge>
  )
}
