import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { useCountUp } from "@/lib/use-count-up"
import { cn } from "@/lib/utils"

type Tone = "primary" | "success" | "warning" | "info" | "destructive"

/** Icon chip colours and the matching accent line along the top edge. */
const tones: Record<Tone, { chip: string; line: string }> = {
  primary: { chip: "text-primary bg-primary/10", line: "bg-primary" },
  info: { chip: "text-brand-blue bg-brand-blue/10", line: "bg-brand-blue" },
  success: { chip: "text-success bg-success/10", line: "bg-success" },
  warning: { chip: "text-warning bg-warning/12", line: "bg-warning" },
  destructive: { chip: "text-destructive bg-destructive/10", line: "bg-destructive" },
}

/** Counts up the first number in a formatted figure ("1,204", "$41.20", "12/40"); ends on the exact original text. */
function Figure({ value }: { value: ReactNode }) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : null
  const match = text?.match(/\d[\d,]*(\.\d+)?/)
  const target = match ? Number(match[0].replace(/,/g, "")) : 0
  const shown = useCountUp(target)
  if (!text || !match || shown === target) return <>{value}</>
  const digits = match[1] ? match[1].length - 1 : 0
  const live = shown.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return <>{text.replace(match[0], live)}</>
}

/** KPI tile: tinted icon chip, animated figure, one line of context; lifts on hover. */
export function StatCard({ label, value, hint, icon: Icon, tone = "primary" }: { label: string; value: ReactNode; hint?: ReactNode; icon: LucideIcon; tone?: Tone }) {
  return (
    <Card className="lift relative gap-0">
      <span className={cn("absolute inset-x-0 top-0 h-0.5 opacity-70", tones[tone].line)} aria-hidden="true" />
      <CardContent className="space-y-3">
        <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span className={cn("flex size-8 items-center justify-center rounded-lg", tones[tone].chip)}>
            <Icon className="size-4" strokeWidth={2} />
          </span>
          {label}
        </p>
        <p className="tabular text-[1.875rem] font-semibold leading-none tracking-tight text-foreground">
          <Figure value={value} />
        </p>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
