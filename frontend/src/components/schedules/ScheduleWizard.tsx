/**
 * Create or edit a recurring schedule in three short steps:
 *   1. What to research — upload a new file, pick an earlier upload, or always the latest upload
 *   2. When — the repeat rule, with a live preview of the next runs
 *   3. Deliver & review — channels, name, a summary of exactly what will happen, and (new
 *      schedules) whether to start the first run right away
 * With `fixedUpload` (the "Repeat" option of a run started from an upload) step 1 is skipped.
 * `mode="edit"`: every step is open and already complete; changes can be saved from any step.
 *
 * Layout "embedded" (inside a panel): steps on top, one scrolling body, actions at the bottom.
 * Layout "page" (full page): the page scrolls, the actions stick to the bottom of the screen, and
 * wide screens show a live summary beside the steps.
 */
import { useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, History, Info, Layers, Loader2, Repeat, UploadCloud } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ChoiceCards } from "@/components/common/ChoiceCards"
import { ChannelPicker } from "@/components/datasets/ChannelPicker"
import { EmailCapacityNote } from "@/components/datasets/EmailCapacityNote"
import { UploadPicker } from "@/components/datasets/DatasetPicker"
import { UploadFlow } from "@/components/datasets/UploadFlow"
import { RepeatEditor } from "./RepeatEditor"
import { useSchedulePreview, type ScheduleInput } from "@/api/schedules"
import { useScopeOptions } from "@/api/hooks"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type Step = "what" | "when" | "deliver"
type Source = "new" | "earlier" | "latest"

const STEPS: { key: Step; title: string }[] = [
  { key: "what", title: "What to research" },
  { key: "when", title: "When" },
  { key: "deliver", title: "Deliver & review" },
]

/** "Nov logos · 09 Nov 2026, 13:59" for an upload id (from the saved-uploads list). */
function useUploadLabel(id: string | undefined) {
  const scopes = useScopeOptions()
  return id ? (scopes.data?.find((s) => s.key === `import:${id}`)?.label ?? `Upload #${id}`) : undefined
}

