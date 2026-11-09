/**
 * "Research this upload?" — shown when an upload finishes saving, and when re-running an earlier one.
 * Now · at a time (once) · not now. Every run covers exactly this upload's logos and delivers to the
 * PAMs this upload mapped them to.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { CalendarClock, Check, Clock, Info, Loader2, Mail, MessageCircle, Play, Rocket } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useEmailEstimate, useStartRun } from "@/api/hooks"
import { ApiError, errorMessage } from "@/api/http"
import { fmtDateTime, fmtUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { DeliveryChannel } from "@/api/types"

const PER_COMPANY_USD = 0.0125
type Mode = "now" | "at" | "later"

/** datetime-local value one hour from now (browser time). */
const inAnHour = () => {
  const d = new Date(Date.now() + 3_600_000)
  d.setSeconds(0, 0)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

const CHANNELS: { key: DeliveryChannel; label: string; hint: string; icon: typeof Mail }[] = [
  { key: "email", label: "Email", hint: "Digest to each PAM's inbox", icon: Mail },
  { key: "whatsapp", label: "WhatsApp", hint: "Short alert to each PAM", icon: MessageCircle },
]

/** Delivery channels as toggle tiles (any combination; at least one is required to start). */
export function ChannelPicker({ value, onChange }: { value: DeliveryChannel[]; onChange: (v: DeliveryChannel[]) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {CHANNELS.map((c) => {
        const on = value.includes(c.key)
        return (
          <button
            key={c.key}
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => onChange(on ? value.filter((x) => x !== c.key) : [...value, c.key])}
            className={cn(
              "flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all duration-200 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border-primary/60 bg-primary/[0.06]" : "bg-card opacity-80 hover:opacity-100",
            )}
          >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-md transition-colors", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
              <c.icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{c.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{c.hint}</span>
            </span>
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Email digests this run will send (one per PAM) against the mailbox's sending limits. */
function EmailCapacityNote({ importId }: { importId: string }) {
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

export function ResearchPlan({
  importId,
  label,
  companies,
  previousRuns = 0,
  lastRunAt,
  onDone,
}: {
  importId: string
  label: string
  companies: number
  previousRuns?: number
  lastRunAt?: string | null
  onDone?: () => void
}) {
  const navigate = useNavigate()
  const start = useStartRun()
  const [mode, setMode] = useState<Mode>("now")
  const [runAt, setRunAt] = useState(inAnHour)
  const [channels, setChannels] = useState<DeliveryChannel[]>(["email", "whatsapp"])

  const options: { key: Mode; icon: typeof Play; title: string; hint: string }[] = [
    { key: "now", icon: Play, title: previousRuns ? "Run again now" : "Research now", hint: "Starts immediately" },
    { key: "at", icon: Clock, title: "At a time", hint: "Once, later" },
    { key: "later", icon: CalendarClock, title: "Not now", hint: "Keep the upload; run it any time" },
  ]

  const submit = async () => {
    if (mode === "later") return onDone?.()
    if (channels.length === 0) return toast.error("Choose at least one delivery channel")
    try {
      const run = await start.mutateAsync({ importId, runAt: mode === "at" ? new Date(runAt).toISOString() : undefined, channels })
      toast.success(mode === "at" ? `Run #${run.id} scheduled` : `Run #${run.id} started`, { description: `${companies.toLocaleString("en-IN")} logos from “${label}”` })
      onDone?.()
      navigate(`/runs/${run.id}`)
    } catch (e) {
      const budget = e instanceof ApiError && e.code === "budget_exceeded"
      toast.error(budget ? "Monthly budget reached" : "Could not start research", { description: errorMessage(e) })
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="When to run">
        {options.map((o) => {
          const on = mode === o.key
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMode(o.key)}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on && "border-primary bg-primary/[0.06] ring-1 ring-primary",
              )}
            >
              <span className={cn("grid size-9 shrink-0 place-items-center rounded-md transition-colors", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-primary")}>
                <o.icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{o.title}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
              {on && <Check className="absolute right-2.5 top-2.5 size-3.5 text-primary" />}
            </button>
          )
        })}
      </div>

      {mode !== "later" && (
        <div className="grid gap-4 animate-in fade-in-0 duration-200">
          {mode === "at" && (
            <div className="grid max-w-xs gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-200">
              <Label htmlFor="plan-at">Run at (your local time)</Label>
              <Input id="plan-at" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </div>
          )}
          <div className="grid gap-2">
            <Label>Send digests by</Label>
            <ChannelPicker value={channels} onChange={setChannels} />
            {channels.length === 0 && <p className="text-xs text-destructive">Choose at least one channel.</p>}
          </div>
        </div>
      )}

      {mode !== "later" && channels.includes("email") && <EmailCapacityNote importId={importId} />}

      {previousRuns > 0 && mode !== "later" && (
        <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          This upload has run {previousRuns} time{previousRuns === 1 ? "" : "s"}
          {lastRunAt ? ` (last ${fmtDateTime(lastRunAt)})` : ""}. A re-run researches the same logos for the PAMs this upload mapped them to;
          answers still fresh from an earlier run come from the cache at no cost.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3">
        {mode === "later" ? (
          <p className="text-sm text-muted-foreground">Run it any time from Research runs → New run, or from Imports.</p>
        ) : (
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Logos</dt>
              <dd className="tabular font-semibold">{companies.toLocaleString("en-IN")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Est. cost</dt>
              <dd className="tabular font-semibold">≤ {fmtUsd(companies * PER_COMPANY_USD)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Delivery</dt>
              <dd className="font-semibold">{channels.length ? channels.map((c) => (c === "email" ? "Email" : "WhatsApp")).join(" + ") : "—"}</dd>
            </div>
          </dl>
        )}
        <Button
          variant={mode === "later" ? "outline" : "brand"}
          size="lg"
          onClick={submit}
          disabled={start.isPending || companies === 0 || (mode !== "later" && channels.length === 0)}
          className="min-w-40"
        >
          {start.isPending ? <Loader2 className="animate-spin" /> : mode === "now" ? <Rocket /> : mode === "at" ? <Clock /> : null}
          {mode === "now" ? (previousRuns ? "Run again" : "Start research") : mode === "at" ? "Schedule run" : "Done"}
        </Button>
      </div>
    </div>
  )
}
