/** Process-event columns, shared by the Telemetry page and a run's "Events" tab. */
import { Link } from "react-router-dom"
import type { ColumnDef } from "@tanstack/react-table"
import { CheckCircle2, CircleSlash, Info, RotateCcw, XCircle, type LucideIcon } from "lucide-react"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import type { EventStatus, ProcessEvent } from "@/api/types"
import { fmtDateTime } from "@/lib/format"
import { fmtMs, kindLabel } from "@/lib/telemetry"
import { cn } from "@/lib/utils"

const n = (x: number) => x.toLocaleString("en-IN")

export const EVENT_STATUS: Record<EventStatus, { icon: LucideIcon; cls: string; label: string }> = {
  ok: { icon: CheckCircle2, cls: "text-success", label: "OK" },
  retry: { icon: RotateCcw, cls: "text-warning", label: "Retry" },
  error: { icon: XCircle, cls: "text-destructive", label: "Error" },
  skipped: { icon: CircleSlash, cls: "text-muted-foreground", label: "Skipped" },
  info: { icon: Info, cls: "text-info", label: "Info" },
}

/** Status = icon + text, never colour alone. */
function Outcome({ status }: { status: EventStatus }) {
  const s = EVENT_STATUS[status] ?? EVENT_STATUS.info
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <s.icon className={cn("size-3.5", s.cls)} aria-hidden="true" />
      {s.label}
    </span>
  )
}

export function eventColumns(showRun: boolean): ColumnDef<ProcessEvent, unknown>[] {
  return [
    {
      id: "ts",
      accessorKey: "ts",
      size: 170,
      meta: { label: "Time", filter: { type: "date" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time (IST)" />,
      cell: ({ row }) => <span className="tabular whitespace-nowrap text-sm text-muted-foreground">{fmtDateTime(row.original.ts)}</span>,
    },
    {
      id: "kind",
      accessorKey: "kind",
      meta: { label: "Step", filter: { type: "text", placeholder: "e.g. research. or notify.attempt" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Step" />,
      cell: ({ row }) => {
        const e = row.original
        return (
          <div>
            <span className="font-medium">{kindLabel(e.kind)}</span>
            <p className="text-xs text-muted-foreground">
              {showRun && e.runId ? (
                <Link to={`/runs/${e.runId}?tab=timeline`} className="hover:underline" onClick={(ev) => ev.stopPropagation()}>
                  Run #{e.runId}
                </Link>
              ) : null}
              {showRun && e.runId && (e.companyId || e.attempt) ? " · " : null}
              {e.companyId ? `logo ${e.companyId}` : null}
              {e.attempt ? ` · attempt ${e.attempt}` : null}
              {!showRun && !e.companyId && e.attrs.channel ? String(e.attrs.channel) : null}
            </p>
          </div>
        )
      },
    },
    {
      id: "status",
      accessorKey: "status",
      meta: {
        label: "Outcome",
        filter: { type: "enum", options: (Object.keys(EVENT_STATUS) as EventStatus[]).map((s) => ({ value: s, label: EVENT_STATUS[s].label })) },
      },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Outcome" />,
      cell: ({ row }) => <Outcome status={row.original.status} />,
    },
    {
      id: "message",
      accessorKey: "message",
      enableSorting: false,
      meta: { label: "Detail", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Detail" />,
      cell: ({ row }) => {
        const e = row.original
        return (
          <span className="line-clamp-2 max-w-md whitespace-normal break-words text-sm text-muted-foreground">
            {e.message ?? (e.attrs.cached ? "Answer reused from cache" : e.attrs.outcome ? String(e.attrs.outcome).replace("_", " ") : "—")}
          </span>
        )
      },
    },
    {
      id: "durationMs",
      accessorKey: "durationMs",
      meta: { label: "Duration", align: "right", filter: { type: "range", unit: "ms" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Duration" align="right" />,
      cell: ({ row }) => <span className="tabular text-sm">{fmtMs(row.original.durationMs)}</span>,
    },
    {
      id: "tokens",
      enableSorting: false,
      meta: { label: "Tokens", align: "right" },
      header: () => <span className="block text-right">Tokens</span>,
      cell: ({ row }) => {
        const e = row.original
        return <span className="tabular text-sm text-muted-foreground">{e.tokensIn || e.tokensOut ? `${n(e.tokensIn ?? 0)} / ${n(e.tokensOut ?? 0)}` : "—"}</span>
      },
    },
    {
      id: "actor",
      accessorKey: "actor",
      meta: { label: "Actor", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Actor" />,
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.actor ?? "—"}</span>,
    },
  ]
}
