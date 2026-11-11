/**
 * Quick view of an uploaded dataset: server-paged rows with search and PAM filters,
 * sortable columns, row-level edit (inline) and delete (single or bulk).
 * Edits update the real company / PAM records; delete removes the row from this dataset and
 * stops tracking the company if it is in no other dataset.
 */
import { useState } from "react"
import { toast } from "sonner"
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Loader2, Pencil, Search, Trash2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useDatasetRows, useDeleteDatasetRows, useUpdateDatasetRow } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { useDebounced } from "@/lib/use-debounced"
import { cn } from "@/lib/utils"
import type { DatasetRow, DatasetRowPatch, DatasetRowQuery } from "@/api/types"

const ALL = "__all"
const n = (x: number) => x.toLocaleString("en-IN")
type SortKey = NonNullable<DatasetRowQuery["sort"]>

type Draft = { company: string; industry: string; pamName: string; pamEmail: string; pamWhatsapp: string }
const toDraft = (r: DatasetRow): Draft => ({ company: r.company, industry: r.industry, pamName: r.pamName, pamEmail: r.pamEmail, pamWhatsapp: r.pamWhatsapp })

function changes(r: DatasetRow, d: Draft): DatasetRowPatch {
  const p: DatasetRowPatch = {}
  if (d.company.trim() !== r.company) p.company = d.company.trim()
  if (d.industry.trim() !== r.industry) p.industry = d.industry.trim()
  if (d.pamEmail.trim().toLowerCase() !== r.pamEmail) p.pamEmail = d.pamEmail.trim()
  if (d.pamName.trim() !== r.pamName) p.pamName = d.pamName.trim()
  if (d.pamWhatsapp.trim() !== r.pamWhatsapp) p.pamWhatsapp = d.pamWhatsapp.trim()
  return p
}

