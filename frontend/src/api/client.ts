import * as Comlink from "comlink"
import type { MockServer } from "@/mock/server.worker"
import type { LiveBatch } from "./types"

/**
 * The API contract the UI depends on (Dependency Inversion).
 *
 * Every method is async and list-shaped results are paged/filtered/joined server-side, so
 * the UI never holds the full 10k-logo / 5k-PAM dataset. Today it is backed by a mock server
 * running in a Web Worker (off the UI thread); the FastAPI client will implement the same type
 * with fetch() + SSE, and no page changes.
 */
export type NewsFeedApi = {
  [K in keyof MockServer]: (...args: Parameters<MockServer[K]>) => Promise<Awaited<ReturnType<MockServer[K]>>>
}

const worker = new Worker(new URL("../mock/server.worker.ts", import.meta.url), { type: "module", name: "ttbs-mock-api" })
const remote = Comlink.wrap<MockServer>(worker)

export const api = remote as unknown as NewsFeedApi

/**
 * Subscribe to a run's live progress stream. Returns an unsubscribe function.
 * Production: an EventSource on /api/v1/runs/{id}/events (SSE, fed by Redis pub/sub).
 */
export function subscribeRun(runId: string, onBatch: (b: LiveBatch) => void): () => void {
  let subId: number | null = null
  let closed = false
  void remote.subscribeRun(runId, Comlink.proxy(onBatch)).then((id) => {
    subId = id
    if (closed) void remote.unsubscribe(id)
  })
  return () => {
    closed = true
    if (subId !== null) void remote.unsubscribe(subId)
  }
}
