/**
 * "Research these companies?" — shown when a dataset finishes saving.
 * Now · at a time · every N days (creates a schedule) · not now.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { CalendarClock, Clock, Loader2, Play, Repeat } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useCreateSchedule, useStartRun } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDateTime, fmtUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { DeliveryChannel } from "@/api/types"

const PER_COMPANY_USD = 0.0125
type Mode = "now" | "at" | "every" | "later"

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

export function ResearchPlan({ scopeKey, label, companies, onDone }: { scopeKey: string; label: string; companies: number; onDone?: () => void }) {
  const navigate = useNavigate()
  const start = useStartRun()
  const schedule = useCreateSchedule()
  const [mode, setMode] = useState<Mode>("now")
  const [runAt, setRunAt] = useState(inAnHour)
  const [every, setEvery] = useState("10")
  const [time, setTime] = useState("06:00")
  const [channels, setChannels] = useState<DeliveryChannel[]>(["email", "whatsapp"])
  const busy = start.isPending || schedule.isPending

  const options: { key: Mode; icon: typeof Play; title: string; hint: string }[] = [
    { key: "now", icon: Play, title: "Research now", hint: "Starts immediately" },
    { key: "at", icon: Clock, title: "At a time", hint: "Once, later" },
    { key: "every", icon: Repeat, title: "Every few days", hint: "Recurring schedule" },
    { key: "later", icon: CalendarClock, title: "Not now", hint: "Just keep the data" },
  ]

  const submit = async () => {
    if (mode === "later") return onDone?.()
    if (channels.length === 0) return toast.error("Choose at least one delivery channel")
    try {
      if (mode === "every") {
        const s = await schedule.mutateAsync({ name: `${label} · every ${every} days`, intervalDays: Number(every), runAtTime: time, scopeKey, channels })
        toast.success("Schedule created", { description: `First run ${fmtDateTime(s.nextRunAt)} IST` })
        onDone?.()
        navigate("/schedules")
        return
      }
      const run = await start.mutateAsync({
        label: `Research · ${label}`,
        templateId: "t1",
        scopeKey,
        runAt: mode === "at" ? new Date(runAt).toISOString() : undefined,
        channels,
      })
      toast.success(mode === "at" ? `Run #${run.id} scheduled` : `Run #${run.id} started`, { description: `${companies.toLocaleString("en-IN")} companies` })
      onDone?.()
      navigate(`/runs/${run.id}`)
    } catch (e) {
      toast.error("Could not start research", { description: errorMessage(e) })
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
          {mode === "every" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="plan-every">Every (days)</Label>
                <Input id="plan-every" type="number" min={1} max={90} value={every} onChange={(e) => setEvery(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="plan-time">At (IST)</Label>
                <Input id="plan-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <Label>Send digests by</Label>
            <ChannelPicker value={channels} onChange={setChannels} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {mode === "later"
            ? "You can start research any time from Research runs or Schedules."
            : `${companies.toLocaleString("en-IN")} companies · est. ${fmtUsd(companies * PER_COMPANY_USD)} per run`}
        </p>
        <Button onClick={submit} disabled={busy || companies === 0}>
          {busy && <Loader2 className="animate-spin" />}
          {mode === "now" ? "Start research" : mode === "at" ? "Schedule run" : mode === "every" ? "Create schedule" : "Done"}
        </Button>
      </div>
    </div>
  )
}
