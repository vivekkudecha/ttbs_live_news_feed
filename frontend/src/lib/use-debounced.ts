import { useEffect, useState } from "react"

/** Debounce a fast-changing value (e.g. a search box) before it reaches a query key. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
