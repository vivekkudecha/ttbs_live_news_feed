/** Small presentational pieces of the results board (rows, timeline sheet). */
import { useState } from "react"
import { AlertTriangle, ExternalLink, Mail, MessageCircle } from "lucide-react"
import { RichText, safeHref } from "@/components/common/RichText"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BoardDigest, BoardLogo, BoardPam, DeliveryChannel } from "@/api/types"
import { n } from "./board-utils"
import { withoutUrls } from "@/lib/findings"

// ---- Avatar ------------------------------------------------------------------------------------

const TONES = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
]

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("")
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold", TONES[h % TONES.length], className)}>
      {initials || "?"}
    </span>
  )
}

// ---- Outcome bar (PAM rows) --------------------------------------------------------------------------

export function OutcomeBar({ g }: { g: BoardPam }) {
  const parts = [
    ["Signals", g.signal, "bg-brand"],
    ["No signal", g.noSignal, "bg-muted-foreground/35"],
    ["Failed", g.failed, "bg-destructive"],
    ["In progress", g.pending, "bg-info/60 animate-pulse"],
  ] as const
  const total = Math.max(1, g.logos)
  const label = parts.filter(([, v]) => v).map(([l, v]) => `${l} ${v}`).join(", ")
  return (
    <div className="w-full max-w-36 space-y-1.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={label || "No logos"}>
        {parts.map(([l, v, cls]) => (v ? <span key={l} className={cn("h-full transition-[width] duration-500", cls)} style={{ width: `${(v / total) * 100}%` }} /> : null))}
      </div>
      <p className="tabular text-xs text-muted-foreground">
        {g.doneAll === g.totalAll ? `${n(g.totalAll)} researched` : `${n(g.doneAll)} of ${n(g.totalAll)} researched`}
        {g.logos !== g.totalAll && <span> · {n(g.logos)} match</span>}
      </p>
    </div>
  )
}

// ---- Digest delivery (PAM rows) ------------------------------------------------------------------------

const CH_ICON: Record<DeliveryChannel, typeof Mail> = { email: Mail, whatsapp: MessageCircle }

export function DigestBadges({ g }: { g: BoardPam }) {
  const chans = Object.entries(g.digests) as [DeliveryChannel, BoardDigest][]
  if (!chans.length) return <span className="text-xs text-muted-foreground">{g.doneAll < g.totalAll ? "After the last logo" : "—"}</span>
  return (
    <div className="flex flex-col items-start gap-1 [&_[data-slot=badge]]:text-[11px]">
      {chans.map(([ch, d]) => {
        const Icon = CH_ICON[ch] ?? Mail
        const detail = d.status === "sent" ? `Sent ${fmtDateTime(d.sentAt)}` : d.lastError ?? d.status
        return (
          <Tooltip key={ch}>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-wrap items-center gap-1">
                <Icon className="size-3.5 text-muted-foreground" aria-label={ch} />
                <StatusBadge status={d.status === "sending" ? "running" : d.status} />
                {d.outdated && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                    <AlertTriangle className="size-3" /> Outdated
                  </span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="capitalize">{ch}: {detail}</p>
              {d.outdated && (
                <p className="mt-1">
                  Built with {d.signals ?? 0} signals; this PAM has {g.signalAll} now. Resend to update it.
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

// ---- Findings (logo rows and the timeline sheet) -----------------------------------------------------------

export function Findings({ r, full = false }: { r: BoardLogo; full?: boolean }) {
  const [open, setOpen] = useState(full)
  if (r.status === "failed") return <span className="text-destructive">{r.error ?? "Failed"}</span>
  if (r.status === "no_signal") return <span className="text-muted-foreground">No TTBS-relevant news in the window.</span>
  if (r.status !== "signal")
    return <span className="text-muted-foreground">{r.status === "running" ? "Researching now…" : r.error ? `Retrying: ${r.error}` : "Waiting in queue…"}</span>
  return (
    <div className="space-y-1.5">
      <div className={cn("wrap-anywhere", !open && "line-clamp-2")}>
        <RichText text={withoutUrls(r.keySignals)} />
      </div>
      {open && (
        <>
          {r.opportunity && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Opportunity: </span>
              <RichText text={withoutUrls(r.opportunity)} />
            </p>
          )}
          {r.outreach && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Outreach: </span>
              <RichText text={withoutUrls(r.outreach)} />
            </p>
          )}
          {r.sources.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
              {r.sources.map((s) => (
                <a
                  key={s.url}
                  href={safeHref(s.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  <ExternalLink className="size-3" /> {s.title}
                </a>
              ))}
            </div>
          )}
        </>
      )}
      {!full && (r.opportunity || r.outreach || r.sources.length > 0) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
          className="text-xs font-medium text-primary hover:underline"
        >
          {open ? "Show less" : "Opportunity, outreach & sources"}
        </button>
      )}
    </div>
  )
}

