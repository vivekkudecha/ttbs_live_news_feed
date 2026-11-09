import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, ShieldCheck } from "lucide-react"
import { AuthLayout } from "@/components/auth/AuthLayout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordField } from "@/components/auth/PasswordField"
import { api } from "@/api/client"
import { ApiError, errorMessage } from "@/api/http"
import { useSession } from "@/context/session"

/** Sign-in with username + password. Failures get one generic message (the server never says
 * whether the username exists); repeated failures lock the account for a while. */
export default function Login() {
  const { establish } = useSession()
  const navigate = useNavigate()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const s = await api.login(username.trim(), password)
      establish(s)
      navigate(s.user.mustChangePassword ? "/change-password" : "/", { replace: true })
    } catch (err) {
      setPassword("")
      setError(
        err instanceof ApiError && err.status === 401
          ? "Invalid username or password. After several failed attempts the account is locked for a few minutes."
          : err instanceof ApiError && err.status === 429
            ? "Too many sign-in attempts. Wait a minute and try again."
            : errorMessage(err),
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout className="space-y-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">Sign in</h1>
        <p className="leading-relaxed text-muted-foreground">
          Sales signals for every logo, researched every 10 days and sent to each PAM by email and WhatsApp.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-6" noValidate>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            className="h-11"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={64}
            required
            autoFocus
          />
        </div>
        <PasswordField id="password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        <Button type="submit" variant="brand" className="h-11 w-full" disabled={loading || !username.trim() || !password}>
          {loading && <Loader2 className="animate-spin" />}
          Sign in
        </Button>
      </form>

      <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        Accounts are created by an administrator. Every sign-in and change is recorded in the audit log.
      </p>
    </AuthLayout>
  )
}
