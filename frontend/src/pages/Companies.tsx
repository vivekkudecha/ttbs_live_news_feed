import { useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"
import { Building2, Copy, Download, MoreHorizontal, PanelRightOpen, Play, Search, Trash2, UserRound, X, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge } from "@/components/common/SignalCard"
import { DataTable } from "@/components/data-table/DataTable"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { DataTableFacetedFilter } from "@/components/data-table/DataTableFacetedFilter"
import { DataTablePagination } from "@/components/data-table/DataTablePagination"
import { DataTableViewOptions } from "@/components/data-table/DataTableViewOptions"
import { CompanyDrawer } from "@/components/companies/CompanyDrawer"
import { ReassignDialog } from "@/components/companies/ReassignDialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAllResults, useCompanies, usePams, useRuns } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDate, initials } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Company, ResearchStatus, SignalCategory } from "@/api/types"

type CycleMark = { runId: string; status: ResearchStatus; windowEnd: string }

interface CompanyRow extends Company {
  pamName: string
  latestStatus: ResearchStatus | "none"
  latestCategory?: SignalCategory
  signals: number
  lastSignal: string | null
  cycles: CycleMark[]
}

const latestStatusOptions = [
  { value: "signal", label: "Signal" },
  { value: "no_signal", label: "No signal" },
  { value: "failed", label: "Failed" },
  { value: "none", label: "Not researched" },
]

const globalSearch: FilterFn<CompanyRow> = (row, _id, value: string) => {
  const q = value.trim().toLowerCase()
  if (!q) return true
  const r = row.original
  return `${r.name} ${r.industry} ${r.pamName} ${r.region}`.toLowerCase().includes(q)
}

/** Copies text when the browser allows it; never throws. */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Copied", { description: text })
  } catch {
    toast.error("Couldn't copy. Select the name and copy it manually.")
  }
}

/** One dot per research cycle, oldest → newest. Filled = signal found. */
function CycleDots({ cycles }: { cycles: CycleMark[] }) {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {cycles.map((c) => (
        <span
          key={c.runId}
          className={cn(
            "size-2 rounded-full",
            c.status === "signal" ? "bg-brand" : c.status === "failed" ? "bg-destructive/60" : "bg-border",
          )}
        />
      ))}
    </span>
  )
}

