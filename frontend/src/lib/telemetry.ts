/** Formatting helpers for process events (run timeline, telemetry page). */

const KIND_LABEL: Record<string, string> = {
  "dataset.upload": "File uploaded and validated",
  "dataset.chunk": "Rows saved",
  "dataset.saved": "Upload saved",
  "dataset.failed": "Upload stopped",
  "dataset.resume": "Upload resumed",
  "run.queued": "Run queued",
  "run.scheduled": "Run scheduled",
  "run.start": "Run started",
  "run.finish": "Run finished",
  "run.cancel": "Run cancelled",
  "run.retry_failed": "Failed logos re-queued",
  "research.attempt": "Research attempt",
  "notify.queued": "Digest queued",
  "notify.skipped": "Digest skipped",
  "notify.attempt": "Digest delivery",
  "notify.resend": "Digest re-sent",
  "sweeper.recovered": "Lost work recovered",
}

export const kindLabel = (k: string) => KIND_LABEL[k] ?? k

export const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

/** HH:MM:SS in IST. */
export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
