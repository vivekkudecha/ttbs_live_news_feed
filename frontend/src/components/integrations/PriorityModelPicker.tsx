/**
 * The model that writes PRIORITY ACTIONS for each PAM after its research. It only reads the research
 * results (no web search), so a small, low-cost model is enough. Unset = the research model.
 */
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { ListRestart, Loader2, ShieldCheck, Undo2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useLoadLlmModels, useSavePriorityModel } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { LlmConfig, LlmModel } from "@/api/types"
import { ownerLabel, shortModel } from "@/lib/models"

/** Names that usually mean a small, cheap model. */
const LOW_COST = /haiku|mini|nano|lite|flash|sonar(?!-pro)|small/i

export function PriorityModelPicker({ c }: { c: LlmConfig }) {
  const load = useLoadLlmModels()
  const save = useSavePriorityModel()
  const [models, setModels] = useState<LlmModel[] | null>(null)
  const [model, setModel] = useState("")
  // Low-cost models first, then the rest by owner and name.
  const sorted = useMemo(
    () => [...(models ?? [])].sort((a, b) => Number(LOW_COST.test(b.id)) - Number(LOW_COST.test(a.id)) || a.id.localeCompare(b.id)),
    [models],
  )

  const open = () =>
    load.mutate(
      { provider: c.provider },
      {
        onSuccess: (r) => {
          setModels(r.models)
          setModel(c.priorityModel ?? "")
        },
        onError: (e) => toast.error("Could not load models", { description: errorMessage(e) }),
      },
    )
  const apply = (m: string | null) =>
    save.mutate(
      { provider: c.provider, model: m },
      {
        onSuccess: () => {
          toast.success("Priority actions model saved", { description: m ? shortModel(m) : `Using the research model (${shortModel(c.model)})` })
          setModels(null)
        },
        onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
      },
    )

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Priority actions model</p>
          <p className="text-xs text-muted-foreground">
            Reads each PAM's research and writes their ranked priority actions. No web search, so a small, low-cost model is enough.
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            {c.priorityModel ? (
              <>
                <Badge variant="outline">{ownerLabel(c.priorityModelProvider ?? "")}</Badge>
                <code className="text-xs">{shortModel(c.priorityModel)}</code>
              </>
            ) : (
              <span className="text-muted-foreground">
                Using the research model (<code className="text-xs">{shortModel(c.model)}</code>)
              </span>
            )}
          </p>
        </div>
        {!models && (
          <Button variant="outline" size="sm" onClick={open} disabled={load.isPending}>
            {load.isPending ? <Loader2 className="animate-spin" /> : <ListRestart />} Change
          </Button>
        )}
      </div>

      {models && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label className="text-xs">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="font-mono text-xs">{m.id}</span>
                    {LOW_COST.test(m.id) && <Badge variant="secondary">low cost</Badge>}
                    {m.id === c.priorityModel && <Badge variant="outline">current</Badge>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => apply(model)} disabled={!model || model === c.priorityModel || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify &amp; save
            </Button>
            {c.priorityModel && (
              <Button size="sm" variant="ghost" onClick={() => apply(null)} disabled={save.isPending} title="Use the research model again">
                <Undo2 /> Research model
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setModels(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