export function CompaniesList() {
  const { user } = useSession()
  const navigate = useNavigate()
  const isPam = user!.role === "pam"
  const manage = can.manageData(user!.role)
  const companies = useCompanies()
  const pams = usePams()
  const runs = useRuns()
  const allResults = useAllResults()
  const [params, setParams] = useSearchParams()
  const openId = params.get("company")

  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ segment: false })
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [globalFilter, setGlobalFilter] = useState("")
  const [reassignIds, setReassignIds] = useState<string[]>([])

  const openDrawer = (id: string) => setParams((p) => (p.set("company", id), p))
  const closeDrawer = () => setParams((p) => (p.delete("company"), p))

  const data = useMemo<CompanyRow[]>(() => {
    if (!companies.data || !pams.data || !runs.data || !allResults.data) return []
    const finished = runs.data.filter((r) => r.status !== "queued")
    const latestDone = runs.data.find((r) => r.status === "completed")
    const runEnd = new Map(finished.map((r) => [r.id, r.windowEnd]))
    return companies.data
      .filter((c) => !isPam || c.pamId === user!.pamId)
      .map((c) => {
        const mine = allResults.data!.filter((r) => r.companyId === c.id && r.status !== "pending" && runEnd.has(r.runId))
        const cycles = mine
          .map((r) => ({ runId: r.runId, status: r.status, windowEnd: runEnd.get(r.runId)! }))
          .sort((a, b) => a.windowEnd.localeCompare(b.windowEnd))
        const latest = mine.find((r) => r.runId === latestDone?.id)
        const signalCycles = cycles.filter((x) => x.status === "signal")
        return {
          ...c,
          pamName: pams.data!.find((p) => p.id === c.pamId)?.name ?? "Unassigned",
          latestStatus: latest?.status ?? "none",
          latestCategory: latest?.category,
          signals: signalCycles.length,
          lastSignal: signalCycles.at(-1)?.windowEnd ?? null,
          cycles,
        }
      })
  }, [companies.data, pams.data, runs.data, allResults.data, isPam, user])

  const columns = useMemo<ColumnDef<CompanyRow>[]>(() => {
    const cols: ColumnDef<CompanyRow>[] = []
    if (manage) {
      cols.push({
        id: "select",
        size: 40,
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all on this page"
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
          />
        ),
        cell: ({ row }) => (
          <div className="-m-2 p-2" onClick={(e) => e.stopPropagation()}>
            <Checkbox aria-label={`Select ${row.original.name}`} checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(v === true)} />
          </div>
        ),
      })
    }
    cols.push(
      {
        accessorKey: "name",
        meta: { label: "Company" },
        enableHiding: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Company" />,
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-medium text-muted-foreground">
              {initials(row.original.name)}
            </span>
            <div className="min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  openDrawer(row.original.id)
                }}
                className="block max-w-[18rem] truncate text-left font-medium text-foreground underline-offset-2 hover:text-brand-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {row.original.name}
              </button>
              <span className="block text-xs text-muted-foreground">{row.original.industry}</span>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "region",
        meta: { label: "Region" },
        filterFn: "arrIncludesSome",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Region" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.region} <span className="text-muted-foreground/60">·</span> {row.original.segment}
          </span>
        ),
      },
      { accessorKey: "segment", meta: { label: "Segment" }, filterFn: "arrIncludesSome", header: "Segment" },
    )
    if (!isPam) {
      cols.push({
        id: "pam",
        accessorFn: (r) => r.pamId ?? "",
        meta: { label: "PAM" },
        filterFn: "arrIncludesSome",
        sortingFn: (a, b) => a.original.pamName.localeCompare(b.original.pamName),
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <Avatar className="size-6">
              <AvatarFallback className="bg-accent text-[10px] font-medium text-accent-foreground">{initials(row.original.pamName)}</AvatarFallback>
            </Avatar>
            <span className="truncate">{row.original.pamName}</span>
          </span>
        ),
      })
    }
    cols.push(
      {
        accessorKey: "latestStatus",
        meta: { label: "Latest cycle" },
        filterFn: "arrIncludesSome",
        enableSorting: false,
        header: "Latest cycle",
        cell: ({ row }) =>
          row.original.latestStatus === "none" ? (
            <span className="text-xs text-muted-foreground">Not researched</span>
          ) : row.original.latestStatus === "signal" ? (
            <CategoryBadge category={row.original.latestCategory} />
          ) : (
            <StatusBadge status={row.original.latestStatus} />
          ),
      },
      {
        accessorKey: "signals",
        meta: { label: "Signals" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Signals" />,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-2.5">
                <span className="tabular w-3 text-right font-medium">{row.original.signals}</span>
                <CycleDots cycles={row.original.cycles} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {row.original.signals} of {row.original.cycles.length} cycles had a TTBS-relevant signal
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        accessorKey: "lastSignal",
        meta: { label: "Last signal" },
        sortUndefined: "last",
        sortingFn: (a, b) => (a.original.lastSignal ?? "").localeCompare(b.original.lastSignal ?? ""),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last signal" />,
        cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.lastSignal ? fmtDate(row.original.lastSignal) : "—"}</span>,
      },
      {
        id: "actions",
        size: 48,
        enableHiding: false,
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const c = row.original
          return (
            <div className="text-right" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`} className="opacity-70 group-hover/row:opacity-100 data-[state=open]:opacity-100">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="truncate text-xs text-muted-foreground">{c.name}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => openDrawer(c.id)}>
                    <PanelRightOpen /> View timeline
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/signals")}>
                    <Zap /> Open signals feed
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => copy(c.name)}>
                    <Copy /> Copy company name
                  </DropdownMenuItem>
                  {manage && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setReassignIds([c.id])}>
                        <UserRound /> Reassign PAM…
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toast.success(`Research queued for ${c.name}`)}>
                        <Play /> Research now
                      </DropdownMenuItem>
                    </>
                  )}
                  {can.admin(user!.role) && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => toast.info(`Stop tracking ${c.name}? Confirmation opens here (prototype).`)}>
                        <Trash2 /> Stop tracking
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    )
    return cols
    // openDrawer/navigate are stable for our purposes; columns rebuild when role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manage, isPam, user])

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, rowSelection, globalFilter },
    getRowId: (r) => r.id,
    enableRowSelection: manage,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: globalSearch,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize: 10 } },
  })

  const selectedIds = table.getSelectedRowModel().rows.map((r) => r.original.id)
  const filtered = columnFilters.length > 0 || globalFilter !== ""
  const loading = !companies.data || !pams.data || !runs.data || !allResults.data

  return (
    <div>
      <PageHeader
        title={isPam ? "My companies" : "Companies"}
        description="Every logo being tracked, its PAM and its signal history. Select a company to see its full timeline."
        actions={
          <>
            <Button variant="outline" onClick={() => toast.success(`Exported ${table.getFilteredRowModel().rows.length} companies to Excel`)}>
              <Download /> Export
            </Button>
            {manage && (
              <Button variant="outline" asChild>
                <Link to="/imports">Import Excel / CSV</Link>
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative lg:w-72">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search companies"
            placeholder="Search company, industry or PAM"
            className="h-9 pl-9 pr-8"
            value={globalFilter}
            onChange={(e) => {
              setGlobalFilter(e.target.value)
              table.setPageIndex(0)
            }}
          />
          {globalFilter && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setGlobalFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DataTableFacetedFilter column={table.getColumn("region")} title="Region" options={["North", "South", "East", "West"].map((v) => ({ value: v, label: v }))} />
          <DataTableFacetedFilter
            column={table.getColumn("segment")}
            title="Segment"
            options={["Enterprise", "Mid-market", "Emerging"].map((v) => ({ value: v, label: v }))}
          />
          {!isPam && (
            <DataTableFacetedFilter column={table.getColumn("pam")} title="PAM" options={(pams.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          )}
          <DataTableFacetedFilter column={table.getColumn("latestStatus")} title="Latest cycle" options={latestStatusOptions} />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-muted-foreground"
              onClick={() => {
                table.resetColumnFilters()
                setGlobalFilter("")
              }}
            >
              Reset <X />
            </Button>
          )}
        </div>
        <div className="lg:ml-auto">
          <DataTableViewOptions table={table} />
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-blue/30 bg-accent/60 px-4 py-2.5 text-sm">
          <span className="font-medium">{selectedIds.length} selected</span>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={() => setReassignIds(selectedIds)}>
            <UserRound /> Reassign PAM
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.success(`Research queued for ${selectedIds.length} companies`)}>
            <Play /> Research now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.success(`Exported ${selectedIds.length} companies`)}>
            <Download /> Export
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => table.resetRowSelection()}>
            Clear selection
          </Button>
        </div>
      )}

      {loading ? (
        <Skeleton className="h-[32rem]" />
      ) : (
        <>
          <DataTable
            table={table}
            onRowClick={(r) => openDrawer(r.id)}
            activeRowId={openId ?? undefined}
            empty={
              <EmptyState icon={Building2} title="No companies match">
                Try a different search or clear the filters.
              </EmptyState>
            }
          />
          <DataTablePagination table={table} />
        </>
      )}

      <CompanyDrawer companyId={openId} onOpenChange={(o) => !o && closeDrawer()} onReassign={(id) => setReassignIds([id])} />
      <ReassignDialog
        companyIds={reassignIds}
        open={reassignIds.length > 0}
        onOpenChange={(o) => !o && setReassignIds([])}
        onDone={() => table.resetRowSelection()}
      />
    </div>
  )
}

/** Old deep links (/companies/:id) now open the drawer on the list. */
export function CompanyDetail() {
  const { id = "" } = useParams()
  return <Navigate to={`/companies?company=${encodeURIComponent(id)}`} replace />
}
