import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Minimal KPI tile: label, figure, one line of context.
 * `tone` is kept for API compatibility; colour is intentionally not used on figures.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon: LucideIcon
  tone?: "primary" | "success" | "warning" | "info" | "destructive"
}) {
  return (
    <Card className="gap-0">
      <CardContent className="space-y-3">
        <p className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
          <Icon className="size-4" strokeWidth={1.75} />
          {label}
        </p>
        <p className="tabular text-[1.75rem] font-medium leading-none tracking-tight text-foreground">{value}</p>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
