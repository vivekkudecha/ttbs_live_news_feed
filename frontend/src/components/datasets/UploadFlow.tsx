/**
 * Upload an Excel/CSV, preview it, save it under a name, watch it save, then decide what to do next.
 *
 *   1. File (≤ 1 GB)         → POST /imports/stage (streamed to disk, with upload progress)
 *      Check                 → background: every row validated + compared (progress), GET /imports/{id}/preview
 *      Name → save           → POST /imports/{id}/save (original file kept, time-stamped; rows saved in the background)
 *   2. Saving… progress bar  → background job, chunked + resumable; safe to close the dialog
 *   3. Saved                 → summary + skipped rows, then "Research these companies?" and a
 *                              quick-view grid to check / edit / delete rows.
 *
 * Also opens an existing dataset (`datasetId`), e.g. from the Imports list.
 */
import { useMemo, useRef, useState, type ReactNode } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, Download, FileSpreadsheet, Loader2, Pencil, RotateCcw, Table2, UploadCloud, XCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useClientTable } from "@/components/data-table/useSmartTable"
import { useDataset, useRenameDataset, useResumeDataset, useSaveUpload, useUploadPreview } from "@/api/hooks"
import { ApiError, backend, errorMessage, stageUpload } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Dataset, ImportRowIssue, UploadPreview } from "@/api/types"
import { DatasetGrid } from "./DatasetGrid"
import { ResearchPlan } from "./ResearchPlan"

const n = (x: number) => x.toLocaleString("en-IN")

export const COLUMNS: [string, string][] = [
  ["Company", "required"],
  ["PAM Name", "required"],
  ["PAM Email", "required"],
  ["PAM WhatsApp", "required; 10-digit numbers get +91"],
  ["Industry", "optional"],
]

export function downloadTemplate() {
  const rows = [
    ["Company", "Industry", "PAM Name", "PAM Email", "PAM WhatsApp"],
    ["Example Logistics Pvt Ltd", "Logistics", "Aarav Mehta", "aarav.mehta@ttbs.example", "+91 98100 11001"],
  ]
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n")
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }))
  const a = Object.assign(document.createElement("a"), { href: url, download: "ttbs_company_pam_mapping_template.csv" })
  a.click()
  URL.revokeObjectURL(url)
}

const baseName = (f: string) => f.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim()

// ---- Step 1: pick a file → preview it → save it under a name ----------------------------------

const CHANGE: Record<UploadPreview["rows"][number]["change"], { label: string; cls: string }> = {
  new: { label: "New logo", cls: "bg-success/15 text-success" },
  reassigned: { label: "Moves PAM", cls: "bg-warning/20 text-[color-mix(in_oklch,var(--warning),black_40%)] dark:text-warning" },
  updated: { label: "Updated", cls: "bg-info/15 text-info" },
  unchanged: { label: "Already known", cls: "bg-muted text-muted-foreground" },
}

type PreviewRow = UploadPreview["rows"][number]

