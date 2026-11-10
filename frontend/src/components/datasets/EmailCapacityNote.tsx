import { Mail } from "lucide-react"
import { useEmailEstimate } from "@/api/hooks"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Email digests a run of this upload will send (one per PAM) against the mailbox's sending limits. */
export function EmailCapacityNote({ importId }: { importId: string }) {
  const est = useEmailEstimate(importId, true)
  const e = est.data
  if (!e || e.emails === 0) return null
  const n = (x: number) => x.toLocaleString("en-IN")
  const tight = e.queuedAhead + e.emails > e.remainingToday
  return (
    <p className={cn("flex items-start gap-2 rounded-lg p-3 text-xs", tight ? "bg-warning/12 text-foreground" : "bg-muted/50 text-muted-foreground")}>
      <Mail className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Up to {n(e.emails)} email digest{e.emails === 1 ? "" : "s"} (one per PAM)
        {e.queuedAhead ? `, behind ${n(e.queuedAhead)} already queued` : ""}. The mailbox can send {n(e.remainingToday)} more in the current 24 h window
        ({n(e.perDay)}/day).
        {tight && e.drainEta && ` Sending continues automatically in the next windows, oldest first; all sent by about ${fmtDateTime(e.drainEta)}.`}
      </span>
    </p>
  )
}
