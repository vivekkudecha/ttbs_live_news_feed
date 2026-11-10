/**
 * Per-column filter (the funnel in a table header). The popover edits a draft and applies it on
 * "Apply" / Enter, so a server table sends one request per change, not one per keystroke.
 */
import { useState } from "react"
import type { Column } from "@tanstack/react-table"
import { Check, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { isEmptyFilter, type DateValue, type FilterDef, type FilterValue, type RangeValue } from "./table-meta"

export function ColumnFilter<T>({ column, def, title }: { column: Column<T>; def: FilterDef; title: string }) {
  const current = column.getFilterValue() as FilterValue | undefined
  const active = !isEmptyFilter(current)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FilterValue | undefined>(current)

  const apply = (v: FilterValue | undefined) => {
    column.setFilterValue(isEmptyFilter(v) ? undefined : v)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft(current)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter ${title}${active ? " (active)" : ""}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "relative inline-grid size-5 shrink-0 place-items-center rounded transition-colors hover:bg-muted hover:text-foreground",
            // Always visible next to the title (dim until hovered or active).
            active ? "text-primary" : "opacity-45 group-hover/th:opacity-75 focus-visible:opacity-100 data-[state=open]:opacity-100",
          )}
        >
          <Filter className="size-3" fill={active ? "currentColor" : "none"} />
          {active && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-brand" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2 text-xs font-medium text-muted-foreground">Filter · {title}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            apply(draft)
          }}
          className="space-y-3"
        >
          <Editor def={def} value={draft} onChange={setDraft} />
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={!active && isEmptyFilter(draft)} onClick={() => apply(undefined)}>
              Clear
            </Button>
            <Button type="submit" size="sm">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function Editor({ def, value, onChange }: { def: FilterDef; value: FilterValue | undefined; onChange: (v: FilterValue | undefined) => void }) {
  if (def.type === "text")
    return <Input autoFocus value={typeof value === "string" ? value : ""} placeholder={def.placeholder ?? "Contains…"} onChange={(e) => onChange(e.target.value)} className="h-8" />
  if (def.type === "enum") {
    const sel = Array.isArray(value) ? value : []
    return (
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {def.options.map((o) => {
          const on = sel.includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(on ? sel.filter((x) => x !== o.value) : [...sel, o.value])}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span className={cn("grid size-4 place-items-center rounded border transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                {on && <Check className="size-3" />}
              </span>
              {o.label}
            </button>
          )
        })}
      </div>
    )
  }
  if (def.type === "bool") {
    const [yes, no] = def.labels ?? ["Yes", "No"]
    return (
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 text-xs">
        {([[undefined, "Any"], [true, yes], [false, no]] as const).map(([v, l]) => (
          <button
            key={l}
            type="button"
            onClick={() => onChange(v)}
            className={cn("rounded-md px-2 py-1.5 font-medium transition-all", value === v ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {l}
          </button>
        ))}
      </div>
    )
  }
  if (def.type === "date") {
    const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as DateValue
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          From
          <Input type="date" value={v.from ?? ""} onChange={(e) => onChange({ ...v, from: e.target.value || undefined })} className="h-8" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          To
          <Input type="date" value={v.to ?? ""} onChange={(e) => onChange({ ...v, to: e.target.value || undefined })} className="h-8" />
        </label>
      </div>
    )
  }
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as RangeValue
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="space-y-1 text-xs text-muted-foreground">
        Min{def.unit ? ` (${def.unit})` : ""}
        <Input type="number" value={v.min ?? ""} onChange={(e) => onChange({ ...v, min: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-8" />
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        Max{def.unit ? ` (${def.unit})` : ""}
        <Input type="number" value={v.max ?? ""} onChange={(e) => onChange({ ...v, max: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-8" />
      </label>
    </div>
  )
}
