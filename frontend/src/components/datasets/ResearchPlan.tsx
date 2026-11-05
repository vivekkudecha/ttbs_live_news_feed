/**
 * "Research this upload?" — shown when an upload finishes saving, and when re-running an earlier one.
 * Now · at a time (once) · not now. Every run covers exactly this upload's logos and delivers to the
 * PAMs this upload mapped them to.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { CalendarClock, Clock, Info, Loader2, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useStartRun } from "@/api/hooks"
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

export function ChannelPicker({ value, onChange }: { value: DeliveryChannel[]; onChange: (v: DeliveryChannel[]) => void }) {
  return (
    <div className="flex h-9 items-center gap-4">
      {(["email", "whatsapp"] as DeliveryChannel[]).map((c) => (
        <label key={c} className="flex items-center gap-2 text-sm">
          <Checkbox checked={value.includes(c)} onCheckedChange={(v) => onChange(v === true ? [...value, c] : value.filter((x) => x !== c))} />
          {c === "email" ? "Email" : "WhatsApp"}
        </label>
      ))}
    </div>
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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setMode(o.key)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
              mode === o.key && "border-primary bg-primary/5 ring-1 ring-primary",
            )}
            aria-pressed={mode === o.key}
          >
            <o.icon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{o.title}</span>
            <span className="text-xs text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>

      {mode !== "later" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {mode === "at" && (
            <div className="grid gap-2">
              <Label htmlFor="plan-at">Run at (your local time)</Label>
              <Input id="plan-at" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </div>
          )}
          <div className="grid gap-2">
            <Label>Send digests by</Label>
            <ChannelPicker value={channels} onChange={setChannels} />
          </div>
        </div>
      )}

      {previousRuns > 0 && mode !== "later" && (
        <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          This upload has run {previousRuns} time{previousRuns === 1 ? "" : "s"}
          {lastRunAt ? ` (last ${fmtDateTime(lastRunAt)})` : ""}. A re-run researches the same logos for the PAMs this upload mapped them to;
          answers still fresh from an earlier run come from the cache at no cost.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {mode === "later"
            ? "Run it any time from Research runs → New run, or from Imports."
            : `${companies.toLocaleString("en-IN")} logos · est. up to ${fmtUsd(companies * PER_COMPANY_USD)}`}
        </p>
        <Button onClick={submit} disabled={start.isPending || companies === 0}>
          {start.isPending && <Loader2 className="animate-spin" />}
          {mode === "now" ? (previousRuns ? "Run again" : "Start research") : mode === "at" ? "Schedule run" : "Done"}
        </Button>
      </div>
    </div>
  )
}
