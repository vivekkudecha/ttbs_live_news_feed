import logoUrl from "@/assets/ttbs-logo.svg"
import { cn } from "@/lib/utils"

/**
 * Tata Tele Business Services logo with the product name.
 * Shown as-is in both themes; the artwork stays legible on the dark sidebar.
 */
export function Logo({ className, subtitle = true, size = "md" }: { className?: string; subtitle?: boolean; size?: "md" | "lg" }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="inline-flex w-fit">
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
