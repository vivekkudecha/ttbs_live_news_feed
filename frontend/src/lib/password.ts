import type { PasswordPolicy } from "@/api/types"

/** The rules the server enforces, ticked off as the user types (the server re-checks all of them,
 * plus history and personal information). */
export function policyChecks(p: PasswordPolicy | undefined, pw: string) {
  const min = p?.minLength ?? 12
  return [
    { label: `At least ${min} characters`, ok: pw.length >= min },
    { label: "An upper-case letter", ok: /[A-Z]/.test(pw) },
    { label: "A lower-case letter", ok: /[a-z]/.test(pw) },
    { label: "A digit", ok: /\d/.test(pw) },
    { label: "A symbol, such as ! @ # $ %", ok: /[^A-Za-z0-9]/.test(pw) },
    { label: "No character three times in a row", ok: pw.length > 0 && !/(.)\1\1/.test(pw) },
  ]
}
