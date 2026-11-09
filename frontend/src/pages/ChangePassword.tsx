import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { KeyRound, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/common/Logo"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PasswordChecklist, PasswordField } from "@/components/auth/PasswordField"
import { policyChecks } from "@/lib/password"
import { api } from "@/api/client"
import { ApiError, errorMessage } from "@/api/http"
import { usePasswordPolicy } from "@/api/hooks"
import { useSession } from "@/context/session"

/**
 * Choose a new password. Forced (no way around it) on the first sign-in, after an admin reset
 * and when the password has expired; otherwise reached from the user menu. Success ends every
 * other session of this user and issues a fresh one.
 */
export default function ChangePassword() {
  const { user, establish, signOut } = useSession()
  const navigate = useNavigate()
  const { data: policy } = usePasswordPolicy()
  const forced = !!user?.mustChangePassword
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [loading, setLoading] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const rulesOk = policyChecks(policy, next).every((c) => c.ok)
  const matches = next.length > 0 && next === confirm
  const ready = current.length > 0 && rulesOk && matches && next !== current

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setProblems([])
    setError(null)
    try {
      establish(await api.changePassword(current, next))
      toast.success("Password changed", { description: "Other sessions were signed out." })
      navigate("/", { replace: true })
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { problems?: string[] } | undefined) : undefined
      if (details?.problems?.length) setProblems(details.problems)
      else setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <div className="h-1 bg-brand-gradient" aria-hidden="true" />
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[26rem] space-y-8">
          <Logo size="lg" />
          <div className="space-y-2">
            <h1 className="flex items-center gap-2 text-2xl font-medium tracking-tight">
              <KeyRound className="size-5" aria-hidden /> {forced ? "Set a new password" : "Change password"}
            </h1>
            <p className="leading-relaxed text-muted-foreground">
              {forced
                ? `Hi ${user?.name.split(" ")[0] ?? ""}, before you continue choose your own password. The one you signed in with was temporary or has expired.`
                : "Enter your current password, then choose a new one."}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-5" noValidate>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <PasswordField id="current" label={forced ? "Temporary or current password" : "Current password"} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
            <PasswordField id="new" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
            <PasswordField id="confirm" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={confirm.length > 0 && !matches} />
            {confirm.length > 0 && !matches && <p className="-mt-3 text-sm text-destructive">The passwords do not match.</p>}
            <PasswordChecklist policy={policy} password={next} problems={problems} />
            <div className="flex gap-3">
              <Button type="submit" className="h-11 flex-1" disabled={loading || !ready}>
                {loading && <Loader2 className="animate-spin" />}
                Save new password
              </Button>
              {forced ? (
                <Button type="button" variant="outline" className="h-11" onClick={() => void signOut()}>
                  Sign out
                </Button>
              ) : (
                <Button type="button" variant="outline" className="h-11" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
