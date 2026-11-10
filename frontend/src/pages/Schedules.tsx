/**
 * Research: every run comes from a schedule, so runs live under the schedule that started them.
 *   /schedules              all schedules (tabs, search, column filters); click one to open it
 *   /schedules/:id          that schedule: its rule, next/last run, actions, and all its runs
 *   /schedules/unscheduled  runs from before every run came from a schedule
 * A run's own page (/runs/:id) links back to its schedule.
 */
import { useMemo, useState, type ReactNode } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ChevronRight, History, Loader2, Repeat, Search, TriangleAlert, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/common/EmptyState"
import { LiveDot } from "@/components/common/LiveDot"
import { Page } from "@/components/common/layout"
import { PageHeader } from "@/components/common/PageHeader"
import { SearchBox } from "@/components/data-table/SearchBox"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useClientTable } from "@/components/data-table/useSmartTable"
import { NewScheduleButton } from "@/components/schedules/NewScheduleButton"
import { ScheduleActions } from "@/components/schedules/ScheduleActions"
import { Delivery, LastRun, When } from "@/components/schedules/cells"
import { scheduleColumns } from "@/components/schedules/columns"
import { useRunScheduleNow, useSchedule, useSchedules, useUpdateSchedule, type Schedule } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime, fmtRelative } from "@/lib/format"
import { useDebounced } from "@/lib/use-debounced"
import { cn } from "@/lib/utils"
import { QueueStrip, RunsTable } from "./Runs"

type Group = "all" | "active" | "paused" | "attention"
const GROUPS: { key: Group; label: string; test: (s: Schedule) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "active", label: "Active", test: (s) => s.enabled },
  { key: "paused", label: "Paused", test: (s) => !s.enabled },
  { key: "attention", label: "Needs attention", test: (s) => s.enabled && !!s.lastOutcome && s.lastOutcome !== "started" },
]

// ---- /schedules ---------------------------------------------------------------------------------

export default function Research() {
  const q = useSchedules()
  const rows = useMemo(() => q.data?.rows ?? [], [q.data])
  const unscheduled = q.data?.unscheduled ?? 0
  const nothingYet = !q.isLoading && rows.length === 0 && unscheduled === 0

  return (
    <Page>
      <PageHeader
        title="Research"
        description="Every research run starts from a schedule: what to research, how often, and how results reach each PAM. Open a schedule to see its runs."
        actions={<NewScheduleButton />}
      />
      {nothingYet ? (
        <EmptyState icon={Repeat} title="Nothing scheduled yet">
          <p>A schedule researches an upload on a repeat rule. Its first run can start right away.</p>
          <div className="mt-4 flex justify-center">
            <NewScheduleButton />
          </div>
        </EmptyState>
      ) : (
        <>
          <NextUp rows={rows} />
          <SchedulesTable rows={rows} loading={q.isLoading} />
          {unscheduled > 0 && <UnscheduledLink count={unscheduled} />}
        </>
      )}
    </Page>
  )
}

