import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { DeliveryStatus, ResearchStatus, RunStatus } from "@/api/types"

export type AnyStatus =
  | RunStatus
  | DeliveryStatus
  | ResearchStatus
  | "connected"
  | "not_configured"
  | "error"
  | "active"
  | "inactive"
  | "processing"

type Tone = "neutral" | "success" | "info" | "warning" | "danger" | "brand"

const map: Record<AnyStatus, { label: string; tone: Tone; spin?: boolean }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  queued: { label: "Queued", tone: "neutral" },
  processing: { label: "Processing", tone: "info", spin: true },
  running: { label: "Running", tone: "info", spin: true },
  completed: { label: "Completed", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  sent: { label: "Sent", tone: "success" },
  pending: { label: "Pending", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
  signal: { label: "Signal", tone: "brand" },
  no_signal: { label: "No signal", tone: "neutral" },
  connected: { label: "Connected", tone: "success" },
  not_configured: { label: "Not configured", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
}

const dot: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  danger: "bg-destructive",
  brand: "bg-brand",
}

const pill: Record<Tone, string> = {
  neutral: "bg-muted",
  success: "bg-success/10",
  info: "bg-info/10",
  warning: "bg-warning/12",
  danger: "bg-destructive/10",
  brand: "bg-brand/12",
}

/** Status = tinted pill with coloured dot + text label (never colour alone). */
export function StatusBadge({ status, label, className }: { status: AnyStatus; label?: string; className?: string }) {
  const s = map[status]
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium text-foreground/85", pill[s.tone], className)}>
      {s.spin ? <Loader2 className="size-3 animate-spin text-info" /> : <span className={cn("size-1.5 rounded-full", dot[s.tone])} aria-hidden="true" />}
      {label ?? s.label}
    </span>
  )
}
