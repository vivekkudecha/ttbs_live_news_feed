import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Pause, Pencil, Play, Trash2, Zap } from "lucide-react"
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

/**
 * Run now · Edit · Pause/Resume · Delete (confirmed), as a row menu ("menu") or as visible buttons
 * ("buttons", the schedule's own page). Run now opens the new run live; Edit opens the edit page.
 */
export function ScheduleActions({ s, variant = "menu", onDeleted }: { s: Schedule; variant?: "menu" | "buttons"; onDeleted?: () => void }) {
  const navigate = useNavigate()
  const update = useUpdateSchedule()
  const runNow = useRunScheduleNow()
  const remove = useDeleteSchedule()
  const [confirm, setConfirm] = useState(false)

  const start = () =>
    runNow.mutate(s.id, {
      onSuccess: (run) => {
        toast.success(`Run #${run.id} started`)
        navigate(`/runs/${run.id}?tab=live`)
      },
      onError: (e) => toast.error("Could not start the run", { description: errorMessage(e) }),
    })
  const toggle = () =>
    update.mutate(
      { id: s.id, enabled: !s.enabled },
      {
        onSuccess: () => toast.success(s.enabled ? "Schedule paused" : "Schedule resumed"),
        onError: (e) => toast.error("Could not change the schedule", { description: errorMessage(e) }),
      },
    )
  const edit = () => navigate(`/schedules/${s.id}/edit`)
  const del = () =>
    remove.mutate(s.id, {
      onSuccess: () => {
        toast.success("Schedule deleted")
        onDeleted?.()
      },
      onError: (e) => toast.error("Could not delete the schedule", { description: errorMessage(e) }),
    })

  const PauseIcon = s.enabled ? Pause : Play
  const confirmDialog = (
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{s.name}”?</AlertDialogTitle>
          <AlertDialogDescription>No more runs will start from this schedule. Runs it already started, and their results, are kept.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={del}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  if (variant === "buttons")
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="brand" onClick={start} disabled={runNow.isPending}>
          {runNow.isPending ? <Loader2 className="animate-spin" /> : <Zap />} Run now
        </Button>
        <Button variant="outline" onClick={edit}>
          <Pencil /> Edit
        </Button>
        <Button variant="outline" onClick={toggle} disabled={update.isPending}>
          <PauseIcon /> {s.enabled ? "Pause" : "Resume"}
        </Button>
        <Button variant="destructive" onClick={() => setConfirm(true)}>
          <Trash2 /> Delete
        </Button>
        {confirmDialog}
      </div>
    )

  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={runNow.isPending} onClick={start}>
            <Zap /> Run now
          </DropdownMenuItem>
          <DropdownMenuItem onClick={edit}>
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggle}>
            <PauseIcon /> {s.enabled ? "Pause" : "Resume"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDialog}
    </div>
  )
}
