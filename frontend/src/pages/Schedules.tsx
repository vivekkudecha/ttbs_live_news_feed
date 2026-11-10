/**
 * Research: every run comes from a schedule, so runs live under the schedule that started them.
 *   /schedules              all schedules (tabs, search, column filters); click one to open it
 *   /schedules/:id          that schedule: its rule, next/last run, actions, and all its runs
 *   /schedules/unscheduled  runs from before every run came from a schedule
 * A run's own page (/runs/:id) links back to its schedule.
 */
import { useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"
import { Activity, CalendarClock, ChevronRight, History, Radio, Repeat, Search, TriangleAlert, Wallet, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/common/EmptyState"
import { LiveDot } from "@/components/common/LiveDot"
import { Page, Split, StatGrid } from "@/components/common/layout"
import { ChartCard } from "@/components/common/ChartCard"
import { chartTheme } from "@/components/common/chart-theme"
import { StatCard } from "@/components/common/StatCard"
import { PageHeader } from "@/components/common/PageHeader"
import { SearchBox } from "@/components/data-table/SearchBox"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useClientTable } from "@/components/data-table/useSmartTable"
import { NewScheduleButton } from "@/components/schedules/NewScheduleButton"
import { ScheduleActions } from "@/components/schedules/ScheduleActions"
import { Delivery, LastRun } from "@/components/schedules/cells"
import { scheduleColumns } from "@/components/schedules/columns"
import { useSchedule, useScheduleStats, useSchedules, useUpdateSchedule, type Schedule, type ScheduleStats } from "@/api/schedules"
import { errorMessage } from "@/api/http"
import { fmtDateTime, fmtRelative, fmtUsd, pct } from "@/lib/format"
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
          <QueueStrip />
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
  const stats = useScheduleStats(id)
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

  const t = stats.data?.totals
  const st = stats.data?.byStatus ?? {}
  const attention = (st.partial ?? 0) + (st.failed ?? 0)
  const live = [...(stats.data?.recent ?? [])].reverse().find((r) => ACTIVE_RUN.has(r.status)) // newest active run

  return (
    <Page>
      <PageHeader
        title={s.name}
        description={`${s.summary} IST${s.enabled ? "" : " · paused"}`}
        back={{ to: "/schedules", label: "All schedules" }}
        actions={<ScheduleActions s={s} variant="buttons" onDeleted={() => navigate("/schedules")} />}
      />

      {live && (
        <Link
          to={`/runs/${live.id}?tab=live`}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-blue/25 bg-brand-blue/[0.06] px-4 py-3 text-sm transition-colors hover:bg-brand-blue/10"
        >
          <LiveDot />
          <span className="font-medium">
            Run #{live.id} is {live.status === "running" ? "researching" : "waiting for a worker"}
          </span>
          <span className="tabular text-muted-foreground">
            {n(live.done)} / {n(live.logos)} logos · {n(live.signals)} signals so far
          </span>
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-blue">
            <Radio className="size-4" /> Watch live
          </span>
        </Link>
      )}

      <StatGrid>
        <StatCard icon={Activity} tone="info" label="Runs" value={t ? n(t.runs) : "—"} hint={t ? `${n(st.completed ?? 0)} completed${attention ? ` · ${n(attention)} need attention` : ""}` : " "} />
        <StatCard icon={Zap} tone="success" label="Signals found" value={t ? n(t.signals) : "—"} hint={t ? `${pct(t.signals, t.logos)}% of ${n(t.logos)} logos researched` : " "} />
        <StatCard
          icon={CalendarClock}
          tone="primary"
          label="Next run"
          value={s.nextRunAt ? fmtRelative(s.nextRunAt) : "Paused"}
          hint={s.nextRunAt ? fmtDateTime(s.nextRunAt) : "Resume to schedule the next run"}
        />
        <StatCard
          icon={Wallet}
          tone="warning"
          label="Spend"
          value={t ? fmtUsd(t.cost) : "—"}
          hint={t ? `${n(t.cacheHits)} answers reused free${t.avgDurationS != null ? ` · ~${durationLabel(t.avgDurationS)} per run` : ""}` : " "}
        />
      </StatGrid>

      <Split ratio="1.7fr 1fr">
        <SignalsPerRun runs={stats.data?.recent} />
        <AboutSchedule s={s} />
      </Split>

      <section className="space-y-3">
        <h2 className="font-medium">All runs</h2>
        <RunsTable
          schedule={s.id}
          emptyState={
            <EmptyState icon={Repeat} title="No runs yet">
              {s.nextRunAt ? `The first run starts ${fmtRelative(s.nextRunAt)} (${fmtDateTime(s.nextRunAt)}).` : "This schedule is paused."} Use Run now to start one right away.
            </EmptyState>
          }
        />
      </section>
    </Page>
  )
}

