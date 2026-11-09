/**
 * Delivery outbox and dead-letter queue (live backend). Every digest is an outbox row; each
 * delivery attempt is kept (time, HTTP status, Microsoft error code, request id). Emails that
 * failed permanently or ran out of attempts land in the dead-letter queue, where an operator can
 * requeue them (after fixing the cause) or discard them with a note. Everything is audited.
 */
import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { ChevronLeft, ChevronRight, Inbox, Loader2, MailWarning, RotateCcw, Search, Settings2, XCircle } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { EmptyState } from "@/components/common/EmptyState"
import { Page } from "@/components/common/layout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useDeadLetters, useDiscardDeadLetter, useNotificationDetail, useOutbox, useRequeueDeadLetters, useResendNotification } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { DeadLetter, DeadLetterStatus, OutboxStatus } from "@/api/types"
import { useDebounced } from "@/lib/use-debounced"
import { fmtDateTime } from "@/lib/format"
import { useSession } from "@/context/session"
import { can } from "@/lib/access"

const PAGE = 50
const num = (n: number | undefined) => (n ?? 0).toLocaleString("en-IN")

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const from = total ? page * PAGE + 1 : 0
  const to = Math.min(total, (page + 1) * PAGE)
  return (
    <nav aria-label="Pagination" className="flex items-center gap-2">
      <span className="tabular text-sm text-muted-foreground">
        {num(from)}–{num(to)} of {num(total)}
      </span>
      <Button variant="outline" size="icon-sm" onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page">
        <ChevronLeft />
      </Button>
      <Button variant="outline" size="icon-sm" onClick={() => onPage(page + 1)} disabled={to >= total} aria-label="Next page">
        <ChevronRight />
      </Button>
    </nav>
  )
}

