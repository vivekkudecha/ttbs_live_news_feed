/** A PAM's email digest for the run: exactly as sent, or (not sent yet / outdated) rendered now from the current results. */
import { Mail, Send } from "lucide-react"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { usePamDigest } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import type { DigestRender } from "@/api/types"

/** The digest's "To" line; after a PAM edit it also says where a resend now goes. */
export function DigestRecipient({ d }: { d: DigestRender }) {
  const moved = d.asSent && d.currentRecipient && d.currentRecipient !== d.recipient
  return (
    <p>
      <span className="inline-block w-16 text-muted-foreground">To</span> <span className="break-all">{d.recipient ?? "—"}</span>
      {moved && <span className="ml-16 block text-xs text-muted-foreground">Resend goes to {d.currentRecipient}</span>}
    </p>
  )
}

export function DigestPreviewDialog({
  runId,
  pamId,
  pamName,
  canManage,
  onClose,
  onResend,
}: {
  runId: string
  pamId: string | null
  pamName?: string
  canManage: boolean
  onClose: () => void
  onResend: (pamId: string) => void
}) {
  const q = usePamDigest(runId, pamId)
  const d = q.data
  return (
    <Dialog open={!!pamId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-5 text-primary" /> {pamName ? `${pamName}'s digest` : "Digest"}
          </DialogTitle>
          <DialogDescription>
            {d ? (d.asSent ? `Exactly as sent ${fmtDateTime(d.sentAt)}.` : "Not sent in this form: rendered now from the current results with the active template.") : "Loading…"}
          </DialogDescription>
          {d && (
            <div className="mt-2 space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <DigestRecipient d={d} />
              <p className="flex items-center">
                <span className="inline-block w-16 text-muted-foreground">Subject</span>
                <span className="font-medium">{d.subject}</span>
              </p>
              <p className="flex items-center">
                <span className="inline-block w-16 text-muted-foreground">Status</span>
                {d.status === "none" ? "Not queued yet" : <StatusBadge status={d.status === "sending" ? "running" : d.status} />}
              </p>
            </div>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {q.isError ? (
            <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
          ) : !d ? (
            <Skeleton className="h-[32rem]" />
          ) : d.html ? (
            <iframe title="Digest email" sandbox="" srcDoc={d.html} className="h-[32rem] w-full rounded-lg border bg-white" />
          ) : (
            <pre className="whitespace-pre-wrap rounded-lg border p-4 text-sm">{d.text}</pre>
          )}
        </div>
        <DialogFooter className="m-0 px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {canManage && pamId && d && d.status !== "none" && d.status !== "pending" && d.status !== "sending" && (
            <Button onClick={() => onResend(pamId)}>
              <Send /> Resend with current results
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