/** First rows of the upload with what saving would do to each (sortable / filterable in the browser). */
function PreviewTable({ p }: { p: UploadPreview }) {
  const columns = useMemo<ColumnDef<PreviewRow, unknown>[]>(
    () => [
      {
        id: "row",
        accessorKey: "row",
        size: 60,
        meta: { label: "Row", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Row" />,
        cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.row}</span>,
      },
      {
        id: "company",
        accessorKey: "company",
        meta: { label: "Company", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Company" />,
        cell: ({ row }) => (
          <div className="max-w-64">
            <span className="block truncate font-medium">{row.original.company}</span>
            {row.original.industry && <span className="block truncate text-xs text-muted-foreground">{row.original.industry}</span>}
          </div>
        ),
      },
      {
        id: "pamName",
        accessorKey: "pamName",
        meta: { label: "PAM", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => (
          <div className="max-w-56">
            <span className="block truncate">{row.original.pamName}</span>
            <span className="block truncate text-xs text-muted-foreground">{row.original.pamEmail}</span>
          </div>
        ),
      },
      {
        id: "pamWhatsapp",
        accessorKey: "pamWhatsapp",
        meta: { label: "WhatsApp", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="WhatsApp" />,
        cell: ({ row }) => <span className="tabular text-sm">{row.original.pamWhatsapp}</span>,
      },
      {
        id: "change",
        accessorKey: "change",
        meta: { label: "On save", filter: { type: "enum", options: (Object.keys(CHANGE) as PreviewRow["change"][]).map((k) => ({ value: k, label: CHANGE[k].label })) } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="On save" />,
        cell: ({ row }) => (
          <div>
            <Badge className={cn("font-normal", CHANGE[row.original.change].cls)}>{CHANGE[row.original.change].label}</Badge>
            {row.original.change === "reassigned" && row.original.currentPam && <span className="block text-xs text-muted-foreground">from {row.original.currentPam}</span>}
          </div>
        ),
      },
    ],
    [],
  )
  const state = useClientTable<PreviewRow>({ id: "upload-preview", data: p.rows, columns, pageSize: 10, getRowId: (r) => `${r.row}-${r.company}` })
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm font-medium">
        Preview <span className="font-normal text-muted-foreground">· first {n(p.rowsShown)} of {n(p.validRows)} valid rows</span>
      </p>
      <SmartTable state={state} minWidth="52rem" pageSizes={[10, 25, 50]} empty={<p className="text-sm text-muted-foreground">No rows match.</p>} />
    </div>
  )
}

const fmtBytes = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const MAX_BYTES = 1 << 30 // 1 GB, as the server enforces

function DropZone({ onFile, busy }: { onFile: (f: File) => void; busy?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const choose = (f: File | undefined) => {
    if (!f) return
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast.error("Only .xlsx or .csv files are accepted")
    if (f.size > MAX_BYTES) return toast.error("The file is larger than 1 GB", { description: `${f.name} is ${fmtBytes(f.size)}` })
    onFile(f)
  }
  return (
    <div className="space-y-5">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          if (!busy) choose(e.dataTransfer.files[0])
        }}
        className={cn("flex min-h-44 flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors", drag && "border-primary bg-primary/5")}
      >
        {busy ?? (
          <>
            <UploadCloud className="size-9 text-primary" />
            <p className="mt-2 font-medium">Drop Excel or CSV here</p>
            <p className="text-sm text-muted-foreground">.xlsx or .csv · up to 1 GB · you will see a preview before anything is saved</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => input.current?.click()}>
              Browse files
            </Button>
          </>
        )}
        <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ""))} />
      </div>
      {!busy && (
        <details className="rounded-lg border px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">Expected columns</summary>
          <ul className="mt-3 space-y-1.5">
            {COLUMNS.map(([c, d]) => (
              <li key={c} className="flex items-start justify-between gap-2">
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{c}</code>
                <span className="text-right text-xs text-muted-foreground">{d}</span>
              </li>
            ))}
          </ul>
          <Button variant="link" size="sm" className="mt-2 px-0" onClick={downloadTemplate}>
            <Download /> Download template
          </Button>
        </details>
      )}
    </div>
  )
}

