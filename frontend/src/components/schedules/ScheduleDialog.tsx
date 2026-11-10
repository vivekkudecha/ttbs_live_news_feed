import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Repeat } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DEFAULT_RULE, useCreateSchedule, useUpdateSchedule, type Schedule, type ScheduleInput } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { ScheduleForm } from "./ScheduleForm"

const BLANK: ScheduleInput = { ...DEFAULT_RULE, name: "", target: "latest", channels: ["email", "whatsapp"] }

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
  const create = useCreateSchedule()
  const update = useUpdateSchedule()

  const save = async (v: ScheduleInput) => {
    try {
      const s = schedule ? await update.mutateAsync({ id: schedule.id, ...v }) : await create.mutateAsync(v)
      toast.success(schedule ? "Schedule updated" : `Schedule “${s.name}” created`, {
        description: s.nextRunAt ? `${s.summary}. Next run ${fmtDateTime(s.nextRunAt)}.` : s.summary,
      })
      setOpen(false)
    } catch (e) {
      toast.error("Could not save the schedule", { description: errorMessage(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="flex-row items-start gap-3 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-md shadow-brand/25">
            <Repeat className="size-5" />
          </span>
          <div className="space-y-1">
            <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
            <DialogDescription>Research runs on its own at the times below. Each run appears in Research runs like any other.</DialogDescription>
          </div>
        </DialogHeader>
        {open && (
          <ScheduleForm
            initial={schedule ? inputOf(schedule) : BLANK}
            submitLabel={schedule ? "Save changes" : "Create schedule"}
            pending={create.isPending || update.isPending}
            onSubmit={save}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
