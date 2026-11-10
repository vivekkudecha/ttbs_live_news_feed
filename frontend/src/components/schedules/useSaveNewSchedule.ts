import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { useCreateSchedule, useRunScheduleNow, type ScheduleInput } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"

/**
 * Create a schedule and, if asked, start its first run right away (then open that run live).
 * Otherwise open the new schedule's page. Every research run starts this way.
 */
export function useSaveNewSchedule(onDone?: () => void) {
  const navigate = useNavigate()
  const create = useCreateSchedule()
  const runNow = useRunScheduleNow()

  const save = async (v: ScheduleInput, startNow: boolean) => {
    let s
    try {
      s = await create.mutateAsync(v)
    } catch (e) {
      return toast.error("Could not create the schedule", { description: errorMessage(e) })
    }
    onDone?.()
    if (!startNow) {
      toast.success(`Schedule “${s.name}” created`, { description: `${s.summary}. First run ${fmtDateTime(s.nextRunAt)}.` })
      return navigate(`/schedules/${s.id}`)
    }
    try {
      const run = await runNow.mutateAsync(s.id)
      toast.success(`Schedule “${s.name}” created, first run started`, { description: `${s.summary}. Next run ${fmtDateTime(s.nextRunAt)}.` })
      navigate(`/runs/${run.id}?tab=live`)
    } catch (e) {
      toast.error("Schedule created, but its first run could not start", { description: errorMessage(e) })
      navigate(`/schedules/${s.id}`)
    }
  }

  return { save, pending: create.isPending || runNow.isPending }
}