function SortHead({ id, label, sort, desc, onSort, className }: { id: SortKey; label: string; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort === id
  return (
    <TableHead className={className}>
      <button type="button" onClick={() => onSort(id)} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
        {label}
        {active && (desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
      </button>
    </TableHead>
  )
}

export function DatasetGrid({ datasetId, pageSize = 25, className }: { datasetId: string; pageSize?: number; className?: string }) {
  const [search, setSearch] = useState("")
  const [pamId, setPamId] = useState(ALL)
  const [sort, setSort] = useState<SortKey>("company")
  const [desc, setDesc] = useState(false)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ row: DatasetRow; draft: Draft } | null>(null)
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const q = useDebounced(search, 250)

  const rows = useDatasetRows(datasetId, {
    page,
    pageSize,
    q: q || undefined,
    pamId: pamId === ALL ? undefined : pamId,
    sort,
    desc,
  })
  const update = useUpdateDatasetRow()
  const remove = useDeleteDatasetRows()
  const data = rows.data
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1
  const pageIds = data?.rows.map((r) => r.companyId) ?? []
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))

  const reset = () => {
    setPage(0)
    setSelected(new Set())
  }
  const onSort = (k: SortKey) => {
    if (k === sort) setDesc((d) => !d)
    else {
      setSort(k)
      setDesc(false)
    }
    reset()
  }

  const save = () => {
    if (!editing) return
    const patch = changes(editing.row, editing.draft)
    if (Object.keys(patch).length === 0) return setEditing(null)
    update.mutate(
      { id: datasetId, companyId: editing.row.companyId, patch },
      {
        onSuccess: (r) => {
          toast.success(`Saved ${r.company}`, { description: "The company and PAM records were updated." })
          setEditing(null)
        },
        onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
      },
    )
  }

  const doDelete = () => {
    if (!confirm) return
    remove.mutate(
      { id: datasetId, companyIds: confirm },
      {
        onSuccess: (r) => {
          toast.success(`${n(r.removed)} row${r.removed === 1 ? "" : "s"} removed`, {
            description: r.stoppedTracking ? `${n(r.stoppedTracking)} compan${r.stoppedTracking === 1 ? "y is" : "ies are"} no longer tracked (not in any other dataset).` : undefined,
          })
          setConfirm(null)
          setSelected(new Set())
        },
        onError: (e) => toast.error("Not removed", { description: errorMessage(e) }),
      },
    )
  }

  const set = (k: keyof Draft, v: string) => editing && setEditing({ ...editing, draft: { ...editing.draft, [k]: v } })
  const cell = (k: keyof Draft, placeholder?: string, cls?: string) => (
    <Input
      value={editing!.draft[k]}
      onChange={(e) => set(k, e.target.value)}
      placeholder={placeholder}
      className={cn("h-8", cls)}
      onKeyDown={(e) => {
        if (e.key === "Enter") save()
        if (e.key === "Escape") setEditing(null)
      }}
    />
  )

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:w-72">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search rows"
            placeholder="Search company, industry or PAM"
            className="pl-8"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              reset()
            }}
          />
        </div>
        <Select
          value={pamId}
          onValueChange={(v) => {
            setPamId(v)
            reset()
          }}
        >
          <SelectTrigger className="lg:w-56" aria-label="Filter by PAM">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All PAMs</SelectItem>
            {data?.facets.pams.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} <span className="text-muted-foreground">({n(p.count)})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 lg:ml-auto">
          {selected.size > 0 && (
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirm([...selected])}>
              <Trash2 /> Delete {n(selected.size)} selected
            </Button>
          )}
          <span className="tabular text-sm text-muted-foreground">{data ? `${n(data.total)} rows` : ""}</span>
        </div>
      </div>

      <div className={cn("overflow-x-auto rounded-lg border transition-opacity", rows.isPlaceholderData && "opacity-60")}>
        <Table className="min-w-[60rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-3">
                <Checkbox
                  aria-label="Select all rows on this page"
                  checked={allOnPage}
                  onCheckedChange={(v) => {
                    const next = new Set(selected)
                    pageIds.forEach((id) => (v === true ? next.add(id) : next.delete(id)))
                    setSelected(next)
                  }}
                />
              </TableHead>
              <SortHead id="row" label="Row" sort={sort} desc={desc} onSort={onSort} className="w-16" />
              <SortHead id="company" label="Company" sort={sort} desc={desc} onSort={onSort} />
              <SortHead id="industry" label="Industry" sort={sort} desc={desc} onSort={onSort} />
              <SortHead id="pam" label="PAM" sort={sort} desc={desc} onSort={onSort} />
              <TableHead>WhatsApp</TableHead>
              <TableHead className="w-24 pr-3 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.isLoading &&
              [0, 1, 2, 3].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-6" />
                  </TableCell>
                </TableRow>
              ))}
            {rows.isError && (
              <TableRow>
                <TableCell colSpan={8} className="text-sm text-destructive">
                  {errorMessage(rows.error)}
                </TableCell>
              </TableRow>
            )}
            {data?.rows.map((r) => {
              const isEditing = editing?.row.companyId === r.companyId
              return (
                <TableRow key={r.companyId} data-state={selected.has(r.companyId) ? "selected" : undefined} className="align-top">
                  <TableCell className="pl-3">
                    <Checkbox
                      aria-label={`Select ${r.company}`}
                      checked={selected.has(r.companyId)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected)
                        if (v === true) next.add(r.companyId)
                        else next.delete(r.companyId)
                        setSelected(next)
                      }}
                    />
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">{r.rowNo || "—"}</TableCell>
                  {isEditing ? (
                    <>
                      <TableCell>{cell("company", "Company")}</TableCell>
                      <TableCell>{cell("industry", "Industry")}</TableCell>
                      <TableCell className="space-y-1.5">
                        {cell("pamName", "PAM name")}
                        {cell("pamEmail", "PAM email")}
                      </TableCell>
                      <TableCell>{cell("pamWhatsapp", "+91…")}</TableCell>
                      <TableCell className="pr-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="icon-sm" aria-label="Save row" onClick={save} disabled={update.isPending}>
                            {update.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                          </Button>
                          <Button size="icon-sm" variant="ghost" aria-label="Cancel edit" onClick={() => setEditing(null)}>
                            <X />
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="font-medium">
                        {r.company}
                        {!r.active && (
                          <Badge variant="secondary" className="ml-2 font-normal">
                            not tracked
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.industry || "—"}</TableCell>
                      <TableCell>
                        <p>{r.pamName || "—"}</p>
                        <p className="text-xs text-muted-foreground">{r.pamEmail}</p>
                      </TableCell>
                      <TableCell className="tabular">{r.pamWhatsapp || "—"}</TableCell>
                      <TableCell className="pr-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.company}`} onClick={() => setEditing({ row: r, draft: toDraft(r) })}>
                            <Pencil />
                          </Button>
                          <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.company}`} className="text-destructive" onClick={() => setConfirm([r.companyId])}>
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              )
            })}
            {data && data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-20 text-center text-sm text-muted-foreground">
                  No rows match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.total > pageSize && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span className="tabular">
            Page {page + 1} of {pages}
          </span>
          <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight />
          </Button>
        </div>
      )}

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {confirm && confirm.length > 1 ? `${n(confirm.length)} rows` : "this row"}?
            </DialogTitle>
            <DialogDescription>
              The {confirm && confirm.length > 1 ? "companies are" : "company is"} removed from this dataset. A company that is in no other dataset stops being tracked
              (no more research or digests). Past research results are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="animate-spin" />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
