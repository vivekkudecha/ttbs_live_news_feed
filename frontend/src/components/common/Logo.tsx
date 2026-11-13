import logoUrl from "@/assets/ttbs-logo.svg"
import markUrl from "@/assets/ttbs-mark.png"
import { cn } from "@/lib/utils"

/**
 * Tata Tele Business Services logo with the product name.
 * Shown as-is in both themes; the artwork stays legible on the dark sidebar.
 * `compact` swaps in the "Do Big" app mark (the same image as the favicon) for the collapsed sidebar
 * rail. It is bundled (not read from /public) so the URL is right on nested routes too.
 */
export function Logo({ className, subtitle = true, size = "md", compact = false }: { className?: string; subtitle?: boolean; size?: "md" | "lg"; compact?: boolean }) {
  if (compact) return <img src={markUrl} alt="TTBS Signals" width={63} height={56} className={cn("h-8 w-auto rounded-md shadow-sm", className)} />
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
