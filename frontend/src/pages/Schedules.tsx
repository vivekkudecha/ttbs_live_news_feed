import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { CalendarClock, Clock, Loader2, Mail, MessageCircle, Play, Plus, Wallet } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { backendEnabled, errorMessage } from "@/api/http"
import { useCreateSchedule, useRunScheduleNow, useSchedules, useScopeOptions, useStartRun, useTemplates, useToggleSchedule } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDateTime, fmtUsd } from "@/lib/format"
import type { DeliveryChannel } from "@/api/types"

const PER_LOGO_USD = 0.0125
const RATE_PER_SEC = 45

function ScopeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const scopes = useScopeOptions()
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={scopes.isLoading ? "Loading…" : "Choose companies"} />
      </SelectTrigger>
      <SelectContent>
        {scopes.data?.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            {s.label} ({s.count.toLocaleString("en-IN")})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ChannelPicker({ value, onChange }: { value: DeliveryChannel[]; onChange: (v: DeliveryChannel[]) => void }) {
  return (
    <div className="flex h-9 items-center gap-4">
      {(["email", "whatsapp"] as DeliveryChannel[]).map((c) => (
        <label key={c} className="flex items-center gap-2 text-sm">
          <Checkbox checked={value.includes(c)} onCheckedChange={(v) => onChange(v === true ? [...value, c] : value.filter((x) => x !== c))} />
          {c === "email" ? "Email" : "WhatsApp"}
        </label>
      ))}
    </div>
  )
}

export function NewRunDialog() {
  const { user } = useSession()
  const templates = useTemplates()
  const start = useStartRun()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const scopes = useScopeOptions()
  const [scope, setScope] = useState("all")
  const [templateId, setTemplateId] = useState("t1")
  const [windowDays, setWindowDays] = useState("10")
  const chosen = scopes.data?.find((s) => s.key === scope)
  const count = chosen?.count ?? 0
  const est = count * PER_LOGO_USD
  const minutes = Math.max(1, Math.ceil(count / RATE_PER_SEC / 60))

  const submit = async () => {
    try {
      const run = await start.mutateAsync({ label: `Ad-hoc: ${chosen?.label ?? scope}`, templateId, scopeKey: scope, actor: user!.username })
      setOpen(false)
      toast.success(backendEnabled ? `Job ${run.id} queued` : `${run.id} started`, {
        description: `${count.toLocaleString("en-IN")} companies · results stream in as each logo finishes`,
      })
      navigate(backendEnabled ? `/jobs/${run.id}` : `/runs/${run.id}`)
    } catch (e) {
      toast.error("Could not start the run", { description: errorMessage(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Play /> Run now
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start an ad-hoc research run</DialogTitle>
          <DialogDescription>Uses the same pipeline as scheduled runs: research → per-PAM priority → digest delivery.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label>Scope</Label>
            <ScopeSelect value={scope} onChange={setScope} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Output template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · v{t.activeVersion}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="window">Research window (days)</Label>
              <Input id="window" type="number" min={1} max={60} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} disabled={backendEnabled} />
            </div>
          </div>
          <Alert>
            <Wallet />
            <AlertTitle>Estimated cost {fmtUsd(est)}</AlertTitle>
            <AlertDescription>About {minutes} min at {RATE_PER_SEC} logos/s. Results appear live as each logo finishes, and each PAM's digest goes out as soon as their logos are done. Cached results from the last {windowDays} days are reused at no cost.</AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={start.isPending || count === 0}>
            {start.isPending && <Loader2 className="animate-spin" />}
            Queue run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewScheduleDialog() {
  const create = useCreateSchedule()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("All accounts · 10-day cycle")
  const [intervalDays, setIntervalDays] = useState("10")
  const [runAtTime, setRunAtTime] = useState("06:00")
  const [scopeKey, setScopeKey] = useState("all")
  const [channels, setChannels] = useState<DeliveryChannel[]>(["email", "whatsapp"])
  const [budget, setBudget] = useState("")

  const submit = async () => {
    try {
      const s = await create.mutateAsync({
        name: name.trim(),
        intervalDays: Number(intervalDays),
        runAtTime,
        scopeKey,
        channels,
        budgetCap: budget ? Number(budget) : null,
      })
      setOpen(false)
      toast.success("Schedule created", { description: `First run ${fmtDateTime(s.nextRunAt)} IST` })
    } catch (e) {
      toast.error("Could not create the schedule", { description: errorMessage(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus /> New schedule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New recurring schedule</DialogTitle>
          <DialogDescription>The dispatcher checks every 30 seconds and starts a research job when the schedule is due.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="sname">Name</Label>
            <Input id="sname" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="sint">Every (days)</Label>
              <Input id="sint" type="number" min={1} max={90} value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stime">At (IST)</Label>
              <Input id="stime" type="time" value={runAtTime} onChange={(e) => setRunAtTime(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Companies</Label>
            <ScopeSelect value={scopeKey} onChange={setScopeKey} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Send digests by</Label>
              <ChannelPicker value={channels} onChange={setChannels} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sbudget">Budget cap per run (USD)</Label>
              <Input id="sbudget" type="number" min={0} step="1" placeholder="No cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || !name.trim() || channels.length === 0}>
            {create.isPending && <Loader2 className="animate-spin" />}
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function Schedules() {
  const { user } = useSession()
  const navigate = useNavigate()
  const schedules = useSchedules()
  const templates = useTemplates()
  const toggle = useToggleSchedule()
  const runNow = useRunScheduleNow()
  const editable = can.runJobs(user!.role)

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="When research runs, for which logos, with which template and provider. Stored in the database; the dispatcher checks every 30 seconds."
        actions={
          editable && (
            <>
              {backendEnabled ? (
                <NewScheduleDialog />
              ) : (
                <Button variant="outline" onClick={() => toast.info("Schedule editor opens here (prototype)")}>
                  <Plus /> New schedule
                </Button>
              )}
              <NewRunDialog />
            </>
          )
        }
      />
      {schedules.isError && <p className="mb-4 text-sm text-destructive">{errorMessage(schedules.error)}</p>}
      {schedules.data?.length === 0 && <p className="text-sm text-muted-foreground">No schedules yet. Create one to run research automatically.</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        {schedules.data?.map((s) => {
          const tpl = templates.data?.find((t) => t.id === s.templateId)
          return (
            <Card key={s.id} className={s.enabled ? "" : "opacity-75"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CalendarClock className="size-4 text-muted-foreground" /> {s.name}
                </CardTitle>
                <CardDescription>{s.scope}</CardDescription>
                <CardAction>
                  <Switch
                    checked={s.enabled}
                    disabled={!editable}
                    aria-label={`Enable ${s.name}`}
                    onCheckedChange={(v) =>
                      toggle.mutate(
                        { id: s.id, enabled: v, actor: user!.username },
                        {
                          onSuccess: () => toast.success(`${s.name} ${v ? "enabled" : "paused"}`),
                          onError: (e) => toast.error("Could not update the schedule", { description: errorMessage(e) }),
                        },
                      )
                    }
                  />
                </CardAction>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Frequency</dt>
                    <dd className="flex items-center gap-1.5 font-medium">
                      <Clock className="size-3.5 text-muted-foreground" /> Every {s.intervalDays} days · {s.runAtTime} IST
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Next run</dt>
                    <dd className="font-medium">{s.enabled ? fmtDateTime(s.nextRunAt) : "Paused"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Template</dt>
                    <dd className="font-medium">{tpl ? `${tpl.name} · v${tpl.activeVersion}` : "Default research prompt"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Provider</dt>
                    <dd className="font-medium">Perplexity Agent API</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Delivery</dt>
                    <dd className="flex gap-1.5 pt-0.5">
                      {s.channels.includes("email") && (
                        <Badge variant="outline" className="font-normal">
                          <Mail /> Email
                        </Badge>
                      )}
                      {s.channels.includes("whatsapp") && (
                        <Badge variant="outline" className="font-normal">
                          <MessageCircle /> WhatsApp
                        </Badge>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Budget cap per run</dt>
                    <dd className="font-medium">{s.budgetCap != null ? fmtUsd(s.budgetCap, 0) : "No cap"}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">Last run: {fmtDateTime(s.lastRunAt)}</p>
                  {backendEnabled && editable && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={runNow.isPending}
                      onClick={() =>
                        runNow.mutate(s.id, {
                          onSuccess: (job) => {
                            toast.success(`Job ${job.id} queued`)
                            navigate(`/jobs/${job.id}`)
                          },
                          onError: (e) => toast.error("Could not start the run", { description: errorMessage(e) }),
                        })
                      }
                    >
                      <Play /> Run now
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
