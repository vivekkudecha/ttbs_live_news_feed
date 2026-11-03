/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, type ReactNode } from "react"
import type { User } from "@/api/types"

interface SessionValue {
  user: User | null
  signIn: (u: User) => void
  signOut: () => void
}

const SessionContext = createContext<SessionValue | null>(null)
const KEY = "ttbs-session"

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
  return <SessionContext.Provider value={{ user, signIn: set, signOut: () => set(null) }}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used within SessionProvider")
  return ctx
}
