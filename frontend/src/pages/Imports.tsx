import { useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { AlertTriangle, CalendarClock, CheckCircle2, Download, FileSpreadsheet, Loader2, UploadCloud, XCircle } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { backend, errorMessage } from "@/api/http"
import { useCommitBackendImport, useImports } from "@/api/hooks"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BackendImportPreview, DeliveryChannel, ImportPreview, RunPlan } from "@/api/types"

const COLUMNS = [
  ["Company", "required"],
  ["PAM Name", "required"],
  ["PAM Email", "required"],
  ["PAM WhatsApp", "required; 10-digit numbers get +91"],
  ["Industry", "optional"],
  ["Segment", "optional: Enterprise, Mid-market, Emerging"],
]

const changeTone: Record<string, string> = {
  new: "bg-success/15 text-success",
  updated: "bg-info/15 text-info",
  reassigned: "bg-warning/20 text-[color-mix(in_oklch,var(--warning),black_40%)] dark:text-warning",
  unchanged: "bg-muted text-muted-foreground",
}

function downloadTemplate() {
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

/** Datetime-local value (browser time) one hour from now, rounded to the minute. */
const defaultRunAt = () => {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setSeconds(0, 0)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function RunPlanPicker({ plan, onChange }: { plan: RunPlan; onChange: (p: RunPlan) => void }) {
  const toggle = (c: DeliveryChannel, on: boolean) => onChange({ ...plan, channels: on ? [...plan.channels, c] : plan.channels.filter((x) => x !== c) })
  return (
    <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-[14rem_1fr]">
      <div className="grid gap-2">
        <Label>After commit</Label>
        <Select value={plan.mode} onValueChange={(v) => onChange({ ...plan, mode: v as RunPlan["mode"], runAt: v === "at" ? (plan.runAt ?? defaultRunAt()) : plan.runAt })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Only save the mapping</SelectItem>
            <SelectItem value="now">Research these companies now</SelectItem>
            <SelectItem value="at">Schedule research for later</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {plan.mode !== "none" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {plan.mode === "at" && (
            <div className="grid gap-2">
              <Label htmlFor="runAt">Run at (your local time)</Label>
              <Input id="runAt" type="datetime-local" value={plan.runAt ?? ""} onChange={(e) => onChange({ ...plan, runAt: e.target.value })} />
            </div>
          )}
          <div className="grid gap-2">
            <Label>Send digests by</Label>
            <div className="flex h-9 items-center gap-4">
              {(["email", "whatsapp"] as DeliveryChannel[]).map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={plan.channels.includes(c)} onCheckedChange={(v) => toggle(c, v === true)} />
                  {c === "email" ? "Email" : "WhatsApp"}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Imports() {
  const navigate = useNavigate()
  const history = useImports()
  const commitReal = useCommitBackendImport()
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<(ImportPreview & Partial<BackendImportPreview>) | null>(null)
  const [plan, setPlan] = useState<RunPlan>({ mode: "now", channels: ["email", "whatsapp"] })
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState(false)
  const committing = commitReal.isPending

  const handle = async (file: File) => {
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      toast.error("Only .xlsx or .csv files are accepted")
      return
    }
    setLoading(true)
    try {
      setPreview(await backend.uploadImport(file))
    } catch (e) {
      toast.error("Could not read the file", { description: errorMessage(e) })
    } finally {
      setLoading(false)
      if (input.current) input.current.value = ""
    }
  }

  const commit = async () => {
    if (!preview) return
    try {
      if (preview.id) {
        if (plan.mode === "at" && !plan.runAt) return toast.error("Pick a date and time for the research run")
        if (plan.mode !== "none" && plan.channels.length === 0) return toast.error("Choose at least one delivery channel")
        const schedule: RunPlan = plan.mode === "at" ? { ...plan, runAt: new Date(plan.runAt!).toISOString() } : plan
        const res = await commitReal.mutateAsync({ id: preview.id, schedule })
        setPreview(null)
        if (res.run) {
          toast.success("Import committed", {
            description: `${res.import.summary}. ${res.run.status === "scheduled" ? `Research scheduled for ${fmtDateTime(res.run.scheduledFor)}` : "Research queued"}.`,
            action: { label: "View job", onClick: () => navigate(`/jobs/${res.run!.id}`) },
          })
        } else toast.success("Import committed", { description: res.import.summary })
      }
    } catch (e) {
      toast.error("Commit failed", { description: errorMessage(e) })
    }
  }

  const errors = preview?.errorRows ?? preview?.issues.filter((i) => i.severity === "error").length ?? 0
  const valid = preview?.validRows ?? (preview ? preview.rows - errors : 0)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Imports"
        description="Upload the company → PAM mapping. Nothing changes until you review the preview and commit."
        actions={
          <Button variant="outline" onClick={downloadTemplate}>
            <Download /> Download template
          </Button>
        }
      />

      {!preview && (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              const f = e.dataTransfer.files[0]
              if (f) handle(f)
            }}
            className={cn(
              "flex min-h-56 flex-col items-center justify-center rounded-xl border-2 border-dashed bg-card p-8 text-center transition-colors",
              drag && "border-primary bg-primary/5",
            )}
          >
            {loading ? <Loader2 className="size-10 animate-spin text-primary" /> : <UploadCloud className="size-10 text-primary" />}
            <p className="mt-3 font-medium">{loading ? "Validating file…" : "Drop Excel or CSV here"}</p>
            <p className="mt-1 text-sm text-muted-foreground">.xlsx or .csv · max 10 MB · formulas are read as values</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button onClick={() => input.current?.click()} disabled={loading}>
                Browse files
              </Button>
            </div>
            <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Expected columns</CardTitle>
              <CardDescription>Header names are matched case-insensitively.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {COLUMNS.map(([c, d]) => (
                  <li key={c} className="flex items-start justify-between gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{c}</code>
                    <span className="text-right text-xs text-muted-foreground">{d}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="size-4 text-muted-foreground" /> Preview · {preview.fileName}
            </CardTitle>
            <CardDescription>{preview.rows} rows read. Review the changes before committing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ["New companies", preview.newCompanies],
                ["Updated", preview.updatedCompanies],
                ["Reassigned", preview.reassignments],
                ["Duplicates merged", preview.duplicatesMerged],
                ["New PAMs", preview.newPams],
              ].map(([l, v]) => (
                <div key={l as string} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{l}</p>
                  <p className="tabular text-xl font-semibold">{v}</p>
                </div>
              ))}
            </div>

            {preview.issues.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Validation</p>
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {preview.issues.map((i, k) => (
                    <div key={`${i.row}-${i.field}-${k}`} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
                      {i.severity === "error" ? <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
                      <div>
                        <span className="font-medium">
                          Row {i.row}
                          {i.company && ` · ${i.company}`}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          ({i.field}): {i.message}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Company</TableHead>
                    <TableHead>PAM</TableHead>
                    <TableHead>WhatsApp</TableHead>
                    <TableHead>Segment</TableHead>
                    <TableHead className="pr-4">Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.sample.map((s) => (
                    <TableRow key={s.company}>
                      <TableCell className="pl-4 font-medium">{s.company}</TableCell>
                      <TableCell>
                        {s.pam}
                        <p className="text-xs text-muted-foreground">{s.email}</p>
                      </TableCell>
                      <TableCell className={cn("tabular", s.whatsapp.startsWith("+") ? "" : "text-destructive")}>{s.whatsapp}</TableCell>
                      <TableCell className="text-muted-foreground">{s.segment ?? "—"}</TableCell>
                      <TableCell className="pr-4">
                        <Badge className={cn("capitalize", changeTone[s.change])}>{s.change}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {preview.id && (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <CalendarClock className="size-4 text-muted-foreground" /> Research job
                </p>
                <RunPlanPicker plan={plan} onChange={setPlan} />
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <p className="text-xs text-muted-foreground sm:mr-auto">
                {errors} row{errors === 1 ? "" : "s"} with errors will be skipped. Everything else commits in one transaction.
              </p>
              <Button variant="outline" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button disabled={committing || valid === 0} onClick={commit}>
                {committing ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                Commit {valid} rows
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <CardHeader className="pt-5">
          <CardTitle>Import history</CardTitle>
          <CardDescription>
            Research jobs started from an import appear under <Link to="/jobs" className="underline underline-offset-2">Jobs</Link>.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[40rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">File</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-5">Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.isError && (
                <TableRow>
                  <TableCell colSpan={5} className="pl-5 text-sm text-destructive">
                    {errorMessage(history.error)}
                  </TableCell>
                </TableRow>
              )}
              {history.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="pl-5 text-sm text-muted-foreground">
                    No imports yet.
                  </TableCell>
                </TableRow>
              )}
              {history.data?.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="pl-5 font-medium">{h.fileName}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDateTime(h.uploadedAt)}
                    <p className="text-xs">by {h.uploadedBy}</p>
                  </TableCell>
                  <TableCell className="tabular">{h.rows}</TableCell>
                  <TableCell>
                    <StatusBadge status={h.status === "committed" ? "completed" : h.status === "failed" ? "failed" : "pending"} label={h.status} />
                  </TableCell>
                  <TableCell className="whitespace-normal pr-5 text-sm text-muted-foreground">{h.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
