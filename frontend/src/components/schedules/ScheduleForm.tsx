/**
 * Create or edit a recurring schedule: name · what to research · repeat rule · delivery.
 * Used in the "Repeat" step of a new run (upload already chosen) and on the Schedules page.
 */
import { useState, type ReactNode } from "react"
import { FileSpreadsheet, Info, Layers, Loader2, Repeat } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ChannelPicker } from "@/components/datasets/ChannelPicker"
import { UploadPicker } from "@/components/datasets/DatasetPicker"
import { RepeatEditor } from "./RepeatEditor"
import type { RepeatRule, ScheduleInput, ScheduleTarget } from "@/api/schedules"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  )
}

export function ScheduleForm({
  initial,
  fixedUpload,
  submitLabel = "Save schedule",
  pending,
  onSubmit,
}: {
  initial: ScheduleInput
  /** The upload is already chosen (new-run flow): offer "this upload" instead of a picker. */
  fixedUpload?: { id: string; label: string }
  submitLabel?: string
  pending?: boolean
  onSubmit: (v: ScheduleInput) => void
}) {
  const [v, setV] = useState<ScheduleInput>(initial)
  const set = (patch: Partial<ScheduleInput>) => setV((cur) => ({ ...cur, ...patch }))
  const needsUpload = v.target === "upload" && !v.importId
  const ready = v.name.trim() !== "" && !needsUpload && (v.frequency !== "weekly" || v.weekdays.length > 0)

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit({ ...v, name: v.name.trim() })
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="sch-name">Name</Label>
        <Input id="sch-name" value={v.name} maxLength={200} placeholder="e.g. Key accounts · 10-day cycle" onChange={(e) => set({ name: e.target.value })} />
      </div>

      <Section title="What to research">
        <ToggleGroup
          type="single"
          variant="outline"
          value={v.target}
          onValueChange={(t) => t && set({ target: t as ScheduleTarget, importId: t === "upload" ? (fixedUpload?.id ?? v.importId) : undefined })}
          className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <TargetOption value="upload" icon={FileSpreadsheet} title={fixedUpload ? "This upload" : "A specific upload"} hint={fixedUpload?.label ?? "The same logos every time"} />
          <TargetOption value="latest" icon={Layers} title="Latest upload" hint="Whatever was uploaded most recently, at each run" />
        </ToggleGroup>
        {v.target === "upload" && !fixedUpload && (
          <UploadPicker value={v.importId ?? null} onChange={(id) => set({ importId: id })} label="Upload" />
        )}
      </Section>

      <Section title="Repeat">
        <RepeatEditor value={v} onChange={(rule: RepeatRule) => set(rule)} />
      </Section>

      <Section title="Send digests by">
        <ChannelPicker value={v.channels} onChange={(channels) => set({ channels })} />
        {v.channels.length === 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5" /> Research only: results are saved to each run, no digests are sent.
          </p>
        )}
      </Section>

      <div className="flex justify-end border-t pt-4">
        <Button type="submit" variant="brand" size="lg" disabled={!ready || pending} className="min-w-40">
          {pending ? <Loader2 className="animate-spin" /> : <Repeat />}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

function TargetOption({ value, icon: Icon, title, hint }: { value: ScheduleTarget; icon: typeof Layers; title: string; hint: string }) {
  return (
    <ToggleGroupItem
      value={value}
      className="h-auto justify-start gap-3 rounded-lg p-3 text-left data-[state=on]:border-primary data-[state=on]:bg-primary/[0.06] data-[state=on]:ring-1 data-[state=on]:ring-primary"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block truncate text-xs font-normal text-muted-foreground">{hint}</span>
      </span>
    </ToggleGroupItem>
  )
}
