/**
 * Schedules: research that starts on its own. Recurring schedules (main column) and one-time runs
 * waiting for their start time (side column). Every firing becomes an ordinary research run.
 */
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { CalendarClock, CalendarPlus, Clock, Repeat, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/EmptyState"
import { Page, Split, StatGrid } from "@/components/common/layout"
import { PageHeader } from "@/components/common/PageHeader"
import { StatCard } from "@/components/common/StatCard"
import { ScheduleCard } from "@/components/schedules/ScheduleCard"
import { ScheduleDialog } from "@/components/schedules/ScheduleDialog"
import { useSchedules } from "@/api/schedules"
import { useCancelJob } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDateTime, fmtRelative } from "@/lib/format"
import type { Job } from "@/api/types"

export default function Schedules() {
  const q = useSchedules()
  const rows = q.data?.rows ?? []
  const oneTime = q.data?.oneTime ?? []
  const next = [...rows.map((s) => s.nextRunAt), ...oneTime.map((r) => r.scheduledFor)].filter(Boolean).sort()[0] ?? null
  const attention = rows.filter((s) => s.enabled && s.lastOutcome && s.lastOutcome !== "started").length

  return (
    <Page>
      <PageHeader
        title="Schedules"
        description="Research that starts on its own: recurring schedules and one-time runs waiting for their start time."
        actions={<ScheduleDialog trigger={<Button variant="brand"><CalendarPlus /> New schedule</Button>} />}
      />

      <StatGrid>
        <StatCard icon={Repeat} label="Active schedules" value={String(rows.filter((s) => s.enabled).length)} hint={`${rows.length} in total`} />
        <StatCard icon={CalendarClock} tone="info" label="Next research" value={next ? fmtRelative(next) : "—"} hint={next ? fmtDateTime(next) : "Nothing scheduled"} />
        <StatCard icon={Clock} tone="success" label="One-time runs waiting" value={String(oneTime.length)} hint="Set from an upload's “At a time”" />
        <StatCard icon={CalendarClock} tone={attention ? "warning" : "primary"} label="Need attention" value={String(attention)} hint="Last time skipped or could not start" />
      </StatGrid>

      <Split>
        <section className="space-y-4">
          <h2 className="font-medium">Recurring</h2>
          {q.isLoading ? (
            <Skeleton className="h-48" />
          ) : rows.length === 0 ? (
            <EmptyState icon={Repeat} title="No recurring schedules yet">
              Create one here, or choose <span className="font-medium text-foreground">Repeat</span> when starting a run from an upload.
            </EmptyState>
          ) : (
            <div className="grid gap-4 2xl:grid-cols-2">
              {rows.map((s) => (
                <ScheduleCard key={s.id} s={s} />
              ))}
            </div>
          )}
        </section>

        <OneTimeRuns runs={oneTime} />
      </Split>
    </Page>
  )
}

function OneTimeRuns({ runs }: { runs: Job[] }) {
  const cancel = useCancelJob()
  const qc = useQueryClient()
  return (
    <Card>
      <CardHeader>
        <CardTitle>One-time</CardTitle>
        <CardDescription>Runs set to start once, later</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {runs.length === 0 && <p className="text-sm text-muted-foreground">None waiting.</p>}
        {runs.map((r) => (
          <div key={r.id} className="group flex items-center gap-3 rounded-lg p-2 hover:bg-muted/60">
            <Clock className="size-4 shrink-0 text-muted-foreground" />
            <Link to={`/runs/${r.id}`} className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium group-hover:text-primary">{r.label}</p>
              <p className="text-xs text-muted-foreground">
                {fmtRelative(r.scheduledFor)} · {fmtDateTime(r.scheduledFor)} · {r.companies.toLocaleString("en-IN")} logos
              </p>
            </Link>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Cancel ${r.label}`}
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(r.id, {
                  onSuccess: () => {
                    toast.success("Run cancelled")
                    qc.invalidateQueries({ queryKey: ["schedules"] })
                  },
                  onError: (e) => toast.error("Could not cancel", { description: errorMessage(e) }),
                })
              }
            >
              <X />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
