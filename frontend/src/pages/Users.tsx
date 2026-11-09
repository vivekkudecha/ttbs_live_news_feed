import { useMemo, useState } from "react"
import { Copy, KeyRound, Loader2, LogOut, MoreHorizontal, Pencil, ShieldCheck, Unlock, UserPlus, UserX, UserCheck } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/common/PageHeader"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ColumnDef } from "@tanstack/react-table"
import { EmptyState } from "@/components/common/EmptyState"
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useServerTable } from "@/components/data-table/useSmartTable"
import { useCreateUser, useModules, useUpdateUser, useUserAction } from "@/api/hooks"
import { backend, errorMessage } from "@/api/http"
import type { IssuedPassword, ManagedUser, ModuleKey, PermLevel, Role } from "@/api/types"
import { useSession } from "@/context/session"
import { fmtDateTime } from "@/lib/format"
import { Page } from "@/components/common/layout"

type Perms = Partial<Record<ModuleKey, PermLevel>>
type Draft = { username: string; name: string; email: string; role: Role; permissions: Perms }

const LEVEL_LABEL: Record<PermLevel | "none", string> = { none: "No access", view: "View", manage: "View & manage" }

function StatusBadges({ u }: { u: ManagedUser }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {!u.active ? <Badge variant="secondary">Deactivated</Badge> : <Badge variant="outline">Active</Badge>}
      {u.locked && <Badge variant="destructive">Locked</Badge>}
      {u.active && u.mustChangePassword && <Badge variant="outline">Must set password</Badge>}
    </div>
  )
}

function accessSummary(u: ManagedUser) {
  if (u.role === "admin") return "All modules + user management"
  const n = Object.keys(u.grantedPermissions).length
  return n === 0 ? "No modules" : `${n} module${n === 1 ? "" : "s"}`
}

