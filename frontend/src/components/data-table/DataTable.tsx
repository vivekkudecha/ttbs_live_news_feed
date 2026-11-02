import { flexRender, type Table as TanTable } from "@tanstack/react-table"
import type { ReactNode } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * Presentational TanStack table: the page owns state and columns, this renders them.
 * Rows are clickable when `onRowClick` is given (keyboard: Enter on the focused row).
 */
export function DataTable<T>({
  table,
  empty,
  onRowClick,
  activeRowId,
  minWidth = "56rem",
}: {
  table: TanTable<T>
  empty: ReactNode
  onRowClick?: (row: T) => void
  activeRowId?: string
  minWidth?: string
}) {
  const rows = table.getRowModel().rows
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table style={{ minWidth }}>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((h) => (
                <TableHead
                  key={h.id}
                  style={{ width: h.column.columnDef.size !== 150 ? h.column.columnDef.size : undefined }}
                  className="h-11 text-xs font-medium text-muted-foreground first:pl-4 last:pr-4"
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                aria-current={activeRowId === row.id ? "true" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row.original)
                      }
                    : undefined
                }
                className={cn(
                  "group/row h-14 outline-none focus-visible:bg-muted/60",
                  onRowClick && "cursor-pointer",
                  activeRowId === row.id && "bg-accent/60",
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="first:pl-4 last:pr-4">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-48 text-center">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