function BusyState({ title, detail, percent, onCancel }: { title: string; detail: string; percent: number | null; onCancel?: () => void }) {
  return (
    <div className="w-full max-w-lg space-y-3 text-left">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" />
        <p className="font-medium">{title}</p>
        {percent != null && <span className="tabular ml-auto text-sm text-muted-foreground">{percent}%</span>}
      </div>
      {percent != null ? <Progress value={percent} className="h-2 [&>div]:bg-info" aria-label={`${title} ${percent}%`} /> : <Progress value={100} className="h-2 animate-pulse" />}
      <p className="text-xs text-muted-foreground">{detail}</p>
      {onCancel && (
        <Button variant="ghost" size="sm" className="px-0" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  )
}

/**
 * Pick → upload (progress) → server checks every row in the background (progress) → preview →
 * name it → save. The file is sent once, streamed to disk on the server, never held in memory.
 */
function PickFile({ onUploaded }: { onUploaded: (d: Dataset) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [sent, setSent] = useState<{ sent: number; total: number } | null>(null)
  const [stagedId, setStagedId] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const abortRef = useRef<(() => void) | null>(null)
  const staged = useDataset(stagedId) // polls every second while "analyzing"
  const ready = staged.data?.status === "previewed"
  const preview = useUploadPreview(stagedId, ready)
  const save = useSaveUpload()
  const p = preview.data

  const reset = (discard = true) => {
    abortRef.current?.()
    if (discard && stagedId && staged.data && ["analyzing", "previewed"].includes(staged.data.status)) void backend.discardUpload(stagedId).catch(() => undefined)
    setFile(null)
    setSent(null)
    setStagedId(null)
    setLabel("")
  }

  const start = (f: File) => {
    reset()
    setFile(f)
    setSent({ sent: 0, total: f.size })
    const up = stageUpload(f, (s, t) => setSent({ sent: s, total: t }))
    abortRef.current = up.abort
    up.promise
      .then((d) => setStagedId(d.id))
      .catch((e) => {
        if (!(e instanceof ApiError && e.code === "aborted")) toast.error("Upload failed", { description: errorMessage(e) })
        setFile(null)
        setSent(null)
      })
      .finally(() => (abortRef.current = null))
  }

  const doSave = () =>
    stagedId &&
    label.trim() &&
    save.mutate(
      { id: stagedId, label: label.trim() },
      { onSuccess: (d) => onUploaded(d), onError: (e) => toast.error("Could not save the upload", { description: errorMessage(e) }) },
    )

  // 1. Uploading the bytes.
  if (file && !stagedId && sent)
    return (
      <DropZone
        onFile={start}
        busy={
          <BusyState
            title={`Uploading ${file.name}`}
            detail={`${fmtBytes(sent.sent)} of ${fmtBytes(sent.total)} sent · nothing is saved until you name it`}
            percent={sent.total ? Math.floor((sent.sent / sent.total) * 100) : null}
            onCancel={() => reset()}
          />
        }
      />
    )

  // 2. The server is checking every row.
  if (stagedId && (!staged.data || staged.data.status === "analyzing" || (ready && !p)))
    return (
      <DropZone
        onFile={start}
        busy={
          <BusyState
            title={`Checking ${file?.name ?? "the file"}`}
            detail={`${n(staged.data?.rowsRead ?? 0)} rows read so far · validating, finding duplicates, comparing with the logos and PAMs already saved`}
            percent={staged.data?.progress ?? null}
            onCancel={() => reset()}
          />
        }
      />
    )

  // The check found a problem with the file as a whole.
  if (stagedId && staged.data?.status === "failed")
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{file?.name ?? "The file"} cannot be saved</AlertTitle>
          <AlertDescription>{staged.data.error}</AlertDescription>
        </Alert>
        <IssueList issues={staged.data.issues ?? []} errorRows={staged.data.errorRows} />
        <Button variant="outline" onClick={() => reset(false)}>
          Choose another file
        </Button>
      </div>
    )

  if (!stagedId || !p) return <DropZone onFile={start} />

  // 3. Preview, then the name to save it under.
  const stamp = fmtDateTime(new Date().toISOString())
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <FileSpreadsheet className="size-5 text-primary" />
        <div className="min-w-0">
          <p className="truncate font-medium">{p.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {fmtBytes(p.sizeBytes)} · {n(p.rowsTotal)} rows · {n(p.pams)} PAMs · not saved yet
          </p>
        </div>
        <Button variant="link" size="sm" className="ml-auto" onClick={() => reset()}>
          Choose a different file
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Valid rows" value={n(p.validRows)} />
        <Stat label="Rows rejected" value={n(p.errorRows)} tone={p.errorRows ? "danger" : undefined} />
        <Stat label="New logos" value={n(p.newCompanies)} />
        <Stat label="Already known" value={n(p.unchanged + p.updatedCompanies)} />
        <Stat label="Move to another PAM" value={n(p.reassignments)} />
        <Stat label="New PAMs" value={n(p.newPams)} />
        <Stat label="Duplicates merged" value={n(p.duplicatesMerged)} />
      </div>
      <IssueList issues={p.issues} errorRows={p.errorRows} />
      <PreviewTable p={p} />

      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="ds-label">Save this upload as</Label>
          <Input
            id="ds-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSave()}
            placeholder={`e.g. ${baseName(p.fileName)}`}
            maxLength={200}
            autoFocus
            aria-required="true"
          />
          <p className="text-xs text-muted-foreground">
            Kept with its upload time: “{label.trim() || "your name"} · {stamp}”. The original file is stored too.{" "}
            {!label.trim() && (
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setLabel(baseName(p.fileName))}>
                Use the file name
              </button>
            )}
          </p>
        </div>
        <Button onClick={doSave} disabled={!label.trim() || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {save.isPending ? "Saving…" : `Save ${n(p.validRows)} rows`}
        </Button>
      </div>
    </div>
  )
}

// ---- Steps 2 + 3: progress, then summary / research / grid -----------------------------------

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular text-xl font-semibold", tone === "danger" && "text-destructive")}>{value}</p>
    </div>
  )
}