/** Shown once: the server never returns this password again. */
function IssuedPasswordDialog({ issued, onClose }: { issued: IssuedPassword | null; onClose: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued!.temporaryPassword)
      toast.success("Copied")
    } catch {
      toast.error("Copy failed: select the password and copy it manually")
    }
  }
  return (
    <Dialog open={!!issued} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Temporary password for @{issued?.user.username}</DialogTitle>
          <DialogDescription>
            Give it to {issued?.user.name} through a separate, private channel. It works once: they must choose their own password when they sign in.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={issued?.temporaryPassword ?? ""} className="font-mono" onFocus={(e) => e.target.select()} aria-label="Temporary password" />
          <Button variant="outline" size="icon" onClick={copy} aria-label="Copy password">
            <Copy />
          </Button>
        </div>
        <Alert>
          <AlertDescription>This password is shown only now. If it is lost, reset the password again.</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UserDialog({ open, editing, onClose, onIssued }: { open: boolean; editing: ManagedUser | null; onClose: () => void; onIssued: (p: IssuedPassword) => void }) {
  const { data: modules = [] } = useModules()
  const create = useCreateUser()
  const update = useUpdateUser()
  const [draft, setDraft] = useState<Draft>(() =>
    editing
      ? { username: editing.username, name: editing.name, email: editing.email ?? "", role: editing.role, permissions: editing.grantedPermissions }
      : { username: "", name: "", email: "", role: "member", permissions: {} },
  )
  const busy = create.isPending || update.isPending
  const setLevel = (m: ModuleKey, v: PermLevel | "none") =>
    setDraft((d) => {
      const permissions = { ...d.permissions }
      if (v === "none") delete permissions[m]
      else permissions[m] = v
      return { ...d, permissions }
    })
  const setAll = (v: PermLevel | "none") => setDraft((d) => ({ ...d, permissions: v === "none" ? {} : Object.fromEntries(modules.map((m) => [m.key, v])) }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const email = draft.email.trim() || null
      if (editing) {
        await update.mutateAsync({ id: editing.id, patch: { name: draft.name.trim(), email, role: draft.role, permissions: draft.permissions } })
        toast.success("Access updated", { description: `@${editing.username}` })
      } else {
        onIssued(await create.mutateAsync({ username: draft.username.trim().toLowerCase(), name: draft.name.trim(), email, role: draft.role, permissions: draft.permissions }))
      }
      onClose()
    } catch (err) {
      toast.error(editing ? "Could not update the user" : "Could not create the user", { description: errorMessage(err) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={save} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit @${editing.username}` : "Add user"}</DialogTitle>
            <DialogDescription>
              {editing ? "Changes apply to their next request." : "A temporary password is generated; they must replace it at first sign-in."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="u-username">Username</Label>
              <Input
                id="u-username"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                disabled={!!editing}
                autoCapitalize="none"
                spellCheck={false}
                pattern="[a-z0-9][a-z0-9._\-]{2,63}"
                title="3-64 characters: lower-case letters, digits, '.', '_' or '-'"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-name">Full name</Label>
              <Input id="u-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={200} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-email">Email (optional)</Label>
              <Input id="u-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} maxLength={320} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-role">Role</Label>
              <Select value={draft.role} onValueChange={(v) => setDraft({ ...draft, role: v as Role })}>
                <SelectTrigger id="u-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member: only the modules below</SelectItem>
                  <SelectItem value="admin">Admin: everything, including users</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {draft.role === "admin" ? (
            <Alert>
              <ShieldCheck />
              <AlertDescription>Admins can view and manage every module, and manage users and their access.</AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Module access</p>
                <div className="flex gap-1.5">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAll("none")}>None</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAll("view")}>View all</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAll("manage")}>Manage all</Button>
                </div>
              </div>
              <ul className="divide-y rounded-md border">
                {modules.map((m) => (
                  <li key={m.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{m.label}</p>
                      <p className="text-xs text-muted-foreground">{m.description}</p>
                    </div>
                    <Select value={draft.permissions[m.key] ?? "none"} onValueChange={(v) => setLevel(m.key, v as PermLevel | "none")}>
                      <SelectTrigger className="w-full sm:w-44" aria-label={`${m.label} access`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["none", "view", "manage"] as const).map((l) => (
                          <SelectItem key={l} value={l}>
                            {LEVEL_LABEL[l]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">"View" can open and read the module; "View & manage" can also create, change, start, cancel and delete in it.</p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !draft.name.trim() || (!editing && draft.username.trim().length < 3)}>
              {busy && <Loader2 className="animate-spin" />}
              {editing ? "Save changes" : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type Confirm = { user: ManagedUser; kind: "reset" | "deactivate" | "activate" | "revoke" }

const CONFIRM_TEXT: Record<Confirm["kind"], { title: string; body: string; cta: string }> = {
  reset: { title: "Reset password", body: "Issues a new temporary password and signs them out everywhere. They must set their own password at next sign-in.", cta: "Reset password" },
  deactivate: { title: "Deactivate user", body: "They are signed out at once and cannot sign in until reactivated. Their audit history is kept.", cta: "Deactivate" },
  activate: { title: "Reactivate user", body: "They can sign in again with their current password.", cta: "Reactivate" },
  revoke: { title: "Sign out everywhere", body: "Ends all of their active sessions. They can sign in again.", cta: "Sign out everywhere" },
}

export default function Users() {
  const { user: me } = useSession()
  const update = useUpdateUser()
  const action = useUserAction()
  const [dialog, setDialog] = useState<{ editing: ManagedUser | null } | null>(null)
  const [issued, setIssued] = useState<IssuedPassword | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)

  const columns = useMemo<ColumnDef<ManagedUser, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        meta: { label: "User", filter: { type: "text" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
        cell: ({ row }) => {
          const u = row.original
          return (
            <div className={u.active ? undefined : "opacity-60"}>
              <p className="font-medium">
                {u.name} {u.id === me?.id && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
              </p>
              <p className="text-xs text-muted-foreground">@{u.username}{u.email ? ` · ${u.email}` : ""}</p>
            </div>
          )
        },
      },
      { id: "username", accessorKey: "username", meta: { label: "Username", filter: { type: "text" } }, header: ({ column }) => <DataTableColumnHeader column={column} title="Username" />, cell: ({ row }) => <span className="text-sm">@{row.original.username}</span> },
      { id: "email", accessorKey: "email", meta: { label: "Email", filter: { type: "text" } }, header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />, cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.email || "—"}</span> },
      {
        id: "role",
        accessorKey: "role",
        meta: { label: "Role", filter: { type: "enum", options: [{ value: "admin", label: "Admin" }, { value: "member", label: "Member" }] } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        cell: ({ row }) => <Badge variant={row.original.role === "admin" ? "default" : "secondary"}>{row.original.role === "admin" ? "Admin" : "Member"}</Badge>,
      },
      { id: "access", enableSorting: false, meta: { label: "Access" }, header: "Access", cell: ({ row }) => <span className="text-sm">{accessSummary(row.original)}</span> },
      {
        id: "active",
        accessorKey: "active",
        meta: { label: "Status", filter: { type: "bool", labels: ["Active", "Deactivated"] } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <StatusBadges u={row.original} />,
      },
      {
        id: "lastLoginAt",
        accessorKey: "lastLoginAt",
        meta: { label: "Last sign-in", filter: { type: "date" } },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last sign-in" />,
        cell: ({ row }) => <span className="whitespace-nowrap text-sm text-muted-foreground">{row.original.lastLoginAt ? fmtDateTime(row.original.lastLoginAt) : "Never"}</span>,
      },
      {
        id: "actions",
        size: 48,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const u = row.original
          const self = u.id === me?.id
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for @${u.username}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDialog({ editing: u })}>
                  <Pencil /> Edit details & access
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setConfirm({ user: u, kind: "reset" })}>
                  <KeyRound /> Reset password
                </DropdownMenuItem>
                {u.locked && (
                  <DropdownMenuItem onClick={() => void unlock(u)}>
                    <Unlock /> Unlock
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setConfirm({ user: u, kind: "revoke" })}>
                  <LogOut /> Sign out everywhere
                </DropdownMenuItem>
                {!self && (
                  <>
                    <DropdownMenuSeparator />
                    {u.active ? (
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirm({ user: u, kind: "deactivate" })}>
                        <UserX /> Deactivate
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setConfirm({ user: u, kind: "activate" })}>
                        <UserCheck /> Reactivate
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me?.id],
  )
  const state = useServerTable<ManagedUser>({
    id: "users",
    columns,
    queryKey: ["users"],
    fetcher: (q) => backend.users(q),
    defaultSort: { id: "name", desc: false },
    defaultHidden: ["username", "email"],
    getRowId: (u) => u.id,
  })

  const runConfirm = async () => {
    if (!confirm) return
    const { user, kind } = confirm
    try {
      if (kind === "reset") setIssued((await action.mutateAsync({ id: user.id, action: "reset" })) as IssuedPassword)
      else if (kind === "revoke") {
        const r = (await action.mutateAsync({ id: user.id, action: "revoke" })) as { revoked: number }
        toast.success(`Signed out of ${r.revoked} session${r.revoked === 1 ? "" : "s"}`)
      } else {
        await update.mutateAsync({ id: user.id, patch: { active: kind === "activate" } })
        toast.success(kind === "activate" ? "User reactivated" : "User deactivated")
      }
      setConfirm(null)
    } catch (err) {
      toast.error("Action failed", { description: errorMessage(err) })
    }
  }

  const unlock = async (u: ManagedUser) => {
    try {
      await action.mutateAsync({ id: u.id, action: "unlock" })
      toast.success(`@${u.username} unlocked`)
    } catch (err) {
      toast.error("Could not unlock", { description: errorMessage(err) })
    }
  }

  return (
    <Page>
      <PageHeader
        title="Users & access"
        description="Who can sign in, and which modules each person can view or manage."
        actions={
          <Button onClick={() => setDialog({ editing: null })}>
            <UserPlus /> Add user
          </Button>
        }
      />

      <SmartTable
        state={state}
        toolbar={
          <p className="text-sm text-muted-foreground">
            <span className="tabular font-medium text-foreground">{state.total}</span> users · sort or filter from the column headers
          </p>
        }
        empty={
          <EmptyState icon={ShieldCheck} title="No users match">
            Clear a filter to see everyone.
          </EmptyState>
        }
      />

      {dialog && <UserDialog open editing={dialog.editing} onClose={() => setDialog(null)} onIssued={setIssued} />}
      <IssuedPasswordDialog issued={issued} onClose={() => setIssued(null)} />

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm && `${CONFIRM_TEXT[confirm.kind].title}: @${confirm.user.username}`}</DialogTitle>
            <DialogDescription>{confirm && CONFIRM_TEXT[confirm.kind].body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant={confirm?.kind === "deactivate" ? "destructive" : "default"} onClick={() => void runConfirm()} disabled={action.isPending || update.isPending}>
              {(action.isPending || update.isPending) && <Loader2 className="animate-spin" />}
              {confirm && CONFIRM_TEXT[confirm.kind].cta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}
