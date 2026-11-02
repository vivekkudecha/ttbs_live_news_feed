import type { Table } from "@tanstack/react-table"
import { Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Column visibility toggle. Columns name themselves via `meta.label`. */
export function DataTableViewOptions<T>({ table }: { table: Table<T> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 font-normal">
          <Settings2 className="opacity-60" /> View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {table
          .getAllColumns()
          .filter((c) => c.getCanHide())
          .map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={c.getIsVisible()}
              onCheckedChange={(v) => c.toggleVisibility(!!v)}
              onSelect={(e) => e.preventDefault()}
            >
              {(c.columnDef.meta as { label?: string } | undefined)?.label ?? c.id}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
