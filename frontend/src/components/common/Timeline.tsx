import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * Vertical timeline adapted from the 21st.dev "Timeline" pattern (kuratlielia):
 * a connecting rail that draws downward, markers that pop in one after another,
 * and rows that expand in place. CSS-only (no motion library); the global
 * prefers-reduced-motion rule disables the animations.
 */

export type TimelineTone = "brand" | "neutral" | "success" | "danger" | "info"

export interface TimelineItem {
  id: string
  title: ReactNode
  meta?: ReactNode
  /** Right-aligned time label, e.g. a date range. */
  time?: ReactNode
  icon?: ReactNode
  tone?: TimelineTone
  /** Revealed in place when the row is expanded. Rows without detail are not interactive. */
  detail?: ReactNode
}

const markerTone: Record<TimelineTone, string> = {
  brand: "border-transparent bg-brand-gradient text-white shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_14%,transparent)]",
  neutral: "border-border bg-card text-muted-foreground",
  success: "border-transparent bg-success text-white",
  danger: "border-transparent bg-destructive text-white",
  info: "border-transparent bg-brand-blue text-white",
}

export function Timeline({
  items,
  label,
  defaultExpanded = [],
  className,
}: {
  items: TimelineItem[]
  label: string
  defaultExpanded?: string[]
  className?: string
}) {
  const [open, setOpen] = useState(() => new Set(defaultExpanded))
  const baseId = useId()

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Arrow keys move between expandable rows (as in the original pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return
    const triggers = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-tl-trigger]")]
    const i = triggers.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    e.preventDefault()
    const n = e.key === "Home" ? 0 : e.key === "End" ? triggers.length - 1 : Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), triggers.length - 1)
    triggers[n]?.focus()
  }

  return (
    <ol aria-label={label} onKeyDown={onKeyDown} className={cn("relative", className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1
        const expanded = open.has(item.id)
        const detailId = `${baseId}-${item.id}`
        const delay = { "--tl-delay": `${Math.min(i, 8) * 70}ms` } as CSSProperties
        const Row = item.detail ? "button" : "div"
        return (
          <li key={item.id} className="relative grid grid-cols-[2rem_1fr] gap-x-4 pb-6 last:pb-0" style={delay}>
            {!last && (
              <span
                aria-hidden="true"
                className="absolute left-[calc(1rem-0.5px)] top-9 bottom-1 w-px origin-top bg-border motion-safe:animate-[tl-draw_420ms_cubic-bezier(.2,.7,.2,1)_both] [animation-delay:calc(var(--tl-delay)+120ms)]"
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "relative z-[1] mt-0.5 flex size-8 items-center justify-center rounded-full border [&_svg]:size-3.5",
                "motion-safe:animate-[tl-pop_380ms_cubic-bezier(.3,1.4,.5,1)_both] [animation-delay:var(--tl-delay)]",
                markerTone[item.tone ?? "neutral"],
              )}
            >
              {item.icon}
            </span>
            <div className="min-w-0">
              <Row
                {...(item.detail
                  ? { type: "button" as const, "data-tl-trigger": "", "aria-expanded": expanded, "aria-controls": detailId, onClick: () => toggle(item.id) }
                  : {})}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md text-left",
                  item.detail && "-mx-2 px-2 py-1.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                  !item.detail && "py-1.5",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-foreground">{item.title}</span>
                  {item.time && <span className="tabular mt-0.5 block text-xs text-muted-foreground sm:hidden">{item.time}</span>}
                  {item.meta && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{item.meta}</span>}
                </span>
                {item.time && <span className="tabular hidden shrink-0 pt-0.5 text-xs text-muted-foreground sm:block">{item.time}</span>}
                {item.detail && (
                  <ChevronDown aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} />
                )}
              </Row>
              {item.detail && (
                <div
                  id={detailId}
                  className={cn(
                    "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
                    expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                  inert={!expanded}
                >
                  <div className="overflow-hidden">
                    <div className="pb-1 pt-3">{item.detail}</div>
                  </div>
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