function LabelEditor({ d }: { d: Dataset }) {
  const rename = useRenameDataset()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(d.label)
  if (!editing)
    return (
      <button type="button" className="group inline-flex items-center gap-1.5 text-left text-base font-semibold" onClick={() => setEditing(true)}>
        {d.label}
        <Pencil className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    )
  const save = () =>
    rename.mutate(
      { id: d.id, label: value },
      { onSuccess: () => setEditing(false), onError: (e) => toast.error("Not renamed", { description: errorMessage(e) }) },
    )
  return (
    <div className="flex items-center gap-2">
      <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-64" autoFocus onKeyDown={(e) => e.key === "Enter" && save()} />
      <Button size="sm" onClick={save} disabled={rename.isPending || !value.trim()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  )
}

function IssueList({ issues, errorRows }: { issues: ImportRowIssue[]; errorRows: number }) {
  if (!issues.length) return null
  const errors = issues.filter((i) => i.severity === "error").length
  return (
    <details className="rounded-lg border">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
        <AlertTriangle className="size-4 text-warning" />
        {n(errorRows)} row{errorRows === 1 ? "" : "s"} rejected
        {issues.length - errors > 0 && ` · ${n(issues.length - errors)} warning${issues.length - errors === 1 ? "" : "s"}`}
        <ChevronDown className="ml-auto size-4 text-muted-foreground" />
      </summary>
      <div className="max-h-64 space-y-1.5 overflow-y-auto border-t p-3">
        {issues.map((i, k) => (
          <div key={`${i.row}-${i.field}-${k}`} className="flex items-start gap-2 text-sm">
            {i.severity === "error" ? <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
            <span>
              <span className="font-medium">
                Row {i.row}
                {i.company && ` · ${i.company}`}
              </span>{" "}
              <span className="text-muted-foreground">
                ({i.field}): {i.message}
              </span>
            </span>
          </div>
        ))}
      </div>
    </details>
  )
}

const Issues = ({ d }: { d: Dataset }) => <IssueList issues={d.issues ?? []} errorRows={d.errorRows} />

function Saving({ d }: { d: Dataset }) {
  const resume = useResumeDataset()
  const failed = d.status === "failed"
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium">
            {failed ? "Saving stopped" : d.status === "queued" ? "Waiting for a worker…" : "Saving rows…"}
          </p>
          <p className="tabular text-sm text-muted-foreground">
            {n(d.saved)} of {n(d.validRows)} rows · {d.progress}%
          </p>
        </div>
        <Progress value={d.progress} className={cn("h-2.5", !failed && "[&>div]:bg-info")} aria-label={`${d.progress}% saved`} />
      </div>
      {failed ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{d.validRows ? "The upload stopped before every row was saved" : "No valid rows to save"}</AlertTitle>
          <AlertDescription>
            <p>{d.error}</p>
            {d.validRows > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                disabled={resume.isPending}
                onClick={() => resume.mutate(d.id, { onError: (e) => toast.error("Could not resume", { description: errorMessage(e) }) })}
              >
                <RotateCcw /> Resume from row {n(d.saved + 1)}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          You can close this window: saving continues in the background and picks up from the last saved rows after any interruption (lost connection, restart, crash).
        </p>
      )}
      <Issues d={d} />
    </div>
  )
}

function Saved({ d, onUse, onDone }: { d: Dataset; onUse?: (importId: string) => void; onDone?: () => void }) {
  const companies = d.companies ?? d.saved
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="min-w-0">
          <LabelEditor d={d} />
          <p className="text-sm text-muted-foreground">
            {d.fileName} · uploaded {fmtDateTime(d.uploadedAt)} by {d.uploadedBy}
          </p>
        </div>
        <Badge variant="secondary" className="ml-auto shrink-0">
          {n(companies)} companies
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Stat label="New logos" value={n(d.newCompanies)} />
        <Stat label="Already known" value={n(d.unchanged ?? 0)} />
        <Stat label="Updated" value={n(d.updatedCompanies)} />
        <Stat label="Reassigned" value={n(d.reassignments)} />
        <Stat label="New PAMs" value={n(d.newPams)} />
        <Stat label="Rows skipped" value={n(d.errorRows)} tone={d.errorRows ? "danger" : undefined} />
      </div>
      <Issues d={d} />

      <Tabs defaultValue={onUse ? "data" : "research"}>
        <TabsList>
          {!onUse && (
            <TabsTrigger value="research">
              <CalendarClock /> Schedule research
            </TabsTrigger>
          )}
          <TabsTrigger value="data">
            <Table2 /> View &amp; edit data
          </TabsTrigger>
        </TabsList>
        {!onUse && (
          <TabsContent value="research" className="mt-4">
            <ResearchPlan importId={d.id} label={d.label} previousRuns={d.runs ?? 0} lastRunAt={d.lastRunAt} onDone={onDone} />
          </TabsContent>
        )}
        <TabsContent value="data" className="mt-4">
          <DatasetGrid datasetId={d.id} pageSize={10} />
        </TabsContent>
      </Tabs>

      {onUse && (
        <div className="flex justify-end">
          <Button onClick={() => onUse(d.id)}>Use this upload</Button>
        </div>
      )}
    </div>
  )
}

