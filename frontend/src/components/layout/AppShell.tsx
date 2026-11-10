import { Suspense, useEffect, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { motion } from "motion/react"
import { useTheme } from "next-themes"
import { KeyRound, LogOut, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react"
import { useIsFetching } from "@tanstack/react-query"
import { Logo } from "@/components/common/Logo"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
import { useSession } from "@/context/session"
import { navGroups, visible, type NavItem as NavItemDef } from "./nav"
import { TopbarProvider, useTopbarSlots } from "./topbar"
import { cn } from "@/lib/utils"
import { preloadRoute } from "@/lib/route-chunks"
import { PageTransition } from "@/components/motion/PageTransition"
import { LogoDrawerProvider } from "@/components/logo/LogoDrawer"
import { initials } from "@/lib/format"

const RAIL_KEY = "ttbs.sidebar.rail"

/** Sidebar collapse preference; defaults to the icon rail on narrow laptops (< 1280px). */
function useRail() {
  const [rail, setRail] = useState(() => {
    try {
      const saved = localStorage.getItem(RAIL_KEY)
      if (saved !== null) return saved === "1"
    } catch {
      /* storage blocked: fall back to the width default */
    }
    return window.innerWidth < 1280
  })
  const toggle = () =>
    setRail((r) => {
      try {
        localStorage.setItem(RAIL_KEY, r ? "0" : "1")
      } catch {
        /* preference just won't persist */
      }
      return !r
    })
  // Very short windows (< 640px tall) always get the icon rail, so nothing has to scroll.
  const [tooShort, setTooShort] = useState(() => window.matchMedia("(max-height: 640px)").matches)
  useEffect(() => {
    const mq = window.matchMedia("(max-height: 640px)")
    const on = () => setTooShort(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return [rail || tooShort, toggle] as const
}

function NavItem({ item, rail, onNavigate, layoutGroup }: { item: NavItemDef; rail: boolean; onNavigate?: () => void; layoutGroup: string }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      onClick={onNavigate}
      onMouseEnter={() => preloadRoute(item.to)}
      onFocus={() => preloadRoute(item.to)}
      aria-label={rail ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          "group/nav relative flex items-center gap-3 rounded-lg px-3 py-2 text-[0.9375rem] text-sidebar-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
          "short:py-1 tiny:py-[3px] tiny:text-sm",
          rail && "justify-center px-0",
          isActive && "font-medium text-sidebar-accent-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* One shared highlight that glides to the active item. */}
          {isActive && (
            <motion.span
              layoutId={`nav-active-${layoutGroup}`}
              className="absolute inset-0 rounded-lg bg-sidebar-accent before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-brand-gradient"
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
            />
          )}
          <item.icon className="relative size-[1.125rem] shrink-0 opacity-80 transition-transform duration-200 group-hover/nav:scale-110" strokeWidth={1.75} />
          {!rail && <span className="relative truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  )
  if (!rail) return link
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  )
}

function Sidebar({ rail = false, onToggle, onNavigate, layoutGroup = "desktop" }: { rail?: boolean; onToggle?: () => void; onNavigate?: () => void; layoutGroup?: string }) {
  const { user } = useSession()
  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar/95 text-sidebar-foreground backdrop-blur">
      <div className={cn("flex shrink-0 items-center gap-2 pb-3 pt-5 short:pb-1.5 short:pt-3", rail ? "flex-col justify-center px-2" : "px-5")}>
        <Logo compact={rail} />
        {onToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onToggle} className={cn("text-muted-foreground", !rail && "ml-auto")} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}>
                {rail ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{rail ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {/* No scrollbar: spacing tightens on shorter screens (short:/tiny: variants) so everything fits. */}
      <nav className={cn("flex min-h-0 flex-1 flex-col gap-4 py-2 short:gap-2 short:py-1 tiny:gap-1", rail ? "px-2.5" : "px-3")}>
        {navGroups.map((g) => {
          const items = g.items.filter((i) => visible(user, i))
          if (items.length === 0) return null
          return (
            <div key={g.label}>
              {rail ? (
                <Separator className="mx-auto mb-1.5 w-6" />
              ) : (
                <p className="eyebrow px-3 pb-1.5 short:pb-0.5 short:text-[0.6875rem]">{g.label}</p>
              )}
              <ul className="space-y-0.5 tiny:space-y-0">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavItem item={i} rail={rail} onNavigate={onNavigate} layoutGroup={layoutGroup} />
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>
    </div>
  )
}

/** Thin brand-gradient sweep across the top bar whenever any query is fetching. */
function FetchIndicator() {
  const busy = useIsFetching() > 0
  return (
    <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden transition-opacity duration-300", busy ? "opacity-100" : "opacity-0")} aria-hidden="true">
      <div className="h-full w-2/5 bg-brand-gradient motion-safe:animate-[sweep_1.1s_ease-in-out_infinite]" />
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
  return (
    <TopbarProvider>
      <LogoDrawerProvider>
        <Shell />
      </LogoDrawerProvider>
    </TopbarProvider>
  )
}

function Shell() {
  const slots = useTopbarSlots()
  const { user, signOut } = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [rail, toggleRail] = useRail()

  return (
    <div className="flex min-h-svh bg-background">
      <aside className={cn("sticky top-0 hidden h-svh shrink-0 transition-[width] duration-300 lg:block", rail ? "w-[4.5rem]" : "w-64 3xl:w-72")}>
        <Sidebar rail={rail} onToggle={toggleRail} />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 border-0 p-0" showCloseButton={false} dismissOnOutsideClick>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar onNavigate={() => setOpen(false)} layoutGroup="mobile" />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur-md sm:px-6 lg:px-8 3xl:px-12">
          <FetchIndicator />
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          {/* Pages render their title/description and actions into these slots (PageHeader). */}
          <div ref={slots.setTitle} className="min-w-0 flex-1" />
          <div ref={slots.setActions} className="flex shrink-0 items-center gap-2" />
          <span className="mx-1 hidden h-6 w-px bg-border md:block" aria-hidden="true" />
          <div className="flex shrink-0 items-center gap-1.5">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-9 gap-2 px-1.5">
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-brand-gradient text-xs font-semibold text-white">{initials(user!.name)}</AvatarFallback>
                  </Avatar>
                  <span className="hidden text-sm font-medium md:block">{user!.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm">{user!.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">@{user!.username}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/change-password")}>
                  <KeyRound /> Change password
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[120rem] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 3xl:px-12">
          <Suspense fallback={<Skeleton className="h-96" />}>
            <PageTransition />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
