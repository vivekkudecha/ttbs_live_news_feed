/**
 * Column metadata shared by every table: a human label (View menu, filter chips), an optional
 * filter (header funnel + chip), and alignment. Filter values match the API's `filter` JSON
 * (backend/app/api/listing.py), so server tables send them as-is.
 */
import type { FilterFn, RowData } from "@tanstack/react-table"

export type FilterDef =
  | { type: "text"; placeholder?: string }
  | { type: "enum"; options: { value: string; label: string }[] }
  | { type: "range"; unit?: string }
  | { type: "date" }
  | { type: "bool"; labels?: [yes: string, no: string] }

export type RangeValue = { min?: number | string; max?: number | string }
export type DateValue = { from?: string; to?: string }
export type FilterValue = string | string[] | RangeValue | DateValue | boolean

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string
    filter?: FilterDef
    align?: "left" | "right"
    /** Column width in a fixed-layout table (e.g. "22%", "3rem"); leave one column without it to take the rest. */
    width?: string
  }
}

/** True when a filter value would not filter anything (cleared input). */
export const isEmptyFilter = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => x === undefined || x === null || x === ""))

/** Client-side equivalent of the server filters (for small, fully loaded tables). */
export const smartFilter: FilterFn<unknown> = (row, columnId, value) => {
  if (isEmptyFilter(value)) return true
  const cell = row.getValue(columnId)
  if (typeof value === "string") return String(cell ?? "").toLowerCase().includes(value.toLowerCase())
  if (typeof value === "boolean") return Boolean(cell) === value
  if (Array.isArray(value)) return value.includes(String(cell))
  const v = value as RangeValue & DateValue
  if ("from" in v || "to" in v) {
    const d = cell ? String(cell).slice(0, 10) : ""
    if (!d) return false
    return (!v.from || d >= v.from) && (!v.to || d <= v.to)
  }
  const n = Number(cell)
  return (v.min === undefined || v.min === "" || n >= Number(v.min)) && (v.max === undefined || v.max === "" || n <= Number(v.max))
}
smartFilter.autoRemove = isEmptyFilter

/** Short text for a filter chip: "Status: Sent, Failed", "Attempts: 2–5", "Created: from 1 Nov". */
export function describeFilter(def: FilterDef | undefined, value: FilterValue): string {
  if (typeof value === "boolean") return def?.type === "bool" && def.labels ? def.labels[value ? 0 : 1] : value ? "Yes" : "No"
  if (typeof value === "string") return `“${value}”`
  if (Array.isArray(value)) {
    const opts = def?.type === "enum" ? def.options : []
    const names = value.map((v) => opts.find((o) => o.value === v)?.label ?? v)
    return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")
  }
  const r = value as RangeValue & DateValue
  if ("from" in r || "to" in r) return r.from && r.to ? `${r.from} → ${r.to}` : r.from ? `from ${r.from}` : `until ${r.to}`
  return r.min !== undefined && r.min !== "" && r.max !== undefined && r.max !== "" ? `${r.min}–${r.max}` : r.min !== undefined && r.min !== "" ? `≥ ${r.min}` : `≤ ${r.max}`
}
