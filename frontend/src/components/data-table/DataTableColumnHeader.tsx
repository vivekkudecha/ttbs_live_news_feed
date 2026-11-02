import type { Column } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"

/** Sortable header: click cycles asc → desc → off; the icon states the current order. */
export function DataTableColumnHeader<T>({ column, title, align = "left" }: { column: Column<T>; title: string; align?: "left" | "right" }) {
  if (!column.getCanSort()) return <span className={cn(align === "right" && "block text-right")}>{title}</span>
  const sorted = column.getIsSorted()
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        "-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground",
        sorted && "text-foreground",
        align === "right" && "ml-auto flex",
      )}
      aria-label={`Sort by ${title}${sorted ? `, currently ${sorted === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      {title}
      <Icon className={cn("size-3.5", !sorted && "opacity-40")} />
    </button>
  )
}
