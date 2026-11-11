/** Plain helpers and constants of the results board (kept out of component files for fast refresh). */
import type { BoardLogo, BoardPam } from "@/api/types"

export const n = (x: number) => x.toLocaleString("en-IN")

export const RESULT_STATUS = [
  { value: "signal", label: "Signal" },
  { value: "no_signal", label: "No signal" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "In progress" },
]

export const DIGEST_STATUS = [
  { value: "sent", label: "Sent" },
  { value: "pending", label: "Queued" },
  { value: "sending", label: "Sending" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
  { value: "none", label: "Not yet" },
]

export const categoryLabel = (c: string | null | undefined) => (!c || c === "none" ? "No category" : c)

/** Sorts each endpoint understands (others are ignored for that level). */
export const GROUP_SORT = new Set(["account", "status", "findings", "attempts", "finishedAt"])
export const LOGO_SORT = new Set(["account", "pamName", "status", "category", "attempts", "finishedAt"])

export const pamKey = (g: BoardPam) => g.pamId ?? "0"

/** Lines for the CSV export (one per logo). */
export function toCsv(rows: BoardLogo[]): string {
  const head = ["Company", "Industry", "PAM", "Status", "Category", "Key signals", "Opportunity", "Outreach", "Sources", "Attempts", "Finished"]
  const plain = (s: string | null | undefined) => (s ?? "").replace(/\*\*/g, "")
  const esc = (v: unknown) => {
    const s = String(v ?? "")
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map((r) =>
    [
      r.companyName,
      r.industry,
      r.pamName,
      r.status,
      r.category,
      plain(r.keySignals),
      plain(r.opportunity),
      plain(r.outreach),
      r.sources.map((s) => s.url).join(" "),
      r.attempts,
      r.finishedAt,
    ]
      .map(esc)
      .join(","),
  )
  return [head.join(","), ...lines].join("\n")
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
