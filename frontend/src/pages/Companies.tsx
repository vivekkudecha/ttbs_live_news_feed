import { useEffect, useMemo, useRef, useState } from "react"
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom"
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
import { AlertTriangle, Building2, CircleDashed, CircleOff, Copy, Download,  Upload, MoreHorizontal, PanelRightOpen, Search, Sparkles, Trash2, UserRound, X } from "lucide-react"
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
import { useLogoDrawer } from "@/components/logo/logo-drawer-context"
import { ReassignDialog } from "@/components/companies/ReassignDialog"
import { PamMultiFilter } from "@/components/pickers/Pickers"
import { Badge } from "@/components/ui/badge"
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
import { useCountUp } from "@/lib/use-count-up"
import { useDebounced } from "@/lib/use-debounced"
import { fmtDate, initials } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CompanyListRow, LatestStatus } from "@/api/types"
import { Page } from "@/components/common/layout"

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

/** Stable colour per name, so a company or PAM keeps the same chip everywhere. */
const TONES = [
  "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
]
const tone = (name: string) => TONES[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % TONES.length]

const SEGMENT_TONE: Record<string, string> = {
  Enterprise: "border-sky-300/60 bg-sky-50 text-sky-700 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-300",
  "Mid-market": "border-violet-300/60 bg-violet-50 text-violet-700 dark:border-violet-400/30 dark:bg-violet-500/10 dark:text-violet-300",
  Emerging: "border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-300",
}

type CoverageKey = "signal" | "no_signal" | "none" | "failed"
const COVERAGE: { key: CoverageKey; label: string; icon: typeof Sparkles; bar: string; chip: string; ring: string }[] = [
  { key: "signal", label: "With a signal", icon: Sparkles, bar: "bg-brand", chip: "bg-brand/12 text-brand", ring: "ring-brand" },
  { key: "no_signal", label: "No signal", icon: CircleOff, bar: "bg-brand-blue/60", chip: "bg-brand-blue/10 text-brand-blue", ring: "ring-brand-blue" },
  { key: "none", label: "Not researched yet", icon: CircleDashed, bar: "bg-muted-foreground/25", chip: "bg-muted text-muted-foreground", ring: "ring-muted-foreground" },
  { key: "failed", label: "Research failed", icon: AlertTriangle, bar: "bg-destructive/70", chip: "bg-destructive/10 text-destructive", ring: "ring-destructive" },
]

function Count({ value }: { value: number }) {
  return <>{useCountUp(value).toLocaleString("en-IN")}</>
}

/**
 * Coverage tiles: how many logos (under the other filters) had a signal in their latest cycle,
 * none, failed, or were never researched. Click a tile to filter the table; click again to clear.
 */
