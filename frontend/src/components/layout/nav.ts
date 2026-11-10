import {
  CalendarClock,
  BarChart3,
  Building2,
  FileSpreadsheet,
  Gauge,
  FileText,
  Inbox,
  LayoutDashboard,
  PlugZap,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { ModuleKey, User } from "@/api/types"
import { can, isAdmin } from "@/lib/access"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Shown only to users with at least "view" on this module (admins see everything). */
  module?: ModuleKey
  adminOnly?: boolean
  /** Other path prefixes that count as this item (e.g. a run's page is part of Research). */
  also?: string[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, module: "dashboard" }],
  },
  {
    label: "Signals",
    items: [
      { to: "/schedules", label: "Research", icon: CalendarClock, module: "runs", also: ["/runs/"] },
      { to: "/outbox", label: "Delivery outbox", icon: Inbox, module: "runs" },
    ],
  },
  {
    label: "Accounts",
    items: [
      { to: "/companies", label: "Companies (Logos)", icon: Building2, module: "companies" },
      { to: "/pams", label: "PAMs", icon: Users, module: "pams" },
      { to: "/imports", label: "Uploads", icon: FileSpreadsheet, module: "imports" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/templates", label: "Output templates", icon: FileText },
      { to: "/integrations", label: "Providers & channels", icon: PlugZap, module: "integrations" },
    ],
  },
  {
    label: "Governance",
    items: [
      { to: "/costs", label: "Costs (FinOps)", icon: BarChart3, module: "costs" },
      { to: "/telemetry", label: "Telemetry", icon: Gauge, module: "telemetry" },
      { to: "/audit", label: "Audit log", icon: ScrollText, module: "audit" },
    ],
  },
  {
    label: "Administration",
    items: [{ to: "/users", label: "Users & access", icon: ShieldCheck, adminOnly: true }],
  },
]

/** Only what the server would let this user open (it still enforces every request). */
export const visible = (user: User | null | undefined, i: NavItem) => (i.adminOnly ? isAdmin(user) : !i.module || can(user, i.module))

/** Where to land after sign-in: the first page this user may open. */
export const firstAllowed = (user: User | null | undefined) =>
  navGroups.flatMap((g) => g.items).find((i) => visible(user, i))?.to ?? "/templates"
