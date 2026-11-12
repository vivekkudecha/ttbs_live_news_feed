import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { getCoreRowModel, useReactTable, type ColumnDef, type PaginationState, type RowSelectionState, type SortingState, type VisibilityState } from "@tanstack/react-table"
import { Building2, Copy, Download, FileSpreadsheet, Mail, MessageCircle, MoreHorizontal, Pencil, Users, X } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatusBadge } from "@/components/common/StatusBadge"
import { DataTable } from "@/components/data-table/DataTable"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { DataTableFacetedFilter } from "@/components/data-table/DataTableFacetedFilter"
import { DataTablePagination } from "@/components/data-table/DataTablePagination"
import { DataTableCompactPager } from "@/components/data-table/DataTableCompactPager"
import { DataTableViewOptions } from "@/components/data-table/DataTableViewOptions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Toolbar, ToolbarSearch } from "@/components/data-table/Toolbar"
import { Skeleton } from "@/components/ui/skeleton"
import { usePamPage } from "@/api/hooks"
import { useDebounced } from "@/lib/use-debounced"
import { initials } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { PamCard } from "@/api/types"
import { Page } from "@/components/common/layout"
import { EditPamDialog } from "@/components/pams/EditPamDialog"
import { useSession } from "@/context/session"
import { can } from "@/lib/access"

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Copied", { description: text })
  } catch {
    toast.error("Couldn't copy. Select the text and copy it manually.")
  }
}

