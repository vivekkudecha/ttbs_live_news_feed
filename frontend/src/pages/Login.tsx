import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/common/Logo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/api/client"
import { errorMessage } from "@/api/http"
import { useSession } from "@/context/session"

/** Sign-in by name (no passwords yet). The name is recorded as the actor in the audit log. */
export default function Login() {
  const { signIn } = useSession()
  const navigate = useNavigate()
  const [username, setUsername] = useState("")
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      signIn(await api.login(username.trim()))
      navigate("/")
    } catch (err) {
      toast.error("Could not sign in", { description: errorMessage(err) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <div className="h-1 bg-brand-gradient" aria-hidden="true" />
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[24rem] space-y-10">
          <Logo size="lg" />

          <div className="space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">Sign in</h1>
            <p className="leading-relaxed text-muted-foreground">
              Sales signals for every logo, researched every 10 days and sent to each PAM by email and WhatsApp.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="username">Your name</Label>
              <Input
                id="username"
                className="h-11"
                autoComplete="username"
                placeholder="e.g. vivek"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>
            <Button type="submit" className="h-11 w-full" disabled={loading || !username.trim()}>
              {loading && <Loader2 className="animate-spin" />}
              Sign in
            </Button>
          </form>

          <p className="text-sm leading-relaxed text-muted-foreground">Every sign-in and change is recorded in the audit log under this name.</p>
        </div>
      </div>
      <p className="px-4 pb-6 text-center text-sm text-muted-foreground">Tata Tele Business Services · Internal sales tool</p>
    </div>
  )
}