export default function EmailOutbox() {
  const { user } = useSession()
  const dl = useDeadLetters({ page: 0, pageSize: 1, status: "open" })
  const open = dl.data?.counts.open ?? 0
  return (
    <Page>
      <PageHeader
        title="Delivery outbox"
        description="Every digest, its delivery attempts, and the dead-letter queue for emails that could not be delivered."
        actions={
          can(user, "integrations") ? (
            <Button variant="outline" asChild>
              <Link to="/integrations">
                <Settings2 /> Email settings
              </Link>
            </Button>
          ) : undefined
        }
      />
      <Tabs defaultValue="outbox">
        <TabsList>
          <TabsTrigger value="outbox">
            <Inbox /> Outbox
          </TabsTrigger>
          <TabsTrigger value="dlq">
            <MailWarning /> Dead-letter queue {open > 0 && <Badge variant="destructive">{num(open)}</Badge>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="outbox" className="mt-4">
          <OutboxTab />
        </TabsContent>
        <TabsContent value="dlq" className="mt-4">
          <DeadLetterTab />
        </TabsContent>
      </Tabs>
    </Page>
  )
}

// --- Outbox --------------------------------------------------------------------------------------------

const STATUSES: (OutboxStatus | "all")[] = ["all", "pending", "sending", "sent", "failed", "skipped"]

function OutboxTab() {
  const [status, setStatus] = useState<OutboxStatus | "all">("all")
  const [channel, setChannel] = useState("email")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const dq = useDebounced(q, 300)
  const data = useOutbox({ page, pageSize: PAGE, status: status === "all" ? undefined : status, channel: channel === "all" ? undefined : channel, q: dq || undefined })
  const counts = data.data?.counts ?? {}
  const all = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            onClick={() => {
              setStatus(s)
              setPage(0)
            }}
            aria-pressed={status === s}
            className="capitalize"
          >
            {s} <span className="tabular opacity-70">{num(s === "all" ? all : counts[s])}</span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap gap-2">
          <div className="relative min-w-56 flex-1 sm:max-w-sm">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search recipient…"
              className="pl-8"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
            />
          </div>
          <Select
            value={channel}
            onValueChange={(c) => {
              setChannel(c)
              setPage(0)
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="whatsapp">WhatsApp</SelectItem>
              <SelectItem value="all">All channels</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Pager page={page} total={data.data?.total ?? 0} onPage={setPage} />
      </div>
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[60rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Queued</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead className="pr-5">Next try / sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.isLoading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-24" />
                  </TableCell>
                </TableRow>
              )}
              {data.data?.rows.map((n) => (
                <TableRow key={n.id} className="cursor-pointer" onClick={() => setOpenId(n.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpenId(n.id)}>
                  <TableCell className="tabular pl-5 text-sm text-muted-foreground">{fmtDateTime(n.createdAt)}</TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{n.pamName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{n.recipient ?? "no address"}</div>
                  </TableCell>
                  <TableCell className="max-w-sm truncate text-sm">{n.subject ?? "—"}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <StatusBadge status={n.status === "sending" ? "processing" : n.status} label={n.status === "sending" ? "Sending" : undefined} />
                      {n.status === "pending" && n.reservedAt && <Badge variant="outline">slot reserved</Badge>}
                    </span>
                    {n.lastError && n.status !== "sent" && <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground">{n.lastError}</div>}
                  </TableCell>
                  <TableCell className="tabular text-right text-sm">{n.attempts}</TableCell>
                  <TableCell className="tabular pr-5 text-sm text-muted-foreground">{n.sentAt ? fmtDateTime(n.sentAt) : fmtDateTime(n.nextAttemptAt)}</TableCell>
                </TableRow>
              ))}
              {data.data && data.data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing here.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <DetailSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}

function DetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const d = useNotificationDetail(id)
  const resend = useResendNotification()
  const n = d.data
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{n?.subject ?? "Delivery"}</SheetTitle>
          <SheetDescription>
            {n ? (
              <>
                To {n.pamName} &lt;{n.recipient}&gt; · {n.channel} · run #{n.runId}
                {n.templateVersion ? ` · template v${n.templateVersion}` : ""}
              </>
            ) : (
              "Loading…"
            )}
          </SheetDescription>
        </SheetHeader>
        {n && (
          <div className="space-y-5 px-4 pb-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={n.status === "sending" ? "processing" : n.status} />
              {(n.status === "failed" || n.status === "skipped") && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resend.isPending}
                  onClick={() =>
                    resend.mutate(n.id, {
                      onSuccess: () => toast.success("Re-queued", { description: "It goes back in line for the next free sending slot." }),
                      onError: (e) => toast.error("Not re-queued", { description: errorMessage(e) }),
                    })
                  }
                >
                  <RotateCcw /> Resend
                </Button>
              )}
            </div>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Attempts</h3>
              {n.history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No attempt yet.</p>
              ) : (
                <ol className="space-y-2">
                  {n.history.map((a) => (
                    <li key={a.attempt} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">#{a.attempt}</span>
                        <StatusBadge status={a.outcome === "sent" ? "sent" : a.outcome === "retry" ? "pending" : "failed"} label={a.outcome === "retry" ? "Will retry" : undefined} />
                        <span className="tabular text-xs text-muted-foreground">
                          {fmtDateTime(a.startedAt)} · {a.durationMs} ms · {a.adapter}
                          {a.httpStatus ? ` · HTTP ${a.httpStatus}` : ""}
                          {a.errorCode ? ` · ${a.errorCode}` : ""}
                        </span>
                      </div>
                      {a.error && <p className="mt-1 break-words text-xs text-muted-foreground">{a.error}</p>}
                      {a.providerRequestId && <p className="mt-1 font-mono text-[0.7rem] text-muted-foreground">request-id {a.providerRequestId}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Message</h3>
              {n.rendered?.aiError && (
                <Alert className="mb-2">
                  <AlertDescription>Sent without the AI summary: {n.rendered.aiError}</AlertDescription>
                </Alert>
              )}
              {n.rendered?.html ? (
                <iframe title="Sent email" sandbox="" srcDoc={n.rendered.html} className="h-[32rem] w-full rounded-lg border bg-white" />
              ) : (
                <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs">{n.rendered?.text ?? n.body ?? "Rendered at the first attempt."}</pre>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// --- Dead-letter queue ---------------------------------------------------------------------------------

function DeadLetterTab() {
  const [status, setStatus] = useState<DeadLetterStatus>("open")
  const [page, setPage] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [discard, setDiscard] = useState<DeadLetter | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const data = useDeadLetters({ page, pageSize: PAGE, status })
  const requeue = useRequeueDeadLetters()
  const rows = data.data?.rows ?? []
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id))

  const doRequeue = (ids: string[]) =>
    requeue.mutate(ids, {
      onSuccess: (r) => {
        toast.success(`${num(r.requeued)} requeued`, { description: "They go back in line, oldest first, within the sending limits." })
        setPicked(new Set())
      },
      onError: (e) => toast.error("Not requeued", { description: errorMessage(e) }),
    })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {(["open", "requeued", "discarded"] as DeadLetterStatus[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "default" : "outline"}
              className="capitalize"
              aria-pressed={status === s}
              onClick={() => {
                setStatus(s)
                setPage(0)
                setPicked(new Set())
              }}
            >
              {s} <span className="tabular opacity-70">{num(data.data?.counts[s])}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status === "open" && (
            <Button size="sm" disabled={picked.size === 0 || requeue.isPending} onClick={() => doRequeue([...picked])}>
              {requeue.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Requeue {picked.size > 0 && num(picked.size)}
            </Button>
          )}
          <Pager page={page} total={data.data?.total ?? 0} onPage={setPage} />
        </div>
      </div>
      {data.data && data.data.total === 0 ? (
        <EmptyState icon={MailWarning} title={status === "open" ? "No undelivered emails" : `Nothing ${status}`}>
          {status === "open" ? "Emails that fail permanently or run out of attempts appear here for review." : undefined}
        </EmptyState>
      ) : (
        <Card className="py-0">
          <CardContent className="overflow-x-auto p-0">
            <Table className="min-w-[62rem]">
              <TableHeader>
                <TableRow>
                  {status === "open" && (
                    <TableHead className="w-10 pl-5">
                      <Checkbox
                        checked={allPicked}
                        onCheckedChange={(c) => setPicked(c === true ? new Set(rows.map((r) => r.id)) : new Set())}
                        aria-label="Select all on this page"
                      />
                    </TableHead>
                  )}
                  <TableHead className={status === "open" ? "" : "pl-5"}>Failed</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead className="pr-5 text-right">{status === "open" ? "Actions" : "Resolved"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id}>
                    {status === "open" && (
                      <TableCell className="pl-5">
                        <Checkbox
                          checked={picked.has(d.id)}
                          onCheckedChange={(c) =>
                            setPicked((p) => {
                              const n = new Set(p)
                              if (c === true) n.add(d.id)
                              else n.delete(d.id)
                              return n
                            })
                          }
                          aria-label={`Select ${d.recipient}`}
                        />
                      </TableCell>
                    )}
                    <TableCell className={status === "open" ? "tabular text-sm text-muted-foreground" : "tabular pl-5 text-sm text-muted-foreground"}>
                      {fmtDateTime(d.createdAt)}
                    </TableCell>
                    <TableCell>
                      <button type="button" className="text-left text-sm font-medium hover:underline" onClick={() => setOpenId(d.notificationId)}>
                        {d.recipient ?? "—"}
                      </button>
                      <div className="max-w-xs truncate text-xs text-muted-foreground">{d.subject}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={d.reason === "permanent" ? "destructive" : "secondary"}>{d.reason === "permanent" ? "Permanent" : `Gave up after ${d.attempts}`}</Badge>
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal break-words text-xs text-muted-foreground">{d.lastError}</TableCell>
                    <TableCell className="pr-5 text-right">
                      {status === "open" ? (
                        <span className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => doRequeue([d.id])} disabled={requeue.isPending}>
                            <RotateCcw /> Requeue
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDiscard(d)}>
                            <XCircle /> Discard
                          </Button>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {fmtDateTime(d.resolvedAt)} · {d.resolvedBy}
                          {d.resolutionNote && <span className="block">{d.resolutionNote}</span>}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        Fix the cause first (for example the mailbox permission or the recipient address), then requeue. Requeued emails are rendered again with the active
        template and sent within the sending limits. Every requeue and discard is in the audit log.
      </p>
      <DiscardDialog letter={discard} onClose={() => setDiscard(null)} />
      <DetailSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}

function DiscardDialog({ letter, onClose }: { letter: DeadLetter | null; onClose: () => void }) {
  const discard = useDiscardDeadLetter()
  const [note, setNote] = useState("")
  return (
    <Dialog
      open={!!letter}
      onOpenChange={(o) => {
        if (!o) {
          setNote("")
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard this email?</DialogTitle>
          <DialogDescription>
            It will not be sent. The email, its attempts and your note stay in the record for audit. To {letter?.recipient}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="dlq-note">Reason (required)</Label>
          <Textarea id="dlq-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. PAM left the company; digest no longer needed" />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={note.trim().length < 3 || discard.isPending}
            onClick={() =>
              letter &&
              discard.mutate(
                { id: letter.id, note: note.trim() },
                {
                  onSuccess: () => {
                    toast.success("Discarded")
                    setNote("")
                    onClose()
                  },
                  onError: (e) => toast.error("Not discarded", { description: errorMessage(e) }),
                },
              )
            }
          >
            {discard.isPending && <Loader2 className="animate-spin" />} Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
