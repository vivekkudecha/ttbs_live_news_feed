/**
 * Upload an Excel/CSV as a named dataset, watch it save, then decide what to do next.
 *
 *   1. Label + file          → POST /imports (validated, queued)
 *   2. Saving… progress bar  → background job, chunked + resumable; safe to close the dialog
 *   3. Saved                 → summary + skipped rows, then "Research these companies?" and a
 *                              quick-view grid to check / edit / delete rows.
 *
 * Also opens an existing dataset (`datasetId`), e.g. from the Imports list.
 */
import { useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, ChevronDown, Download, FileSpreadsheet, Loader2, Pencil, RotateCcw, Table2, UploadCloud, XCircle, Zap } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDataset, useRenameDataset, useResumeDataset, useUploadDataset } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Dataset } from "@/api/types"
import { DatasetGrid } from "./DatasetGrid"
import { ResearchPlan } from "./ResearchPlan"

const n = (x: number) => x.toLocaleString("en-IN")

export const COLUMNS: [string, string][] = [
  ["Company", "required"],
  ["PAM Name", "required"],
  ["PAM Email", "required"],
  ["PAM WhatsApp", "required; 10-digit numbers get +91"],
  ["Industry", "optional"],
  ["Segment", "optional: Enterprise, Mid-market, Emerging"],
]

export function downloadTemplate() {
  const rows = [
    ["Company", "Industry", "Segment", "PAM Name", "PAM Email", "PAM WhatsApp"],
    ["Example Logistics Pvt Ltd", "Logistics", "Enterprise", "Aarav Mehta", "aarav.mehta@ttbs.example", "+91 98100 11001"],
  ]
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n")
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }))
  const a = Object.assign(document.createElement("a"), { href: url, download: "ttbs_company_pam_mapping_template.csv" })
  a.click()
  URL.revokeObjectURL(url)
}

const baseName = (f: string) => f.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim()

// ---- Step 1: pick file + label ---------------------------------------------------------------

function PickFile({ onUploaded }: { onUploaded: (d: Dataset) => void }) {
  const upload = useUploadDataset()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState("")
  const [drag, setDrag] = useState(false)

  const choose = (f: File | undefined) => {
    if (!f) return
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast.error("Only .xlsx or .csv files are accepted")
    setFile(f)
    if (!label.trim()) setLabel(baseName(f.name))
  }

  const go = () =>
    file &&
    upload.mutate(
      { file, label },
      {
        onSuccess: (d) => onUploaded(d),
        onError: (e) => toast.error("Upload failed", { description: errorMessage(e) }),
      },
    )

  return (
    <div className="space-y-5">
      <div className="grid gap-2">
        <Label htmlFor="ds-label">Dataset name</Label>
        <Input id="ds-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. November logos" maxLength={200} />
        <p className="text-xs text-muted-foreground">Saved with the upload time, e.g. “{label.trim() || "November logos"} · {fmtDateTime(new Date().toISOString())}”.</p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          choose(e.dataTransfer.files[0])
        }}
        className={cn("flex min-h-44 flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors", drag && "border-primary bg-primary/5")}
      >
        {file ? (
          <>
            <FileSpreadsheet className="size-9 text-primary" />
            <p className="mt-2 font-medium">{file.name}</p>
            <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
            <Button variant="link" size="sm" onClick={() => input.current?.click()}>
              Choose a different file
            </Button>
          </>
        ) : (
          <>
            <UploadCloud className="size-9 text-primary" />
            <p className="mt-2 font-medium">Drop Excel or CSV here</p>
            <p className="text-sm text-muted-foreground">.xlsx or .csv · max 10 MB</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => input.current?.click()}>
              Browse files
            </Button>
          </>
        )}
        <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
      </div>

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

      <div className="flex justify-end">
        <Button onClick={go} disabled={!file || upload.isPending}>
          {upload.isPending ? <Loader2 className="animate-spin" /> : <UploadCloud />}
          {upload.isPending ? "Uploading & validating…" : "Upload & save"}
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

function Issues({ d }: { d: Dataset }) {
  const issues = d.issues ?? []
  if (!issues.length) return null
  const errors = issues.filter((i) => i.severity === "error").length
  return (
    <details className="rounded-lg border">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
        <AlertTriangle className="size-4 text-warning" />
        {n(d.errorRows)} row{d.errorRows === 1 ? "" : "s"} skipped
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

function Saved({ d, onUse, onDone }: { d: Dataset; onUse?: (scopeKey: string) => void; onDone?: () => void }) {
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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="New companies" value={n(d.newCompanies)} />
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
              <Zap /> Research these companies
            </TabsTrigger>
          )}
          <TabsTrigger value="data">
            <Table2 /> View &amp; edit data
          </TabsTrigger>
        </TabsList>
        {!onUse && (
          <TabsContent value="research" className="mt-4">
            <ResearchPlan scopeKey={`import:${d.id}`} label={d.label} companies={companies} onDone={onDone} />
          </TabsContent>
        )}
        <TabsContent value="data" className="mt-4">
          <DatasetGrid datasetId={d.id} pageSize={10} />
        </TabsContent>
      </Tabs>

      {onUse && (
        <div className="flex justify-end">
          <Button onClick={() => onUse(`import:${d.id}`)}>Use this dataset</Button>
        </div>
      )}
    </div>
  )
}

export function UploadFlow({ datasetId, onUse, onDone }: { datasetId?: string; onUse?: (scopeKey: string) => void; onDone?: () => void }) {
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
