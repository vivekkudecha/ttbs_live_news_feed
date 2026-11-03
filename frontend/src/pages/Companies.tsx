import { useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"
import { Building2, Copy, Download, Gauge, Upload, MoreHorizontal, PanelRightOpen, Play, Search, Trash2, UserRound, X, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge } from "@/components/common/SignalCard"
import { DataTable } from "@/components/data-table/DataTable"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { DataTableFacetedFilter } from "@/components/data-table/DataTableFacetedFilter"
import { DataTablePagination } from "@/components/data-table/DataTablePagination"
import { DataTableCompactPager } from "@/components/data-table/DataTableCompactPager"
import { DataTableViewOptions } from "@/components/data-table/DataTableViewOptions"
import { CompanyDrawer } from "@/components/companies/CompanyDrawer"
import { ReassignDialog } from "@/components/companies/ReassignDialog"
import { PamMultiFilter } from "@/components/pickers/Pickers"
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
import { useCompanyPage } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { useDebounced } from "@/lib/use-debounced"
import { fmtDate, initials } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CompanyListRow, LatestStatus } from "@/api/types"

const latestStatusOptions = [
  { value: "signal", label: "Signal" },
  { value: "no_signal", label: "No signal" },
  { value: "failed", label: "Failed" },
  { value: "none", label: "Not researched" },
]

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
function CycleDots({ cycles }: { cycles: CompanyListRow["cycles"] }) {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {cycles.map((c) => (
        <span key={c.runId} className={cn("size-2 rounded-full", c.status === "signal" ? "bg-brand" : c.status === "failed" ? "bg-destructive/60" : "bg-border")} />
      ))}
    </span>
  )
}