const ACTIVE_RUN = new Set(["scheduled", "queued", "running"])
const n = (x: number) => x.toLocaleString("en-IN")
const durationLabel = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`)

/** One bar per run (latest 20, oldest left): how many signals it found. Logos and failures in the tooltip. */
function SignalsPerRun({ runs }: { runs: ScheduleStats["recent"] | undefined }) {
  const data = (runs ?? []).map((r) => ({ ...r, name: `#${r.id}` }))
  return (
    <ChartCard
      title="Signals per run"
      description={data.length ? `Latest ${data.length} run${data.length === 1 ? "" : "s"}` : undefined}
      label={`Signals per run: ${data.map((r) => `run ${r.id} ${r.signals}`).join(", ")}`}
      height="h-64 3xl:h-80"
      empty={runs && data.length === 0 ? "No runs yet." : undefined}
    >
      <BarChart data={data} margin={{ left: -12, right: 8, top: 8 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} {...chartTheme.grid} />
        <XAxis dataKey="name" {...chartTheme.axis} minTickGap={12} />
        <YAxis allowDecimals={false} {...chartTheme.axis} />
        <Tooltip
          {...chartTheme.tooltip}
          labelFormatter={(_, p) => {
            const r = p?.[0]?.payload as (typeof data)[number] | undefined
            return r ? `Run #${r.id} · ${fmtDateTime(r.at)}` : ""
          }}
          formatter={(v, _name, item) => {
            const r = item.payload as (typeof data)[number]
            return [`${n(Number(v))} signals · ${n(r.done)}/${n(r.logos)} logos${r.failed ? ` · ${n(r.failed)} failed` : ""}`, ""]
          }}
          separator=""
        />
        <Bar dataKey="signals" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} {...chartTheme.bar} />
      </BarChart>
    </ChartCard>
  )
}

/** What the schedule does, and when it runs next. */
function AboutSchedule({ s }: { s: Schedule }) {
  const upcoming = s.upcoming ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>About this schedule</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <dt className="text-muted-foreground">Researches</dt>
          <dd className="truncate font-medium" title={s.targetLabel}>{s.targetLabel}</dd>
          <dt className="text-muted-foreground">Repeats</dt>
          <dd className="font-medium">{s.summary} IST</dd>
          <dt className="text-muted-foreground">Delivery</dt>
          <dd><Delivery channels={s.channels} /></dd>
          <dt className="text-muted-foreground">Last run</dt>
          <dd><LastRun s={s} /></dd>
          <dt className="text-muted-foreground">Created by</dt>
          <dd className="font-medium">{s.createdBy}</dd>
        </dl>
        <div>
          <p className="eyebrow mb-2">Upcoming</p>
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground">{s.enabled ? "No more runs before the end date." : "Paused: no runs scheduled."}</p>
          ) : (
            <ol className="space-y-1.5">
              {upcoming.map((at, i) => (
                <li key={at} className="flex items-center gap-2.5">
                  <span className={cn("size-1.5 shrink-0 rounded-full", i === 0 ? "bg-brand-blue" : "bg-muted-foreground/40")} aria-hidden="true" />
                  <span className="tabular">{fmtDateTime(at)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{fmtRelative(at)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
