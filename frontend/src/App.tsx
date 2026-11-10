import { lazy, type ReactNode } from "react"
import { HashRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { MotionConfig } from "motion/react"
import { Lock } from "lucide-react"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/layout/AppShell"
import { firstAllowed } from "@/components/layout/nav"
import { EmptyState } from "@/components/common/EmptyState"
import { Skeleton } from "@/components/ui/skeleton"
import { SessionProvider, useSession } from "@/context/session"
import { can, isAdmin } from "@/lib/access"
import { routeChunks } from "@/lib/route-chunks"
import type { ModuleKey } from "@/api/types"
import Login from "@/pages/Login"
import Dashboard from "@/pages/Dashboard"
import ChangePassword from "@/pages/ChangePassword"

// Secondary pages load on demand to keep the first paint small (and are preloaded on nav hover).
const c = routeChunks
const RunDetail = lazy(() => c.runs().then((m) => ({ default: m.RunDetail })))
const Research = lazy(c.schedules)
const ScheduleDetail = lazy(() => c.schedules().then((m) => ({ default: m.ScheduleDetail })))
const JobsRedirect = lazy(() => c.runs().then((m) => ({ default: m.JobsRedirect })))
const CompaniesList = lazy(() => c.companies().then((m) => ({ default: m.CompaniesList })))
const CompanyDetail = lazy(() => c.companies().then((m) => ({ default: m.CompanyDetail })))
const Pams = lazy(c.pams)
const Imports = lazy(c.imports)
const Templates = lazy(c.templates)
const Telemetry = lazy(c.telemetry)
const Integrations = lazy(c.integrations)
const Costs = lazy(c.costs)
const Audit = lazy(c.audit)
const EmailOutbox = lazy(c.outbox)
const Users = lazy(c.users)

// The shareable demo build (VITE_ROUTER=memory) runs inside a hosted viewer where URL hashes
// are not reliable, so it routes in memory. Local dev and the real deployment use URLs.
const Router = import.meta.env.VITE_ROUTER === "memory" ? MemoryRouter : HashRouter
// Honour a host-provided theme (data-theme on <html>) when present; otherwise follow the OS.
const hostTheme = document.documentElement.getAttribute("data-theme") ?? "system"

// Cache: lists are fresh for 30 s, unused results stay in memory for 30 min (instant back/forward
// navigation), one retry on failure. Reference data sets a longer staleTime in its own hook.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 } },
})

function Booting() {
  return (
    <div className="flex min-h-svh items-center justify-center p-8" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-40 w-full max-w-md" />
    </div>
  )
}

/** Route guard: a live session with a usable password (the server enforces the same). */
function Guard({ children }: { children: ReactNode }) {
  const { user } = useSession()
  const loc = useLocation()
  if (user === undefined) return <Booting />
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />
  return <>{children}</>
}

/** Page guard: the module (or admin role) this page belongs to. */
function Allow({ module, admin, children }: { module?: ModuleKey; admin?: boolean; children: ReactNode }) {
  const { user } = useSession()
  const ok = admin ? isAdmin(user) : !module || can(user, module)
  if (ok) return <>{children}</>
  return (
    <EmptyState icon={Lock} title="No access">
      Your account does not have access to this page. Ask an administrator if you need it.
    </EmptyState>
  )
}

function Home() {
  const { user } = useSession()
  return can(user, "dashboard") ? <Dashboard /> : <Navigate to={firstAllowed(user)} replace />
}

function LoginRoute() {
  const { user } = useSession()
  if (user === undefined) return <Booting />
  if (user) return <Navigate to={user.mustChangePassword ? "/change-password" : "/"} replace />
  return <Login />
}

function ChangePasswordRoute() {
  const { user } = useSession()
  if (user === undefined) return <Booting />
  return user ? <ChangePassword /> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
    <ThemeProvider attribute="class" defaultTheme={hostTheme} enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <TooltipProvider>
            <Router>
              <Routes>
                <Route path="/login" element={<LoginRoute />} />
                <Route path="/change-password" element={<ChangePasswordRoute />} />
                <Route
                  element={
                    <Guard>
                      <AppShell />
                    </Guard>
                  }
                >
                  <Route index element={<Home />} />
                  <Route path="runs" element={<JobsRedirect />} />
                  <Route path="runs/:id" element={<Allow module="runs"><RunDetail /></Allow>} />
                  <Route path="outbox" element={<Allow module="runs"><EmailOutbox /></Allow>} />
                  <Route path="jobs" element={<JobsRedirect />} />
                  <Route path="jobs/:id" element={<JobsRedirect />} />
                  <Route path="companies" element={<Allow module="companies"><CompaniesList /></Allow>} />
                  <Route path="companies/:id" element={<Allow module="companies"><CompanyDetail /></Allow>} />
                  <Route path="pams" element={<Allow module="pams"><Pams /></Allow>} />
                  <Route path="imports" element={<Allow module="imports"><Imports /></Allow>} />
                  <Route path="templates" element={<Templates />} />
                  <Route path="schedules" element={<Allow module="runs"><Research /></Allow>} />
                  <Route path="schedules/:id" element={<Allow module="runs"><ScheduleDetail /></Allow>} />
                  <Route path="telemetry" element={<Allow module="telemetry"><Telemetry /></Allow>} />
                  <Route path="integrations" element={<Allow module="integrations"><Integrations /></Allow>} />
                  <Route path="costs" element={<Allow module="costs"><Costs /></Allow>} />
                  <Route path="audit" element={<Allow module="audit"><Audit /></Allow>} />
                  <Route path="users" element={<Allow admin><Users /></Allow>} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Router>
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
    </MotionConfig>
  )
}
