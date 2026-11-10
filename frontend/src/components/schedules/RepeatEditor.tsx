/**
 * Edit a repeat rule: every N days · weekly on chosen days · monthly on a day — at a time (IST),
 * optionally until a date. The server describes the rule and lists its next runs, so what the
 * user reads here is exactly what the scheduler will do.
 */
import { CalendarClock, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSchedulePreview, type Frequency, type RepeatRule } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { useDebounced } from "@/lib/use-debounced"
import { fmtDateTime } from "@/lib/format"

const FREQUENCIES: { key: Frequency; label: string }[] = [
  { key: "interval", label: "Every N days" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
]
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MONTH_DAYS = [...Array.from({ length: 28 }, (_, i) => String(i + 1)), "31"]

export function RepeatEditor({ value, onChange }: { value: RepeatRule; onChange: (v: RepeatRule) => void }) {
  const set = (patch: Partial<RepeatRule>) => onChange({ ...value, ...patch })

  return (
    <div className="grid gap-4">
      <ToggleGroup
        type="single"
        variant="outline"
        value={value.frequency}
        onValueChange={(f) => f && set({ frequency: f as Frequency })}
        aria-label="Repeat"
        className="w-full"
      >
        {FREQUENCIES.map((f) => (
          <ToggleGroupItem key={f.key} value={f.key} className="flex-1 data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
            {f.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        {value.frequency === "interval" && (
          <div className="grid gap-2">
            <Label htmlFor="rep-days">Repeat every</Label>
            <div className="flex items-center gap-2">
              <Input
                id="rep-days"
                type="number"
                min={1}
                max={365}
                className="w-24"
                value={value.intervalDays}
                onChange={(e) => set({ intervalDays: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })}
              />
              <span className="text-sm text-muted-foreground">day{value.intervalDays === 1 ? "" : "s"}</span>
            </div>
          </div>
        )}
        {value.frequency === "weekly" && (
          <div className="grid gap-2">
            <Label>On</Label>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              value={value.weekdays.map(String)}
              onValueChange={(days) => set({ weekdays: days.map(Number).sort() })}
              aria-label="Days of the week"
              className="flex-wrap"
            >
              {DAYS.map((d, i) => (
                <ToggleGroupItem key={d} value={String(i)} className="min-w-11 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                  {d}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
        {value.frequency === "monthly" && (
          <div className="grid gap-2">
            <Label>On day</Label>
            <Select value={String(value.monthDay ?? 1)} onValueChange={(d) => set({ monthDay: Number(d) })}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_DAYS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d === "31" ? "Last day of month" : d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="rep-time">At (IST)</Label>
          <Input id="rep-time" type="time" className="w-32" value={value.runAtTime} onChange={(e) => e.target.value && set({ runAtTime: e.target.value })} />
        </div>
      </div>

      <div className="grid max-w-xs gap-2">
        <Label htmlFor="rep-end">
          End date <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input id="rep-end" type="date" value={value.endsOn ?? ""} onChange={(e) => set({ endsOn: e.target.value || null })} />
      </div>

      <RulePreview rule={value} />
    </div>
  )
}

/** "Every 10 days at 06:00 · next: 12 Nov, 22 Nov, 02 Dec" — or why the rule is not valid yet. */
function RulePreview({ rule }: { rule: RepeatRule }) {
  const p = useSchedulePreview(useDebounced(rule, 300))
  return (
    <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-3 text-sm" aria-live="polite">
      {p.isFetching ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" /> : <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />}
      {p.error ? (
        <p className="text-destructive">{errorMessage(p.error)}</p>
      ) : (
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium">{p.data?.summary ?? "…"}</p>
          {p.data && (
            <p className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
              {p.data.upcoming.length ? "Next:" : "No runs before the end date."}
              {p.data.upcoming.slice(0, 3).map((t) => (
                <span key={t} className="tabular rounded-full bg-card px-2 py-0.5 ring-1 ring-border">
                  {fmtDateTime(t)}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
