import { flexRender, type Table as TanTable } from "@tanstack/react-table"
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { Density } from "./useSmartTable"

/**
 * Presentational TanStack table: the page owns state and columns, this renders them.
 * Rows are clickable when `onRowClick` is given (keyboard: Enter on the focused row).
 *
 * One scroll for the whole page: the table never scrolls vertically on its own. When the table
 * fits its box (the usual case on laptops: cells wrap instead of forcing width), the header row
 * sticks under the app's top bar while the page scrolls — the wrapper then uses `overflow-x: clip`,
 * which unlike `auto` is not a scroll container, so sticky keeps working. Only a table that cannot
 * fit (narrow card, phone) scrolls sideways inside its box, and its header is then not sticky.
 *
 * `dataKey` changes when a new page / sort / filter lands: the rows fade in once (not on refetch).
 */
export function DataTable<T>({
  table,
  empty,
  onRowClick,
  activeRowId,
  minWidth = "56rem",
  stickyHeader = true,
  density = "comfortable",
  dataKey,
}: {
  table: TanTable<T>
  empty: ReactNode
  onRowClick?: (row: T) => void
  activeRowId?: string
  minWidth?: string
  stickyHeader?: boolean
  density?: Density
  dataKey?: string
  /** @deprecated the table no longer scrolls on its own */
  maxHeight?: string
}) {
  const rows = table.getRowModel().rows
  const box = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const t = el.querySelector("table")
      setFits(window.innerWidth >= 1024 && !!t && t.scrollWidth <= el.clientWidth + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const t = el.querySelector("table")
    if (t) ro.observe(t)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={box} className={cn("rounded-xl border bg-card shadow-xs", fits ? "overflow-x-clip" : "overflow-x-auto")}>
      <Table
        style={{ "--table-min": minWidth } as CSSProperties}
        className="min-w-(--table-min) lg:min-w-0 lg:text-sm lg:[&_td]:whitespace-normal lg:[&_td]:break-words lg:[&_th]:whitespace-normal"
        containerClassName="overflow-visible"
      >
        <TableHeader
          className={cn(
            "[&_th]:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))] [&_tr]:border-b-0 [&_th]:shadow-[inset_0_-1px_0_var(--border)]",
            stickyHeader && fits && "sticky top-16 z-20",
          )}
        >
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((h) => (
                <TableHead
                  key={h.id}
                  // Column `size` is declared in px at 1080p; as rem it follows the screen-fitted scale.
                  style={{ width: h.column.columnDef.size && h.column.columnDef.size !== 150 ? `${h.column.columnDef.size / 16}rem` : undefined }}
                  className={cn(
                    "group/th h-11 text-xs font-medium text-muted-foreground first:rounded-tl-xl first:pl-4 last:rounded-tr-xl last:pr-4",
                    h.column.columnDef.meta?.align === "right" && "text-right",
                  )}
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody key={dataKey} className={cn(dataKey && "animate-in fade-in-0 slide-in-from-bottom-1 duration-300")}>
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
                  "group/row outline-none transition-colors duration-150 focus-visible:bg-muted/60 has-[[data-state=open]]:bg-muted/50",
                  density === "compact" ? "h-10" : "h-14",
                  onRowClick && "cursor-pointer",
                  activeRowId === row.id && "bg-accent/60",
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn("first:pl-4 last:pr-4", density === "compact" && "py-1.5", cell.column.columnDef.meta?.align === "right" && "text-right")}
                  >
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
