import { cn } from "@/lib/utils"

const tones = { info: "bg-brand-blue", brand: "bg-brand", success: "bg-success", danger: "bg-destructive" }

/** Pulsing "something is happening right now" indicator. */
export function LiveDot({ tone = "info", pulse = true, className }: { tone?: keyof typeof tones; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative flex size-2.5 shrink-0", className)} aria-hidden="true">
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", tones[tone])} />}
      <span className={cn("relative inline-flex size-2.5 rounded-full", tones[tone])} />
    </span>
  )
}
