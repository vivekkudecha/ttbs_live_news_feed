/**
 * A research result shown section by section: Key signals (as points), Opportunity, Recommended
 * outreach and Sources. URLs are taken out of the text and listed once under Sources, and every
 * line wraps inside its box (long words and links never push the layout wider).
 */
import type { ReactNode } from "react"
import { ExternalLink, Lightbulb, Link2, Megaphone, Zap, type LucideIcon } from "lucide-react"
import { RichText, safeHref } from "@/components/common/RichText"
import { allSources, points, withoutUrls } from "@/lib/findings"
import { cn } from "@/lib/utils"
import type { Source } from "@/api/types"

export function ResultSections({
  keySignals,
  opportunity,
  outreach,
  sources,
  className,
}: {
  keySignals?: string | null
  opportunity?: string | null
  outreach?: string | null
  sources?: Source[]
  className?: string
}) {
  const pts = points(keySignals)
  const links = allSources(sources, keySignals, opportunity, outreach)
  return (
    <div className={cn("min-w-0 space-y-3 text-sm leading-relaxed", className)}>
      {pts.length > 0 && (
        <Section icon={Zap} label="Key signals" tone="text-brand bg-brand/10">
          <ul className="space-y-1.5">
            {pts.map((p, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/70" aria-hidden="true" />
                <span className="min-w-0">
                  <RichText text={p} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {opportunity && (
        <Section icon={Lightbulb} label="Opportunity" tone="text-chart-1 bg-chart-1/10">
          <RichText text={withoutUrls(opportunity)} />
        </Section>
      )}
      {outreach && (
        <Section icon={Megaphone} label="Recommended outreach" tone="text-success bg-success/10">
          <RichText text={withoutUrls(outreach)} />
        </Section>
      )}
      {links.length > 0 && (
        <Section icon={Link2} label={`Sources · ${links.length}`} tone="text-muted-foreground bg-muted">
          <ul className="space-y-1">
            {links.map((l) => {
              const href = safeHref(l.url)
              return (
                <li key={l.url} className="min-w-0">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      title={l.url}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex max-w-full items-center gap-1.5 text-primary underline-offset-2 hover:underline"
                    >
                      <ExternalLink className="size-3.5 shrink-0" />
                      <span className="truncate">{l.label}</span>
                    </a>
                  ) : (
                    <span className="wrap-anywhere text-muted-foreground">{l.url}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </div>
  )
}

function Section({ icon: Icon, label, tone, children }: { icon: LucideIcon; label: string; tone: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border bg-card p-3">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={cn("grid size-6 place-items-center rounded-md", tone)}>
          <Icon className="size-3.5" />
        </span>
        {label}
      </h4>
      <div className="min-w-0 wrap-anywhere text-foreground/90">{children}</div>
    </section>
  )
}
