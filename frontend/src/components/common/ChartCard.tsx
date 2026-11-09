import type { ReactElement, ReactNode } from "react"
import { ResponsiveContainer } from "recharts"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** Card with a titled, responsive chart area. `label` is the text alternative for screen readers. */
export function ChartCard({
  title,
  description,
  action,
  label,
  className,
  height = "h-64 3xl:h-80",
  empty,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  label: string
  className?: string
  height?: string
  /** Shown instead of the chart when set (e.g. "Nothing researched yet."). */
  empty?: ReactNode
  children: ReactElement
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className={cn(height)} role="img" aria-label={label}>
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
