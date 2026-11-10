/**
 * Lazy page modules, keyed by the nav path. App.tsx builds its lazy routes from these, and the
 * sidebar calls `preloadRoute` on hover/focus so the chunk is already downloaded when the user
 * clicks (the page transition never waits on the network). import() is cached by the browser.
 */
export const routeChunks = {
  signals: () => import("@/pages/Signals"),
  digest: () => import("@/pages/Digest"),
  runs: () => import("@/pages/Runs"),
  schedules: () => import("@/pages/Schedules"),
  companies: () => import("@/pages/Companies"),
  pams: () => import("@/pages/Pams"),
  imports: () => import("@/pages/Imports"),
  templates: () => import("@/pages/Templates"),
  telemetry: () => import("@/pages/Telemetry"),
  integrations: () => import("@/pages/Integrations"),
  costs: () => import("@/pages/Costs"),
  audit: () => import("@/pages/Audit"),
  outbox: () => import("@/pages/EmailOutbox"),
  users: () => import("@/pages/Users"),
} as const

export function preloadRoute(path: string) {
  const key = path.replace(/^\//, "").split("/")[0] as keyof typeof routeChunks
  void routeChunks[key]?.().catch(() => undefined)
}