export function CompaniesList() {
  const { user } = useSession()
  const navigate = useNavigate()
  const isPam = user!.role === "pam"
  const manage = can.manageData(user!.role)
  const [params, setParams] = useSearchParams()
  const openId = params.get("company")

  // All of this is sent to the server; the browser only ever holds one page.
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 })
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [search, setSearch] = useState("")
  const [regions, setRegions] = useState<string[]>([])
  const [segments, setSegments] = useState<string[]>([])
  // Arriving from the PAMs table (?pam=ID) pre-filters to that PAM's logos.
  const [pamIds, setPamIds] = useState<string[]>(() => (params.get("pam") ? [params.get("pam")!] : []))
  const [latest, setLatest] = useState<string[]>([])
  const [reassignIds, setReassignIds] = useState<string[]>([])
  const debouncedSearch = useDebounced(search, 250)

  const resetPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }))
  const openDrawer = (id: string) => setParams((p) => (p.set("company", id), p))
  const closeDrawer = () => setParams((p) => (p.delete("company"), p))

  const query = useCompanyPage({
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
    search: debouncedSearch,
    regions,
    segments,
    pamIds,
    latest: latest as LatestStatus[],
    sort: sorting[0],
    scopePamId: isPam ? user!.pamId : undefined,
  })
  const page = query.data

  const columns = useMemo<ColumnDef<CompanyListRow>[]>(() => {
    const cols: ColumnDef<CompanyListRow>[] = []
    if (manage)
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
    cols.push(
      {
        id: "name",
        accessorKey: "name",
        meta: { label: "Company" },
        enableHiding: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Company" />,
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-medium text-muted-foreground">{initials(row.original.name)}</span>
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
        id: "region",
        accessorKey: "region",
        meta: { label: "Region" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Region" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.region} <span className="text-muted-foreground/60">·</span> {row.original.segment}
          </span>
        ),
      },
    )
    if (!isPam)
      cols.push({
        id: "pam",
        accessorKey: "pamName",
        meta: { label: "PAM" },
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
    cols.push(
      {
        id: "latestStatus",
        accessorKey: "latestStatus",
        meta: { label: "Latest cycle" },
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
        id: "signals",
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
        id: "lastSignal",
        accessorKey: "lastSignal",
        meta: { label: "Last signal" },
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
    data: page?.rows ?? [],
    columns,
    getRowId: (r) => r.id,
    state: { sorting, pagination, columnVisibility, rowSelection },
    // Server mode: TanStack only renders; the server sorts, filters and pages.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: page?.total ?? 0,
    enableRowSelection: manage,
    enableSortingRemoval: false,
    onSortingChange: (u) => {
      setSorting(u)
      resetPage()
    },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  })

  const selectedIds = Object.keys(rowSelection)
  const filtered = regions.length + segments.length + pamIds.length + latest.length > 0 || search !== ""
  const setFilter = (fn: (v: string[]) => void) => (v: string[]) => {
    fn(v)
    resetPage()
  }

  return (
    <div>
      <PageHeader
        title={isPam ? "My companies" : "Companies"}
        description="Every logo being tracked, its PAM and its signal history. Select a company to see its full timeline."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search companies"
            placeholder="Search company or PAM"
            className="h-9 pl-9 pr-8"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              resetPage()
            }}
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DataTableFacetedFilter title="Region" value={regions} onChange={setFilter(setRegions)} counts={page?.facets.region} options={["North", "South", "East", "West"].map((v) => ({ value: v, label: v }))} />
          <DataTableFacetedFilter title="Segment" value={segments} onChange={setFilter(setSegments)} counts={page?.facets.segment} options={["Enterprise", "Mid-market", "Emerging"].map((v) => ({ value: v, label: v }))} />
          {!isPam && <PamMultiFilter value={pamIds} onChange={setFilter(setPamIds)} />}
          <DataTableFacetedFilter title="Latest cycle" value={latest} onChange={setFilter(setLatest)} counts={page?.facets.latest} options={latestStatusOptions} />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-muted-foreground"
              onClick={() => {
                setRegions([])
                setSegments([])
                setPamIds([])
                setLatest([])
                setSearch("")
                resetPage()
              }}
            >
              Reset <X />
            </Button>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {page && <DataTableCompactPager table={table} totalRows={page.total} />}
          <DataTableViewOptions table={table} />
          <Button variant="outline" className="h-9" onClick={() => toast.success(`Export of ${(page?.total ?? 0).toLocaleString("en-IN")} companies started`, { description: "Large exports are generated on the server and emailed as a link." })}>
            <Download /> Export
          </Button>
          {manage && (
            <Button variant="outline" className="h-9" asChild>
              <Link to="/imports">
                <Upload /> Import
              </Link>
            </Button>
          )}
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-blue/30 bg-brand-blue/[0.06] px-4 py-2.5 text-sm">
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
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setRowSelection({})}>
            Clear selection
          </Button>
        </div>
      )}

      {!page ? (
        <Skeleton className="h-[40rem]" />
      ) : (
        <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")} aria-busy={query.isFetching}>
          <DataTable
            table={table}
            stickyHeader
            onRowClick={(r) => openDrawer(r.id)}
            activeRowId={openId ?? undefined}
            empty={
              <EmptyState icon={Building2} title="No companies match">
                Try a different search or clear the filters.
              </EmptyState>
            }
          />
          <DataTablePagination table={table} totalRows={page.total} pageSizes={[20, 50, 100]} />
            <p className="flex items-center gap-1 px-1 pt-1 text-xs text-muted-foreground" title="Server query time for this page">
              <Gauge className="size-3.5" /> Loaded in {page.tookMs} ms
            </p>
        </div>
      )}

      <CompanyDrawer companyId={openId} onOpenChange={(o) => !o && closeDrawer()} onReassign={(id) => setReassignIds([id])} />
      <ReassignDialog companyIds={reassignIds} open={reassignIds.length > 0} onOpenChange={(o) => !o && setReassignIds([])} onDone={() => setRowSelection({})} />
    </div>
  )
}

/** Old deep links (/companies/:id) now open the drawer on the list. */
export function CompanyDetail() {
  const { id = "" } = useParams()
  return <Navigate to={`/companies?company=${encodeURIComponent(id)}`} replace />
}
