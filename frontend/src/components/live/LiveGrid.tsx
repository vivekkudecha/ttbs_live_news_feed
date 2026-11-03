import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { LiveState } from "./useLiveRun"

const STATUS_LABEL = ["Researching", "Signal found", "No qualifying news", "Failed"]

function palette() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return [v("--border"), v("--brand"), v("--chart-1"), v("--destructive")]
}

/**
 * One cell per logo on a single <canvas> (10,000 DOM nodes would stall layout).
 * Cells are grouped by PAM. Each batch repaints only the cells that changed.
 */
export function LiveGrid({ state, onSelect }: { state: LiveState; onSelect: (companyId: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const colors = useRef<string[]>([])
  const painted = useRef({ width: 0, runId: "", theme: "" })

  const cell = state.total > 6000 ? 6 : state.total > 2500 ? 8 : 11
  const gap = state.total > 6000 ? 1 : 2
  const step = cell + gap
  const cols = Math.max(1, Math.floor((width + gap) / step))
  const rows = Math.ceil(state.total / cols)
  const height = rows * step

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Repaint fully on size/theme/run change; otherwise only dirty cells.
  useEffect(() => {
    const c = canvas.current
    if (!c || width === 0) return
    const ctx = c.getContext("2d")!
    const dpr = window.devicePixelRatio || 1
    const theme = document.documentElement.className
    const full = painted.current.width !== width || painted.current.runId !== state.runId || painted.current.theme !== theme
    if (full) {
      colors.current = palette()
      c.width = Math.floor(width * dpr)
      c.height = Math.floor(height * dpr)
      c.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      for (let k = 0; k < state.total; k++) {
        ctx.fillStyle = colors.current[state.statuses[k]] ?? colors.current[0]
        ctx.fillRect((k % cols) * step, Math.floor(k / cols) * step, cell, cell)
      }
      painted.current = { width, runId: state.runId, theme }
      state.dirty.length = 0
      return
    }
    for (const k of state.dirty) {
      ctx.fillStyle = colors.current[state.statuses[k]] ?? colors.current[0]
      ctx.fillRect((k % cols) * step, Math.floor(k / cols) * step, cell, cell)
    }
    state.dirty.length = 0
  })

  // Repaint when the theme flips (class on <html>).
  useEffect(() => {
    const mo = new MutationObserver(() => (painted.current.theme = "?"))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])

  const indexAt = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    const x = e.clientX - r.left,
      y = e.clientY - r.top
    const col = Math.floor(x / step),
      row = Math.floor(y / step)
    const i = row * cols + col
    return col < cols && i >= 0 && i < state.total ? { i, x, y } : null
  }

  return (
    <div ref={wrap} className="relative w-full">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${state.total.toLocaleString("en-IN")} logos: ${state.signals.toLocaleString("en-IN")} with signals, ${(state.done - state.signals - state.failed).toLocaleString("en-IN")} without, ${state.failed} failed, ${(state.total - state.done).toLocaleString("en-IN")} still researching`}
        className="block w-full cursor-crosshair"
        onMouseMove={(e) => setHover(indexAt(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const h = indexAt(e)
          if (h && state.statuses[h.i] !== 0) onSelect(state.companyIds[h.i])
        }}
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(hover.x + 12, Math.max(0, width - 220)), top: hover.y + 14 }}
        >
          <p className="font-medium">{state.names[hover.i]}</p>
          <p className="text-muted-foreground">
            {state.pamNames[hover.i]} · {STATUS_LABEL[state.statuses[hover.i]]}
          </p>
          {state.statuses[hover.i] !== 0 && <p className="text-muted-foreground">Click to open the result</p>}
        </div>
      )}
    </div>
  )
}

export function LiveLegend() {
  const items = [
    ["bg-border", "Researching"],
    ["bg-brand", "Signal found"],
    ["bg-chart-1", "No qualifying news"],
    ["bg-destructive", "Failed"],
  ]
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className={`size-2.5 rounded-[2px] ${c}`} aria-hidden="true" /> {l}
        </span>
      ))}
    </div>
  )
}
