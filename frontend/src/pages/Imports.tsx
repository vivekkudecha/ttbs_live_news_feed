/**
 * Uploads: every research run starts from one. Each uploaded Excel/CSV is a named, time-stamped
 * upload; logos and PAMs already known are matched (not duplicated) and owner changes go to the
 * history. Uploads still saving show live progress and resume on their own after interruptions.
 * Each row shows how often the upload has been researched, and can be run again.
 */
import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"
import { Download, FileSpreadsheet, FolderOpen, History, Loader2, RotateCcw, Zap } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useServerTable } from "@/components/data-table/useSmartTable"
import { UploadDialog, downloadTemplate } from "@/components/datasets/UploadFlow"
import { useResumeDataset } from "@/api/hooks"
import { backend, datasetFileUrl, errorMessage } from "@/api/http"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Dataset } from "@/api/types"
import { Page } from "@/components/common/layout"

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

const SAVING = new Set(["analyzing", "queued", "processing"])

export default function Imports() {
  const resume = useResumeDataset()
  const [params, setParams] = useSearchParams()
  const open = params.get("open")
  const setOpen = (id: string | null) =>
    setParams(
      (p) => {
        if (id) p.set("open", id)
        else p.delete("open")
        return p
      },
      { replace: true },
    )

  const columns = useMemo<ColumnDef<Dataset, unknown>[]>(
    () => [
      {
        id: "label",
        accessorKey: "label",
        enableHiding: false,
        meta: { label: "Upload", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Upload" />,
        cell: ({ row }) => {
          const d = row.original
          return (
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover/row:bg-primary group-hover/row:text-primary-foreground">
                <FileSpreadsheet className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold">{d.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {d.fileName} · by {d.uploadedBy}
                </p>
              </div>
            </div>
          )
        },
      },
      {
        id: "uploadedAt",
        accessorKey: "uploadedAt",
        meta: { label: "Uploaded", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Uploaded" />,
        cell: ({ row }) => <span className="tabular whitespace-nowrap text-sm text-muted-foreground">{fmtDateTime(row.original.uploadedAt)}</span>,
      },
      {
        id: "status",
        accessorKey: "status",
        meta: {
          label: "Status",
          filter: {
            type: "enum",
            options: [
              { value: "completed", label: "Saved" },
              { value: "processing", label: "Saving" },
              { value: "queued", label: "Waiting" },
              { value: "failed", label: "Stopped / rejected" },
            ],
          },
        },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <SaveState d={row.original} />,
      },
      {
        id: "rowsTotal",
        accessorKey: "rowsTotal",
        meta: { label: "Rows saved", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Rows saved" align="right" />,
        cell: ({ row }) => (
          <span className="tabular">
            {n(row.original.saved)}
            <span className="text-muted-foreground">/{n(row.original.validRows)}</span>
          </span>
        ),
      },
      {
        id: "errorRows",
        accessorKey: "errorRows",
        meta: { label: "Skipped", align: "right", filter: { type: "range" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Skipped" align="right" />,
        cell: ({ row }) => <span className={cn("tabular", row.original.errorRows > 0 && "font-medium text-destructive")}>{n(row.original.errorRows)}</span>,
      },
      {
        id: "companies",
        accessorKey: "companies",
        enableSorting: false,
        meta: { label: "Logos", align: "right" },
        header: () => <span className="block text-right">Logos</span>,
        cell: ({ row }) => <span className="tabular">{row.original.companies === null ? "—" : n(row.original.companies)}</span>,
      },
      {
        id: "changes",
        enableSorting: false,
        meta: { label: "Changes" },
        header: "Changes",
        cell: ({ row }) => {
          const d = row.original
          return d.status === "failed" && d.error ? (
            <span className="line-clamp-2 whitespace-normal text-xs text-destructive">{d.error}</span>
          ) : (
            <span className="flex flex-wrap gap-1 text-xs [&>span]:whitespace-nowrap">
              <span className="rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">{n(d.newCompanies)} new</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{n(d.unchanged ?? 0)} known</span>
              {d.reassignments > 0 && <span className="rounded-full bg-warning/12 px-2 py-0.5 font-medium text-warning">{n(d.reassignments)} reassigned</span>}
              {d.newPams > 0 && <span className="rounded-full bg-brand-blue/10 px-2 py-0.5 font-medium text-brand-blue">{n(d.newPams)} new PAMs</span>}
            </span>
          )
        },
      },
      {
        id: "runs",
        enableSorting: false,
        meta: { label: "Research runs" },
        header: "Research runs",
        cell: ({ row }) => {
          const d = row.original
          return d.runs ? (
            <Link to={`/runs?q=${encodeURIComponent(d.label)}`} className="text-sm hover:underline" onClick={(e) => e.stopPropagation()}>
              <span className="tabular font-medium">{n(d.runs)}×</span>
              <span className="block text-xs text-muted-foreground">last {fmtDateTime(d.lastRunAt)}</span>
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">Not run yet</span>
          )
        },
      },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const d = row.original
          return (
            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
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
                  {d.status !== "completed" ? <FolderOpen /> : d.runs ? <History /> : <Zap />}{" "}
                  {d.status !== "completed" ? "Open" : d.runs ? "Run again" : "Research"}
                </Button>
              )}
              {d.hasFile && (
                <Button size="icon-sm" variant="ghost" asChild>
                  <a href={datasetFileUrl(d.id)} download aria-label={`Download the original file of “${d.label}”`} title="Download the original file">
                    <Download />
                  </a>
                </Button>
              )}
            </div>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resume.isPending],
  )

  const state = useServerTable<Dataset>({
    id: "uploads",
    columns,
    queryKey: ["datasets"],
    fetcher: (q) => backend.listDatasets(q),
    defaultSort: { id: "uploadedAt", desc: true },
    getRowId: (d) => d.id,
    // Poll every 2 s while any visible upload is still being saved.
    refetchInterval: (data) => (data?.rows.some((d) => SAVING.has(d.status)) ? 2_000 : false),
  })
  const nothingYet = !state.loading && state.total === 0 && state.table.getState().columnFilters.length === 0

  return (
    <Page>
      <PageHeader
        title="Uploads"
        description="Every research run starts from an upload. Logos and PAMs already in the system are matched, not duplicated; owner changes are kept in the history."
        actions={
          <>
            <Button variant="outline" onClick={downloadTemplate}>
              <Download /> Template
            </Button>
            <UploadDialog />
          </>
        }
      />

      {nothingYet ? (
        <EmptyState icon={FileSpreadsheet} title="No uploads yet">
          <p>Upload the company → PAM Excel to get started. Columns: Company, PAM Name, PAM Email, PAM WhatsApp, and optionally Industry and Segment.</p>
          <div className="mt-4 flex justify-center">
            <UploadDialog />
          </div>
        </EmptyState>
      ) : (
        <SmartTable
          state={state}
          onRowClick={(d) => setOpen(d.id)}
          minWidth="64rem"
          toolbar={
            <p className="text-sm text-muted-foreground">
              <span className="tabular font-medium text-foreground">{n(state.total)}</span> uploads · click one to research it again or edit its rows
            </p>
          }
          empty={
            <EmptyState icon={FileSpreadsheet} title="No uploads match">
              Clear a filter to see every upload.
            </EmptyState>
          }
        />
      )}

      <UploadDialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)} datasetId={open ?? undefined} />
    </Page>
  )
}
