import { useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Link } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useTopbarSlots } from "@/components/layout/topbar"

/**
 * Page title, description and page-level actions, rendered into the app top bar.
 *
 * - Title + description: top bar, left (description truncates; full text on hover).
 * - Actions: top bar, right, on ≥ md. On phones they render inline at the top of the page,
 *   because the top bar has no room for them there.
 * Pages with a table toolbar should put their actions in the toolbar row instead.
 */
export function PageHeader({ title, description, actions, back }: { title: string; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  const slots = useTopbarSlots()

  useEffect(() => {
    document.title = `${title} · TTBS Signals`
  }, [title])

  const descText = typeof description === "string" ? description : undefined

  return (
    <>
      {slots.title &&
        createPortal(
          <div className="flex min-w-0 items-center gap-2">
            {back && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" asChild className="-ml-1 shrink-0">
                    <Link to={back.to} aria-label={back.label}>
                      <ArrowLeft />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{back.label}</TooltipContent>
              </Tooltip>
            )}
            <div className="min-w-0 leading-tight">
              <h1 className="truncate text-base font-medium tracking-tight text-foreground">{title}</h1>
              {description && (
                <p className="hidden truncate text-xs text-muted-foreground md:block" title={descText}>
                  {description}
                </p>
              )}
            </div>
          </div>,
          slots.title,
        )}
      {actions && slots.actions && createPortal(<div className="hidden items-center gap-2 md:flex">{actions}</div>, slots.actions)}
      {actions && <div className="mb-5 flex flex-wrap items-center gap-2 md:hidden">{actions}</div>}
    </>
  )
}
