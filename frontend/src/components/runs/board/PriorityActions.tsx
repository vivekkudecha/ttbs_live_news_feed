/**
 * PRIORITY ACTIONS under a PAM on the run board: the AI's ranked "Why now? / Action:" list over that
 * PAM's signals (the same list that ends their digest). Written once the PAM's research is done.
 */
import { Loader2, RotateCcw, Target } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useRetryPriorities } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { PamPriorities } from "@/api/types"
import { shortModel } from "@/lib/models"

export function PriorityActions({ runId, pamId, data, onOpenCompany }: { runId: string; pamId: string; data: PamPriorities; onOpenCompany: (companyId: string) => void }) {
  const retry = useRetryPriorities(runId)
  return (
    <section aria-label="Priority actions" className="rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow flex items-center gap-1.5 text-warning">
          <Target className="size-3.5" /> Priority actions
        </p>
        {data.status === "ready" && data.model && <span className="text-2xs text-muted-foreground">written by {shortModel(data.model)}</span>}
      </div>

      {data.status === "pending" && (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Interpreting this PAM's signals… the digest goes out once these are ready.
        </p>
      )}

      {data.status === "failed" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="min-w-0 text-destructive">Not written: {data.error ?? "the AI did not answer"}. The digest went out without them.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            onClick={() =>
              retry.mutate(pamId, {
                onSuccess: () => toast.success("Writing priority actions again", { description: "The digest is refreshed when they are ready." }),
                onError: (e) => toast.error("Could not retry", { description: errorMessage(e) }),
              })
            }
          >
            {retry.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
          </Button>
        </div>
      )}

      {data.status === "ready" &&
        (data.actions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No action stood out for this PAM's signals.</p>
        ) : (
          <ol className="mt-2 divide-y divide-warning/20">
            {data.actions.map((a) => (
              <li key={a.rank} className="flex gap-3 py-2.5 text-sm first:pt-1 last:pb-0.5">
                <span className="tabular mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-warning/15 text-2xs font-semibold text-warning">{a.rank}</span>
                <div className="min-w-0 space-y-0.5">
                  <button type="button" onClick={() => onOpenCompany(String(a.companyId))} className="text-left font-semibold uppercase tracking-wide hover:text-primary hover:underline">
                    {a.company}
                  </button>
                  {a.whyNow && (
                    <p className="leading-relaxed">
                      <span className="font-medium text-warning">Why now?</span> {a.whyNow}
                    </p>
                  )}
                  {a.action && (
                    <p className="leading-relaxed">
                      <span className="font-medium text-success">Action:</span> {a.action}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ))}
    </section>
  )
}
