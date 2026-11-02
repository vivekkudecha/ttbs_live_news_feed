import type { Table } from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function DataTablePagination<T>({ table, pageSizes = [10, 20, 50] }: { table: Table<T>; pageSizes?: number[] }) {
  const { pageIndex, pageSize } = table.getState().pagination
  const total = table.getFilteredRowModel().rows.length
  const from = total === 0 ? 0 : pageIndex * pageSize + 1
  const to = Math.min(total, (pageIndex + 1) * pageSize)
  const selected = table.getFilteredSelectedRowModel().rows.length

  return (
    <div className="flex flex-col-reverse gap-3 px-1 pt-4 text-[0.8125rem] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <p className="tabular">
        {selected > 0 ? `${selected} selected · ` : ""}
        {from}–{to} of {total}
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <span id="rows-per-page">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
            <SelectTrigger size="sm" className="h-8 w-[4.5rem]" aria-labelledby="rows-per-page">
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
          Page {table.getPageCount() === 0 ? 0 : pageIndex + 1} of {table.getPageCount()}
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
    </div>
  )
}