/** The soonest research that will start on its own. */
function NextUp({ rows }: { rows: Schedule[] }) {
  const next = rows
    .filter((s) => s.nextRunAt)
    .map((s) => ({ at: s.nextRunAt!, name: s.name }))
    .sort((a, b) => a.at.localeCompare(b.at))[0]
  const active = rows.filter((s) => s.enabled).length
  return (
    <Card className="py-0">
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 py-3.5 text-sm">
        <span className="flex min-w-0 items-center gap-2.5">
          {next ? <LiveDot pulse={new Date(next.at).getTime() - Date.now() < 3_600_000} /> : <LiveDot tone="success" pulse={false} />}
          {next ? (
            <span className="min-w-0 truncate">
              Next: <span className="font-medium">{next.name}</span>{" "}
              <span className="text-muted-foreground">
                {fmtRelative(next.at)} · {fmtDateTime(next.at)}
              </span>
            </span>
          ) : (
            <span className="font-medium">Nothing due</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Repeat className="size-4" /> <span className="tabular font-semibold text-foreground">{active}</span> active of {rows.length}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">Times are IST</span>
      </CardContent>
    </Card>
  )
}

function SchedulesTable({ rows, loading }: { rows: Schedule[]; loading: boolean }) {
  const navigate = useNavigate()
  const update = useUpdateSchedule()
  const [group, setGroup] = useState<Group>("all")
  const [search, setSearch] = useState("")
  const term = useDebounced(search, 200).trim().toLowerCase()

  const toggle = (s: Schedule, on: boolean) =>
    update.mutate(
      { id: s.id, enabled: on },
      { onSuccess: () => toast.success(on ? "Schedule resumed" : "Schedule paused"), onError: (e) => toast.error("Could not change the schedule", { description: errorMessage(e) }) },
    )
  const columns = useMemo(() => scheduleColumns(toggle), []) // eslint-disable-line react-hooks/exhaustive-deps -- `toggle` only calls a stable mutation
  const test = GROUPS.find((g) => g.key === group)!.test
  const data = useMemo(
    () => rows.filter((s) => test(s) && (!term || `${s.name} ${s.targetLabel} ${s.summary}`.toLowerCase().includes(term))),
    [rows, test, term],
  )
  const state = useClientTable({ id: "schedules", data, columns, loading, defaultSort: { id: "nextRunAt", desc: false }, defaultHidden: ["createdBy"], getRowId: (s) => s.id })

  return (
    <SmartTable
      state={state}
      minWidth="68rem"
      onRowClick={(s) => navigate(`/schedules/${s.id}`)}
      toolbar={
        <>
          <Tabs value={group} onValueChange={(v) => setGroup(v as Group)}>
            <TabsList>
              {GROUPS.map((g) => {
                const count = rows.filter(g.test).length
                return (
                  <TabsTrigger key={g.key} value={g.key} className="gap-1.5">
                    {g.label}
                    {count > 0 && (
                      <span className={cn("tabular rounded-full px-1.5 text-xs", g.key === "attention" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                        {count}
                      </span>
                    )}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
          <SearchBox value={search} onChange={setSearch} placeholder="Search name, upload or rule" label="Search schedules" />
        </>
      }
      empty={
        <EmptyState icon={Search} title={term ? `No schedules match “${search.trim()}”` : "No schedules in this view"}>
          Try another tab, search or column filter.
        </EmptyState>
      }
    />
  )
}

/** Entry for runs no schedule started (from before every run came from one). */
function UnscheduledLink({ count }: { count: number }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate("/schedules/unscheduled")}
      className="lift flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-soft"
    >
      <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <History className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Unscheduled runs</span>
        <span className="block text-xs text-muted-foreground">Runs from before every run came from a schedule</span>
      </span>
      <span className="tabular text-sm font-semibold">{count.toLocaleString("en-IN")}</span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  )
}

// ---- /schedules/:id ------------------------------------------------------------------------------

export function ScheduleDetail() {
  const { id = "" } = useParams()
  if (id === "unscheduled") {
    return (
      <Page>
        <PageHeader title="Unscheduled runs" description="Runs from before every run came from a schedule." back={{ to: "/schedules", label: "All schedules" }} />
        <RunsTable schedule="none" emptyState={<EmptyState icon={History} title="No unscheduled runs" />} />
      </Page>
    )
  }
  return <SchedulePage id={id} />
}

function SchedulePage({ id }: { id: string }) {
  const navigate = useNavigate()
  const q = useSchedule(id)
  const runNow = useRunScheduleNow()
  const s = q.data

  if (q.isError)
    return (
      <EmptyState icon={TriangleAlert} title="Schedule not available">
        <p>{errorMessage(q.error)}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/schedules")}>
          Back to Research
        </Button>
      </EmptyState>
    )
  if (!s) return <Skeleton className="h-96" />

  const start = () =>
    runNow.mutate(s.id, {
      onSuccess: (run) => {
        toast.success(`Run #${run.id} started`)
        navigate(`/runs/${run.id}?tab=live`)
      },
      onError: (e) => toast.error("Could not start the run", { description: errorMessage(e) }),
    })

  return (
    <Page>
      <PageHeader
        title={s.name}
        description={`${s.summary} IST${s.enabled ? "" : " · paused"}`}
        back={{ to: "/schedules", label: "All schedules" }}
        actions={
          <>
            <Button variant="brand" onClick={start} disabled={runNow.isPending}>
              {runNow.isPending ? <Loader2 className="animate-spin" /> : <Zap />} Run now
            </Button>
            <ScheduleActions s={s} onDeleted={() => navigate("/schedules")} />
          </>
        }
      />

      <Card className="py-0">
        <CardContent className="grid gap-x-8 gap-y-4 py-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <Fact label="Researches">{s.targetLabel}</Fact>
          <Fact label="Delivery">
            <Delivery channels={s.channels} />
          </Fact>
          <Fact label="Next run">
            <When iso={s.nextRunAt} paused={!s.enabled} />
          </Fact>
          <Fact label="Last run">
            <LastRun s={s} />
          </Fact>
        </CardContent>
      </Card>

      <QueueStrip />

      <RunsTable
        schedule={s.id}
        emptyState={
          <EmptyState icon={Repeat} title="No runs yet">
            {s.nextRunAt ? `The first run starts ${fmtRelative(s.nextRunAt)} (${fmtDateTime(s.nextRunAt)}).` : "This schedule is paused."} Use Run now to start one right away.
          </EmptyState>
        }
      />
    </Page>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <div className="mt-1 min-w-0 truncate font-medium">{children}</div>
    </div>
  )
}