export function UploadFlow({ datasetId, onUse, onDone }: { datasetId?: string; onUse?: (importId: string) => void; onDone?: () => void }) {
  const [id, setId] = useState<string | null>(datasetId ?? null)
  const ds = useDataset(id)
  if (!id) return <PickFile onUploaded={(d) => setId(d.id)} />
  if (!ds.data) return ds.isError ? <p className="text-sm text-destructive">{errorMessage(ds.error)}</p> : <Skeleton className="h-40" />
  return ds.data.status === "completed" ? <Saved d={ds.data} onUse={onUse} onDone={onDone} /> : <Saving d={ds.data} />
}

/** Upload dialog: the full flow in one place. `trigger` defaults to an "Upload Excel" button. */
export function UploadDialog({ trigger, datasetId, open: openProp, onOpenChange }: { trigger?: ReactNode; datasetId?: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = onOpenChange ?? setOpenState
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {openProp === undefined && (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button>
              <UploadCloud /> Upload Excel
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{datasetId ? "Dataset" : "Upload companies & PAMs"}</DialogTitle>
          <DialogDescription>Each upload is kept as its own dataset, named and time-stamped, so you can research it now or later.</DialogDescription>
        </DialogHeader>
        {open && <UploadFlow key={datasetId ?? "new"} datasetId={datasetId} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}
