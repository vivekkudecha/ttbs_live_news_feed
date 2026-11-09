/**
 * State + data for the shared SmartTable.
 *
 * - `useServerTable`: the server sorts, filters and pages. Sort, column filters and page live in
 *   the URL (`?<id>.sort=name.desc&<id>.filter={…}&<id>.page=2`), so a view can be shared and the
 *   Back button restores it. The previous page stays on screen while the next one loads, and the
 *   page after the current one is prefetched.
 * - `useClientTable`: same UI over a small, fully loaded array (sorted/filtered in the browser).
 *
 * Column visibility and row density are per-user conveniences kept in localStorage.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { keepPreviousData, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Table,
  type Updater,
  type VisibilityState,
} from "@tanstack/react-table"
import type { Page } from "@/api/types"
import { isEmptyFilter, smartFilter } from "./table-meta"

export type Density = "comfortable" | "compact"

export interface TableQuery {
  page: number
  pageSize: number
  sort?: string
  desc?: boolean
  /** JSON object column → value (backend/app/api/listing.py) */
  filter?: string
}

const resolve = <S,>(u: Updater<S>, old: S): S => (typeof u === "function" ? (u as (o: S) => S)(old) : u)

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage blocked: the preference just doesn't persist */
  }
}

/** Visibility + density, remembered per table. */
function usePrefs(id: string, defaultHidden: string[] = []) {
  const [columnVisibility, setVis] = useState<VisibilityState>(() =>
    stored(`ttbs.table.${id}.cols`, Object.fromEntries(defaultHidden.map((c) => [c, false]))),
  )
  const [density, setDensityState] = useState<Density>(() => stored(`ttbs.table.${id}.density`, "comfortable"))
  const onColumnVisibilityChange: OnChangeFn<VisibilityState> = (u) =>
    setVis((old) => {
      const next = resolve(u, old)
      store(`ttbs.table.${id}.cols`, next)
      return next
    })
  const setDensity = (d: Density) => {
    setDensityState(d)
    store(`ttbs.table.${id}.density`, d)
  }
  return { columnVisibility, onColumnVisibilityChange, density, setDensity }
}

export interface SmartTableState<T> {
  table: Table<T>
  total: number
  density: Density
  setDensity: (d: Density) => void
  /** Changes whenever a different set of rows is shown (drives the row fade-in). */
  dataKey: string
  loading: boolean
  fetching: boolean
  stale: boolean
  error: unknown
  resetFilters: () => void
}

// ---------------------------------------------------------------------------------------------

