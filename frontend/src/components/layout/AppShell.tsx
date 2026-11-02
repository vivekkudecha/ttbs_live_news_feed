import { Suspense, useState } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import { useTheme } from "next-themes"
import { ChevronsUpDown, FlaskConical, LogOut, Menu, Monitor, Moon, Sun, UserCog } from "lucide-react"
import { Logo } from "@/components/common/Logo"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { roleLabel, useSession } from "@/context/session"
import { navGroups } from "./nav"
import { cn } from "@/lib/utils"
import { initials } from "@/lib/format"
import type { Role } from "@/api/types"

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useSession()
  const role = user!.role
  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
      {navGroups.map((g) => {
        const items = g.items.filter((i) => i.roles.includes(role))
        if (!items.length) return null
        return (
          <div key={g.label}>
            <p className="eyebrow px-3 pb-2">{g.label}</p>
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.to === "/"}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "relative flex items-center gap-3 rounded-md px-3 py-2 text-[0.8125rem] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        isActive &&
                          "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-gradient",
                      )
                    }
                  >
                    <i.icon className="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function SidebarFooter() {
  return (
    <div className="border-t border-sidebar-border px-6 py-4 text-[11px] leading-relaxed text-muted-foreground">
      <div className="flex items-center gap-1.5 font-medium text-sidebar-foreground">
        <FlaskConical className="size-3.5" /> Design prototype
      </div>
      Fictional demo data · no live API calls
    </div>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="px-6 pb-4 pt-7">
        <Logo />
      </div>
      <SidebarNav onNavigate={onNavigate} />
      <SidebarFooter />
    </div>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppShell() {
  const { user, signOut, switchRole } = useSession()
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const current = navGroups.flatMap((g) => g.items).find((i) => (i.to === "/" ? pathname === "/" : pathname.startsWith(i.to)))

  return (
    <div className="flex min-h-svh bg-background">
      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 lg:block">
        <Sidebar />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 border-0 p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-card/90 px-4 backdrop-blur sm:px-8 lg:px-10">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <p className="truncate text-[0.8125rem] text-muted-foreground">{current?.label ?? "TTBS Signals"}</p>
          <div className="ml-auto flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="hidden gap-1.5 sm:inline-flex">
                  <UserCog />
                  View as: {roleLabel[user!.role]}
                  <ChevronsUpDown className="opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Demo only: preview each role's view</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={user!.role}
                  onValueChange={(v) => {
                    switchRole(v as Role)
                    navigate("/")
                  }}
                >
                  {(Object.keys(roleLabel) as Role[]).map((r) => (
                    <DropdownMenuRadioItem key={r} value={r}>
                      {roleLabel[r]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-9 gap-2 px-1.5">
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials(user!.name)}</AvatarFallback>
                  </Avatar>
                  <span className="hidden text-left leading-tight md:block">
                    <span className="block text-sm font-medium">{user!.name}</span>
                    <span className="block text-[11px] text-muted-foreground">{roleLabel[user!.role]}</span>
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm">{user!.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">@{user!.username}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <div className="sm:hidden">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">View as (demo)</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={user!.role} onValueChange={(v) => { switchRole(v as Role); navigate("/") }}>
                    {(Object.keys(roleLabel) as Role[]).map((r) => (
                      <DropdownMenuRadioItem key={r} value={r}>
                        {roleLabel[r]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </div>
                <DropdownMenuItem onClick={signOut}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-8 lg:px-10 lg:py-10">
          <Suspense fallback={<Skeleton className="h-96" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
