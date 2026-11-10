/** Cell renderers for the Schedules tables (columns.tsx wires them into columns). */
import { Link } from "react-router-dom"
import { AlertTriangle, Mail, MessageCircle, SkipForward } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { LiveDot } from "@/components/common/LiveDot"
import { StatusBadge } from "@/components/common/StatusBadge"
import type { Schedule } from "@/api/schedules"
import type { DeliveryChannel } from "@/api/types"
import { fmtDateTime, fmtRelative } from "@/lib/format"
import { cn } from "@/lib/utils"

const SOON_MS = 3_600_000

export function Delivery({ channels }: { channels: DeliveryChannel[] }) {
  if (channels.length === 0) return <Badge variant="outline" className="font-normal">Research only</Badge>
  return (
    <span className="flex flex-wrap gap-1">
      {channels.includes("email") && <Badge variant="secondary" className="gap-1 font-normal"><Mail className="size-3" /> Email</Badge>}
      {channels.includes("whatsapp") && <Badge variant="secondary" className="gap-1 font-normal"><MessageCircle className="size-3" /> WhatsApp</Badge>}
    </span>
  )
}

export function When({ iso, paused }: { iso: string | null; paused?: boolean }) {
  if (paused || !iso) return <span className="text-sm text-muted-foreground">Paused</span>
  const soon = new Date(iso).getTime() - Date.now() < SOON_MS
  return (
    <span className="flex items-center gap-2 whitespace-nowrap" title={fmtDateTime(iso)}>
      {soon && <LiveDot />}
      <span className="leading-tight">
        <span className="block text-sm font-medium">{fmtRelative(iso)}</span>
        <span className="block text-xs text-muted-foreground">{fmtDateTime(iso)}</span>
      </span>
    </span>
  )
}

export function LastRun({ s }: { s: Schedule }) {
  if (!s.lastRunAt) return <span className="text-sm text-muted-foreground">Not run yet</span>
  if (s.lastOutcome === "started" && s.lastRun)
    return (
      <span className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Link to={`/runs/${s.lastRun.id}`} className="text-sm font-medium text-primary hover:underline">
          Run #{s.lastRun.id}
        </Link>
        <StatusBadge status={s.lastRun.status} />
      </span>
    )
  const skipped = s.lastOutcome === "skipped"
  const Icon = skipped ? SkipForward : AlertTriangle
  return (
    <span className={cn("flex items-start gap-1.5 text-xs", skipped ? "text-warning" : "text-destructive")} title={s.lastError ?? undefined}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="line-clamp-2">
        {skipped ? "Skipped" : "Did not start"} {fmtRelative(s.lastRunAt)}: {s.lastError}
      </span>
    </span>
  )
}