export function ScheduleWizard({
  initial,
  fixedUpload,
  submitLabel = "Create schedule",
  pending,
  offerStartNow = false,
  mode = "create",
  layout = "embedded",
  onSubmit,
}: {
  initial: ScheduleInput
  fixedUpload?: { id: string; label: string }
  submitLabel?: string
  pending?: boolean
  /** New schedules: offer "Start the first run now" (on by default when the upload is already chosen). */
  offerStartNow?: boolean
  mode?: "create" | "edit"
  layout?: "embedded" | "page"
  onSubmit: (v: ScheduleInput, startNow: boolean) => void
}) {
  const editing = mode === "edit"
  const page = layout === "page"
  const steps = fixedUpload ? STEPS.slice(1) : STEPS
  const [step, setStep] = useState<Step>(steps[0].key)
  const [v, setV] = useState<ScheduleInput>(initial)
  const [source, setSource] = useState<Source>(initial.target === "latest" ? "latest" : initial.importId ? "earlier" : "new")
  const [startNow, setStartNow] = useState(offerStartNow && !!fixedUpload)
  const set = (patch: Partial<ScheduleInput>) => setV((cur) => ({ ...cur, ...patch }))
  const qc = useQueryClient()
  const uploadLabel = useUploadLabel(v.importId) ?? fixedUpload?.label

  const valid: Record<Step, boolean> = {
    what: source === "latest" || !!v.importId,
    when: v.frequency !== "weekly" || v.weekdays.length > 0,
    deliver: v.name.trim() !== "",
  }
  const at = steps.findIndex((s) => s.key === step)
  const last = at === steps.length - 1
  const reachable = (i: number) => steps.slice(0, i).every((s) => valid[s.key])
  const complete = steps.every((s) => valid[s.key])
  const submit = () => onSubmit({ ...v, name: v.name.trim() }, offerStartNow && startNow)

  const pickSource = (s: Source) => {
    setSource(s)
    set(s === "latest" ? { target: "latest", importId: undefined } : { target: "upload", importId: s === "new" ? undefined : v.importId })
  }
  /** Every step change goes through here. On the last step, suggest a name if there is none yet. */
  const goTo = (target: Step) => {
    if (target === "deliver" && !v.name.trim()) set({ name: source === "latest" ? "Latest upload" : (uploadLabel ?? "").split(" · ")[0] })
    setStep(target)
  }
  const chooseUpload = (importId: string) => {
    void qc.invalidateQueries({ queryKey: ["scopes"] }) // the new upload's name, for the review
    set({ importId })
    setStep("when")
  }

  return (
    <div className={cn("flex flex-col", !page && "min-h-0 flex-1")}>
      <ol className="flex shrink-0 items-center gap-2 border-b px-6 py-3">
        {steps.map((s, i) => {
          // Editing: every valid step is already done; creating: steps before the current one are.
          const state = i === at ? "current" : (editing ? valid[s.key] : i < at) ? "done" : "todo"
          return (
            <li key={s.key} className="flex min-w-0 items-center gap-2">
              {i > 0 && <span className="h-px w-6 bg-border sm:w-10" aria-hidden="true" />}
              <button
                type="button"
                disabled={!reachable(i)}
                onClick={() => goTo(s.key)}
                aria-current={state === "current" ? "step" : undefined}
                className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors",
                    state === "current" ? "bg-primary text-primary-foreground" : state === "done" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}
                >
                  {state === "done" ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("hidden truncate sm:inline", state === "current" ? "font-medium" : "text-muted-foreground")}>{s.title}</span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className={cn("min-w-0 flex-1", page ? "grid xl:grid-cols-[minmax(0,1fr)_22rem]" : "min-h-0 overflow-y-auto overflow-x-hidden")}>
      <div className="min-w-0 space-y-5 overflow-x-hidden px-6 py-5">
        {step === "what" && (
          <>
            <ChoiceCards
              label="What to research"
              value={source}
              onChange={pickSource}
              options={[
                { key: "new", icon: UploadCloud, title: "Upload a new file", hint: "Excel or CSV of logos and PAMs" },
                { key: "earlier", icon: History, title: "An earlier upload", hint: "The same logos every time" },
                { key: "latest", icon: Layers, title: "Latest upload", hint: "Whatever is newest at each run" },
              ]}
            />
            {source === "new" &&
              (v.importId ? (
                <Chosen label={uploadLabel} onChange={() => set({ importId: undefined })} changeLabel="Upload a different file" />
              ) : (
                <div className="min-w-0 rounded-lg border p-4">
                  <UploadFlow onUse={chooseUpload} />
                </div>
              ))}
            {source === "earlier" && <UploadPicker value={v.importId ?? null} onChange={(id) => set({ importId: id })} label="Upload" />}
            {source === "latest" && (
              <Note>Each run researches the most recent saved upload at that moment. To change what the next run covers, just upload a new file before it.</Note>
            )}
          </>
        )}

        {step === "when" && <RepeatEditor value={v} onChange={(rule) => set(rule)} />}

        {step === "deliver" && (
          <>
            <div className="grid gap-2">
              <Label>Send digests by</Label>
              <ChannelPicker value={v.channels} onChange={(channels) => set({ channels })} />
              {v.channels.length === 0 && <Note>Research only: results are saved to each run, no digests are sent.</Note>}
              {v.importId && v.channels.includes("email") && <EmailCapacityNote importId={v.importId} />}
            </div>
            <div className="grid max-w-md gap-2">
              <Label htmlFor="wiz-name">Schedule name</Label>
              <Input id="wiz-name" value={v.name} maxLength={200} placeholder="e.g. Key accounts · 10-day cycle" onChange={(e) => set({ name: e.target.value })} />
            </div>
            <Review v={v} source={source} uploadLabel={uploadLabel} className={page ? "xl:hidden" : undefined} />
            {offerStartNow && (
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border p-3">
                <Switch checked={startNow} onCheckedChange={setStartNow} />
                <span className="text-sm">
                  <span className="block font-medium">Start the first run now</span>
                  <span className="block text-xs text-muted-foreground">Researches right away and opens it live; the schedule then continues as above.</span>
                </span>
              </label>
            )}
          </>
        )}
      </div>
        {page && (
          <aside className="hidden border-l bg-muted/20 px-5 py-5 xl:block">
            <div className="sticky top-24 space-y-3">
              <p className="eyebrow">Summary</p>
              <Review v={v} source={source} uploadLabel={uploadLabel} stacked />
            </div>
          </aside>
        )}
      </div>

      <div className={cn("flex shrink-0 items-center gap-2 border-t bg-muted/30 px-6 py-3", page && "sticky bottom-0 z-10 rounded-b-xl bg-card/95 backdrop-blur")}>
        <span className="text-xs text-muted-foreground">{editing ? "Editing · changes apply from the next run" : `Step ${at + 1} of ${steps.length}`}</span>
        <div className="ml-auto flex gap-2">
          {at > 0 && (
            <Button type="button" variant="outline" onClick={() => goTo(steps[at - 1].key)}>
              <ArrowLeft /> Back
            </Button>
          )}
          {!last && (
            <Button type="button" variant={editing ? "outline" : "default"} disabled={!valid[step]} onClick={() => goTo(steps[at + 1].key)}>
              Next <ArrowRight />
            </Button>
          )}
          {(last || editing) && (
            <Button type="button" variant="brand" disabled={!complete || pending} onClick={submit}>
              {pending ? <Loader2 className="animate-spin" /> : <Repeat />} {submitLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

function Chosen({ label, onChange, changeLabel }: { label?: string; onChange: () => void; changeLabel: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success/[0.06] p-3 text-sm">
      <FileSpreadsheet className="size-4 text-success" />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onChange}>
        {changeLabel}
      </Button>
    </div>
  )
}

/** Exactly what will happen, in plain words. */
function Review({ v, source, uploadLabel, stacked, className }: { v: ScheduleInput; source: Source; uploadLabel?: string; stacked?: boolean; className?: string }) {
  const p = useSchedulePreview(v)
  const rows: [string, ReactNode][] = [
    ["Name", v.name.trim() || "—"],
    ["Researches", source === "latest" ? "The latest upload at each run" : uploadLabel],
    ["Repeats", p.data ? `${p.data.summary} (IST)` : "…"],
    ["First run", p.data?.upcoming[0] ? fmtDateTime(p.data.upcoming[0]) : "—"],
    [
      "Delivery",
      v.channels.length ? (
        <span className="flex gap-1.5">{v.channels.map((c) => <Badge key={c} variant="secondary">{c === "email" ? "Email" : "WhatsApp"}</Badge>)}</span>
      ) : (
        "Research only"
      ),
    ],
  ]
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 rounded-lg border bg-primary/[0.03] p-4 text-sm", !stacked && "sm:grid-cols-2", className)}>
      {rows.map(([k, val]) => (
        <div key={k} className="min-w-0">
          <dt className="eyebrow">{k}</dt>
          <dd className={cn("mt-1 font-medium", stacked ? "break-words" : "truncate")}>{val}</dd>
        </div>
      ))}
    </dl>
  )
}
