/**
 * Email delivery settings (live backend): Microsoft Graph with app-to-app credentials
 * (Entra ID app registration, client-credentials flow, Mail.Send application permission).
 *
 * - Connection: tenant, client id, client secret (write-only), sender mailbox. Saving verifies
 *   the credentials with Microsoft first and checks the token carries Mail.Send.
 * - Limits & quota: the mailbox sending limits (rolling minute / hour / 24 h buckets) the
 *   dispatcher enforces, live usage, backlog and when the backlog will be fully sent.
 * - Retry & policy: attempts, backoff, whether to email PAMs with no signals.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import {
  CircleCheck,
  CircleOff,
  Clock,
  Eye,
  EyeOff,
  Gauge,
  Info,
  KeyRound,
  Loader2,
  Mail,
  Pause,
  Play,
  PlugZap,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  useEmailSettings,
  useEnableEmail,
  usePauseEmail,
  useRemoveEmailSettings,
  useResumeEmail,
  useSaveEmailLimits,
  useSaveEmailPolicy,
  useSaveEmailSettings,
  useSendTestEmail,
  useTestEmailSettings,
} from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { EmailQuota, EmailSettings } from "@/api/types"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const EXCHANGE_DEFAULTS = { perMinute: 30, perHour: 3600, perDay: 10000, safetyMarginPct: 5 }
const num = (n: number) => n.toLocaleString("en-IN")

/** "in 3 h 20 min" / "in 45 s" for a future ISO time. */
function fromNow(iso: string | null | undefined): string {
  if (!iso) return "—"
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  if (s <= 0) return "now"
  if (s < 90) return `in ${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `in ${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h} h${m % 60 ? ` ${m % 60} min` : ""}`
  return `in ${Math.round(h / 24)} days`
}

export function EmailProviderSettings() {
  const settings = useEmailSettings()
  if (settings.isLoading) return <Skeleton className="h-96 w-full" />
  if (settings.isError || !settings.data)
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load email settings: {errorMessage(settings.error)}</AlertDescription>
      </Alert>
    )
  const s = settings.data
  return (
    <div className="space-y-4">
      <ModeBanner s={s} />
      <Tabs defaultValue={s.configured ? "quota" : "connection"}>
        <TabsList>
          <TabsTrigger value="connection">
            <KeyRound /> Connection
          </TabsTrigger>
          <TabsTrigger value="quota">
            <Gauge /> Limits &amp; quota
          </TabsTrigger>
          <TabsTrigger value="policy">
            <RotateCcw /> Retry &amp; policy
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connection" className="mt-4">
          <ConnectionCard s={s} />
        </TabsContent>
        <TabsContent value="quota" className="mt-4 space-y-4">
          <QuotaCard q={s.quota} />
          <LimitsCard s={s} />
        </TabsContent>
        <TabsContent value="policy" className="mt-4">
          <PolicyCard s={s} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ModeBanner({ s }: { s: EmailSettings }) {
  const enable = useEnableEmail()
  const resume = useResumeEmail()
  const q = s.quota
  const toggle = (v: boolean) =>
    enable.mutate(v, {
      onSuccess: () => toast.success(v ? "Email delivery switched on" : "Email delivery switched off", { description: v ? undefined : "New digests wait in the outbox." }),
      onError: (e) => toast.error("Not changed", { description: errorMessage(e) }),
    })

  if (q.mode === "console")
    return (
      <Alert>
        <Info />
        <AlertTitle>Email is not connected: digests are logged by the worker, not sent</AlertTitle>
        <AlertDescription>Connect a Microsoft 365 mailbox under Connection to start sending. Queued digests are kept and follow the same quota.</AlertDescription>
      </Alert>
    )
  return (
    <Alert variant={q.mode === "active" ? "default" : "destructive"}>
      {q.mode === "active" ? <CircleCheck className="text-emerald-600" /> : <CircleOff />}
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {q.mode === "active" && <>Sending as {s.connection?.senderAddress}</>}
        {q.mode === "disabled" && <>Email delivery is switched off · {num(q.backlog.pending)} waiting</>}
        {q.mode === "paused" && <>Sending paused until {fmtDateTime(q.pausedUntil)} ({fromNow(q.pausedUntil)})</>}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {q.mode === "paused"
            ? q.pauseReason
            : q.mode === "disabled"
              ? "Digests are queued and kept; nothing is sent until delivery is switched back on."
              : `Up to ${num(q.limits.effective.minute)}/min · ${num(q.limits.effective.hour)}/h · ${num(q.limits.effective.day)}/24 h, oldest first.`}
        </span>
        <span className="flex items-center gap-3">
          {q.mode === "paused" && (
            <Button size="sm" variant="outline" onClick={() => resume.mutate(undefined, { onError: (e) => toast.error("Not resumed", { description: errorMessage(e) }) })}>
              {resume.isPending ? <Loader2 className="animate-spin" /> : <Play />} Resume now
            </Button>
          )}
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={s.enabled} onCheckedChange={toggle} disabled={enable.isPending} aria-label="Email delivery enabled" />
            {s.enabled ? "On" : "Off"}
          </label>
        </span>
      </AlertDescription>
    </Alert>
  )
}

// --- Connection -------------------------------------------------------------------------------------

function Field({ id, label, help, children }: { id: string; label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

function ConnectionCard({ s }: { s: EmailSettings }) {
  const save = useSaveEmailSettings()
  const test = useTestEmailSettings()
  const remove = useRemoveEmailSettings()
  const c = s.connection
  const [f, setF] = useState({
    tenantId: c?.tenantId ?? "",
    clientId: c?.clientId ?? "",
    clientSecret: "",
    senderAddress: c?.senderAddress ?? "",
    senderName: c?.senderName ?? "TTBS Signals",
    replyTo: c?.replyTo ?? "",
    saveToSent: c?.saveToSent ?? false,
  })
  const [showSecret, setShowSecret] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }))

  const sameApp = !!c && c.tenantId === f.tenantId.trim().toLowerCase() && c.clientId === f.clientId.trim().toLowerCase()
  const needsSecret = !c || !sameApp
  const dirty =
    !c ||
    !!f.clientSecret.trim() ||
    f.tenantId !== c.tenantId ||
    f.clientId !== c.clientId ||
    f.senderAddress !== c.senderAddress ||
    (f.senderName || "") !== (c.senderName || "") ||
    (f.replyTo || "") !== (c.replyTo || "") ||
    f.saveToSent !== c.saveToSent
  const ready = f.tenantId.trim() && f.clientId.trim() && f.senderAddress.trim() && (!needsSecret || f.clientSecret.trim())

  const onSave = () =>
    save.mutate(
      {
        tenantId: f.tenantId.trim(),
        clientId: f.clientId.trim(),
        clientSecret: f.clientSecret.trim() || undefined,
        senderAddress: f.senderAddress.trim(),
        senderName: f.senderName.trim() || undefined,
        replyTo: f.replyTo.trim() || undefined,
        saveToSent: f.saveToSent,
      },
      {
        onSuccess: (r) => {
          toast.success("Microsoft Graph connected", { description: `Verified in ${r.check?.latencyMs ?? "?"} ms · sending as ${r.connection?.senderAddress}` })
          setF((x) => ({ ...x, clientSecret: "" }))
          setShowSecret(false)
        },
        onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
      },
    )

  const onTest = () =>
    test.mutate(undefined, {
      onSuccess: (r) => (r.ok ? toast.success("Credentials OK", { description: `Token issued in ${r.check?.latencyMs} ms with Mail.Send` }) : toast.error("Check failed", { description: r.error ?? "" })),
      onError: (e) => toast.error("Check failed", { description: errorMessage(e) }),
    })

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)]">
      <Card className={s.configured ? "" : "border-dashed"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground" /> Microsoft 365 (Graph API)
          </CardTitle>
          <CardDescription>App-to-app: the app sends as one mailbox with its own credentials. No user sign-in, no SMTP password.</CardDescription>
          <CardAction>
            <StatusBadge status={!s.configured ? "not_configured" : s.check?.ok === false ? "error" : "connected"} />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-5">
          {s.configured && s.check && (
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Client secret</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  <KeyRound className="size-3.5 text-muted-foreground" /> <code className="text-xs">{c?.secretHint}</code>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last check</dt>
                <dd className="font-medium">
                  {s.check.ok ? <span className="tabular">OK · {s.check.latencyMs} ms · {fmtDateTime(s.check.verifiedAt)}</span> : <span className="text-destructive">Failed</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Updated</dt>
                <dd className="font-medium">
                  {fmtDateTime(s.updatedAt)} · {s.updatedBy}
                </dd>
              </div>
            </dl>
          )}
          {s.check?.ok === false && s.check.error && (
            <Alert variant="destructive">
              <AlertDescription>{s.check.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="em-tenant" label="Directory (tenant) ID" help="GUID or a verified domain, e.g. contoso.onmicrosoft.com">
              <Input id="em-tenant" value={f.tenantId} onChange={(e) => set("tenantId")(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono" spellCheck={false} autoComplete="off" />
            </Field>
            <Field id="em-client" label="Application (client) ID">
              <Input id="em-client" value={f.clientId} onChange={(e) => set("clientId")(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono" spellCheck={false} autoComplete="off" />
            </Field>
          </div>
          <Field
            id="em-secret"
            label="Client secret value"
            help={needsSecret ? "Copy the secret's Value (not its ID). Encrypted on the server (AES-256-GCM) and never shown again." : `Leave blank to keep ${c?.secretHint}. Secrets expire: rotate here before the expiry date in Entra ID.`}
          >
            <div className="relative">
              <Input
                id="em-secret"
                type={showSecret ? "text" : "password"}
                value={f.clientSecret}
                onChange={(e) => set("clientSecret")(e.target.value)}
                placeholder={needsSecret ? "Secret value" : `Leave blank to keep ${c?.secretHint}`}
                className="pr-9 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? "Hide secret" : "Show secret"}
              >
                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="em-sender" label="Send as (mailbox)" help="A shared mailbox is recommended. The app sends as this address.">
              <Input id="em-sender" type="email" value={f.senderAddress} onChange={(e) => set("senderAddress")(e.target.value)} placeholder="signals@company.com" />
            </Field>
            <Field id="em-name" label="Sender display name">
              <Input id="em-name" value={f.senderName} onChange={(e) => set("senderName")(e.target.value)} placeholder="TTBS Signals" />
            </Field>
            <Field id="em-reply" label="Reply-to (optional)" help="Where PAM replies go, e.g. the sales-ops team.">
              <Input id="em-reply" type="email" value={f.replyTo} onChange={(e) => set("replyTo")(e.target.value)} placeholder="sales-ops@company.com" />
            </Field>
            <div className="space-y-2">
              <Label htmlFor="em-sent">Keep a copy in Sent Items</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch id="em-sent" checked={f.saveToSent} onCheckedChange={(v) => set("saveToSent")(v)} />
                <span className="text-sm text-muted-foreground">{f.saveToSent ? "Yes" : "No (recommended at volume)"}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={onSave} disabled={!ready || !dirty || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify &amp; save
            </Button>
            {s.configured && (
              <>
                <Button variant="outline" onClick={onTest} disabled={test.isPending}>
                  {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Check credentials
                </Button>
                <Button variant="outline" onClick={() => setTestOpen(true)}>
                  <Send /> Send test email
                </Button>
                <Button variant="outline" onClick={() => setConfirmRemove(true)}>
                  <Trash2 /> Disconnect
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Saving asks Microsoft for a token with these credentials and checks it carries the Mail.Send permission. Only a real test email proves the mailbox
            accepts the app.
          </p>
        </CardContent>
      </Card>

      <SetupGuide />

      <TestSendDialog open={testOpen} onOpenChange={setTestOpen} />
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Microsoft Graph?</DialogTitle>
            <DialogDescription>
              The saved credentials are deleted. Queued digests stay in the outbox and are logged instead of sent until a mailbox is connected again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmRemove(false)
                    toast.success("Email disconnected")
                  },
                  onError: (e) => toast.error("Not removed", { description: errorMessage(e) }),
                })
              }
            >
              {remove.isPending && <Loader2 className="animate-spin" />} Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SetupGuide() {
  const steps: ReactNode[] = [
    <>
      In <strong>Microsoft Entra ID → App registrations</strong>, create an app (single tenant). Copy its <em>Application (client) ID</em> and{" "}
      <em>Directory (tenant) ID</em>.
    </>,
    <>
      <strong>API permissions → Add → Microsoft Graph → Application permissions → Mail.Send</strong>, then <strong>Grant admin consent</strong>.
    </>,
    <>
      <strong>Certificates &amp; secrets → New client secret</strong>. Copy the secret <em>Value</em> right away and note its expiry.
    </>,
    <>
      Recommended: restrict the app to the sender mailbox with an Exchange <strong>Application Access Policy</strong> (otherwise Mail.Send can send as any
      mailbox).
    </>,
    <>Fill in the form, Verify &amp; save, then send a test email.</>,
  ]
  return (
    <Card className="h-fit bg-muted/30">
      <CardHeader>
        <CardTitle className="text-sm">Set up in Azure (one time)</CardTitle>
        <CardDescription>Done by a Microsoft 365 admin.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3 text-sm">
          {steps.map((st, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
              <span className="text-muted-foreground [&_strong]:text-foreground">{st}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function TestSendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const send = useSendTestEmail()
  const [to, setTo] = useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test email</DialogTitle>
          <DialogDescription>A real email through Microsoft Graph. It counts against the sending quota like any other.</DialogDescription>
        </DialogHeader>
        <Field id="em-test-to" label="Send to">
          <Input id="em-test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@company.com" autoFocus />
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={!to.trim() || send.isPending}
            onClick={() =>
              send.mutate(to.trim(), {
                onSuccess: (r) => {
                  toast.success(`Test email accepted for ${r.to}`, { description: r.requestId ? `Graph request ${r.requestId}` : undefined })
                  onOpenChange(false)
                },
                onError: (e) => toast.error("Test email failed", { description: errorMessage(e) }),
              })
            }
          >
            {send.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- Quota ------------------------------------------------------------------------------------------

function Meter({ label, used, limit, hint }: { label: string; used: number; limit: number; hint: string }) {
  const p = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">
          <span className={cn("font-semibold text-foreground", p >= 100 && "text-destructive")}>{num(used)}</span> / {num(limit)}
        </span>
      </div>
      <Progress value={p} aria-label={`${label}: ${used} of ${limit}`} className={cn(p >= 100 && "[&>div]:bg-destructive")} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function QuotaCard({ q }: { q: EmailQuota }) {
  const pause = usePauseEmail()
  const [pauseOpen, setPauseOpen] = useState(false)
  const [minutes, setMinutes] = useState("60")
  const [reason, setReason] = useState("")
  const b = q.backlog
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" /> Sending quota (live)
        </CardTitle>
        <CardDescription>
          Every email is counted in a time bucket. Each turn the dispatcher fills what is free with the oldest pending emails; when a bucket is full the rest wait
          for the next window and resume from there.
        </CardDescription>
        {q.mode === "active" && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setPauseOpen(true)}>
              <Pause /> Pause
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-5 md:grid-cols-3">
          <Meter label="This minute" used={q.used.minute} limit={q.limits.effective.minute} hint="Sends are also spaced evenly across the minute." />
          <Meter label="Last 60 minutes" used={q.used.hour} limit={q.limits.effective.hour} hint="Rolling hour." />
          <Meter label="Last 24 hours" used={q.used.day} limit={q.limits.effective.day} hint="Rolling 24 h, as Exchange Online counts it." />
        </div>
        <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Waiting to send</dt>
            <dd className="tabular text-lg font-semibold">{num(b.pending - b.reserved)}</dd>
            <dd className="text-xs text-muted-foreground">{num(b.due)} due now</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Handed to workers</dt>
            <dd className="tabular text-lg font-semibold">{num(b.reserved + b.sending)}</dd>
            <dd className="text-xs text-muted-foreground">{num(b.sending)} sending right now</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Free capacity now</dt>
            <dd className="tabular text-lg font-semibold">{num(q.capacityNow)}</dd>
            <dd className="text-xs text-muted-foreground">{q.capacityNow ? "Sending" : `Next slot ${fromNow(q.nextFreeAt)}`}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Backlog fully sent</dt>
            <dd className="text-lg font-semibold">{b.pending ? fromNow(q.drainEta) : "Nothing waiting"}</dd>
            <dd className="text-xs text-muted-foreground">
              {b.pending && q.drainEta ? fmtDateTime(q.drainEta) : b.oldestQueuedAt ? `Oldest queued ${fmtDateTime(b.oldestQueuedAt)}` : " "}
              {q.beyondHorizon > 0 && ` · ${num(q.beyondHorizon)} beyond 60 days`}
            </dd>
          </div>
        </dl>
        {b.pending > q.limits.effective.day && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Clock className="mt-0.5 size-3.5 shrink-0" />
            The backlog is larger than one day's limit, so it is sent over several days, oldest first. Nothing is dropped; ask Microsoft for higher limits or lower
            volume if this is too slow.
          </p>
        )}
      </CardContent>
      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause sending</DialogTitle>
            <DialogDescription>Emails keep queuing and resume automatically, oldest first, when the pause ends.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label>For</Label>
              <Select value={minutes} onValueChange={setMinutes}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ["15", "15 minutes"],
                    ["60", "1 hour"],
                    ["240", "4 hours"],
                    ["1440", "24 hours"],
                  ].map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field id="em-pause-reason" label="Reason (audited)">
              <Input id="em-pause-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. mailbox migration" />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={pause.isPending}
              onClick={() =>
                pause.mutate(
                  { minutes: Number(minutes), reason: reason.trim() || undefined },
                  { onSuccess: () => setPauseOpen(false), onError: (e) => toast.error("Not paused", { description: errorMessage(e) }) },
                )
              }
            >
              {pause.isPending ? <Loader2 className="animate-spin" /> : <Pause />} Pause
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function NumberField({ id, label, value, onChange, min, max, suffix }: { id: string; label: string; value: number; onChange: (v: number) => void; min: number; max: number; suffix?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.valueAsNumber)} className="tabular" />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  )
}

function LimitsCard({ s }: { s: EmailSettings }) {
  const save = useSaveEmailLimits()
  const [v, setV] = useState({ perMinute: s.limits.perMinute, perHour: s.limits.perHour, perDay: s.limits.perDay, safetyMarginPct: s.limits.safetyMarginPct })
  useEffect(() => {
    setV({ perMinute: s.limits.perMinute, perHour: s.limits.perHour, perDay: s.limits.perDay, safetyMarginPct: s.limits.safetyMarginPct })
  }, [s.limits.perMinute, s.limits.perHour, s.limits.perDay, s.limits.safetyMarginPct])
  const eff = (n: number) => Math.max(1, Math.floor((n * (100 - (v.safetyMarginPct || 0))) / 100))
  const valid = [v.perMinute, v.perHour, v.perDay, v.safetyMarginPct].every(Number.isFinite) && v.perMinute <= v.perHour && v.perHour <= v.perDay
  const dirty = v.perMinute !== s.limits.perMinute || v.perHour !== s.limits.perHour || v.perDay !== s.limits.perDay || v.safetyMarginPct !== s.limits.safetyMarginPct
  const perDayAtMinuteRate = eff(v.perMinute) * 60 * 24

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mailbox sending limits</CardTitle>
        <CardDescription>
          Exchange Online allows 30 messages a minute, 3,600 an hour and 10,000 recipients a day per mailbox. Going over can block the mailbox, so the dispatcher
          stays under these numbers minus the safety margin.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField id="lim-min" label="Per minute" value={v.perMinute} onChange={(n) => setV({ ...v, perMinute: n })} min={1} max={10000} />
          <NumberField id="lim-hour" label="Per hour" value={v.perHour} onChange={(n) => setV({ ...v, perHour: n })} min={1} max={1000000} />
          <NumberField id="lim-day" label="Per 24 hours" value={v.perDay} onChange={(n) => setV({ ...v, perDay: n })} min={1} max={10000000} />
          <NumberField id="lim-margin" label="Safety margin" value={v.safetyMarginPct} onChange={(n) => setV({ ...v, safetyMarginPct: n })} min={0} max={50} suffix="%" />
        </div>
        <p className="text-sm text-muted-foreground">
          Enforced:{" "}
          <span className="tabular font-medium text-foreground">
            {num(eff(v.perMinute))}/min · {num(eff(v.perHour))}/h · {num(eff(v.perDay))}/24 h
          </span>
          {Number.isFinite(perDayAtMinuteRate) && perDayAtMinuteRate > eff(v.perDay) && (
            <> · at full speed the day limit is reached after about {Math.round((eff(v.perDay) / (Math.min(eff(v.perMinute) * 60, eff(v.perHour)) || 1)) * 10) / 10} h</>
          )}
        </p>
        {!valid && <p className="text-sm text-destructive">Limits must satisfy per minute ≤ per hour ≤ per 24 hours.</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!s.configured || !valid || !dirty || save.isPending}
            onClick={() =>
              save.mutate(v, {
                onSuccess: () => toast.success("Limits saved", { description: "The dispatcher uses them from its next turn." }),
                onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
              })
            }
          >
            {save.isPending && <Loader2 className="animate-spin" />} Save limits
          </Button>
          <Button variant="outline" onClick={() => setV(EXCHANGE_DEFAULTS)}>
            <RotateCcw /> Exchange Online defaults
          </Button>
        </div>
        {!s.configured && <p className="text-xs text-muted-foreground">Connect a mailbox first; until then the defaults apply.</p>}
      </CardContent>
    </Card>
  )
}

// --- Retry & policy -----------------------------------------------------------------------------------

const dur = (sec: number) => (sec < 90 ? `${Math.round(sec)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${Math.round((sec / 3600) * 10) / 10} h`)

function PolicyCard({ s }: { s: EmailSettings }) {
  const save = useSaveEmailPolicy()
  const [v, setV] = useState(s.policy)
  useEffect(() => setV(s.policy), [s.policy])
  const schedule = useMemo(() => {
    if (![v.maxAttempts, v.backoffBaseS, v.backoffCapS].every(Number.isFinite)) return []
    let t = 0
    return Array.from({ length: Math.max(0, Math.min(20, v.maxAttempts) - 1) }, (_, i) => {
      const d = Math.min(v.backoffCapS, v.backoffBaseS * 2 ** i)
      t += d
      return { attempt: i + 2, wait: d, total: t }
    })
  }, [v])
  const dirty = JSON.stringify(v) !== JSON.stringify(s.policy)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retries, dead-letter queue and delivery policy</CardTitle>
        <CardDescription>
          A temporary failure (throttling, Microsoft outage) is retried with exponential backoff, never sooner than Microsoft's Retry-After. A permanent failure
          (unknown mailbox, missing permission) or the last failed attempt moves the email to the dead-letter queue, where it can be requeued or discarded with a
          note. Every attempt is kept for audit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField id="pol-att" label="Attempts per email" value={v.maxAttempts} onChange={(n) => setV({ ...v, maxAttempts: n })} min={1} max={20} />
          <NumberField id="pol-base" label="First retry after" value={v.backoffBaseS} onChange={(n) => setV({ ...v, backoffBaseS: n })} min={5} max={3600} suffix="s" />
          <NumberField id="pol-cap" label="Longest wait" value={v.backoffCapS} onChange={(n) => setV({ ...v, backoffCapS: n })} min={30} max={86400} suffix="s" />
        </div>
        {schedule.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">Attempt 1 · when its slot comes</Badge>
            {schedule.map((r) => (
              <Badge key={r.attempt} variant="outline" className="tabular">
                Attempt {r.attempt} · +{dur(r.wait)}
              </Badge>
            ))}
            <Badge variant="outline">then dead-letter queue (~{dur(schedule[schedule.length - 1].total)} after the first try)</Badge>
          </div>
        )}
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <Switch checked={v.sendWhenNoSignals} onCheckedChange={(c) => setV({ ...v, sendWhenNoSignals: c })} className="mt-0.5" />
          <span className="text-sm">
            <span className="font-medium">Email PAMs even when none of their accounts has a signal</span>
            <span className="block text-muted-foreground">Off: those digests are skipped (and saved as skipped), which saves quota for the ones that matter.</span>
          </span>
        </label>
        <Button
          disabled={!s.configured || !dirty || save.isPending}
          onClick={() =>
            save.mutate(v, {
              onSuccess: () => toast.success("Delivery policy saved"),
              onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
            })
          }
        >
          {save.isPending && <Loader2 className="animate-spin" />} Save policy
        </Button>
      </CardContent>
    </Card>
  )
}
