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
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useCreateUser, useModules, useUpdateUser, useUserAction, useUsers } from "@/api/hooks"
import { errorMessage } from "@/api/http"
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
  const { data: users, isLoading, error } = useUsers()
  const update = useUpdateUser()
  const action = useUserAction()
  const [dialog, setDialog] = useState<{ editing: ManagedUser | null } | null>(null)
  const [issued, setIssued] = useState<IssuedPassword | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const sorted = useMemo(() => [...(users ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.username.localeCompare(b.username)), [users])

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

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((u) => {
                const self = u.id === me?.id
                return (
                  <TableRow key={u.id} className={u.active ? undefined : "opacity-60"}>
                    <TableCell>
                      <p className="font-medium">
                        {u.name} {self && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">@{u.username}{u.email ? ` · ${u.email}` : ""}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role === "admin" ? "Admin" : "Member"}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{accessSummary(u)}</TableCell>
                    <TableCell>
                      <StatusBadges u={u} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never"}</TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

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
