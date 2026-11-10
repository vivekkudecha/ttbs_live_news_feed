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

/** "in 5 min" / "3 h ago" for the recent past and near future; a date beyond a week. */
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  if (abs > 7 * 86_400_000) return fmtDateTime(iso)
  const [v, u] = abs < 60_000 ? [0, ""] : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"]
  if (!u) return diff > 0 ? "in a moment" : "just now"
  return diff > 0 ? `in ${v} ${u}` : `${v} ${u} ago`
}
