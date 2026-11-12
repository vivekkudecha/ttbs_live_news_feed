/**
 * One cost breakdown on the Costs page (by run / upload / PAM / model / logo), laid out like the
 * Companies table: a toolbar (search, filter chips, pager, sort, view, export) over a sortable table.
 * Rows are already loaded, so search, filters, sorting and paging happen in the browser.
 */
import { useMemo, useState, type ReactNode } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Download, Wallet } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table/DataTable"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { DataTableCompactPager } from "@/components/data-table/DataTableCompactPager"
import { DataTableFacetedFilter, type FacetOption } from "@/components/data-table/DataTableFacetedFilter"
import { DataTablePagination } from "@/components/data-table/DataTablePagination"
import { DataTableSortMenu } from "@/components/data-table/DataTableSortMenu"
import { DataTableViewOptions } from "@/components/data-table/DataTableViewOptions"
import { Toolbar, ToolbarSearch } from "@/components/data-table/Toolbar"
import { useClientTable } from "@/components/data-table/useSmartTable"
import type { CostRow } from "@/api/types"
import { TokenBreakdown } from "@/components/finops/TokenBreakdown"
import { fmtUsd } from "@/lib/format"

const n = (x: number) => x.toLocaleString("en-IN")
const usd = (v: number) => fmtUsd(v, 4)

/** `text`: the row's name as plain text (search, sort, CSV); `search`: extra text to match (email, file…). */
export type CostTableRow = { key: string; name: ReactNode; sub?: ReactNode; text: string; search?: string; provider?: string | null } & CostRow

/** A filter chip in the toolbar: each row falls in one option. */
export type CostFacet<R> = { id: string; title: string; options: FacetOption[]; of: (r: R) => string }

/** Filters every cost table has. */
const COMMON: CostFacet<CostTableRow>[] = [
  { id: "spend", title: "Spend", options: [{ value: "paid", label: "Has spend" }, { value: "free", label: "No spend" }], of: (r) => (r.total > 0 ? "paid" : "free") },
  {
    id: "cache",
    title: "Cache",
    options: [
      { value: "none", label: "All paid calls" },
      { value: "some", label: "Partly from cache" },
      { value: "all", label: "All from cache" },
    ],
    of: (r) => (r.cacheHits === 0 ? "none" : r.calls === 0 ? "all" : "some"),
  },
  { id: "signals", title: "Signals", options: [{ value: "yes", label: "With signals" }, { value: "no", label: "No signals" }], of: (r) => (r.signals > 0 ? "yes" : "no") },
]

const NO_COLUMNS: never[] = []

const num = <R extends CostTableRow>(id: keyof CostRow, title: string, fmt: (r: R) => ReactNode): ColumnDef<R, unknown> => ({
  id,
  accessorFn: (r) => r[id] ?? undefined,
  sortDescFirst: true,
  sortUndefined: "last",
  meta: { label: title, align: "right" },
  header: ({ column }) => <DataTableColumnHeader column={column} title={title} align="right" />,
  cell: ({ row }) => <span className="tabular whitespace-nowrap">{fmt(row.original)}</span>,
})

