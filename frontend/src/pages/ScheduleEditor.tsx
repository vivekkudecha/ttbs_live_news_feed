/**
 * Full-page schedule wizard.
 *   /schedules/new        create (optionally start the first run right away)
 *   /schedules/:id/edit   edit: the wizard opens with the saved schedule, every step open
 */
import type { ReactNode } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { TriangleAlert } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/EmptyState"
import { Page } from "@/components/common/layout"
import { PageHeader } from "@/components/common/PageHeader"
import { ScheduleWizard } from "@/components/schedules/ScheduleWizard"
import { useSaveNewSchedule } from "@/components/schedules/useSaveNewSchedule"
import { DEFAULT_RULE, useSchedule, useUpdateSchedule, type Schedule, type ScheduleInput } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"

const BLANK: ScheduleInput = { ...DEFAULT_RULE, name: "", target: "upload", channels: ["email", "whatsapp"] }

/** The saved schedule as wizard input (rule fields it does not use keep sensible defaults). */
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

/** The wizard sits in one bordered panel; no overflow clipping, so its action bar can stick. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border bg-card shadow-soft">{children}</div>
}

export default function ScheduleEditor() {
  const { id } = useParams()
  return id ? <EditSchedule id={id} /> : <NewSchedule />
}

function NewSchedule() {
  const creator = useSaveNewSchedule()
  return (
    <Page>
      <PageHeader
        title="New schedule"
        description="What to research, how often, and how results reach each PAM. Every run appears under this schedule in Research."
        back={{ to: "/schedules", label: "All schedules" }}
      />
      <Panel>
        <ScheduleWizard initial={BLANK} layout="page" offerStartNow pending={creator.pending} onSubmit={creator.save} />
      </Panel>
    </Page>
  )
}

function EditSchedule({ id }: { id: string }) {
  const navigate = useNavigate()
  const q = useSchedule(id)
  const update = useUpdateSchedule()
  const back = `/schedules/${id}`

  if (q.isError) return <EmptyState icon={TriangleAlert} title="Schedule not available">{errorMessage(q.error)}</EmptyState>
  if (!q.data) return <Skeleton className="h-[32rem]" />

  const save = async (v: ScheduleInput) => {
    // Send only what changed: the server restarts the timing whenever a timing field is sent,
    // so renaming a schedule must not move its next run.
    const before = inputOf(q.data!)
    const changes = Object.fromEntries(
      (Object.keys(v) as (keyof ScheduleInput)[]).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(before[k])).map((k) => [k, v[k]]),
    ) as Partial<ScheduleInput>
    if (changes.importId !== undefined || changes.target !== undefined) Object.assign(changes, { target: v.target, importId: v.importId })
    if (Object.keys(changes).length === 0) return navigate(back)
    try {
      const s = await update.mutateAsync({ id, ...changes })
      toast.success("Schedule updated", { description: s.nextRunAt ? `${s.summary}. Next run ${fmtDateTime(s.nextRunAt)}.` : s.summary })
      navigate(back)
    } catch (e) {
      toast.error("Could not save the schedule", { description: errorMessage(e) })
    }
  }

  return (
    <Page>
      <PageHeader title={`Edit “${q.data.name}”`} description={`${q.data.summary} IST`} back={{ to: back, label: "Back to the schedule" }} />
      <Panel>
        {/* Keyed by id: the wizard starts from the saved schedule, never from a previous form. */}
        <ScheduleWizard key={id} initial={inputOf(q.data)} mode="edit" layout="page" submitLabel="Save changes" pending={update.isPending} onSubmit={save} />
      </Panel>
    </Page>
  )
}
