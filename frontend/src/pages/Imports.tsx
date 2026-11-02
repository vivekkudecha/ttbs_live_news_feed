import { useRef, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, UploadCloud, XCircle } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/api/client"
import { useCommitImport, useImports } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ImportPreview } from "@/api/types"

const COLUMNS = [
  ["Company", "required"],
  ["PAM Name", "required"],
  ["PAM Email", "required"],
  ["PAM WhatsApp", "required, E.164 e.g. +91 98xxx xxxxx"],
  ["Region", "optional"],
  ["Segment", "optional"],
]

const changeTone: Record<string, string> = {
  new: "bg-success/15 text-success",
  updated: "bg-info/15 text-info",
  reassigned: "bg-warning/20 text-[color-mix(in_oklch,var(--warning),black_40%)] dark:text-warning",
  unchanged: "bg-muted text-muted-foreground",
}

export default function Imports() {
  const { user } = useSession()
  const history = useImports()
  const commit = useCommitImport()
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState(false)
  const editable = can.manageData(user!.role)

  const handle = async (name: string) => {
    if (!/\.(xlsx|csv)$/i.test(name)) {
      toast.error("Only .xlsx or .csv files are accepted")
      return
    }
    setLoading(true)
    setPreview(await api.previewImport(name))
    setLoading(false)
  }

  const errors = preview?.issues.filter((i) => i.severity === "error").length ?? 0

  return (
    <div className="space-y-8">
      <PageHeader
        title="Imports"
        description="Upload the company → PAM mapping. Nothing changes until you review the preview and commit."
        actions={
          <Button variant="outline" onClick={() => toast.success("Template downloaded (prototype)")}>
            <Download /> Download template
          </Button>
        }
      />

      {editable && !preview && (
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
              if (f) handle(f.name)
            }}
            className={cn(
              "flex min-h-56 flex-col items-center justify-center rounded-xl border-2 border-dashed bg-card p-8 text-center transition-colors",
              drag && "border-primary bg-primary/5",
            )}
          >
            {loading ? <Loader2 className="size-10 animate-spin text-primary" /> : <UploadCloud className="size-10 text-primary" />}
            <p className="mt-3 font-medium">{loading ? "Validating file…" : "Drop Excel or CSV here"}</p>
            <p className="mt-1 text-sm text-muted-foreground">.xlsx or .csv · max 10 MB · macros and formulas are ignored</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button onClick={() => input.current?.click()} disabled={loading}>
                Browse files
              </Button>
              <Button variant="ghost" onClick={() => handle("ttbs_logos_pam_mapping_nov.xlsx")} disabled={loading}>
                Use sample file
              </Button>
            </div>
            <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && handle(e.target.files[0].name)} />
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
                ["Aliases merged", preview.duplicatesMerged],
                ["New PAMs", preview.newPams],
              ].map(([l, v]) => (
                <div key={l as string} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{l}</p>
                  <p className="tabular text-xl font-semibold">{v}</p>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Validation</p>
              {preview.issues.map((i) => (
                <div key={i.row} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
                  {i.severity === "error" ? <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
                  <div>
                    <span className="font-medium">
                      Row {i.row} · {i.company}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      ({i.field}): {i.message}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Company</TableHead>
                    <TableHead>PAM</TableHead>
                    <TableHead>WhatsApp</TableHead>
                    <TableHead>Region</TableHead>
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
                      <TableCell>{s.region}</TableCell>
                      <TableCell className="pr-4">
                        <Badge className={cn("capitalize", changeTone[s.change])}>{s.change}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <p className="text-xs text-muted-foreground sm:mr-auto">
                {errors} row{errors === 1 ? "" : "s"} with errors will be skipped. Everything else commits in one transaction.
              </p>
              <Button variant="outline" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button
                disabled={commit.isPending}
                onClick={async () => {
                  const rec = await commit.mutateAsync(preview.fileName)
                  toast.success("Import committed", { description: rec.summary })
                  setPreview(null)
                }}
              >
                {commit.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                Commit {preview.rows - errors} rows
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <CardHeader className="pt-5">
          <CardTitle>Import history</CardTitle>
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
