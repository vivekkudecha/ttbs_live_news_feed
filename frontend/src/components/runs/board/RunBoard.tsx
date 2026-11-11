/**
 * Results board: a run's Results, PAMs, Digests and logo timelines in one table.
 *
 * - Group by PAM (default): one row per PAM (outcome bar, signals, digest delivery, failures);
 *   expand a PAM to see its logos as sub-rows (loaded on demand, 25 at a time).
 * - All logos: the same filters over a flat, paged list of logos.
 * - Top bar: search (company or PAM), status tabs with live counts, PAM / category / digest
 *   filters with counts, active-filter chips. Every column header sorts and filters too.
 * - Row actions (menu), bulk actions on selected rows (retry failed, resend digests, reassign,
 *   export), click a logo for its timeline, preview any PAM's digest.
 *
 * Sorting, filtering and paging run on the server (services/run_board.py); state lives in the URL.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query"
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type ExpandedState,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Updater,
  type VisibilityState,
} from "@tanstack/react-table"
import {
  AlertTriangle,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Layers,
  List,
  Loader2,
  RotateCcw,
  Rows3,
  Rows4,
  Search,
  Send,
  UserRoundCog,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { EmptyState } from "@/components/common/EmptyState"
import { DataTableFacetedFilter } from "@/components/data-table/DataTableFacetedFilter"
import { DataTablePagination } from "@/components/data-table/DataTablePagination"
import { DataTableViewOptions } from "@/components/data-table/DataTableViewOptions"
import { describeFilter, type FilterValue } from "@/components/data-table/table-meta"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useBoardResend, useBoardRetry } from "@/api/hooks"
import { backend, errorMessage } from "@/api/http"
import { useSession } from "@/context/session"
import { can } from "@/lib/access"
import { useDebounced } from "@/lib/use-debounced"
import { cn } from "@/lib/utils"
import type { BoardLogo, Page } from "@/api/types"
import { DIGEST_STATUS, GROUP_SORT, LOGO_SORT, RESULT_STATUS, categoryLabel, download, n, pamKey, toCsv } from "./board-utils"
import { boardColumns, type BoardCtx, type BoardRow, type PamRow } from "./columns"
import { DigestPreviewDialog } from "./DigestPreviewDialog"
import { useLogoDrawer } from "@/components/logo/logo-drawer-context"
import { useBoardUrl } from "./useBoardUrl"

const SUB_PAGE = 25
const STATUS_TABS: [string, string][] = [
  ["all", "All"],
  ["signal", "Signals"],
  ["no_signal", "No signal"],
  ["failed", "Failed"],
  ["pending", "In progress"],
]
/** Filters that are not table columns (top-bar only). */
const TOPBAR_ONLY = new Set(["pam"])

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* preference just doesn't persist */
  }
}

