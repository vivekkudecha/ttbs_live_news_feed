/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, type ReactNode } from "react"
import type { Role, User } from "@/api/types"

interface SessionValue {
  user: User | null
  signIn: (u: User) => void
  signOut: () => void
  switchRole: (role: Role) => void
}

const SessionContext = createContext<SessionValue | null>(null)
const KEY = "ttbs-demo-session"

function load(): User | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

function save(u: User | null) {
  try {
    if (u) sessionStorage.setItem(KEY, JSON.stringify(u))
    else sessionStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: session lives in memory only */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(load)
  const set = (u: User | null) => {
    save(u)
    setUser(u)
  }
  return (
    <SessionContext.Provider
      value={{
        user,
        signIn: set,
        signOut: () => set(null),
        switchRole: (role) => user && set({ ...user, role, pamId: role === "pam" ? (user.pamId ?? "p1") : user.pamId }),
      }}
    >
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used within SessionProvider")
  return ctx
}

/** UI-side permission checks. The backend enforces the same rules server-side. */
export const can = {
  manageData: (r?: Role) => r === "admin" || r === "manager",
  admin: (r?: Role) => r === "admin",
  runJobs: (r?: Role) => r === "admin" || r === "manager",
  viewAudit: (r?: Role) => r === "admin" || r === "auditor",
  viewCosts: (r?: Role) => r === "admin" || r === "manager" || r === "auditor",
}

export const roleLabel: Record<Role, string> = {
  admin: "Admin",
  manager: "Sales Manager",
  pam: "PAM",
  auditor: "Auditor",
}
