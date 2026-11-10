/**
 * The one table used across the app: toolbar (your controls + View + density), active-filter
 * chips, the table (sortable/filterable headers), and pagination. Works with `useServerTable`
 * (server sorts/filters/pages) or `useClientTable` (small arrays).
 */
import type { ReactNode } from "react"
import { AlertTriangle, Rows3, Rows4, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage } from "@/api/http"
import { cn } from "@/lib/utils"
import { DataTable } from "./DataTable"
import { DataTablePagination } from "./DataTablePagination"
import { DataTableViewOptions } from "./DataTableViewOptions"
import { describeFilter, type FilterValue } from "./table-meta"
import type { SmartTableState } from "./useSmartTable"

export function SmartTable<T>({
  state,
  empty,
  toolbar,
  actions,
  onRowClick,
  activeRowId,
  minWidth,
  pageSizes = [20, 50, 100],
  hidePagination = false,
  className,
}: {
  state: SmartTableState<T>
  empty: ReactNode
  /** Left side of the toolbar (search, tabs, …). */
  toolbar?: ReactNode
  /** Right side of the toolbar, before View / density. */
  actions?: ReactNode
  onRowClick?: (row: T) => void
  activeRowId?: string
  minWidth?: string
  pageSizes?: number[]
  hidePagination?: boolean
  className?: string
}) {
  const { table, total, density, setDensity, dataKey, loading, stale, error, resetFilters } = state
  const filters = table.getState().columnFilters
  const hideable = table.getAllColumns().some((c) => c.getCanHide())

  return (
    <div className={cn("min-w-0 space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
          {hideable && <DataTableViewOptions table={table} />}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label={density === "compact" ? "Comfortable rows" : "Compact rows"}
                onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
              >
                {density === "compact" ? <Rows3 /> : <Rows4 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{density === "compact" ? "Comfortable rows" : "Compact rows"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          {filters.map((f) => {
            const col = table.getColumn(f.id)
            const meta = col?.columnDef.meta
            return (
              <span key={f.id} className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.06] py-0.5 pl-2.5 pr-1 text-xs">
                <span className="text-muted-foreground">{meta?.label ?? f.id}:</span>
                <span className="font-medium">{describeFilter(meta?.filter, f.value as FilterValue)}</span>
                <button
                  type="button"
                  aria-label={`Remove filter ${meta?.label ?? f.id}`}
                  className="grid size-5 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground"
                  onClick={() => col?.setFilterValue(undefined)}
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={resetFilters}>
            Clear all
          </Button>
        </div>
      )}

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" /> {errorMessage(error)}
        </div>
      ) : loading ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9" style={{ opacity: 1 - i * 0.13 }} />
          ))}
        </div>
      ) : (
        <div className={cn("transition-opacity duration-200", stale && "opacity-60")}>
          <DataTable
            table={table}
            empty={empty}
            onRowClick={onRowClick}
            activeRowId={activeRowId}
            minWidth={minWidth}
            density={density}
            dataKey={dataKey}
          />
          {!hidePagination && total > 0 && <DataTablePagination table={table} totalRows={total} pageSizes={pageSizes} />}
        </div>
      )}
    </div>
  )
}
