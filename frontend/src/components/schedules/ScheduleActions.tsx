import { useState } from "react"
import { toast } from "sonner"
import { MoreHorizontal, Pause, Pencil, Play, Trash2, Zap } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useDeleteSchedule, useRunScheduleNow, useUpdateSchedule, type Schedule } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { ScheduleDialog } from "./ScheduleDialog"

/** Runs a mutation with a success / failure toast. */
async function withToast(work: Promise<unknown>, ok: string, fail: string) {
  try {
    await work
    toast.success(ok)
  } catch (e) {
    toast.error(fail, { description: errorMessage(e) })
  }
}

/** Row menu: Run now · Edit · Pause/Resume · Delete (confirmed). Dialogs live outside the menu so they survive it closing. */
export function ScheduleActions({ s, onDeleted }: { s: Schedule; onDeleted?: () => void }) {
  const update = useUpdateSchedule()
  const runNow = useRunScheduleNow()
  const remove = useDeleteSchedule()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)

  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={runNow.isPending} onClick={() => withToast(runNow.mutateAsync(s.id), "Run started", "Could not start the run")}>
            <Zap /> Run now
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => withToast(update.mutateAsync({ id: s.id, enabled: !s.enabled }), s.enabled ? "Schedule paused" : "Schedule resumed", "Could not change the schedule")}
          >
            {s.enabled ? <Pause /> : <Play />} {s.enabled ? "Pause" : "Resume"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ScheduleDialog schedule={s} open={editing} onOpenChange={setEditing} />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{s.name}”?</AlertDialogTitle>
            <AlertDialogDescription>No more runs will start from this schedule. Runs it already started, and their results, are kept.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => withToast(remove.mutateAsync(s.id).then(() => onDeleted?.()), "Schedule deleted", "Could not delete the schedule")}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
