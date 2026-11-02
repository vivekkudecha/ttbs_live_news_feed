import logoUrl from "@/assets/ttbs-logo.svg"
import { cn } from "@/lib/utils"

/**
 * Tata Tele Business Services logo with the product name.
 * The logo artwork is designed for light backgrounds, so in dark mode it sits on a white plate.
 */
export function Logo({ className, subtitle = true, size = "md" }: { className?: string; subtitle?: boolean; size?: "md" | "lg" }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="inline-flex w-fit rounded-md dark:bg-white dark:px-2 dark:py-1">
        <img src={logoUrl} alt="Tata Tele Business Services" className={cn("w-auto", size === "lg" ? "h-10" : "h-7")} />
      </span>
      {subtitle && (
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="h-3 w-0.5 rounded-full bg-brand-gradient" aria-hidden="true" />
          Signals · Live News Feed
        </span>
      )}
    </div>
  )
}
