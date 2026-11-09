/** Audit log columns, shared by the Audit page and a run's "Audit trail" tab. */
import type { ColumnDef } from "@tanstack/react-table"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { Badge } from "@/components/ui/badge"
import type { AuditEntry } from "@/api/types"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const area = (action: string) => action.split(".")[0]
// One quiet dot per event area; the action text carries the meaning.
const areaDot: Record<string, string> = {
  auth: "bg-chart-5",
  run: "bg-brand-blue",
  notify: "bg-success",
  dataset: "bg-chart-3",
  import: "bg-chart-3",
  template: "bg-brand",
  email: "bg-brand",
  research: "bg-chart-4",
  provider: "bg-warning",
  llm: "bg-warning",
  pam: "bg-destructive",
  user: "bg-chart-5",
  company: "bg-brand-blue",
}

export function auditColumns(): ColumnDef<AuditEntry, unknown>[] {
  return [
    {
      id: "ts",
      accessorKey: "ts",
      size: 170,
      meta: { label: "Time", filter: { type: "date" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time (IST)" />,
      cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{fmtDateTime(row.original.ts)}</span>,
    },
    {
      id: "actor",
      accessorKey: "actor",
      meta: { label: "Actor", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Actor" />,
      cell: ({ row }) => <span className="font-medium">{row.original.actor}</span>,
    },
    {
      id: "action",
      accessorKey: "action",
      meta: { label: "Action", filter: { type: "text", placeholder: "e.g. run. or email.template" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Action" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="gap-1.5 font-mono text-xs font-normal text-foreground/80">
          <span className={cn("size-1.5 rounded-full", areaDot[area(row.original.action)] ?? "bg-muted-foreground/50")} aria-hidden="true" />
          {row.original.action}
        </Badge>
      ),
    },
    {
      id: "entity",
      accessorKey: "entity",
      meta: { label: "Entity", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Entity" />,
      cell: ({ row }) => <span className="text-sm">{row.original.entity}</span>,
    },
    {
      id: "detail",
      accessorKey: "detail",
      enableSorting: false,
      meta: { label: "Detail" },
      header: "Detail",
      cell: ({ row }) => <span className="line-clamp-2 max-w-md whitespace-normal text-sm text-muted-foreground">{row.original.detail || "—"}</span>,
    },
    {
      id: "ip",
      accessorKey: "ip",
      meta: { label: "Source IP", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source IP" />,
      cell: ({ row }) => <span className="tabular text-xs text-muted-foreground">{row.original.ip || "—"}</span>,
    },
  ]
}
