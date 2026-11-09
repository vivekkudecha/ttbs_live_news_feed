import { useState } from "react"
import { Check, Eye, EyeOff, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { PasswordPolicy } from "@/api/types"
import { policyChecks } from "@/lib/password"
import { cn } from "@/lib/utils"

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  invalid,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  autoComplete: "current-password" | "new-password"
  autoFocus?: boolean
  invalid?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          className="h-11 pr-11"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          maxLength={128}
          required
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  )
}

export function PasswordChecklist({ policy, password, problems }: { policy?: PasswordPolicy; password: string; problems?: string[] }) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4 text-sm">
      <ul className="space-y-1.5" aria-label="Password requirements">
        {policyChecks(policy, password).map((c) => (
          <li key={c.label} className={cn("flex items-center gap-2", c.ok ? "text-foreground" : "text-muted-foreground")}>
            {c.ok ? <Check className="size-4 text-emerald-600" aria-hidden /> : <X className="size-4" aria-hidden />}
            <span>{c.label}</span>
            <span className="sr-only">{c.ok ? "(met)" : "(not met)"}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        Avoid common words and your name or username.
        {policy?.historyCount ? ` You cannot reuse your last ${policy.historyCount} passwords.` : ""}
        {policy?.maxAgeDays ? ` Passwords expire after ${policy.maxAgeDays} days.` : ""}
      </p>
      {problems && problems.length > 0 && (
        <ul className="space-y-1 border-t pt-3 text-destructive" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
