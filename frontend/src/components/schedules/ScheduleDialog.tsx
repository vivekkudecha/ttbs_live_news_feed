import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Repeat } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DEFAULT_RULE, useUpdateSchedule, type Schedule, type ScheduleInput } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { ScheduleWizard } from "./ScheduleWizard"
import { useSaveNewSchedule } from "./useSaveNewSchedule"

const BLANK: ScheduleInput = { ...DEFAULT_RULE, name: "", target: "upload", channels: ["email", "whatsapp"] }

const inputOf = (s: Schedule): ScheduleInput => ({
  name: s.name,
  frequency: s.frequency,
  intervalDays: s.intervalDays,
  weekdays: s.weekdays.length ? s.weekdays : DEFAULT_RULE.weekdays,
  monthDay: s.monthDay ?? DEFAULT_RULE.monthDay,
  runAtTime: s.runAtTime,
  endsOn: s.endsOn,
  target: s.target,
  importId: s.importId ?? undefined,
  channels: s.channels,
})

/** New schedule, or edit `schedule` when given. Opens from `trigger`, or is controlled via `open`. */
export function ScheduleDialog({
  schedule,
  trigger,
  open: controlled,
  onOpenChange,
}: {
  schedule?: Schedule
  trigger?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const setOpen = onOpenChange ?? setOwn
  const update = useUpdateSchedule()
  const creator = useSaveNewSchedule(() => setOpen(false))

  const saveEdit = async (v: ScheduleInput) => {
    try {
      const s = await update.mutateAsync({ id: schedule!.id, ...v })
      toast.success("Schedule updated", { description: s.nextRunAt ? `${s.summary}. Next run ${fmtDateTime(s.nextRunAt)}.` : s.summary })
      setOpen(false)
    } catch (e) {
      toast.error("Could not save the schedule", { description: errorMessage(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="flex h-[min(46rem,92svh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <div className="h-1 shrink-0 bg-brand-gradient" />
        <DialogHeader className="shrink-0 flex-row items-start gap-3 px-6 pb-4 pt-5 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-md shadow-brand/25">
            <Repeat className="size-5" />
          </span>
          <div className="space-y-1">
            <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
            <DialogDescription>Research runs on its own at the times below. Each run appears under this schedule in Research.</DialogDescription>
          </div>
        </DialogHeader>
        {open && (
          <ScheduleWizard
            initial={schedule ? inputOf(schedule) : BLANK}
            submitLabel={schedule ? "Save changes" : "Create schedule"}
            pending={update.isPending || creator.pending}
            offerStartNow={!schedule}
            onSubmit={(v, startNow) => (schedule ? saveEdit(v) : creator.save(v, startNow))}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
