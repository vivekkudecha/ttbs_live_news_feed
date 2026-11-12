import { modelSource, shortModel } from "@/lib/models"
import { cn } from "@/lib/utils"

/** A research model: "claude-haiku-5-5", with "Anthropic via Perplexity" under it. */
export function ModelName({ provider, model, className }: { provider?: string | null; model?: string | null; className?: string }) {
  const source = modelSource(provider, model)
  return (
    <span className={cn("block min-w-0", className)} title={[model, provider].filter(Boolean).join(" · ")}>
      <code className="block truncate text-xs font-medium">{shortModel(model) || "—"}</code>
      {source && <span className="block truncate text-2xs text-muted-foreground">{source}</span>}
    </span>
  )
}
