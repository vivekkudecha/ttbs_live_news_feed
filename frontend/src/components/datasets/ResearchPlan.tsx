/**
 * "Research this upload" — shown when an upload finishes saving, and when opening a saved one.
 * Research always runs from a schedule: set one up for this upload (by default its first run
 * starts right away), or leave it for later. Each run covers exactly this upload's logos and
 * delivers to the PAMs this upload mapped them to.
 */
import { Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScheduleWizard } from "@/components/schedules/ScheduleWizard"
import { useSaveNewSchedule } from "@/components/schedules/useSaveNewSchedule"
import { DEFAULT_RULE } from "@/api/schedules"
import { fmtDateTime } from "@/lib/format"

export function ResearchPlan({
  importId,
  label,
  previousRuns = 0,
  lastRunAt,
  onDone,
}: {
  importId: string
  label: string
  previousRuns?: number
  lastRunAt?: string | null
  onDone?: () => void
}) {
  const creator = useSaveNewSchedule(onDone)

  return (
    <div className="space-y-3">
      {previousRuns > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          This upload has run {previousRuns} time{previousRuns === 1 ? "" : "s"}
          {lastRunAt ? ` (last ${fmtDateTime(lastRunAt)})` : ""}. Answers still fresh from an earlier run come from the cache at no cost.
        </p>
      )}
      <div className="flex flex-col overflow-hidden rounded-lg border">
        <ScheduleWizard
          initial={{ ...DEFAULT_RULE, name: label.split(" · ")[0], target: "upload", importId, channels: ["email", "whatsapp"] }}
          fixedUpload={{ id: importId, label }}
          offerStartNow
          pending={creator.pending}
          onSubmit={creator.save}
        />
      </div>
      {onDone && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onDone}>
            Not now, keep the upload
          </Button>
        </div>
      )}
    </div>
  )
}
