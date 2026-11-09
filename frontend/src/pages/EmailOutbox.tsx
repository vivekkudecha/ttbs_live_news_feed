/**
 * Delivery outbox and dead-letter queue (live backend). Every digest is an outbox row; each
 * delivery attempt is kept (time, HTTP status, Microsoft error code, request id). Emails that
 * failed permanently or ran out of attempts land in the dead-letter queue, where an operator can
 * requeue them (after fixing the cause) or discard them with a note. Everything is audited.
 */
import { useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Inbox, Loader2, MailWarning, RotateCcw, Search, Settings2, XCircle } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { EmptyState } from "@/components/common/EmptyState"
import { Page } from "@/components/common/layout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useServerTable } from "@/components/data-table/useSmartTable"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useDeadLetters, useDiscardDeadLetter, useNotificationDetail, useRequeueDeadLetters, useResendNotification } from "@/api/hooks"
import { backend, errorMessage } from "@/api/http"
import type { DeadLetter, DeadLetterPage, DeadLetterStatus, OutboxPage, OutboxRow, OutboxStatus } from "@/api/types"
import { useDebounced } from "@/lib/use-debounced"
import { fmtDateTime } from "@/lib/format"
import { useSession } from "@/context/session"
import { can } from "@/lib/access"

const PAGE = 50
const num = (n: number | undefined) => (n ?? 0).toLocaleString("en-IN")

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
  const [openId, setOpenId] = useState<string | null>(null)
  const dq = useDebounced(q, 300)
  const columns = useMemo<ColumnDef<OutboxRow, unknown>[]>(
    () => [
      {
        id: "createdAt",
        accessorKey: "createdAt",
        meta: { label: "Queued", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Queued" />,
        cell: ({ row }) => <span className="tabular whitespace-nowrap text-sm text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span>,
      },
      {
        id: "pamName",
        accessorKey: "pamName",
        meta: { label: "Recipient", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Recipient" />,
        cell: ({ row }) => (
          <div>
            <div className="text-sm font-semibold">{row.original.pamName ?? "—"}</div>
            <div className="text-xs text-muted-foreground">{row.original.recipient ?? "no address"}</div>
          </div>
        ),
      },
      {
        id: "subject",
        accessorKey: "subject",
        enableSorting: false,
        meta: { label: "Subject" },
        header: "Subject",
        cell: ({ row }) => <span className="line-clamp-2 max-w-[16rem] text-sm">{row.original.subject ?? "—"}</span>,
      },
      {
        id: "status",
        accessorKey: "status",
        meta: { label: "Status", filter: { type: "enum", options: STATUSES.filter((x) => x !== "all").map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) })) } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => {
          const n = row.original
          return (
            <div>
              <span className="flex items-center gap-1.5">
                <StatusBadge status={n.status === "sending" ? "processing" : n.status} label={n.status === "sending" ? "Sending" : undefined} />
                {n.status === "pending" && n.reservedAt && <Badge variant="outline">slot reserved</Badge>}
              </span>
              {n.lastError && n.status !== "sent" && <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground">{n.lastError}</div>}
            </div>
          )
        },
      },
      {
        id: "attempts",
        accessorKey: "attempts",
        meta: { label: "Attempts", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Attempts" align="right" />,
        cell: ({ row }) => <span className="tabular text-sm">{row.original.attempts}</span>,
      },
      {
        id: "sentAt",
        accessorKey: "sentAt",
        meta: { label: "Next try / sent", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Next try / sent" />,
        cell: ({ row }) => (
          <span className="tabular whitespace-nowrap text-sm text-muted-foreground">
            {row.original.sentAt ? fmtDateTime(row.original.sentAt) : fmtDateTime(row.original.nextAttemptAt)}
          </span>
        ),
      },
    ],
    [],
  )
  const state = useServerTable<OutboxRow, OutboxPage>({
    id: "outbox",
    columns,
    queryKey: ["outbox", { status, channel, dq }],
    fetcher: (t) => backend.outbox({ ...t, status: status === "all" ? undefined : status, channel: channel === "all" ? undefined : channel, q: dq || undefined }),
    pageSize: PAGE,
    getRowId: (n) => n.id,
    refetchInterval: 10_000,
  })
  const counts = state.data?.counts ?? {}
  const all = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <Button key={s} size="sm" variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)} aria-pressed={status === s} className="capitalize">
            {s} <span className="tabular opacity-70">{num(s === "all" ? all : counts[s])}</span>
          </Button>
        ))}
      </div>
      <SmartTable
        state={state}
        onRowClick={(n) => setOpenId(n.id)}
        minWidth="60rem"
        pageSizes={[25, 50, 100]}
        toolbar={
          <>
            <div className="relative min-w-56 sm:w-72">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search recipient…" className="h-9 pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="all">All channels</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
        empty={
          <EmptyState icon={Inbox} title="Nothing here">
            Try another status, channel or filter.
          </EmptyState>
        }
      />
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
  const [discard, setDiscard] = useState<DeadLetter | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const requeue = useRequeueDeadLetters()

  const doRequeue = (ids: string[], after?: () => void) =>
    requeue.mutate(ids, {
      onSuccess: (r) => {
        toast.success(`${num(r.requeued)} requeued`, { description: "They go back in line, oldest first, within the sending limits." })
        after?.()
      },
      onError: (e) => toast.error("Not requeued", { description: errorMessage(e) }),
    })

  const columns = useMemo<ColumnDef<DeadLetter, unknown>[]>(
    () => [
      ...(status === "open"
        ? [
            {
              id: "select",
              size: 40,
              enableSorting: false,
              enableHiding: false,
              header: ({ table }) => (
                <Checkbox
                  checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
                  onCheckedChange={(c) => table.toggleAllPageRowsSelected(c === true)}
                  aria-label="Select all on this page"
                />
              ),
              cell: ({ row }) => (
                <Checkbox checked={row.getIsSelected()} onCheckedChange={(c) => row.toggleSelected(c === true)} aria-label={`Select ${row.original.recipient}`} />
              ),
            } satisfies ColumnDef<DeadLetter, unknown>,
          ]
        : []),
      {
        id: "createdAt",
        accessorKey: "createdAt",
        meta: { label: "Failed", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Failed" />,
        cell: ({ row }) => <span className="tabular whitespace-nowrap text-sm text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span>,
      },
      {
        id: "recipient",
        accessorKey: "recipient",
        meta: { label: "Recipient", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Recipient" />,
        cell: ({ row }) => (
          <div>
            <button type="button" className="text-left text-sm font-semibold hover:underline" onClick={() => setOpenId(row.original.notificationId)}>
              {row.original.recipient ?? "—"}
            </button>
            <div className="max-w-xs truncate text-xs text-muted-foreground">{row.original.subject}</div>
          </div>
        ),
      },
      {
        id: "reason",
        accessorKey: "reason",
        meta: { label: "Reason", filter: { type: "enum", options: [{ value: "permanent", label: "Permanent" }, { value: "exhausted", label: "Out of attempts" }] } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Reason" />,
        cell: ({ row }) => (
          <Badge variant={row.original.reason === "permanent" ? "destructive" : "secondary"}>
            {row.original.reason === "permanent" ? "Permanent" : `Gave up after ${row.original.attempts}`}
          </Badge>
        ),
      },
      {
        id: "lastError",
        accessorKey: "lastError",
        enableSorting: false,
        meta: { label: "Last error", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last error" />,
        cell: ({ row }) => <span className="line-clamp-2 max-w-md whitespace-normal break-words text-xs text-muted-foreground">{row.original.lastError}</span>,
      },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        meta: { align: "right" },
        header: () => <span className="block text-right">{status === "open" ? "Actions" : "Resolved"}</span>,
        cell: ({ row }) => {
          const d = row.original
          return status === "open" ? (
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
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, requeue.isPending],
  )
  const state = useServerTable<DeadLetter, DeadLetterPage>({
    id: "dlq",
    columns,
    queryKey: ["deadLetters", status],
    fetcher: (t) => backend.deadLetters({ ...t, status }),
    pageSize: PAGE,
    getRowId: (d) => d.id,
    enableRowSelection: status === "open",
    refetchInterval: 15_000,
  })
  const picked = Object.keys(state.table.getState().rowSelection)

  return (
    <div className="space-y-4">
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
              state.table.resetRowSelection()
            }}
          >
            {s} <span className="tabular opacity-70">{num(state.data?.counts[s])}</span>
          </Button>
        ))}
      </div>
      {!state.loading && state.total === 0 && state.table.getState().columnFilters.length === 0 ? (
        <EmptyState icon={MailWarning} title={status === "open" ? "No undelivered emails" : `Nothing ${status}`}>
          {status === "open" ? "Emails that fail permanently or run out of attempts appear here for review." : undefined}
        </EmptyState>
      ) : (
        <SmartTable
          state={state}
          minWidth="62rem"
          pageSizes={[25, 50, 100]}
          actions={
            status === "open" && (
              <Button size="sm" className="h-9" disabled={picked.length === 0 || requeue.isPending} onClick={() => doRequeue(picked, () => state.table.resetRowSelection())}>
                {requeue.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Requeue {picked.length > 0 && num(picked.length)}
              </Button>
            )
          }
          empty={
            <EmptyState icon={MailWarning} title="Nothing matches">
              Clear a filter to see every entry.
            </EmptyState>
          }
        />
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
