import type { Column } from "@tanstack/react-table"
import { ArrowUp, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { ColumnFilter } from "./ColumnFilter"

/**
 * Header cell: click the title to sort (asc → desc), the funnel (meta.filter) to filter.
 * The arrow rotates between directions instead of swapping icons.
 */
export function DataTableColumnHeader<T>({ column, title, align = "left" }: { column: Column<T>; title: string; align?: "left" | "right" }) {
  const filter = column.columnDef.meta?.filter
  const sorted = column.getIsSorted()
  return (
    <span className={cn("group/th inline-flex items-center gap-0.5", align === "right" && "w-full justify-end")}>
      {column.getCanSort() ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          className={cn("-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground", sorted && "text-foreground")}
          aria-label={`Sort by ${title}${sorted ? `, currently ${sorted === "asc" ? "ascending" : "descending"}` : ""}`}
        >
          {title}
          {sorted ? (
            <ArrowUp className={cn("size-3.5 transition-transform duration-300", sorted === "desc" && "rotate-180")} />
          ) : (
            // Takes no width until hover, so headers line up with their (e.g. right-aligned) values.
            <ChevronsUpDown className="size-3.5 w-0 opacity-0 transition-all group-hover/th:w-3.5 group-hover/th:opacity-40" />
          )}
        </button>
      ) : (
        <span className="py-1">{title}</span>
      )}
      {filter && <ColumnFilter column={column} def={filter} title={title} />}
    </span>
  )
}
