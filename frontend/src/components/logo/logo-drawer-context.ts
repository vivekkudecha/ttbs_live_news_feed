/**
 * One logo drawer for the whole app. Any page opens it with `useLogoDrawer().open(...)`; the open
 * logo lives in the URL (`?logo=<companyId>&logoRun=<runId>`), so links can point at it and Back
 * closes it. `siblings` (optional) lets the drawer step to the previous / next logo of a list.
 */
import { createContext, useContext } from "react"

export interface LogoTarget {
  companyId: string
  /** The run to show the logo in; defaults to the logo's latest run. */
  runId?: string
}

export interface LogoDrawerApi {
  open: (t: LogoTarget & { siblings?: LogoTarget[] }) => void
  close: () => void
  current: LogoTarget | null
}

export const LogoDrawerContext = createContext<LogoDrawerApi | null>(null)

export function useLogoDrawer(): LogoDrawerApi {
  const ctx = useContext(LogoDrawerContext)
  if (!ctx) throw new Error("useLogoDrawer must be used inside <LogoDrawerProvider>")
  return ctx
}

/** Search params that open the drawer (for <Link to={...}>). */
export const logoHref = (path: string, t: LogoTarget) => `${path}?logo=${encodeURIComponent(t.companyId)}${t.runId ? `&logoRun=${encodeURIComponent(t.runId)}` : ""}`
