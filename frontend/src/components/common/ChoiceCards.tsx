import { Check, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface Choice<K extends string> {
  key: K
  icon: LucideIcon
  title: string
  hint?: string
}

/** A radio group drawn as cards: icon, title, one line of help. Wraps to fit any width. */
export function ChoiceCards<K extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string
  options: Choice<K>[]
  value: K
  onChange: (key: K) => void
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2", className)}>
      {options.map((o) => {
        const on = value === o.key
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.key)}
            className={cn(
              "group relative flex min-w-0 items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on && "border-primary bg-primary/[0.06] ring-1 ring-primary",
            )}
          >
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-md transition-colors", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-primary")}>
              <o.icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{o.title}</span>
              {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
            </span>
            {on && <Check className="absolute right-2.5 top-2.5 size-3.5 text-primary" />}
          </button>
        )
      })}
    </div>
  )
}
