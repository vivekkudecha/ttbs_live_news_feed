/**
 * Columns of the results board. One set of columns serves both row kinds: a PAM row shows
 * roll-ups (outcome bar, signal count, digest delivery), a logo row shows its own result.
 * Column ids are the API's sort / filter ids (services/run_board.py).
 */
import type { ColumnDef, Row } from "@tanstack/react-table"
import {
  ChevronRight,
  ClipboardCopy,
  Eye,
  History,
  ListFilter,
  Mail,
  MoreHorizontal,
  RotateCcw,
  Send,
  UserRoundCog,
  XCircle,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BoardFacets, BoardLogo, BoardPam } from "@/api/types"
import { Avatar, DigestBadges, Findings, OutcomeBar } from "./cells"
import { DIGEST_STATUS, RESULT_STATUS, categoryLabel, n, pamKey } from "./board-utils"
import type { BoardView } from "./useBoardUrl"

export type PamRow = BoardPam & { subRows?: BoardRow[] }
export type MoreRow = { kind: "more"; id: string; pamKey: string; shown: number; total: number }
export type LoadingRow = { kind: "loading"; id: string }
export type BoardRow = PamRow | BoardLogo | MoreRow | LoadingRow

export interface BoardCtx {
  view: BoardView
  canManage: boolean
  facets?: BoardFacets
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  openLogo: (r: BoardLogo) => void
  openDigest: (pamId: string) => void
  retry: (b: { resultIds?: string[]; pamIds?: string[] }) => void
  resend: (pamIds: string[], names: string[]) => void
  reassign: (companyIds: string[]) => void
  onlyPam: (key: string) => void
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

/** Cell value for TanStack (it enables sort / filter only on columns with an accessor; the server does the work). */
const val = (r: BoardRow, id: string): unknown => (r.kind === "pam" || r.kind === "logo" ? (r as unknown as Record<string, unknown>)[id] ?? null : null)

export function boardColumns(ctx: BoardCtx): ColumnDef<BoardRow, unknown>[] {
  const grouped = ctx.view === "pam"
  const categoryOptions = (ctx.facets?.categories ?? []).map((c) => ({ value: c.value, label: categoryLabel(c.value) }))
  const cols: ColumnDef<BoardRow, unknown>[] = [
    {
      id: "select",
      size: 40,
      meta: { width: "2.5rem" },
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows on this page"
          checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
          onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
        />
      ),
      cell: ({ row }) =>
        row.getCanSelect() ? (
          <Checkbox
            aria-label={`Select ${row.original.kind === "pam" ? row.original.pamName : (row.original as BoardLogo).companyName}`}
            checked={row.getIsSelected() ? true : row.getIsSomeSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            onClick={stop}
          />
        ) : null,
    },
    {
      id: "account",
      accessorFn: (r) => val(r, "account"),
      size: grouped ? 270 : 250,
      enableHiding: false,
      meta: { label: "Logo", width: grouped ? "28%" : "21%", filter: { type: "text", placeholder: "Company name contains…" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title={grouped ? "PAM / logo" : "Logo"} />,
      cell: ({ row }) => <AccountCell row={row} ctx={ctx} />,
    },
  ]
  if (!grouped)
    cols.push({
      id: "pamName",
      accessorFn: (r) => val(r, "pamName"),
      size: 170,
      meta: { label: "PAM", width: "12%", filter: { type: "text", placeholder: "PAM name contains…" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
      cell: ({ row }) => {
        const r = row.original as BoardLogo
        return r.pamName ? (
          <span className="flex items-center gap-2">
            <Avatar name={r.pamName} className="size-6 shrink-0 text-2xs" />
            <span className="min-w-0 break-words">{r.pamName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        )
      },
    })
  const attempts: ColumnDef<BoardRow, unknown> = {
      id: "attempts",
      accessorFn: (r) => val(r, "attempts"),
      size: 100,
      meta: { label: "Attempts", width: "7%", align: "right", filter: { type: "range" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Attempts" align="right" />,
      cell: ({ row }) => {
        const r = row.original
        if (r.kind === "pam")
          return r.failed ? <span className="tabular font-semibold text-destructive">{n(r.failed)}</span> : <span className="text-muted-foreground">—</span>
        if (r.kind === "logo") return <span className={cn("tabular", r.attempts <= 1 && "text-muted-foreground")}>{r.attempts}</span>
        return null
      },
    }
  cols.push(
    {
      id: "status",
      accessorFn: (r) => val(r, "status"),
      size: grouped ? 150 : 120,
      meta: { label: "Status", width: grouped ? "13%" : "10%", filter: { type: "enum", options: RESULT_STATUS } },
      header: ({ column }) => <DataTableColumnHeader column={column} title={grouped ? "Outcome" : "Status"} />,
      cell: ({ row }) => {
        const r = row.original
        if (r.kind === "pam") return <OutcomeBar g={r} />
        if (r.kind === "logo") return <StatusBadge status={r.status === "running" ? "running" : r.status} />
        return null
      },
    },
    {
      id: "category",
      accessorFn: (r) => val(r, "category"),
      size: 130,
      meta: { label: "Category", width: grouped ? "9%" : "10%", filter: { type: "enum", options: categoryOptions } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Category" />,
      cell: ({ row }) => {
        const r = row.original
        if (r.kind !== "logo") return null
        return r.category ? <Badge variant="outline" className="max-w-full truncate" title={r.category}>{r.category}</Badge> : <span className="text-muted-foreground">—</span>
      },
    },
    {
      id: "findings",
      accessorFn: (r) => val(r, "findings"),
      enableSorting: grouped,
      meta: { label: "Findings", filter: { type: "text", placeholder: "Words in the findings…" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title={grouped ? "Signals / findings" : "Findings"} />,
      cell: ({ row }) => {
        const r = row.original
        if (r.kind === "pam")
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              {r.signal ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand">
                  <Zap className="size-3.5" /> {n(r.signal)} {r.signal === 1 ? "signal" : "signals"}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{r.pending ? "No signals yet" : "No signals"}</span>
              )}
              {r.failed > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
                  <XCircle className="size-3.5" /> {n(r.failed)} failed
                </span>
              )}
            </div>
          )
        if (r.kind === "logo")
          return (
            <div className="whitespace-normal break-words">
              <Findings r={r} onOpen={() => ctx.openLogo(r)} />
            </div>
          )
        return null
      },
    },
    {
      id: "digest",
      accessorFn: (r) => val(r, "digest"),
      size: 150,
      enableSorting: false,
      meta: { label: "Digest", width: grouped ? "11%" : "10%", filter: { type: "enum", options: DIGEST_STATUS } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Digest" />,
      cell: ({ row }) => {
        const r = row.original
        if (r.kind === "pam") return <DigestBadges g={r} />
        if (r.kind === "logo" && !grouped)
          return r.digest === "none" ? (
            <span className="text-xs text-muted-foreground">Not yet</span>
          ) : (
            <StatusBadge status={r.digest === "sending" ? "running" : r.digest} />
          )
        return null
      },
    },
    ...(grouped ? [] : [attempts]),
    {
      id: "finishedAt",
      accessorFn: (r) => val(r, "finishedAt"),
      size: 150,
      meta: { label: "Finished", width: "10%", filter: { type: "date" } },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Finished" />,
      cell: ({ row }) => {
        const r = row.original
        const at = r.kind === "pam" || r.kind === "logo" ? r.finishedAt : null
        return <span className="tabular whitespace-nowrap text-xs text-muted-foreground">{at ? fmtDateTime(at) : "—"}</span>
      },
    },
    {
      id: "actions",
      size: 56,
      enableSorting: false,
      enableHiding: false,
      meta: { width: "2.75rem" },
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => <RowActions row={row.original} ctx={ctx} />,
    },
  )
  return cols
}

function AccountCell({ row, ctx }: { row: Row<BoardRow>; ctx: BoardCtx }) {
  const r = row.original
  if (r.kind === "pam") {
    const key = pamKey(r)
    const open = ctx.isOpen(key)
    return (
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${r.pamName}'s logos`}
          onClick={(e) => {
            e.stopPropagation()
            ctx.toggle(key)
          }}
          className="-ml-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className={cn("size-4 transition-transform duration-200", open && "rotate-90")} />
        </button>
        <Avatar name={r.pamName} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={r.pamName}>{r.pamName}</p>
          <p className="flex min-w-0 text-xs text-muted-foreground">
            {r.pamEmail && (
              <span className="truncate" title={r.pamEmail}>
                {r.pamEmail}
              </span>
            )}
            <span className="shrink-0 whitespace-nowrap">
              {r.pamEmail && <span className="px-1">·</span>}
              {n(r.logos)} {r.logos === 1 ? "logo" : "logos"}
            </span>
          </p>
        </div>
      </div>
    )
  }
  if (r.kind !== "logo") return null
  return (
    <div className={cn("min-w-0", row.depth > 0 && "relative pl-8")}>
      {row.depth > 0 && <span aria-hidden="true" className="absolute bottom-[-0.9rem] left-[0.6875rem] top-[-0.9rem] w-px bg-border" />}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          ctx.openLogo(r)
        }}
        className="text-left font-medium leading-snug underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {r.companyName}
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {r.industry}
        {r.cached && <Badge variant="secondary">cached</Badge>}
        {r.attempts > 1 && <Badge variant="secondary">{r.attempts} attempts</Badge>}
      </div>
    </div>
  )
}

function RowActions({ row: r, ctx }: { row: BoardRow; ctx: BoardCtx }) {
  if (r.kind !== "pam" && r.kind !== "logo") return null
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Could not copy"),
    )
  return (
    <div className="flex justify-end" onClick={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Row actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {r.kind === "pam" ? (
            <>
              <DropdownMenuLabel className="truncate">{r.pamName}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => ctx.toggle(pamKey(r))}>
                <ChevronRight /> {ctx.isOpen(pamKey(r)) ? "Hide logos" : "Show logos"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.onlyPam(pamKey(r))}>
                <ListFilter /> Show only this PAM
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!r.pamId} onSelect={() => r.pamId && ctx.openDigest(r.pamId)}>
                <Eye /> Preview digest
              </DropdownMenuItem>
              {ctx.canManage && (
                <DropdownMenuItem disabled={!r.pamId || !Object.keys(r.digests).length} onSelect={() => r.pamId && ctx.resend([r.pamId], [r.pamName])}>
                  <Send /> Resend digest
                </DropdownMenuItem>
              )}
              {ctx.canManage && r.failed > 0 && (
                <DropdownMenuItem onSelect={() => ctx.retry({ pamIds: [pamKey(r)] })}>
                  <RotateCcw /> Retry {r.failed} failed {r.failed === 1 ? "logo" : "logos"}
                </DropdownMenuItem>
              )}
              {r.pamEmail && (
                <DropdownMenuItem onSelect={() => copy(r.pamEmail!)}>
                  <Mail /> Copy email
                </DropdownMenuItem>
              )}
            </>
          ) : (
            <>
              <DropdownMenuLabel className="truncate">{r.companyName}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => ctx.openLogo(r)}>
                <History /> Details &amp; timeline
              </DropdownMenuItem>
              {r.pamId && (
                <DropdownMenuItem onSelect={() => ctx.openDigest(r.pamId!)}>
                  <Eye /> Preview {r.pamName?.split(" ")[0] ?? "PAM"}'s digest
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {ctx.canManage && r.status === "failed" && (
                <DropdownMenuItem onSelect={() => ctx.retry({ resultIds: [r.id] })}>
                  <RotateCcw /> Retry research
                </DropdownMenuItem>
              )}
              {ctx.canManage && (
                <DropdownMenuItem onSelect={() => ctx.reassign([r.companyId])}>
                  <UserRoundCog /> Reassign PAM
                </DropdownMenuItem>
              )}
              {r.status === "signal" && (
                <DropdownMenuItem
                  onSelect={() =>
                    copy([r.companyName, r.keySignals, r.opportunity && `Opportunity: ${r.opportunity}`, r.outreach && `Outreach: ${r.outreach}`].filter(Boolean).join("\n").replace(/\*\*/g, ""))
                  }
                >
                  <ClipboardCopy /> Copy findings
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
