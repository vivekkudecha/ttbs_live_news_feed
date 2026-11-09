import type { ComponentProps, CSSProperties } from "react"
import { cn } from "@/lib/utils"

/** Page body: vertical rhythm, and children fade up in sequence on mount. */
export function Page({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("enter space-y-6 3xl:space-y-8", className)} {...props} />
}

/**
 * KPI tiles that fill the available width: 1–2 per row on phones, 4 on a laptop,
 * up to 6 on 2K/4K — no breakpoint bookkeeping in the pages.
 */
export function StatGrid({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3 sm:gap-5", className)} {...props} />
}

/** Responsive grid of cards (integrations, settings): as many ~22rem columns as fit. */
export function CardGrid({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-5", className)} {...props} />
}

/**
 * Two columns (main + side) from xl up; stacked below. Default: fluid main + a side column
 * that widens with the screen. `ratio` sets fluid tracks instead, e.g. "1.35fr 1fr".
 */
export function Split({ ratio, className, style, ...props }: ComponentProps<"div"> & { ratio?: string }) {
  const cols = ratio ? ratio.replace(/\S+/g, "minmax(0,$&)") : "minmax(0,1fr) clamp(20rem,24vw,30rem)"
  return <div className={cn("grid gap-5 xl:grid-cols-(--split) 3xl:gap-6", className)} style={{ "--split": cols, ...style } as CSSProperties} {...props} />
}
