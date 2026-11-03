import { useId } from "react"
import type { Table } from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/**
 * Works client-side or server-side: pass `totalRows` when the server pages the data.
 * Render it above and below a long table with `placement="top" | "bottom"`.
 */
export function DataTablePagination<T>({
  table,
  pageSizes = [10, 20, 50],
  totalRows,
  placement = "bottom",
}: {
  table: Table<T>
  pageSizes?: number[]
  totalRows?: number
  placement?: "top" | "bottom"
}) {
  const labelId = useId()
  const { pageIndex, pageSize } = table.getState().pagination
  const total = totalRows ?? table.getFilteredRowModel().rows.length
  const from = total === 0 ? 0 : pageIndex * pageSize + 1
  const to = Math.min(total, (pageIndex + 1) * pageSize)
  const selected = Object.keys(table.getState().rowSelection).length

  return (
    <nav
      aria-label={placement === "top" ? "Pagination (top)" : "Pagination"}
      className={cn(
        "flex flex-col-reverse gap-3 px-1 text-[0.9375rem] text-muted-foreground sm:flex-row sm:items-center sm:justify-between",
        placement === "top" ? "pb-3" : "pt-4",
      )}
    >
      <p className="tabular">
        {selected > 0 ? `${selected} selected · ` : ""}
        {from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <span id={labelId}>Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
            <SelectTrigger size="sm" className="h-8 w-[4.5rem]" aria-labelledby={labelId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizes.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="tabular">
          Page {(table.getPageCount() === 0 ? 0 : pageIndex + 1).toLocaleString("en-IN")} of {table.getPageCount().toLocaleString("en-IN")}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} aria-label="First page">
            <ChevronsLeft />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </nav>
  )
}
