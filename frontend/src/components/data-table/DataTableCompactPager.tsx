import type { Table } from "@tanstack/react-table"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Compact pager for the toolbar row: range + previous/next. Full controls stay below the table. */
export function DataTableCompactPager<T>({ table, totalRows }: { table: Table<T>; totalRows: number }) {
  const { pageIndex, pageSize } = table.getState().pagination
  const from = totalRows === 0 ? 0 : pageIndex * pageSize + 1
  const to = Math.min(totalRows, (pageIndex + 1) * pageSize)
  const f = (n: number) => n.toLocaleString("en-IN")
  return (
    <nav aria-label="Pagination (top)" className="flex items-center gap-2">
      <span className="tabular whitespace-nowrap text-[0.9375rem] text-muted-foreground">
        {f(from)}–{f(to)} of {f(totalRows)}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" className="size-9" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon-sm" className="size-9" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}
