import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { AlertTriangle, FileSpreadsheet, Layers, Mail, MessageCircle, MoreHorizontal, Pencil, Play, Repeat, SkipForward, Trash2 } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { LiveDot } from "@/components/common/LiveDot"
import { StatusBadge } from "@/components/common/StatusBadge"
import { useDeleteSchedule, useRunScheduleNow, useUpdateSchedule, type Schedule } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime, fmtRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ScheduleDialog } from "./ScheduleDialog"

const SOON_MS = 3_600_000

/** One recurring schedule: rule, target, delivery, next run (live), last outcome, actions. */
export function ScheduleCard({ s }: { s: Schedule }) {
  const update = useUpdateSchedule()
  const runNow = useRunScheduleNow()
  const remove = useDeleteSchedule()
  const [confirm, setConfirm] = useState(false)
  const [editing, setEditing] = useState(false)
  const soon = s.nextRunAt != null && new Date(s.nextRunAt).getTime() - Date.now() < SOON_MS

  const act = async <T,>(work: Promise<T>, ok: string, fail: string) => {
    try {
      await work
      toast.success(ok)
    } catch (e) {
      toast.error(fail, { description: errorMessage(e) })
    }
  }

  return (
    <Card className={cn("lift gap-0", !s.enabled && "opacity-75")}>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", s.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
            <Repeat className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{s.name}</p>
            <p className="text-sm text-muted-foreground">{s.summary} IST</p>
          </div>
          <Switch
            checked={s.enabled}
            aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
            disabled={update.isPending}
            onCheckedChange={(on) => act(update.mutateAsync({ id: s.id, enabled: on }), on ? "Schedule resumed" : "Schedule paused", "Could not change the schedule")}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Schedule actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={runNow.isPending} onClick={() => act(runNow.mutateAsync(s.id), "Run started", "Could not start the run")}>
                <Play /> Run now
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirm(true)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="max-w-full gap-1 font-normal">
            {s.target === "latest" ? <Layers className="size-3" /> : <FileSpreadsheet className="size-3" />}
            <span className="truncate">{s.targetLabel}</span>
          </Badge>
          {s.channels.length === 0 && <Badge variant="secondary" className="font-normal">Research only</Badge>}
          {s.channels.includes("email") && <Badge variant="secondary" className="gap-1 font-normal"><Mail className="size-3" /> Email</Badge>}
          {s.channels.includes("whatsapp") && <Badge variant="secondary" className="gap-1 font-normal"><MessageCircle className="size-3" /> WhatsApp</Badge>}
        </div>

        <div className="grid gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="eyebrow">Next run</p>
            {s.nextRunAt ? (
              <p className="mt-1 flex items-center gap-2 font-medium" title={fmtDateTime(s.nextRunAt)}>
                {soon && <LiveDot />}
                {fmtRelative(s.nextRunAt)}
                <span className="font-normal text-muted-foreground">· {fmtDateTime(s.nextRunAt)}</span>
              </p>
            ) : (
              <p className="mt-1 text-muted-foreground">Paused</p>
            )}
          </div>
          <div>
            <p className="eyebrow">Last run</p>
            <LastOutcome s={s} />
          </div>
        </div>
      </CardContent>

      <ScheduleDialog schedule={s} open={editing} onOpenChange={setEditing} />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{s.name}”?</AlertDialogTitle>
            <AlertDialogDescription>No more runs will start from this schedule. Runs it already started, and their results, are kept.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => act(remove.mutateAsync(s.id), "Schedule deleted", "Could not delete the schedule")}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function LastOutcome({ s }: { s: Schedule }) {
  if (!s.lastRunAt) return <p className="mt-1 text-muted-foreground">Not run yet</p>
  if (s.lastOutcome === "started" && s.lastRun)
    return (
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <Link to={`/runs/${s.lastRun.id}`} className="font-medium text-primary hover:underline">
          Run #{s.lastRun.id}
        </Link>
        <StatusBadge status={s.lastRun.status} />
      </p>
    )
  const Icon = s.lastOutcome === "skipped" ? SkipForward : AlertTriangle
  return (
    <p className={cn("mt-1 flex items-start gap-1.5", s.lastOutcome === "failed" ? "text-destructive" : "text-warning")} title={s.lastError ?? undefined}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="line-clamp-2">
        {s.lastOutcome === "skipped" ? "Skipped" : "Did not start"} {fmtRelative(s.lastRunAt)}: {s.lastError}
      </span>
    </p>
  )
}
