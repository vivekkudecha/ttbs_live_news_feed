import { useState } from "react"
import { toast } from "sonner"
import { KeyRound, Lock, Plus, ShieldCheck } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useUsers } from "@/api/hooks"
import { PamPicker } from "@/components/pickers/Pickers"
import { can, roleLabel, useSession } from "@/context/session"
import { fmtDateTime, initials } from "@/lib/format"
import type { Role } from "@/api/types"

const perms: [string, Role[]][] = [
  ["View own logos, signals & digest", ["admin", "manager", "pam", "auditor"]],
  ["View all PAMs' results", ["admin", "manager", "auditor"]],
  ["Import companies / manage PAMs", ["admin", "manager"]],
  ["Edit templates, schedules, start runs", ["admin", "manager"]],
  ["Providers, channels, users", ["admin"]],
  ["Audit log", ["admin", "auditor"]],
]

export default function Users() {
  const { user } = useSession()
  const users = useUsers()
  const [open, setOpen] = useState(false)
  const [linkPam, setLinkPam] = useState("")
  const editable = can.admin(user!.role)
  const roles = Object.keys(roleLabel) as Role[]

  return (
    <div className="space-y-8">
      <PageHeader
        title="Users & roles"
        description="Application-level accounts (username + password). Designed so SSO can be added later without changing roles."
        actions={
          editable && (
            <Button onClick={() => setOpen(true)}>
              <Plus /> Add user
            </Button>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card className="py-0">
          <CardContent className="overflow-x-auto p-0">
            <Table className="min-w-[36rem]">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5">Last sign-in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data?.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="pl-5">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-8">
                          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials(u.name)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{u.name}</p>
                          <p className="text-xs text-muted-foreground">@{u.username}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{roleLabel[u.role]}</Badge>
                      {u.pamId && <p className="mt-1 text-xs text-muted-foreground">linked to PAM record</p>}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={u.active ? "active" : "inactive"} />
                    </TableCell>
                    <TableCell className="pr-5 text-sm text-muted-foreground">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never (must set password)"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Role permissions</CardTitle>
              <CardDescription>Enforced on the server for every API call; PAMs only ever receive their own rows.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="pb-2 text-left font-medium" />
                    {roles.map((r) => (
                      <th key={r} className="pb-2 font-medium">
                        {roleLabel[r].replace("Sales ", "")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {perms.map(([p, rs]) => (
                    <tr key={p} className="border-t">
                      <td className="py-2 pr-2">{p}</td>
                      {roles.map((r) => (
                        <td key={r} className="text-center">
                          {rs.includes(r) ? <span className="text-success">●</span> : <span className="text-muted-foreground/40">–</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" /> Password &amp; session policy
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p className="flex gap-2">
                <KeyRound className="mt-0.5 size-3.5 shrink-0" /> Min 12 chars, Argon2id hashing, no reuse of last 5, forced change on first sign-in.
              </p>
              <p className="flex gap-2">
                <Lock className="mt-0.5 size-3.5 shrink-0" /> Lockout after 5 failed attempts (15 min); per-IP throttling; 15-min access tokens with rotating refresh.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>A one-time password is generated; the user must change it on first sign-in.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="nu-name">Full name</Label>
              <Input id="nu-name" placeholder="e.g. Neha Gupta" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nu-user">Username</Label>
              <Input id="nu-user" placeholder="neha.gupta" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Role</Label>
                <Select defaultValue="pam">
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {roleLabel[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Link to PAM (optional)</Label>
                <PamPicker value={linkPam} onChange={(id) => setLinkPam(id)} allLabel="None" className="w-full" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setOpen(false)
                toast.success("User created", { description: "One-time password shown once to the admin (prototype)" })
              }}
            >
              Create user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
