/**
 * Imports: every uploaded Excel is a named, time-stamped dataset. Upload opens the dialog
 * (label → file → background save with progress → research / view & edit data). Datasets that
 * are still saving show live progress here and resume on their own after interruptions.
 */
import { useState } from "react"
import { toast } from "sonner"
import { Download, FileSpreadsheet, FolderOpen, Loader2, RotateCcw, Search, Zap } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { UploadDialog, downloadTemplate } from "@/components/datasets/UploadFlow"
import { useDatasets, useResumeDataset } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Dataset } from "@/api/types"

const n = (x: number) => x.toLocaleString("en-IN")

function SaveState({ d }: { d: Dataset }) {
  if (d.status === "completed") return <StatusBadge status="completed" label="Saved" />
  if (d.status === "failed") return <StatusBadge status="failed" label={d.validRows ? "Stopped" : "Rejected"} />
  return (
    <div className="w-40 space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-info">{d.status === "queued" ? "Waiting…" : "Saving…"}</span>
        <span className="tabular text-muted-foreground">{d.progress}%</span>
      </div>
      <Progress value={d.progress} className="h-1.5 [&>div]:bg-info" aria-label={`${d.progress}% saved`} />
    </div>
  )
}

export default function Imports() {
  const datasets = useDatasets()
  const resume = useResumeDataset()
  const [open, setOpen] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const rows = (datasets.data ?? []).filter((d) => !search.trim() || `${d.label} ${d.fileName} ${d.uploadedBy}`.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <div>
      <PageHeader
        title="Imports"
        description="Each uploaded Excel is kept as a named, time-stamped dataset. Rows are saved in the background and the save resumes by itself after any interruption."
        actions={
          <>
            <Button variant="outline" onClick={downloadTemplate}>
              <Download /> Template
            </Button>
            <UploadDialog />
          </>
        }
      />

      {datasets.isLoading ? (
        <Skeleton className="h-64" />
      ) : datasets.isError ? (
        <p className="text-sm text-destructive">{errorMessage(datasets.error)}</p>
      ) : !datasets.data?.length ? (
        <EmptyState icon={FileSpreadsheet} title="No datasets yet">
          <p>Upload the company → PAM Excel to get started. Columns: Company, PAM Name, PAM Email, PAM WhatsApp, and optionally Industry and Segment.</p>
          <div className="mt-4 flex justify-center">
            <UploadDialog />
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="relative sm:w-80">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search datasets" placeholder="Search datasets" className="h-9 pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Card className="py-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="min-w-[56rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Dataset</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Rows saved</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                    <TableHead className="text-right">Companies</TableHead>
                    <TableHead>Changes</TableHead>
                    <TableHead className="pr-5 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.id} className="cursor-pointer" onClick={() => setOpen(d.id)}>
                      <TableCell className="pl-5">
                        <p className="font-medium">{d.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {fmtDateTime(d.uploadedAt)} · {d.fileName} · by {d.uploadedBy}
                        </p>
                      </TableCell>
                      <TableCell>
                        <SaveState d={d} />
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {n(d.saved)}
                        <span className="text-muted-foreground">/{n(d.validRows)}</span>
                      </TableCell>
                      <TableCell className={cn("tabular text-right", d.errorRows > 0 && "text-destructive")}>{n(d.errorRows)}</TableCell>
                      <TableCell className="tabular text-right">{d.companies === null ? "—" : n(d.companies)}</TableCell>
                      <TableCell className="whitespace-normal text-xs text-muted-foreground">
                        {d.status === "failed" && d.error ? <span className="text-destructive">{d.error}</span> : `${n(d.newCompanies)} new · ${n(d.updatedCompanies)} updated · ${n(d.reassignments)} reassigned · ${n(d.newPams)} new PAMs`}
                      </TableCell>
                      <TableCell className="pr-5 text-right" onClick={(e) => e.stopPropagation()}>
                        {d.status === "failed" && d.validRows > 0 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resume.isPending}
                            onClick={() =>
                              resume.mutate(d.id, {
                                onSuccess: () => toast.success(`Resuming “${d.label}” from row ${n(d.saved + 1)}`),
                                onError: (e) => toast.error("Could not resume", { description: errorMessage(e) }),
                              })
                            }
                          >
                            {resume.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Resume
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setOpen(d.id)}>
                            {d.status === "completed" ? <Zap /> : <FolderOpen />} {d.status === "completed" ? "Research / edit" : "Open"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="h-20 text-center text-sm text-muted-foreground">
                        No datasets match “{search}”.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      <UploadDialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)} datasetId={open ?? undefined} />
    </div>
  )
}
