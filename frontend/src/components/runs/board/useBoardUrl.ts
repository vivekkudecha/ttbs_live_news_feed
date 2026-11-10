/**
 * The results board's state lives in the URL (prefix `b.`), so a view can be shared and the Back
 * button restores it: search, grouping, sort, filters, page, and the open logo timeline / digest.
 *
 *   ?b.q=acme&b.view=logo&b.sort=status.desc&b.filter={"status":["failed"]}&b.page=2&b.open=123
 */
import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import type { FilterValue } from "@/components/data-table/table-meta"
import { isEmptyFilter } from "@/components/data-table/table-meta"

export type BoardView = "pam" | "logo"
export type BoardFilters = Record<string, FilterValue>

const P = "b."

export function useBoardUrl() {
  const [params, setParams] = useSearchParams()
  const get = useCallback((k: string) => params.get(P + k), [params])

  const state = useMemo(() => {
    let filters: BoardFilters = {}
    try {
      const raw = JSON.parse(get("filter") ?? "{}")
      if (raw && typeof raw === "object" && !Array.isArray(raw)) filters = raw as BoardFilters
    } catch {
      /* a hand-edited URL: ignore the filter */
    }
    const [sortId, dir] = (get("sort") ?? "").split(".")
    return {
      q: get("q") ?? "",
      view: (get("view") === "logo" ? "logo" : "pam") as BoardView,
      sort: sortId ? { id: sortId, desc: dir === "desc" } : null,
      filters,
      page: Math.max(0, Number(get("page") ?? 1) - 1) || 0,
      size: Number(get("size")) || 0,
      open: get("open"),
      digest: get("digest"),
    }
  }, [get])

  const write = useCallback(
    (changes: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(changes)) {
            if (v === null || v === "") next.delete(P + k)
            else next.set(P + k, v)
          }
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  const setFilters = useCallback(
    (next: BoardFilters) => {
      const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => !isEmptyFilter(v)))
      write({ filter: Object.keys(clean).length ? JSON.stringify(clean) : null, page: null })
    },
    [write],
  )
  const setFilter = useCallback((id: string, v: FilterValue | undefined) => setFilters({ ...state.filters, [id]: v as FilterValue }), [setFilters, state.filters])

  return {
    ...state,
    setQ: (q: string) => write({ q: q || null, page: null }),
    setView: (v: BoardView) => write({ view: v === "pam" ? null : v, page: null, size: null }),
    setSort: (s: { id: string; desc: boolean } | null) => write({ sort: s ? `${s.id}.${s.desc ? "desc" : "asc"}` : null, page: null }),
    setFilters,
    setFilter,
    setPage: (p: number) => write({ page: p ? String(p + 1) : null }),
    setSize: (n: number) => write({ size: String(n), page: null }),
    openLogo: (id: string | null) => write({ open: id }),
    openDigest: (pamId: string | null) => write({ digest: pamId }),
  }
}

export type BoardUrl = ReturnType<typeof useBoardUrl>
