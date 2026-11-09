/** One cost breakdown (by run / upload / PAM / model / logo) on the Costs page: sortable and
 * filterable by every column (the rows are already loaded, so this sorts in the browser). */
import { useMemo, type ReactNode } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Wallet } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useClientTable } from "@/components/data-table/useSmartTable"
import type { CostRow } from "@/api/types"
import { fmtUsd } from "@/lib/format"

const n = (x: number) => x.toLocaleString("en-IN")
type Row = { key: string; name: ReactNode; sub?: ReactNode; text?: string } & CostRow

const num = (id: keyof CostRow, title: string, fmt: (r: Row) => ReactNode, unit?: string): ColumnDef<Row, unknown> => ({
  id,
  accessorKey: id,
  sortDescFirst: true,
  meta: { label: title, align: "right", filter: { type: "range", unit } },
  header: ({ column }) => <DataTableColumnHeader column={column} title={title} align="right" />,
  cell: ({ row }) => <span className="tabular">{fmt(row.original)}</span>,
})

export function CostTable({ id, title, description, rows, extra }: { id: string; title: string; description?: string; rows: Row[]; extra?: ReactNode }) {
  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "name",
        accessorFn: (r) => r.text ?? (typeof r.name === "string" ? r.name : r.key),
        enableHiding: false,
        meta: { label: "Name", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => (
          <div className="max-w-72">
            <span className="block truncate font-medium">{row.original.name}</span>
            {row.original.sub && <span className="block truncate text-xs text-muted-foreground">{row.original.sub}</span>}
          </div>
        ),
      },
      num("llm", "Research", (r) => fmtUsd(r.llm, 4), "$"),
      num("messaging", "Messaging", (r) => fmtUsd(r.messaging, 4), "$"),
      num("total", "Total", (r) => <b className="font-semibold">{fmtUsd(r.total, 4)}</b>, "$"),
      num("calls", "Paid calls", (r) => n(r.calls)),
      num("cacheRate", "Cache", (r) => `${r.cacheRate}%`, "%"),
      {
        id: "tokens",
        enableSorting: false,
        meta: { label: "Tokens in / out", align: "right" },
        header: () => <span className="block text-right">Tokens in / out</span>,
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">
            {n(row.original.tokensIn)} / {n(row.original.tokensOut)}
          </span>
        ),
      },
      num("signals", "Signals", (r) => n(r.signals)),
      num("costPerCompany", "Per logo", (r) => (r.costPerCompany != null ? fmtUsd(r.costPerCompany, 4) : "—"), "$"),
      num("costPerSignal", "Per signal", (r) => (r.costPerSignal != null ? fmtUsd(r.costPerSignal, 4) : "—"), "$"),
    ],
    [],
  )
  const state = useClientTable<Row>({ id: `costs-${id}`, data: rows, columns, defaultSort: { id: "total", desc: true }, getRowId: (r) => r.key })
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {extra}
      </CardHeader>
      <CardContent>
        <SmartTable
          state={state}
          minWidth="60rem"
          empty={
            <EmptyState icon={Wallet} title="No spend recorded">
              Nothing matches in this range.
            </EmptyState>
          }
        />
      </CardContent>
    </Card>
  )
}
