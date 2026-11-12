import type { Table } from "@tanstack/react-table"
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const label = (c: { id: string; columnDef: { meta?: { label?: string } } }) => c.columnDef.meta?.label ?? c.id

/** Toolbar sort picker (same choice as clicking a column header): column + direction. */
export function DataTableSortMenu<T>({ table }: { table: Table<T> }) {
  const cols = table.getAllLeafColumns().filter((c) => c.getCanSort())
  const [s] = table.getState().sorting
  const current = cols.find((c) => c.id === s?.id)
  const Icon = s?.desc === false ? ArrowUpNarrowWide : ArrowDownWideNarrow
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="font-normal" title={current ? `Sorted by ${label(current)}` : "Sort"}>
          <Icon className="opacity-60" /> <span className="max-2xl:sr-only">{current ? label(current) : "Sort"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={s?.id ?? ""} onValueChange={(id) => table.setSorting([{ id, desc: s?.desc ?? true }])}>
          {cols.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={c.id} onSelect={(e) => e.preventDefault()}>
              {label(c)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={s?.desc === false ? "asc" : "desc"} onValueChange={(d) => s && table.setSorting([{ id: s.id, desc: d === "desc" }])}>
          <DropdownMenuRadioItem value="desc" disabled={!s}>
            High to low · Z to A
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="asc" disabled={!s}>
            Low to high · A to Z
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