export function RunBoard({
  runId,
  live,
  onReassign,
}: {
  runId: string
  live: boolean
  onReassign: (companyIds: string[]) => void
}) {
  const drawer = useLogoDrawer()
  const url = useBoardUrl()
  const { user } = useSession()
  const canManage = can(user, "runs", "manage")
  const grouped = url.view === "pam"
  const size = url.size || (grouped ? 20 : 50)
  const poll: number | false = live ? 4_000 : false

  // ---- search (debounced into the URL) --------------------------------------------------------
  const [search, setSearch] = useState(url.q)
  const q = useDebounced(search, 300)
  useEffect(() => {
    if (q !== url.q) url.setQ(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  // ---- server data ---------------------------------------------------------------------------------
  const filterStr = Object.keys(url.filters).length ? JSON.stringify(url.filters) : undefined
  const groupSort = url.sort && GROUP_SORT.has(url.sort.id) ? url.sort : null
  const logoSort = url.sort && LOGO_SORT.has(url.sort.id) ? url.sort : null
  const base = { q: url.q || undefined, filter: filterStr }

  const facets = useQuery({
    queryKey: ["board", runId, "facets", base],
    queryFn: () => backend.boardFacets(runId, base),
    placeholderData: keepPreviousData,
    refetchInterval: poll,
  })
  const groups = useQuery({
    queryKey: ["board", runId, "groups", base, groupSort, url.page, size],
    queryFn: () => backend.boardGroups(runId, { ...base, page: url.page, pageSize: size, sort: groupSort?.id, desc: groupSort?.desc }),
    placeholderData: keepPreviousData,
    enabled: grouped,
    refetchInterval: poll,
  })
  const flat = useQuery({
    queryKey: ["board", runId, "logos", base, logoSort, url.page, size],
    queryFn: () => backend.boardLogos(runId, { ...base, page: url.page, pageSize: size, sort: logoSort?.id, desc: logoSort?.desc }),
    placeholderData: keepPreviousData,
    enabled: !grouped,
    refetchInterval: poll,
  })

  // Expanded PAMs: key → how many logos to show. Remembered per run while the page is open.
  const [expanded, setExpanded] = useState<Record<string, number>>({})
  const groupRows = useMemo(() => groups.data?.rows ?? [], [groups.data])
  const visibleKeys = useMemo(() => new Set(groupRows.map(pamKey)), [groupRows])
  const openKeys = Object.keys(expanded).filter((k) => visibleKeys.has(k))
  const subs = useQueries({
    queries: grouped
      ? openKeys.map((k) => ({
          queryKey: ["board", runId, "logos", base, logoSort, "pam", k, expanded[k]],
          queryFn: () => backend.boardLogos(runId, { ...base, pamId: k, page: 0, pageSize: expanded[k], sort: logoSort?.id, desc: logoSort?.desc }),
          placeholderData: keepPreviousData,
          refetchInterval: poll,
        }))
      : [],
  })
  const subByKey = new Map<string, Page<BoardLogo> | undefined>(openKeys.map((k, i) => [k, subs[i]?.data]))

  // One PAM in view (filtered / searched to it): open it.
  useEffect(() => {
    if (grouped && groupRows.length === 1) {
      const k = pamKey(groupRows[0])
      setExpanded((e) => (e[k] ? e : { ...e, [k]: SUB_PAGE }))
    }
  }, [grouped, groupRows])

  const data: BoardRow[] = useMemo(() => {
    if (!grouped) return flat.data?.rows ?? []
    return groupRows.map((g): PamRow => {
      const k = pamKey(g)
      if (!expanded[k]) return g
      const page = subByKey.get(k)
      if (!page) return { ...g, subRows: [{ kind: "loading", id: `loading-${k}` }] }
      const more = page.total > page.rows.length ? [{ kind: "more" as const, id: `more-${k}`, pamKey: k, shown: page.rows.length, total: page.total }] : []
      return { ...g, subRows: [...page.rows, ...more] }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, flat.data, groupRows, expanded, ...subs.map((s) => s.data)])

  // ---- selection ------------------------------------------------------------------------------------
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const viewKey = JSON.stringify([url.view, base, url.sort, url.page, size])
  useEffect(() => setRowSelection({}), [viewKey])
  const byId = useMemo(() => {
    const m = new Map<string, BoardRow>()
    const walk = (rows: BoardRow[]) =>
      rows.forEach((r) => {
        m.set(r.id, r)
        if (r.kind === "pam" && r.subRows) walk(r.subRows)
      })
    walk(data)
    return m
  }, [data])
  const selected = Object.keys(rowSelection)
    .filter((id) => rowSelection[id])
    .map((id) => byId.get(id))
    .filter(Boolean) as BoardRow[]
  const selPams = selected.filter((r): r is PamRow => r.kind === "pam")
  const selLogos = selected.filter((r): r is BoardLogo => r.kind === "logo")

  // ---- actions ---------------------------------------------------------------------------------------
  const retry = useBoardRetry(runId)
  const resend = useBoardResend(runId)
  const [confirmResend, setConfirmResend] = useState<{ pamIds: string[]; names: string[] } | null>(null)
  const doRetry = useCallback(
    (b: { resultIds?: string[]; pamIds?: string[] }) =>
      retry.mutate(b, {
        onSuccess: (r) => {
          if (r.requeued) toast.success(`Re-queued ${n(r.requeued)} failed ${r.requeued === 1 ? "logo" : "logos"}`, { description: "Their PAMs' digests update when they finish." })
          else toast.info("Nothing to retry", { description: "None of the selected logos failed." })
          setRowSelection({})
        },
        onError: (e) => toast.error("Could not retry", { description: errorMessage(e) }),
      }),
    [retry],
  )
  const doResend = (pamIds: string[]) =>
    resend.mutate(
      { pamIds },
      {
        onSuccess: (r) => {
          toast.success(`Re-queued ${n(r.requeued)} ${r.requeued === 1 ? "digest" : "digests"}`, {
            description: `Rebuilt from the current results.${r.skipped ? ` ${n(r.skipped)} skipped (already queued or no recipient).` : ""}`,
          })
          setConfirmResend(null)
          setRowSelection({})
        },
        onError: (e) => toast.error("Could not resend", { description: errorMessage(e) }),
      },
    )

  const [exporting, setExporting] = useState(false)
  const exportAll = async () => {
    setExporting(true)
    try {
      const rows: BoardLogo[] = []
      for (let page = 0; page < 25; page++) {
        const p = await backend.boardLogos(runId, { ...base, page, pageSize: 200, sort: logoSort?.id, desc: logoSort?.desc })
        rows.push(...p.rows)
        if (rows.length >= p.total || p.rows.length === 0) break
      }
      download(`run-${runId}-results.csv`, toCsv(rows))
      toast.success(`Exported ${n(rows.length)} logos`)
    } catch (e) {
      toast.error("Export failed", { description: errorMessage(e) })
    } finally {
      setExporting(false)
    }
  }

  // ---- timeline / digest navigation -----------------------------------------------------------------
  // The logo drawer steps through the logos in table order.
  const logoOrder = useMemo(() => [...byId.values()].filter((r): r is BoardLogo => r.kind === "logo").map((r) => ({ companyId: r.companyId, runId })), [byId, runId])
  const openLogo = (r: BoardLogo) => drawer.open({ companyId: r.companyId, runId, siblings: logoOrder })
  const activeLogo = drawer.current?.runId === runId ? drawer.current.companyId : null
  const digestPamName = useMemo(() => {
    if (!url.digest) return undefined
    for (const r of byId.values()) if ((r.kind === "pam" || r.kind === "logo") && r.pamId === url.digest) return r.pamName ?? undefined
    return facets.data?.pams.find((p) => p.value === url.digest)?.label
  }, [url.digest, byId, facets.data])

  // ---- table ------------------------------------------------------------------------------------------
  const toggle = useCallback((k: string) => setExpanded((e) => (e[k] ? Object.fromEntries(Object.entries(e).filter(([x]) => x !== k)) : { ...e, [k]: SUB_PAGE })), [])
  const ctxRef = useRef<BoardCtx>(null as unknown as BoardCtx)
  ctxRef.current = {
    view: url.view,
    canManage,
    facets: facets.data,
    isOpen: (k) => !!expanded[k],
    toggle,
    openLogo,
    openDigest: url.openDigest,
    retry: doRetry,
    resend: (pamIds, names) => setConfirmResend({ pamIds, names }),
    reassign: onReassign,
    onlyPam: (k) => url.setFilters({ ...url.filters, pam: [k] }),
  }
  // Columns read the context through a stable proxy, so they are rebuilt only when their shape changes.
  const ctx = useMemo(
    () => new Proxy({} as BoardCtx, { get: (_t, p) => ctxRef.current[p as keyof BoardCtx] }),
    [],
  )
  const catKey = (facets.data?.categories ?? []).map((c) => c.value).join("|")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => boardColumns(ctx), [url.view, catKey])

  const [columnVisibility, setVis] = useState<VisibilityState>(() => stored("ttbs.table.board.v2.cols", { finishedAt: false, attempts: false }))
  const [density, setDensityState] = useState<"comfortable" | "compact">(() => stored("ttbs.table.board.density", "comfortable"))
  const setDensity = (d: "comfortable" | "compact") => {
    setDensityState(d)
    store("ttbs.table.board.density", d)
  }

  const sorting: SortingState = url.sort ? [url.sort] : []
  const columnFilters: ColumnFiltersState = Object.entries(url.filters)
    .filter(([k]) => !TOPBAR_ONLY.has(k))
    .map(([id, value]) => ({ id, value }))
  const pagination: PaginationState = { pageIndex: url.page, pageSize: size }
  const total = (grouped ? groups.data?.total : flat.data?.total) ?? 0
  const expandedState: ExpandedState = Object.fromEntries(openKeys.map((k) => [`pam-${k}`, true]))

  const table = useReactTable<BoardRow>({
    data,
    columns,
    getRowId: (r) => r.id,
    getSubRows: (r) => (r.kind === "pam" ? r.subRows : undefined),
    state: { sorting, columnFilters, pagination, rowSelection, columnVisibility, expanded: expandedState },
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    rowCount: total,
    enableSortingRemoval: true,
    enableRowSelection: (row) => row.original.kind === "pam" || row.original.kind === "logo",
    enableSubRowSelection: true,
    onSortingChange: (u: Updater<SortingState>) => {
      const next = (typeof u === "function" ? u(sorting) : u)[0]
      url.setSort(next ? { id: next.id, desc: next.desc } : null)
    },
    onColumnFiltersChange: (u: Updater<ColumnFiltersState>) => {
      const next = typeof u === "function" ? u(columnFilters) : u
      const keep = Object.fromEntries(Object.entries(url.filters).filter(([k]) => TOPBAR_ONLY.has(k)))
      url.setFilters({ ...keep, ...Object.fromEntries(next.map((f) => [f.id, f.value as FilterValue])) })
    },
    onPaginationChange: (u: Updater<PaginationState>) => {
      const next = typeof u === "function" ? u(pagination) : u
      if (next.pageSize !== size) url.setSize(next.pageSize)
      else url.setPage(next.pageIndex)
    },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: (u) =>
      setVis((old) => {
        const next = typeof u === "function" ? u(old) : u
        store("ttbs.table.board.v2.cols", next)
        return next
      }),
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })

  const active = grouped ? groups : flat
  const loading = active.isLoading
  const stale = active.isPlaceholderData
  const fa = facets.data
  const statusVal = (() => {
    const s = url.filters.status
    if (!s || (Array.isArray(s) && !s.length)) return "all"
    return Array.isArray(s) && s.length === 1 ? s[0] : "custom"
  })()
  const filterEntries = Object.entries(url.filters)
  const allOpen = groupRows.length > 0 && groupRows.every((g) => expanded[pamKey(g)])

  return (
    <div className="min-w-0 space-y-3">
      {/* One toolbar row: search · status · filters · (right) view controls. The search gives up width first
          (it breaks lines at 8rem, then grows into the free space), so the row wraps only on narrow screens. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto sm:min-w-32 sm:max-w-80 sm:flex-[1_1_8rem]">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search logos or PAMs" placeholder="Search logos or PAMs…" className="pl-8 pr-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Tabs value={statusVal} onValueChange={(v) => url.setFilter("status", v === "all" ? undefined : [v])}>
          <TabsList className="h-auto flex-wrap lg:flex-nowrap">
            {STATUS_TABS.map(([v, label]) => {
              const count = !fa ? null : v === "all" ? fa.all : (fa.status[v as keyof typeof fa.status] ?? 0)
              return (
                <TabsTrigger key={v} value={v} className="gap-1.5">
                  {label}
                  <span className={cn("tabular rounded-full bg-muted px-1.5 text-xs text-muted-foreground", v === "failed" && count ? "bg-destructive/10 text-destructive" : "")}>
                    {count == null ? "·" : n(count)}
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        <DataTableFacetedFilter
          title="PAM"
          options={(fa?.pams ?? []).map((p) => ({ value: p.value, label: p.label ?? p.value }))}
          counts={Object.fromEntries((fa?.pams ?? []).map((p) => [p.value, p.count]))}
          value={(url.filters.pam as string[] | undefined) ?? []}
          onChange={(v) => url.setFilter("pam", v)}
        />
        <DataTableFacetedFilter
          title="Category"
          options={(fa?.categories ?? []).map((c) => ({ value: c.value, label: categoryLabel(c.value) }))}
          counts={Object.fromEntries((fa?.categories ?? []).map((c) => [c.value, c.count]))}
          value={(url.filters.category as string[] | undefined) ?? []}
          onChange={(v) => url.setFilter("category", v)}
        />
        <DataTableFacetedFilter
          title="Digest"
          options={DIGEST_STATUS}
          counts={Object.fromEntries((fa?.digest ?? []).map((c) => [c.value, c.count]))}
          value={(url.filters.digest as string[] | undefined) ?? []}
          onChange={(v) => url.setFilter("digest", v)}
        />
        {facets.isFetching && !facets.isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Updating counts" />}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Tabs value={url.view} onValueChange={(v) => url.setView(v as "pam" | "logo")}>
            <TabsList>
              <TabsTrigger value="pam" className="gap-1.5" aria-label="Group by PAM" title="Group by PAM">
                <Layers className="size-3.5" /> <span className="hidden 2xl:inline">By PAM</span>
              </TabsTrigger>
              <TabsTrigger value="logo" className="gap-1.5" aria-label="All logos" title="All logos">
                <List className="size-3.5" /> <span className="hidden 2xl:inline">All logos</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {grouped && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={!groupRows.length}
                  aria-label={allOpen ? "Collapse all PAMs" : "Expand all PAMs on this page"}
                  onClick={() => setExpanded(allOpen ? {} : Object.fromEntries(groupRows.map((g) => [pamKey(g), expanded[pamKey(g)] ?? SUB_PAGE])))}
                >
                  {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{allOpen ? "Collapse all" : "Expand all on this page"}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" disabled={exporting || !total} onClick={exportAll} aria-label="Export matching logos as CSV">
                {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export every matching logo (CSV)</TooltipContent>
          </Tooltip>
          <DataTableViewOptions table={table} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label={density === "compact" ? "Comfortable rows" : "Compact rows"}
                onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
              >
                {density === "compact" ? <Rows3 /> : <Rows4 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{density === "compact" ? "Comfortable rows" : "Compact rows"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Active filters */}
      {(filterEntries.length > 0 || url.q) && (
        <div className="flex flex-wrap items-center gap-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          {url.q && <Chip label="Search" value={`“${url.q}”`} onRemove={() => setSearch("")} />}
          {filterEntries.map(([id, v]) => (
            <Chip key={id} label={chipLabel(id, table)} value={chipValue(id, v, fa)} onRemove={() => url.setFilter(id, undefined)} />
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setSearch("")
              url.setFilters({})
            }}
          >
            Clear all
          </Button>
        </div>
      )}

      {/* Table */}
      {active.isError ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" /> {errorMessage(active.error)}
        </div>
      ) : loading ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12" style={{ opacity: 1 - i * 0.13 }} />
          ))}
        </div>
      ) : (
        <div className={cn("transition-opacity duration-200", stale && "opacity-60")}>
          <BoardTable
            table={table}
            density={density}
            dataKey={viewKey}
            onRowClick={(r) => (r.kind === "pam" ? toggle(pamKey(r)) : r.kind === "logo" ? openLogo(r) : undefined)}
            onMore={(k, shown) => setExpanded((e) => ({ ...e, [k]: shown + SUB_PAGE }))}
            activeId={activeLogo}
            empty={
              <EmptyState icon={Search} title="Nothing matches">
                {filterEntries.length || url.q ? "Try another tab, or clear a filter." : "This run has no logos yet."}
              </EmptyState>
            }
          />
          {total > 0 && <DataTablePagination table={table} totalRows={total} pageSizes={grouped ? [10, 20, 50] : [25, 50, 100]} />}
        </div>
      )}

      {/* Bulk actions */}
      {selected.length > 0 && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl bg-foreground px-3 py-2 text-background shadow-2xl animate-in fade-in-0 slide-in-from-bottom-4 duration-300">
          <span className="px-2 text-sm font-medium">
            {[selPams.length && `${n(selPams.length)} ${selPams.length === 1 ? "PAM" : "PAMs"}`, selLogos.length && `${n(selLogos.length)} ${selLogos.length === 1 ? "logo" : "logos"}`]
              .filter(Boolean)
              .join(" · ")}{" "}
            selected
          </span>
          {canManage && (
            <BulkButton
              icon={RotateCcw}
              label="Retry failed"
              disabled={retry.isPending || !(selLogos.some((r) => r.status === "failed") || selPams.some((g) => g.failed > 0))}
              onClick={() => doRetry({ resultIds: selLogos.filter((r) => r.status === "failed").map((r) => r.id), pamIds: selPams.filter((g) => g.failed > 0).map(pamKey) })}
            />
          )}
          {canManage && (
            <BulkButton
              icon={Send}
              label="Resend digests"
              onClick={() => {
                const ids = new Map<string, string>()
                selPams.forEach((g) => g.pamId && ids.set(g.pamId, g.pamName))
                selLogos.forEach((r) => r.pamId && ids.set(r.pamId, r.pamName ?? r.pamId))
                if (!ids.size) return toast.info("No PAM in the selection")
                setConfirmResend({ pamIds: [...ids.keys()], names: [...ids.values()] })
              }}
            />
          )}
          {canManage && selLogos.length > 0 && <BulkButton icon={UserRoundCog} label="Reassign PAM" onClick={() => onReassign([...new Set(selLogos.map((r) => r.companyId))])} />}
          {selLogos.length > 0 && <BulkButton icon={Download} label="Export" onClick={() => download(`run-${runId}-selected.csv`, toCsv(selLogos))} />}
          <Button variant="ghost" size="icon" className="size-8 rounded-full text-background hover:bg-background/15 hover:text-background" aria-label="Clear selection" onClick={() => setRowSelection({})}>
            <X />
          </Button>
        </div>
      )}

      <DigestPreviewDialog
        runId={runId}
        pamId={url.digest}
        pamName={digestPamName}
        canManage={canManage}
        onClose={() => url.openDigest(null)}
        onResend={(pid) => setConfirmResend({ pamIds: [pid], names: [digestPamName ?? "this PAM"] })}
      />
      <Dialog open={!!confirmResend} onOpenChange={(o) => !o && setConfirmResend(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resend {confirmResend?.pamIds.length === 1 ? "digest" : `${confirmResend?.pamIds.length} digests`}?</DialogTitle>
            <DialogDescription>
              {confirmResend && confirmResend.names.length <= 3 ? confirmResend.names.join(", ") : `${confirmResend?.names.slice(0, 3).join(", ")} and ${(confirmResend?.names.length ?? 0) - 3} more`}{" "}
              will get the digest again on every channel, rebuilt from this run's current results.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmResend(null)}>
              Cancel
            </Button>
            <Button disabled={resend.isPending} onClick={() => confirmResend && doResend(confirmResend.pamIds)}>
              {resend.isPending ? <Loader2 className="animate-spin" /> : <Send />} Resend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------

function Chip({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.06] py-0.5 pl-2.5 pr-1 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-60 truncate font-medium">{value}</span>
      <button
        type="button"
        aria-label={`Remove filter ${label}`}
        className="grid size-5 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function chipLabel(id: string, table: ReturnType<typeof useReactTable<BoardRow>>) {
  if (id === "pam") return "PAM"
  const col = table.getAllLeafColumns().find((c) => c.id === id)
  return col?.columnDef.meta?.label ?? id
}

function chipValue(id: string, v: FilterValue, fa: { pams: { value: string; label?: string }[] } | undefined): string {
  if (id === "pam" && Array.isArray(v)) return v.map((x) => fa?.pams.find((p) => p.value === x)?.label ?? x).join(", ")
  if (id === "status") return describeFilter({ type: "enum", options: RESULT_STATUS }, v)
  if (id === "digest") return describeFilter({ type: "enum", options: DIGEST_STATUS }, v)
  if (id === "category" && Array.isArray(v)) return v.map(categoryLabel).join(", ")
  return describeFilter(undefined, v)
}

function BulkButton({ icon: Icon, label, onClick, disabled }: { icon: typeof Send; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onClick} className="h-8 rounded-full text-background hover:bg-background/15 hover:text-background disabled:opacity-40">
      <Icon /> {label}
    </Button>
  )
}

/** Table markup with PAM group rows, indented logo sub-rows and "show more" rows; one page scroll, sticky header. */
function BoardTable({
  table,
  density,
  dataKey,
  onRowClick,
  onMore,
  activeId,
  empty,
}: {
  table: ReturnType<typeof useReactTable<BoardRow>>
  density: "comfortable" | "compact"
  dataKey: string
  onRowClick: (r: BoardRow) => void
  onMore: (pamKey: string, shown: number) => void
  activeId: string | null
  empty: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const t = el.querySelector("table")
      setFits(window.innerWidth >= 1024 && !!t && t.scrollWidth <= el.clientWidth + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const t = el.querySelector("table")
    if (t) ro.observe(t)
    return () => ro.disconnect()
  }, [])
  const rows = table.getRowModel().rows
  const span = table.getVisibleLeafColumns().length
  return (
    <div ref={box} className={cn("rounded-xl border bg-card shadow-xs", fits ? "overflow-x-clip" : "overflow-x-auto")}>
      {/* Laptop and up: fixed column proportions and wrapping text, so the table always fits its box
          (no sideways scroll). Phones keep a minimum width and scroll inside the box. */}
      <Table
        className="min-w-[60rem] text-sm lg:min-w-0 lg:table-fixed [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal"
        containerClassName="overflow-visible"
      >
        <TableHeader
          className={cn(
            "[&_th]:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))] [&_tr]:border-b-0 [&_th]:shadow-[inset_0_-1px_0_var(--border)]",
            fits && "sticky top-16 z-20",
          )}
        >
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((h) => (
                <TableHead
                  key={h.id}
                  style={{ width: h.column.columnDef.meta?.width }}
                  className={cn(
                    "group/th h-11 py-1.5 text-xs font-medium text-muted-foreground first:rounded-tl-xl first:pl-3 last:rounded-tr-xl last:pr-3",
                    h.column.columnDef.meta?.align === "right" && "text-right",
                  )}
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody key={dataKey} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={span} className="h-48 text-center">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const r = row.original
              if (r.kind === "loading")
                return (
                  <TableRow key={row.id} className="hover:bg-transparent">
                    <TableCell colSpan={span} className="py-3 pl-16">
                      <div className="space-y-2">
                        <Skeleton className="h-8 w-2/3" />
                        <Skeleton className="h-8 w-1/2 opacity-70" />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              if (r.kind === "more")
                return (
                  <TableRow key={row.id} className="hover:bg-transparent">
                    <TableCell colSpan={span} className="py-2 pl-14">
                      <Button variant="ghost" size="sm" className="h-8 text-primary" onClick={() => onMore(r.pamKey, r.shown)}>
                        <ChevronsUpDown /> Show {Math.min(SUB_PAGE, r.total - r.shown)} more · {n(r.total - r.shown)} left
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              const isPam = r.kind === "pam"
              const sub = row.depth > 0
              return (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  aria-current={r.kind === "logo" && activeId === r.companyId ? "true" : undefined}
                  aria-expanded={isPam ? row.getIsExpanded() : undefined}
                  tabIndex={0}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button,a,[role=checkbox],[role=menuitem]")) return
                    onRowClick(r)
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === "Enter") onRowClick(r)
                    if (e.key === " ") {
                      e.preventDefault()
                      row.toggleSelected()
                    }
                  }}
                  className={cn(
                    "group/row cursor-pointer outline-none transition-colors duration-150 focus-visible:bg-muted/60 has-[[data-state=open]]:bg-muted/50",
                    density === "compact" ? "h-11" : isPam ? "h-16" : "h-14",
                    isPam && "bg-muted/25 font-normal",
                    isPam && row.getIsExpanded() && "border-b-0 bg-muted/40",
                    sub && "animate-in fade-in-0 slide-in-from-top-1 duration-200 bg-card",
                    r.kind === "logo" && activeId === r.companyId && "bg-accent/60",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn("align-middle first:pl-3 last:pr-3", density === "compact" && "py-1.5", cell.column.columnDef.meta?.align === "right" && "text-right")}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}

