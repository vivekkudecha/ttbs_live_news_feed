import { useEffect, useRef, useState } from "react"

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** Animates from the previous value to `target` (ease-out, ~600ms). Jumps straight there under reduced motion. */
export function useCountUp(target: number, ms = 600) {
  const [value, setValue] = useState(() => (reduced() ? target : 0))
  const from = useRef(0)

  useEffect(() => {
    const start = from.current
    from.current = target
    if (reduced() || start === target) {
      setValue(target)
      return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms)
      setValue(start + (target - start) * (1 - (1 - p) ** 3))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])

  return value
}
