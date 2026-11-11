/** Display size: multiplies the fluid root scale (index.css `--ui-scale`). Saved per browser. */
export const UI_SCALES = { compact: 0.9, default: 1, large: 1.1 } as const
export type UiScale = keyof typeof UI_SCALES
const KEY = "ttbs.ui.scale"

export function savedUiScale(): UiScale {
  try {
    const v = localStorage.getItem(KEY)
    if (v && v in UI_SCALES) return v as UiScale
  } catch {
    /* storage blocked: default size */
  }
  return "default"
}

export function applyUiScale(v: UiScale, persist = false) {
  document.documentElement.style.setProperty("--ui-scale", String(UI_SCALES[v]))
  window.dispatchEvent(new Event("ui-scale"))
  if (!persist) return
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* preference just won't persist */
  }
}
