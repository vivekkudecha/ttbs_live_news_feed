import {
  Activity,
  BarChart3,
  Building2,
  CalendarClock,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  MailCheck,
  PlugZap,
  ScrollText,
  ShieldCheck,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react"
import type { Role } from "@/api/types"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  roles: Role[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

const ALL: Role[] = ["admin", "manager", "pam", "auditor"]
const STAFF: Role[] = ["admin", "manager", "auditor"]

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, roles: ALL }],
  },
  {
    label: "Signals",
    items: [
      { to: "/signals", label: "Signals feed", icon: Zap, roles: ALL },
      { to: "/digest", label: "PAM digest preview", icon: MailCheck, roles: ALL },
      { to: "/runs", label: "Research runs", icon: Activity, roles: STAFF },
    ],
  },
  {
    label: "Accounts",
    items: [
      { to: "/companies", label: "Companies (Logos)", icon: Building2, roles: ALL },
      { to: "/pams", label: "PAMs", icon: Users, roles: STAFF },
      { to: "/imports", label: "Imports", icon: FileSpreadsheet, roles: STAFF },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/templates", label: "Output templates", icon: FileText, roles: STAFF },
      { to: "/schedules", label: "Schedules", icon: CalendarClock, roles: STAFF },
      { to: "/integrations", label: "Providers & channels", icon: PlugZap, roles: ["admin", "auditor"] },
    ],
  },
  {
    label: "Governance",
    items: [
      { to: "/costs", label: "Costs (FinOps)", icon: BarChart3, roles: STAFF },
      { to: "/audit", label: "Audit log", icon: ScrollText, roles: ["admin", "auditor"] },
      { to: "/users", label: "Users & roles", icon: ShieldCheck, roles: ["admin", "auditor"] },
    ],
  },
]

export const allowedPaths = (role: Role) =>
  navGroups.flatMap((g) => g.items.filter((i) => i.roles.includes(role)).map((i) => i.to))
