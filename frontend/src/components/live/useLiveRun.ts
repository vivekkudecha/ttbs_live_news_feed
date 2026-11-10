import { useEffect, useReducer, useRef } from "react"
import { api, subscribeRun } from "@/api/client"
import type { LiveBatch, LiveSnapshot, RunStatus, SignalCategory } from "@/api/types"

export interface RecentItem {
  i: number
  name: string
  pamName: string
  s: 1 | 2 | 3
  category?: SignalCategory
  at: number
}

export interface LiveState extends Omit<LiveSnapshot, "status"> {
  status: RunStatus
  ratePerSec: number
  recent: RecentItem[]
  pamsCompleted: LiveBatch["pamsCompleted"]
  /** Grid cells changed since the canvas last painted (consumed by LiveGrid). */
  dirty: number[]
  version: number
  receivedAt: number
}

const RECENT_MAX = 80
const WAIT_MS = 2000
const FINISHED = new Set<RunStatus>(["completed", "partial", "failed", "cancelled"])
const PAMS_MAX = 40

/**
 * Subscribes to a run's live stream (SSE in production) and keeps the state in a ref.
 *
 * Smoothness rules:
 *  - Events are applied to mutable typed arrays, never copied per event.
 *  - React re-renders at most once per animation frame, however many events arrive.
 *  - Events that arrive before the snapshot are buffered and replayed (idempotent), so
 *    nothing is lost or double-counted at subscribe time.
 *  - A queued run has no companies yet (they are created when a worker starts it). Subscribing
 *    then would pin an empty grid, so we wait until the run has companies or has finished.
 */
export function useLiveRun(runId: string | undefined) {
  const ref = useRef<LiveState | null>(null)
  const [, render] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    if (!runId) return
    ref.current = null
    let cancelled = false
    let raf = 0
    const buffer: LiveBatch[] = []
    const flush = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()))
    }
    const apply = (b: LiveBatch) => {
      const st = ref.current!
      for (const it of b.items) {
        if (it.i < 0) continue
        st.statuses[it.i] = it.s
        st.dirty.push(it.i)
        st.recent.unshift({ i: it.i, name: st.names[it.i], pamName: st.pamNames[it.i], s: it.s, category: it.category, at: it.at })
      }
      if (st.recent.length > RECENT_MAX) st.recent.length = RECENT_MAX
      if (b.pamsCompleted.length) {
        st.pamsCompleted = [...b.pamsCompleted.reverse(), ...st.pamsCompleted].slice(0, PAMS_MAX)
      }
      Object.assign(st, { done: b.done, signals: b.signals, failed: b.failed, pamsDone: b.pamsDone, ratePerSec: b.ratePerSec, status: b.status, version: st.version + 1, receivedAt: performance.now() })
    }

    let unsubscribe = () => {}
    let wait: ReturnType<typeof setTimeout> | undefined
    const whenStarted = async () => {
      const probe = await api.liveSnapshot(runId).catch(() => null)
      if (cancelled) return
      if (probe && probe.total === 0 && !FINISHED.has(probe.status)) wait = setTimeout(whenStarted, WAIT_MS)
      else begin()
    }
    const begin = () => {
      unsubscribe = subscribeRun(runId, (b) => {
        if (cancelled) return
        if (!ref.current) buffer.push(b)
        else {
          apply(b)
          flush()
        }
      })
      void api.liveSnapshot(runId).then((snap) => {
        if (cancelled || !snap) return
        ref.current = { ...snap, ratePerSec: 0, recent: [], pamsCompleted: [], dirty: [], version: 0, receivedAt: performance.now() }
        buffer.splice(0).forEach(apply)
        flush()
      })
    }
    void whenStarted()
    return () => {
      cancelled = true
      clearTimeout(wait)
      unsubscribe()
      cancelAnimationFrame(raf)
    }
  }, [runId])

  return ref.current
}
