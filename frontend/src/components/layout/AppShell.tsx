import { Suspense, useCallback, useEffect, useState } from "react"
import { NavLink, useLocation, useMatch, useNavigate } from "react-router-dom"
import { motion } from "motion/react"
import { useTheme } from "next-themes"
import { KeyRound, LogOut, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react"
import { useIsFetching } from "@tanstack/react-query"
import { Logo } from "@/components/common/Logo"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
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
import { applyUiScale, savedUiScale, type UiScale } from "@/lib/ui-scale"

const RAIL_KEY = "ttbs.sidebar.rail"
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform)
const SHORTCUT = isMac ? "⌘B" : "Ctrl+B"

/**
 * Sidebar collapse preference. First visit: the icon rail on narrow (< 1280px) or short (< 640px)
 * screens. After that the choice persists and can be toggled on any screen, from the button at the
 * foot of the sidebar or with Ctrl/⌘+B.
 */
function useRail() {
  const [rail, setRail] = useState(() => {
    try {
      const saved = localStorage.getItem(RAIL_KEY)
      if (saved !== null) return saved === "1"
    } catch {
      /* storage blocked: fall back to the screen default */
    }
    return window.innerWidth < 1280 || window.innerHeight < 640
  })
  const toggle = useCallback(() => {
    setRail((r) => {
      try {
        localStorage.setItem(RAIL_KEY, r ? "0" : "1")
      } catch {
        /* preference just won't persist */
      }
      return !r
    })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])
  return [rail, toggle] as const
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-sidebar-border bg-sidebar px-1.5 py-0.5 font-sans text-[0.6875rem] font-medium text-muted-foreground">{children}</kbd>
}

function NavItem({ item, rail, onNavigate, layoutGroup }: { item: NavItemDef; rail: boolean; onNavigate?: () => void; layoutGroup: string }) {
  const { pathname } = useLocation()
  // Active state is computed here rather than through NavLink's className callback: the rail wraps
  // the link in a TooltipTrigger (Radix Slot), which joins class names as strings and would turn a
  // callback into its own source text.
  const match = useMatch({ path: item.to, end: item.to === "/" })
  const active = !!match || !!item.also?.some((p) => pathname.startsWith(p))
  const link = (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      onClick={onNavigate}
      onMouseEnter={() => preloadRoute(item.to)}
      onFocus={() => preloadRoute(item.to)}
      aria-label={rail ? item.label : undefined}
      className={cn(
        "group/nav relative flex items-center gap-3 rounded-lg px-3 py-2 text-[0.9375rem] leading-5 text-sidebar-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
        "short:py-1.5 tiny:py-1 tiny:text-sm",
        rail && "mx-auto size-10 justify-center p-0 short:size-9 tiny:size-8",
        active && "font-medium text-sidebar-accent-foreground",
      )}
    >
      {/* One shared highlight that glides to the active item. */}
      {active && (
        <motion.span
          layoutId={`nav-active-${layoutGroup}`}
          className="absolute inset-0 rounded-lg bg-sidebar-accent before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-brand-gradient"
          transition={{ type: "spring", stiffness: 520, damping: 40 }}
        />
      )}
      <item.icon className="relative size-[1.125rem] shrink-0 opacity-80 transition-transform duration-200 group-hover/nav:scale-110" strokeWidth={1.75} />
      {!rail && <span className="relative truncate whitespace-nowrap">{item.label}</span>}
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

/**
 * Brand row, the navigation list and (when the sidebar is collapsible) the collapse/expand control.
 * Height adapts to the screen: spacing tightens on shorter windows (short:/tiny: variants) and, if
 * the list still cannot fit, it scrolls instead of clipping the last items.
 */
function Sidebar({ rail = false, onToggle, onNavigate, layoutGroup = "desktop" }: { rail?: boolean; onToggle?: () => void; onNavigate?: () => void; layoutGroup?: string }) {
  const { user } = useSession()
  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar/95 text-sidebar-foreground backdrop-blur">
      {/* Same height as the top bar so the two bottom borders meet in one line. */}
      <div className={cn("flex h-16 shrink-0 items-center border-b border-sidebar-border", rail ? "justify-center px-2" : "px-6")}>
        <Logo compact={rail} />
      </div>
      <nav aria-label="Main" className={cn("sidebar-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden py-4 short:gap-3 short:py-3 tiny:gap-2 tiny:py-2", rail ? "px-2" : "px-3")}>
        {navGroups.map((g) => {
          const items = g.items.filter((i) => visible(user, i))
          if (items.length === 0) return null
          return (
            <div key={g.label}>
              {rail ? (
                <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border short:mb-1.5 tiny:mb-1" aria-hidden="true" />
              ) : (
                <p className="eyebrow px-3 pb-2 short:pb-1.5 short:text-[0.6875rem] tiny:pb-1">{g.label}</p>
              )}
              <ul className="space-y-1 short:space-y-0.5 tiny:space-y-px">
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
      {onToggle && (
        <div className={cn("shrink-0 border-t border-sidebar-border px-3 py-2.5 short:py-2", rail && "flex justify-center px-2")}>
          {rail ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onToggle} className="text-muted-foreground" aria-label="Expand sidebar" aria-expanded={false}>
                  <PanelLeftOpen />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="flex items-center gap-2">
                Expand sidebar <Kbd>{SHORTCUT}</Kbd>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button variant="ghost" size="sm" onClick={onToggle} className="h-9 w-full justify-start gap-3 px-3 text-muted-foreground short:h-8" aria-label="Collapse sidebar" aria-expanded={true}>
              <PanelLeftClose className="size-[1.125rem]" strokeWidth={1.75} />
              <span className="flex-1 text-left">Collapse</span>
              <Kbd>{SHORTCUT}</Kbd>
            </Button>
          )}
        </div>
      )}
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

/** Display menu: theme, and the size multiplier on top of the screen-fitted scale. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [scale, setScale] = useState(savedUiScale)
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Display">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="eyebrow">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="eyebrow">Size</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={scale}
          onValueChange={(v) => {
            setScale(v as UiScale)
            applyUiScale(v as UiScale, true)
          }}
        >
          <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="default">Default</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="large">Large</DropdownMenuRadioItem>
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
      {/* Tablets and up: a persistent sidebar, icon rail or full width, toggled by the user. Phones: a drawer. */}
      <aside
        data-state={rail ? "collapsed" : "expanded"}
        className={cn("sticky top-0 hidden h-svh shrink-0 transition-[width] duration-300 ease-out md:block", rail ? "w-[4.5rem]" : "w-64 3xl:w-72")}
      >
        <Sidebar rail={rail} onToggle={toggleRail} />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[min(18rem,85vw)] border-0 p-0" showCloseButton={false} dismissOnOutsideClick>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar onNavigate={() => setOpen(false)} layoutGroup="mobile" />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur-md sm:px-6 lg:px-8 3xl:px-12">
          <FetchIndicator />
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
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
                <Button variant="ghost" className="gap-2 px-1.5">
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
