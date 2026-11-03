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
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Signals",
    items: [
      { to: "/signals", label: "Signals feed", icon: Zap },
      { to: "/digest", label: "PAM digest preview", icon: MailCheck },
      { to: "/runs", label: "Research runs", icon: Activity },
    ],
  },
  {
    label: "Accounts",
    items: [
      { to: "/companies", label: "Companies (Logos)", icon: Building2 },
      { to: "/pams", label: "PAMs", icon: Users },
      { to: "/imports", label: "Imports", icon: FileSpreadsheet },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/templates", label: "Output templates", icon: FileText },
      { to: "/schedules", label: "Schedules", icon: CalendarClock },
      { to: "/integrations", label: "Providers & channels", icon: PlugZap },
    ],
  },
  {
    label: "Governance",
    items: [
      { to: "/costs", label: "Costs (FinOps)", icon: BarChart3 },
      { to: "/audit", label: "Audit log", icon: ScrollText },
    ],
  },
]
