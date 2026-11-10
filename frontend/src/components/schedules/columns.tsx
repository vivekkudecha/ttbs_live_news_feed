/** Table columns for the Schedules page. */
import type { ColumnDef } from "@tanstack/react-table"
import { CalendarDays, CalendarRange, FileSpreadsheet, Layers, Repeat } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import type { Schedule } from "@/api/schedules"
import type { DeliveryChannel } from "@/api/types"
import { ScheduleActions } from "./ScheduleActions"
import { Delivery, LastRun, When } from "./cells"


const FREQUENCY = {
  interval: { label: "Every N days", icon: Repeat },
  weekly: { label: "Weekly", icon: CalendarDays },
  monthly: { label: "Monthly", icon: CalendarRange },
}

/** One filterable value per channel combination. */
const deliveryKey = (c: DeliveryChannel[]) => (c.length === 2 ? "both" : c[0] ?? "none")
const DELIVERY_OPTIONS = [
  { value: "both", label: "Email + WhatsApp" },
  { value: "email", label: "Email only" },
  { value: "whatsapp", label: "WhatsApp only" },
  { value: "none", label: "Research only" },
]

export function scheduleColumns(onToggle: (s: Schedule, on: boolean) => void): ColumnDef<Schedule, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      meta: { label: "Schedule", filter: { type: "text", placeholder: "Name contains…" }, width: "24%" },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Schedule" />,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.original.name}</p>
          <p className="truncate text-xs text-muted-foreground">{row.original.summary} IST</p>
        </div>
      ),
    },
    {
      id: "target",
      accessorKey: "target",
      meta: { label: "Researches", filter: { type: "enum", options: [{ value: "upload", label: "A specific upload" }, { value: "latest", label: "Latest upload" }] }, width: "22%" },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Researches" />,
      cell: ({ row }) => {
        const s = row.original
        const Icon = s.target === "latest" ? Layers : FileSpreadsheet
        return (
          <span className="flex min-w-0 items-center gap-1.5 text-sm">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{s.targetLabel}</span>
          </span>
        )
      },
    },
    {
      id: "frequency",
      accessorKey: "frequency",
      meta: { label: "Repeat", filter: { type: "enum", options: Object.entries(FREQUENCY).map(([value, f]) => ({ value, label: f.label })) } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Repeat" />,
      cell: ({ row }) => {
        const f = FREQUENCY[row.original.frequency]
        return (
          <Badge variant="outline" className="gap-1 font-normal">
            <f.icon className="size-3" /> {f.label}
          </Badge>
        )
      },
    },
    {
      id: "delivery",
      accessorFn: (s) => deliveryKey(s.channels),
      meta: { label: "Delivery", filter: { type: "enum", options: DELIVERY_OPTIONS } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Delivery" />,
      cell: ({ row }) => <Delivery channels={row.original.channels} />,
    },
    {
      id: "nextRunAt",
      accessorFn: (s) => s.nextRunAt ?? undefined, // paused: sorts last
      sortUndefined: "last",
      meta: { label: "Next run", filter: { type: "date" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Next run" />,
      cell: ({ row }) => <When iso={row.original.nextRunAt} paused={!row.original.enabled} />,
    },
    {
      id: "lastOutcome",
      accessorFn: (s) => s.lastOutcome ?? "never",
      meta: {
        label: "Last run",
        filter: { type: "enum", options: [{ value: "started", label: "Started" }, { value: "skipped", label: "Skipped" }, { value: "failed", label: "Did not start" }, { value: "never", label: "Not run yet" }] },
        width: "18%",
      },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Last run" />,
      cell: ({ row }) => <LastRun s={row.original} />,
    },
    {
      id: "runs",
      accessorKey: "runs",
      meta: { label: "Runs", filter: { type: "range" }, align: "right", width: "5.5rem" },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Runs" align="right" />,
      cell: ({ row }) => <span className="tabular block text-right font-medium">{row.original.runs.toLocaleString("en-IN")}</span>,
    },
    {
      id: "enabled",
      accessorKey: "enabled",
      enableSorting: false,
      meta: { label: "On", width: "4.5rem" },
      header: () => <span>On</span>,
      cell: ({ row }) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Switch checked={row.original.enabled} onCheckedChange={(on) => onToggle(row.original, on)} aria-label={row.original.enabled ? "Pause schedule" : "Resume schedule"} />
        </span>
      ),
    },
    {
      id: "createdBy",
      accessorKey: "createdBy",
      meta: { label: "Created by", filter: { type: "text" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Created by" />,
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.createdBy}</span>,
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      meta: { width: "3.5rem" },
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => <ScheduleActions s={row.original} />,
    },
  ]
}