export function useServerTable<T, R extends Page<T> = Page<T>>({
  id,
  columns,
  queryKey,
  fetcher,
  defaultSort,
  pageSize: defaultPageSize = 20,
  defaultHidden,
  refetchInterval,
  enabled = true,
  getRowId,
  enableRowSelection = false,
}: {
  /** Unique per page (URL param prefix and stored preferences). */
  id: string
  columns: ColumnDef<T, unknown>[]
  queryKey: QueryKey
  fetcher: (q: TableQuery) => Promise<R>
  defaultSort?: { id: string; desc: boolean }
  pageSize?: number
  defaultHidden?: string[]
  refetchInterval?: number | false | ((data: R | undefined) => number | false)
  enabled?: boolean
  getRowId?: (row: T) => string
  enableRowSelection?: boolean
}): SmartTableState<T> & { data: R | undefined } {
  const [params, setParams] = useSearchParams()
  const p = (k: string) => params.get(`${id}.${k}`)

  const sorting: SortingState = useMemo(() => {
    const raw = p("sort")
    if (raw) {
      const [col, dir] = raw.split(".")
      return [{ id: col, desc: dir === "desc" }]
    }
    return defaultSort ? [defaultSort] : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, id])
  const columnFilters: ColumnFiltersState = useMemo(() => {
    try {
      const obj = JSON.parse(p("filter") ?? "{}") as Record<string, unknown>
      return Object.entries(obj).map(([k, value]) => ({ id: k, value }))
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, id])
  const pagination: PaginationState = {
    pageIndex: Math.max(0, Number(p("page") ?? 1) - 1) || 0,
    pageSize: Number(p("size") ?? defaultPageSize) || defaultPageSize,
  }

  const write = useCallback(
    (changes: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(changes)) {
            if (v === null || v === "") next.delete(`${id}.${k}`)
            else next.set(`${id}.${k}`, v)
          }
          return next
        },
        { replace: true },
      ),
    [id, setParams],
  )

  const onSortingChange: OnChangeFn<SortingState> = (u) => {
    const s = resolve(u, sorting)[0]
    const isDefault = !s || (defaultSort && s.id === defaultSort.id && s.desc === defaultSort.desc)
    write({ sort: isDefault ? null : `${s.id}.${s.desc ? "desc" : "asc"}`, page: null })
  }
  const onColumnFiltersChange: OnChangeFn<ColumnFiltersState> = (u) => {
    const next = resolve(u, columnFilters).filter((f) => !isEmptyFilter(f.value))
    write({ filter: next.length ? JSON.stringify(Object.fromEntries(next.map((f) => [f.id, f.value]))) : null, page: null })
  }
  const onPaginationChange: OnChangeFn<PaginationState> = (u) => {
    const n = resolve(u, pagination)
    write({ page: n.pageIndex ? String(n.pageIndex + 1) : null, size: n.pageSize !== defaultPageSize ? String(n.pageSize) : null })
  }

  const query: TableQuery = {
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
    sort: sorting[0]?.id,
    desc: sorting[0]?.desc,
    filter: columnFilters.length ? JSON.stringify(Object.fromEntries(columnFilters.map((f) => [f.id, f.value]))) : undefined,
  }
  const fullKey = [...queryKey, query]
  const result = useQuery({
    queryKey: fullKey,
    queryFn: () => fetcher(query),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: typeof refetchInterval === "function" ? (q) => refetchInterval(q.state.data as R | undefined) : refetchInterval,
  })
  const data = result.data
  const total = data?.total ?? 0

  // Prefetch the next page so "Next" feels instant.
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled || !data || (pagination.pageIndex + 1) * pagination.pageSize >= total) return
    const nextQ = { ...query, page: pagination.pageIndex + 1 }
    void qc.prefetchQuery({ queryKey: [...queryKey, nextQ], queryFn: () => fetcher(nextQ), staleTime: 15_000 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, enabled])

  const prefs = usePrefs(id, defaultHidden)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const table = useReactTable<T>({
    data: data?.rows ?? [],
    columns,
    getRowId,
    state: { sorting, columnFilters, pagination, columnVisibility: prefs.columnVisibility, rowSelection },
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: total,
    enableSortingRemoval: false,
    enableRowSelection,
    onSortingChange,
    onColumnFiltersChange,
    onPaginationChange,
    onColumnVisibilityChange: prefs.onColumnVisibilityChange,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  })

  return {
    table,
    data,
    total,
    density: prefs.density,
    setDensity: prefs.setDensity,
    dataKey: JSON.stringify(query),
    loading: result.isLoading,
    fetching: result.isFetching,
    stale: result.isPlaceholderData,
    error: result.error,
    resetFilters: () => write({ filter: null, page: null }),
  }
}

// ---------------------------------------------------------------------------------------------

export function useClientTable<T>({
  id,
  data,
  columns,
  defaultSort,
  pageSize = 20,
  defaultHidden,
  getRowId,
  loading = false,
}: {
  id: string
  data: T[] | undefined
  columns: ColumnDef<T, unknown>[]
  defaultSort?: { id: string; desc: boolean }
  pageSize?: number
  defaultHidden?: string[]
  getRowId?: (row: T) => string
  loading?: boolean
}): SmartTableState<T> {
  const [sorting, setSorting] = useState<SortingState>(defaultSort ? [defaultSort] : [])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize })
  const prefs = usePrefs(id, defaultHidden)
  const table = useReactTable<T>({
    data: data ?? [],
    columns,
    getRowId,
    defaultColumn: { filterFn: smartFilter as never },
    state: { sorting, columnFilters, pagination, columnVisibility: prefs.columnVisibility },
    autoResetPageIndex: true,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    onColumnVisibilityChange: prefs.onColumnVisibilityChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })
  return {
    table,
    total: table.getFilteredRowModel().rows.length,
    density: prefs.density,
    setDensity: prefs.setDensity,
    dataKey: JSON.stringify([sorting, columnFilters, pagination.pageIndex]),
    loading,
    fetching: false,
    stale: false,
    error: null,
    resetFilters: () => setColumnFilters([]),
  }
}