function CoverageStrip({ counts, value, onChange }: { counts: Record<string, number>; value: string[]; onChange: (v: string[]) => void }) {
  const total = COVERAGE.reduce((a, c) => a + (counts[c.key] ?? 0), 0)
  const only = value.length === 1 ? value[0] : null
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.4fr_repeat(4,1fr)]">
      <button
        type="button"
        onClick={() => onChange([])}
        aria-pressed={value.length === 0}
        className={cn(
          "group relative overflow-hidden rounded-xl border bg-card p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:col-span-2 xl:col-span-1",
          value.length === 0 && "ring-2 ring-primary",
        )}
      >
        <span className="absolute inset-x-0 top-0 h-1 bg-brand-gradient" aria-hidden="true" />
        <span className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-gradient text-white shadow-sm shadow-brand/25">
            <Building2 className="size-4" />
          </span>
          Logos tracked
        </span>
        <span className="tabular mt-2 block text-3xl font-semibold tracking-tight">
          <Count value={total} />
        </span>
        {/* Distribution bar: one segment per status, widths animate when filters change. */}
        <span className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {COVERAGE.map((c) => (
            <span key={c.key} className={cn("h-full transition-all duration-500", c.bar)} style={{ width: `${total ? ((counts[c.key] ?? 0) / total) * 100 : 0}%` }} />
          ))}
        </span>
        <span className="mt-1.5 block text-xs text-muted-foreground">
          {total ? `${Math.round(((counts.signal ?? 0) / total) * 100)}% with a signal in the latest cycle` : "No logos match"}
        </span>
      </button>
      {COVERAGE.map((c) => {
        const v = counts[c.key] ?? 0
        const on = only === c.key
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange(on ? [] : [c.key])}
            aria-pressed={on}
            className={cn(
              "group rounded-xl border bg-card p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md",
              on && cn("ring-2", c.ring),
              v === 0 && !on && "opacity-70",
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className={cn("grid size-8 place-items-center rounded-lg", c.chip)}>
                <c.icon className="size-4" />
              </span>
              <span className="text-xs font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">{on ? "Clear" : "Filter"}</span>
            </span>
            <span className="tabular mt-3 block text-2xl font-semibold tracking-tight">
              <Count value={v} />
            </span>
            <span className="block text-xs text-muted-foreground">
              {c.label}
              {total > 0 && <span className="tabular"> · {Math.round((v / total) * 100)}%</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function CompaniesList() {
  const [params, setParams] = useSearchParams()
  const drawer = useLogoDrawer()
  const openId = drawer.current?.companyId ?? null

  // All of this is sent to the server; the browser only ever holds one page.
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 })
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [search, setSearch] = useState("")
  const [segments, setSegments] = useState<string[]>([])
  // Arriving from the PAMs table (?pam=ID) pre-filters to that PAM's logos.
  const [pamIds, setPamIds] = useState<string[]>(() => (params.get("pam") ? [params.get("pam")!] : []))
  const [latest, setLatest] = useState<string[]>([])
  const [reassignIds, setReassignIds] = useState<string[]>([])
  const debouncedSearch = useDebounced(search, 250)

  const resetPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }))
  // The app-wide logo drawer; it steps through this page's rows. Old links (?company=ID) still open it.
  const pageRowsRef = useRef<{ companyId: string }[]>([])
  const openDrawer = (id: string) => drawer.open({ companyId: id, siblings: pageRowsRef.current })
  const legacyId = params.get("company")
  useEffect(() => {
    if (!legacyId) return
    setParams((p) => (p.delete("company"), p.set("logo", legacyId), p), { replace: true })
  }, [legacyId, setParams])

  const query = useCompanyPage({
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
    search: debouncedSearch,
    segments,
    pamIds,
    latest: latest as LatestStatus[],
    sort: sorting[0],
  })
  const page = query.data
  pageRowsRef.current = (page?.rows ?? []).map((r) => ({ companyId: r.id }))

  const columns = useMemo<ColumnDef<CompanyListRow>[]>(() => {
    const cols: ColumnDef<CompanyListRow>[] = []
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
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold transition-transform duration-200 group-hover/row:scale-105",
                tone(row.original.name),
              )}
            >
              {initials(row.original.name)}
            </span>
            <div className="min-w-0">
              <button
                type="button"
                title={row.original.name}
                onClick={(e) => {
                  e.stopPropagation()
                  openDrawer(row.original.id)
                }}
                className="block max-w-[28rem] truncate text-left font-semibold text-foreground underline-offset-2 hover:text-brand-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {row.original.name}
              </button>
              <span className="block truncate text-xs text-muted-foreground">{row.original.industry || "Industry not set"}</span>
            </div>
          </div>
        ),
      },
      {
        id: "segment",
        accessorKey: "segment",
        meta: { label: "Segment" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Segment" />,
        cell: ({ row }) =>
          row.original.segment ? (
            <Badge variant="outline" className={cn("font-medium", SEGMENT_TONE[row.original.segment])}>
              {row.original.segment}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground/70">—</span>
          ),
      },
    )
      cols.push({
        id: "pam",
        accessorKey: "pamName",
        meta: { label: "PAM" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-2 ring-card", tone(row.original.pamName))}>
              {initials(row.original.pamName)}
            </span>
            <span className="truncate font-medium">{row.original.pamName}</span>
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
            <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
              <CircleDashed className="size-3" /> Not researched
            </span>
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
                <span
                  className={cn(
                    "tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                    row.original.signals > 0 ? "bg-brand/12 text-brand" : "bg-muted text-muted-foreground",
                  )}
                >
                  {row.original.signals}
                </span>
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
                  <DropdownMenuItem onClick={() => copy(c.name)}>
                    <Copy /> Copy company name
                  </DropdownMenuItem>
                  {(
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setReassignIds([c.id])}>
                        <UserRound /> Reassign PAM…
                      </DropdownMenuItem>
                    </>
                  )}
                  {(
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
  }, [])

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
    enableRowSelection: true,
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
  const filtered = segments.length + pamIds.length + latest.length > 0 || search !== ""
  const setFilter = (fn: (v: string[]) => void) => (v: string[]) => {
    fn(v)
    resetPage()
  }

  return (
    <Page>
      <PageHeader
        title="Companies"
        description="Every logo being tracked, its PAM and its signal history. Select a company to see its full timeline."
      />

      {page ? (
        <CoverageStrip counts={page.facets.latest} value={latest} onChange={setFilter(setLatest)} />
      ) : (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.4fr_repeat(4,1fr)]">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-[7.5rem] rounded-xl" />
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-xs">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search companies"
            placeholder="Search company or PAM"
            className="border-transparent bg-muted/60 pl-9 pr-8 focus-visible:bg-card"
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
          <DataTableFacetedFilter title="Segment" value={segments} onChange={setFilter(setSegments)} counts={page?.facets.segment} options={["Enterprise", "Mid-market", "Emerging"].map((v) => ({ value: v, label: v }))} />
          <PamMultiFilter value={pamIds} onChange={setFilter(setPamIds)} />
          <DataTableFacetedFilter title="Latest cycle" value={latest} onChange={setFilter(setLatest)} counts={page?.facets.latest} options={latestStatusOptions} />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
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
          <Button variant="outline" onClick={() => toast.success(`Export of ${(page?.total ?? 0).toLocaleString("en-IN")} companies started`, { description: "Large exports are generated on the server and emailed as a link." })}>
            <Download /> Export
          </Button>
          {(
            <Button variant="outline" asChild>
              <Link to="/imports">
                <Upload /> Import
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Floating action bar while rows are selected. */}
      {selectedIds.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selected companies"
          className="fixed inset-x-4 bottom-5 z-40 mx-auto flex max-w-fit flex-wrap items-center gap-1 rounded-2xl border border-white/10 bg-foreground p-1.5 pl-4 text-sm text-background shadow-2xl animate-in fade-in-0 slide-in-from-bottom-4 duration-300"
        >
          <span className="mr-2 flex items-center gap-2 font-medium">
            <span className="tabular grid h-6 min-w-6 place-items-center rounded-full bg-brand-gradient px-1.5 text-xs font-semibold text-white">{selectedIds.length}</span>
            selected
          </span>
          <Button variant="ghost" size="sm" className="text-background hover:bg-background/15 hover:text-background" onClick={() => setReassignIds(selectedIds)}>
            <UserRound /> Reassign PAM
          </Button>
          <Button variant="ghost" size="sm" className="text-background hover:bg-background/15 hover:text-background" onClick={() => toast.success(`Exported ${selectedIds.length} companies`)}>
            <Download /> Export
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" className="text-background/70 hover:bg-background/15 hover:text-background" onClick={() => setRowSelection({})}>
            <X />
          </Button>
        </div>
      )}

      {!page ? (
        <Skeleton className="h-[40rem]" />
      ) : (
        <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")} aria-busy={query.isFetching}>
          <DataTable
            dataKey={JSON.stringify([pagination, sorting])}
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
        </div>
      )}

      <ReassignDialog companyIds={reassignIds} open={reassignIds.length > 0} onOpenChange={(o) => !o && setReassignIds([])} onDone={() => setRowSelection({})} />
    </Page>
  )
}

/** Old deep links (/companies/:id) now open the drawer on the list. */
export function CompanyDetail() {
  const { id = "" } = useParams()
  return <Navigate to={`/companies?logo=${encodeURIComponent(id)}`} replace />
}