function csvCell(v: unknown) {
  const s = String(v ?? "")
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s // no formula cells when opened in Excel
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function downloadCsv(file: string, rows: CostTableRow[], nameLabel: string) {
  const head = [nameLabel, "Research USD", "Messaging USD", "Total USD", "Paid calls", "Cache hits", "Cache %", "Tokens in", "Tokens out", "Total tokens", "Signals", "Messages", "Per logo USD", "Per signal USD"]
  const body = rows.map((r) => [r.text, r.llm, r.messaging, r.total, r.calls, r.cacheHits, r.cacheRate, r.tokensIn, r.tokensOut, r.tokensIn + r.tokensOut, r.signals, r.messages, r.costPerCompany ?? "", r.costPerSignal ?? ""])
  const blob = new Blob(["﻿" + [head, ...body].map((l) => l.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" })
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: file })
  a.click()
  URL.revokeObjectURL(a.href)
}

export function CostTable<R extends CostTableRow>({
  id,
  title,
  description,
  noun,
  nameLabel = "Name",
  rows,
  facets = [],
  hidden = [],
  columns: extra = NO_COLUMNS,
  range,
}: {
  id: string
  title: string
  description?: string
  /** Plural, for the search box and the count: "runs", "PAMs". */
  noun: string
  nameLabel?: string
  rows: R[]
  /** Filters for this table on top of spend / cache / signals. */
  facets?: CostFacet<R>[]
  /** Columns hidden until shown from View (tokens in / out always start hidden: Total tokens shows both on hover). */
  hidden?: string[]
  /** Table-specific columns, placed after the name (e.g. the run's model). */
  columns?: ColumnDef<R, unknown>[]
  /** For the export file name: "2026-11-01_2026-11-12". */
  range: string
}) {
  const [search, setSearch] = useState("")
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const all = useMemo(() => [...facets, ...(COMMON as CostFacet<R>[])], [facets])

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter((r) => `${r.text} ${r.search ?? ""}`.toLowerCase().includes(q)) : rows
  }, [rows, search])
  const shown = useMemo(() => searched.filter((r) => all.every((f) => !picked[f.id]?.length || picked[f.id].includes(f.of(r)))), [searched, all, picked])
  // Each chip counts what it would show with the other chips applied.
  const counts = (f: CostFacet<R>) => {
    const out: Record<string, number> = {}
    for (const r of searched) if (all.every((g) => g === f || !picked[g.id]?.length || picked[g.id].includes(g.of(r)))) out[f.of(r)] = (out[f.of(r)] ?? 0) + 1
    return out
  }

  const columns = useMemo<ColumnDef<R, unknown>[]>(
    () => [
      {
        id: "name",
        accessorFn: (r) => r.text,
        enableHiding: false,
        meta: { label: nameLabel },
        header: ({ column }) => <DataTableColumnHeader column={column} title={nameLabel} />,
        cell: ({ row }) => (
          <div className="min-w-48 max-w-80">
            <span className="block truncate font-medium" title={row.original.text}>
              {row.original.name}
            </span>
            {row.original.sub && <span className="block truncate text-xs text-muted-foreground">{row.original.sub}</span>}
          </div>
        ),
      },
      ...extra,
      num("total", "Total", (r) => <b className="font-semibold">{usd(r.total)}</b>),
      num("llm", "Research", (r) => usd(r.llm)),
      num("messaging", "Messaging", (r) => usd(r.messaging)),
      num("calls", "Paid calls", (r) => n(r.calls)),
      num("cacheRate", "Cache", (r) => `${r.cacheRate}%`),
      {
        id: "tokens",
        accessorFn: (r) => r.tokensIn + r.tokensOut,
        sortDescFirst: true,
        meta: { label: "Total tokens", align: "right" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Total tokens" align="right" />,
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            <TokenBreakdown row={row.original} provider={row.original.provider}>
              {n(row.original.tokensIn + row.original.tokensOut)}
            </TokenBreakdown>
          </span>
        ),
      },
      num("tokensIn", "Tokens in", (r) => <span className="text-muted-foreground">{n(r.tokensIn)}</span>),
      num("tokensOut", "Tokens out", (r) => <span className="text-muted-foreground">{n(r.tokensOut)}</span>),
      num("signals", "Signals", (r) => n(r.signals)),
      num("costPerCompany", "Per logo", (r) => (r.costPerCompany != null ? usd(r.costPerCompany) : "—")),
      num("costPerSignal", "Per signal", (r) => (r.costPerSignal != null ? usd(r.costPerSignal) : "—")),
    ],
    [nameLabel, extra],
  )
  const { table, total } = useClientTable<R>({
    id: `costs-v3-${id}`,
    data: shown,
    columns,
    defaultSort: { id: "total", desc: true },
    defaultHidden: ["tokensIn", "tokensOut", ...hidden],
    getRowId: (r) => r.key,
  })
  const spend = shown.reduce((s, r) => s + r.total, 0)
  const filtered = search !== "" || Object.values(picked).some((v) => v.length > 0)

  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <p className="tabular text-sm text-muted-foreground">
          {shown.length === rows.length ? n(rows.length) : `${n(shown.length)} of ${n(rows.length)}`} {noun} · <span className="font-medium text-foreground">{fmtUsd(spend, spend >= 1 ? 2 : 4)}</span>
        </p>
      </div>

      <Toolbar className="mb-0">
        <ToolbarSearch label={`Search ${noun}`} placeholder={`Search ${noun}`} value={search} onChange={setSearch} />
        <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
          {all.map((f) => (
            <DataTableFacetedFilter key={f.id} title={f.title} options={f.options} value={picked[f.id] ?? []} counts={counts(f)} onChange={(v) => setPicked((p) => ({ ...p, [f.id]: v }))} />
          ))}
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("")
                setPicked({})
              }}
            >
              Reset
            </Button>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
          <DataTableCompactPager table={table} totalRows={total} />
          <DataTableSortMenu table={table} />
          <DataTableViewOptions table={table} />
          <Button variant="outline" title={`Export these ${noun} (CSV)`} disabled={shown.length === 0} onClick={() => downloadCsv(`costs-${id}_${range}.csv`, shown, nameLabel)}>
            <Download /> <span className="max-2xl:sr-only">Export</span>
          </Button>
        </div>
      </Toolbar>

      <DataTable
        table={table}
        stickyHeader
        minWidth="64rem"
        dataKey={JSON.stringify([table.getState().sorting, search, picked])}
        empty={
          <EmptyState icon={Wallet} title={filtered ? `No ${noun} match` : "No spend recorded"}>
            {filtered ? "Try a different search or clear the filters." : "Nothing was billed in this range."}
          </EmptyState>
        }
      />
      {total > 0 && <DataTablePagination table={table} totalRows={total} pageSizes={[20, 50, 100]} />}
    </section>
  )
}
