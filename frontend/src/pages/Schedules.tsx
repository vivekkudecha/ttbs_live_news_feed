import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { CalendarClock, Clock, Loader2, Mail, MessageCircle, Play, Plus, Wallet } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSchedules, useStartRun, useTemplates, useToggleSchedule } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDateTime, fmtUsd } from "@/lib/format"

const scopes = ["All active companies", "Region = West", "Region = North", "Segment = Enterprise", "Selected PAM: Aarav Mehta"]
const scopeCount: Record<string, number> = { "All active companies": 48, "Region = West": 13, "Region = North": 14, "Segment = Enterprise": 18, "Selected PAM: Aarav Mehta": 6 }

export function NewRunDialog() {
  const { user } = useSession()
  const templates = useTemplates()
  const start = useStartRun()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState(scopes[1])
  const [templateId, setTemplateId] = useState("t1")
  const [windowDays, setWindowDays] = useState("10")
  const est = scopeCount[scope] * 0.036

  const submit = async () => {
    const run = await start.mutateAsync({ label: `Ad-hoc: ${scope}`, templateId, scope, actor: user!.username })
    setOpen(false)
    toast.success(`${run.id} queued`, { description: `${scopeCount[scope]} companies · estimated ${fmtUsd(est)}` })
    navigate(`/runs/${run.id}`)
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
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopes.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s} ({scopeCount[s]})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              <Input id="window" type="number" min={1} max={60} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
            </div>
          </div>
          <Alert>
            <Wallet />
            <AlertTitle>Estimated cost {fmtUsd(est)}</AlertTitle>
            <AlertDescription>Within the monthly budget. Cached results from the last {windowDays} days are reused at no cost.</AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={start.isPending}>
            {start.isPending && <Loader2 className="animate-spin" />}
            Queue run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function Schedules() {
  const { user } = useSession()
  const schedules = useSchedules()
  const templates = useTemplates()
  const toggle = useToggleSchedule()
  const editable = can.runJobs(user!.role)

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="When research runs, for which logos, with which template and provider. Stored in the database; the dispatcher checks every minute."
        actions={
          editable && (
            <>
              <Button variant="outline" onClick={() => toast.info("Schedule editor opens here (prototype)")}>
                <Plus /> New schedule
              </Button>
              <NewRunDialog />
            </>
          )
        }
      />
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
                    onCheckedChange={(v) => {
                      toggle.mutate({ id: s.id, enabled: v, actor: user!.username })
                      toast.success(`${s.name} ${v ? "enabled" : "paused"}`)
                    }}
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
                    <dd className="font-medium">
                      {tpl?.name} · v{tpl?.activeVersion}
                    </dd>
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
                    <dd className="font-medium">{fmtUsd(s.budgetCap, 0)}</dd>
                  </div>
                </dl>
                <p className="mt-4 text-xs text-muted-foreground">Last run: {fmtDateTime(s.lastRunAt)}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
