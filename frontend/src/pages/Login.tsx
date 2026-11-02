import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { Logo } from "@/components/common/Logo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api } from "@/api/client"
import { roleLabel, useSession } from "@/context/session"
import type { Role } from "@/api/types"

const demoUsers: Record<Role, string> = { admin: "admin", manager: "sneha.kulkarni", pam: "aarav.mehta", auditor: "audit.team" }

export default function Login() {
  const { signIn } = useSession()
  const navigate = useNavigate()
  const [role, setRole] = useState<Role>("admin")
  const [username, setUsername] = useState("admin")
  const [password, setPassword] = useState("demo-password")
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    const user = await api.login(username, password, role)
    setLoading(false)
    signIn(user)
    navigate("/")
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <div className="h-1 bg-brand-gradient" aria-hidden="true" />
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[22rem] space-y-10">
          <Logo size="lg" />

          <div className="space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">Sign in</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sales signals for every logo you own, researched every 10 days and sent to you by email and WhatsApp.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" className="h-10" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                className="h-10"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="demo-role" className="text-muted-foreground">
                Demo role
              </Label>
              <Select
                value={role}
                onValueChange={(v) => {
                  setRole(v as Role)
                  setUsername(demoUsers[v as Role])
                }}
              >
                <SelectTrigger id="demo-role" className="h-10 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(roleLabel) as Role[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel[r]} · {demoUsers[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="h-10 w-full" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              Sign in
            </Button>
          </form>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Accounts lock after 5 failed attempts. Every sign-in is recorded in the audit log.
          </p>
        </div>
      </div>
      <p className="px-4 pb-6 text-center text-xs text-muted-foreground">Tata Tele Business Services · Internal sales tool</p>
    </div>
  )
}