export default function Pams() {
  const navigate = useNavigate()
  const { user } = useSession()
  const canManage = can(user, "pams", "manage")
  const [editing, setEditing] = useState<PamCard | null>(null)

  // 5,000 PAMs: searched, filtered, sorted and paged on the server (same model as Companies).
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 })
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ whatsapp: false })
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<string[]>(["active"])
  const q = useDebounced(search, 250)
  const resetPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }))

  const query = usePamPage({
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
    search: q,
    status: status as ("active" | "inactive")[],
    sort: sorting[0],
  })
  const page = query.data

  const columns = useMemo<ColumnDef<PamCard>[]>(() => {
    const cols: ColumnDef<PamCard>[] = []
      cols.push({
        id: "select",
        size: 40,
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all on this page"
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
          />
        ),
        cell: ({ row }) => (
          <div className="-m-2 p-2" onClick={(e) => e.stopPropagation()}>
            <Checkbox aria-label={`Select ${row.original.name}`} checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(v === true)} />
          </div>
        ),
      })
    cols.push(
      {
        id: "name",
        accessorKey: "name",
        meta: { label: "PAM" },
        enableHiding: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="PAM" />,
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <Avatar className="size-8">
              <AvatarFallback className="bg-accent text-xs font-medium text-accent-foreground">{initials(row.original.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.name}</p>
              <p className="truncate text-xs text-muted-foreground">{row.original.email}</p>
            </div>
          </div>
        ),
      },
      {
        id: "load",
        accessorKey: "load",
        meta: { label: "Logos" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Logos" />,
        cell: ({ row }) => <span className="tabular font-medium">{row.original.load.toLocaleString("en-IN")}</span>,
      },
      {
        id: "whatsapp",
        accessorKey: "whatsapp",
        meta: { label: "WhatsApp number" },
        enableSorting: false,
        header: "WhatsApp number",
        cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.whatsapp}</span>,
      },
      {
        id: "notify",
        meta: { label: "Delivery" },
        enableSorting: false,
        header: "Delivery",
        cell: ({ row }) => (
          <span className="flex items-center gap-3 text-xs">
            <span className={cn("inline-flex items-center gap-1", row.original.notifyEmail ? "text-foreground/80" : "text-muted-foreground/60 line-through")}>
              <Mail className="size-3.5" /> Email
            </span>
            <span className={cn("inline-flex items-center gap-1", row.original.notifyWhatsapp ? "text-foreground/80" : "text-muted-foreground/60 line-through")}>
              <MessageCircle className="size-3.5" /> WhatsApp
            </span>
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "active",
        meta: { label: "Status" },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.active ? "active" : "inactive"} />,
      },
      {
        id: "actions",
        size: 48,
        enableHiding: false,
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const p = row.original
          return (
            <div className="text-right" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`} className="opacity-70 group-hover/row:opacity-100 data-[state=open]:opacity-100">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="truncate text-xs text-muted-foreground">{p.name}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => navigate(`/companies?pam=${p.id}`)}>
                    <Building2 /> View {p.load} logos
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => copy(p.email)}>
                    <Copy /> Copy email
                  </DropdownMenuItem>
                  {canManage && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setEditing(p)}>
                        <Pencil /> Edit details
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    )
    return cols
    // navigate is stable; columns rebuild when the role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage])

  const table = useReactTable({
    data: page?.rows ?? [],
    columns,
    getRowId: (r) => r.id,
    state: { sorting, pagination, columnVisibility, rowSelection },
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: page?.total ?? 0,
    enableRowSelection: true,
    enableSortingRemoval: false,
    onSortingChange: (u) => {
      setSorting(u)
      resetPage()
    },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  })

  const setFilter = (fn: (v: string[]) => void) => (v: string[]) => {
    fn(v)
    resetPage()
  }
  const filtered = search !== "" || status.join() !== "active"
  const selectedIds = Object.keys(rowSelection)

  return (
    <Page>
      <PageHeader
        title="PAMs"
        description="Sales owners for logos. Each PAM gets one digest per cycle covering all their companies. Select a PAM to see their logos."
      />
      <Alert>
        <FileSpreadsheet />
        <AlertTitle>Uploads decide who owns each logo</AlertTitle>
        <AlertDescription>
          Each upload maps logos to PAMs, and its research runs deliver to those PAMs. A newer upload can give a logo to a different PAM;
          its history and past results stay with the company. To move logos by hand, select them on Companies and choose Reassign.
        </AlertDescription>
      </Alert>

      <div>
        <Toolbar>
          <ToolbarSearch
            label="Search PAMs"
            placeholder="Search name or email"
            value={search}
            onChange={(v) => {
              setSearch(v)
              resetPage()
            }}
          />
          <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
            <DataTableFacetedFilter
              title="Status"
              value={status}
              onChange={setFilter(setStatus)}
              counts={page?.facets.status}
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
            />
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setStatus(["active"])
                  setSearch("")
                  resetPage()
                }}
              >
                Reset <X />
              </Button>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
            {page && <DataTableCompactPager table={table} totalRows={page.total} />}
            <DataTableViewOptions table={table} />
            <Button variant="outline" title="Export PAMs" onClick={() => toast.success(`Export of ${(page?.total ?? 0).toLocaleString("en-IN")} PAMs started`, { description: "Generated on the server and emailed as a link." })}>
              <Download /> <span className="max-2xl:sr-only">Export</span>
            </Button>
          </div>
        </Toolbar>

        {selectedIds.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-blue/30 bg-brand-blue/[0.06] px-4 py-2.5 text-sm">
            <span className="font-medium">{selectedIds.length} selected</span>
            <span className="mx-1 h-4 w-px bg-border" />
            <Button variant="ghost" size="sm" onClick={() => toast.success(`Exported ${selectedIds.length} PAMs`)}>
              <Download /> Export
            </Button>
            <Button variant="ghost" size="sm" onClick={() => toast.success(`Test digest queued for ${selectedIds.length} PAMs`)}>
              <Mail /> Send test digest
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setRowSelection({})}>
              Clear selection
            </Button>
          </div>
        )}

        {!page ? (
          <Skeleton className="h-[40rem]" />
        ) : (
          <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")} aria-busy={query.isFetching}>
            <DataTable
              dataKey={JSON.stringify([pagination, sorting])}
              table={table}
              stickyHeader
              minWidth="60rem"
              onRowClick={(p) => navigate(`/companies?pam=${p.id}`)}
              empty={
                <EmptyState icon={Users} title="No PAMs match">
                  Try a different search or clear the filters.
                </EmptyState>
              }
            />
            <DataTablePagination table={table} totalRows={page.total} pageSizes={[20, 50, 100]} />
            <p className="px-1 pt-1 text-xs text-muted-foreground">{page.activeTotal.toLocaleString("en-IN")} active PAMs in total</p>
          </div>
        )}
      </div>

      {editing && <EditPamDialog key={editing.id} pam={editing} onClose={() => setEditing(null)} />}
    </Page>
  )
}
