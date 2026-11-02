const IST = "Asia/Kolkata"

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST }) : "—"

export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: IST,
      })
    : "—"

export const fmtUsd = (n: number, digits = 2) => `$${n.toFixed(digits)}`
export const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100))

export const durationMin = (a: string, b: string | null) => {
  if (!b) return "—"
  return `${Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)} min`
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
