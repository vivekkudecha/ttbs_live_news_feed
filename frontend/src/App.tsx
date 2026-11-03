import { lazy, type ReactNode } from "react"
import { HashRouter, MemoryRouter, Navigate, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/layout/AppShell"
import { SessionProvider, useSession } from "@/context/session"
import Login from "@/pages/Login"
import Dashboard from "@/pages/Dashboard"

// Secondary pages load on demand to keep the first paint small.
const Signals = lazy(() => import("@/pages/Signals"))
const Digest = lazy(() => import("@/pages/Digest"))
const RunsList = lazy(() => import("@/pages/Runs").then((m) => ({ default: m.RunsList })))
const RunDetail = lazy(() => import("@/pages/Runs").then((m) => ({ default: m.RunDetail })))
const JobsRedirect = lazy(() => import("@/pages/Runs").then((m) => ({ default: m.JobsRedirect })))
const CompaniesList = lazy(() => import("@/pages/Companies").then((m) => ({ default: m.CompaniesList })))
const CompanyDetail = lazy(() => import("@/pages/Companies").then((m) => ({ default: m.CompanyDetail })))
const Pams = lazy(() => import("@/pages/Pams"))
const Imports = lazy(() => import("@/pages/Imports"))
const Templates = lazy(() => import("@/pages/Templates"))
const Schedules = lazy(() => import("@/pages/Schedules"))
const Integrations = lazy(() => import("@/pages/Integrations"))
const Costs = lazy(() => import("@/pages/Costs"))
const Audit = lazy(() => import("@/pages/Audit"))

// The shareable demo build (VITE_ROUTER=memory) runs inside a hosted viewer where URL hashes
// are not reliable, so it routes in memory. Local dev and the real deployment use URLs.
const Router = import.meta.env.VITE_ROUTER === "memory" ? MemoryRouter : HashRouter
// Honour a host-provided theme (data-theme on <html>) when present; otherwise follow the OS.
const hostTheme = document.documentElement.getAttribute("data-theme") ?? "system"

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } })

/** Route guard: signed in. */
function Guard({ children }: { children: ReactNode }) {
  const { user } = useSession()
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function LoginRoute() {
  const { user } = useSession()
  return user ? <Navigate to="/" replace /> : <Login />
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme={hostTheme} enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <TooltipProvider>
            <Router>
              <Routes>
                <Route path="/login" element={<LoginRoute />} />
                <Route
                  element={
                    <Guard>
                      <AppShell />
                    </Guard>
                  }
                >
                  <Route index element={<Dashboard />} />
                  <Route path="signals" element={<Signals />} />
                  <Route path="digest" element={<Digest />} />
                  <Route path="runs" element={<RunsList />} />
                  <Route path="runs/:id" element={<RunDetail />} />
                  <Route path="jobs" element={<JobsRedirect />} />
                  <Route path="jobs/:id" element={<JobsRedirect />} />
                  <Route path="companies" element={<CompaniesList />} />
                  <Route path="companies/:id" element={<CompanyDetail />} />
                  <Route path="pams" element={<Pams />} />
                  <Route path="imports" element={<Imports />} />
                  <Route path="templates" element={<Templates />} />
                  <Route path="schedules" element={<Schedules />} />
                  <Route path="integrations" element={<Integrations />} />
                  <Route path="costs" element={<Costs />} />
                  <Route path="audit" element={<Audit />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Router>
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
