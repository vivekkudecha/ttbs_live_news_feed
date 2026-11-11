import { useEffect, useState } from "react"

const read = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

/** The current root font size in px (the fluid UI scale), for the few APIs that need numbers (chart axes). */
export function useRootPx() {
  const [px, setPx] = useState(read)
  useEffect(() => {
    const on = () => setPx(read())
    window.addEventListener("resize", on)
    window.addEventListener("ui-scale", on)
    return () => {
      window.removeEventListener("resize", on)
      window.removeEventListener("ui-scale", on)
    }
  }, [])
  return px
}
