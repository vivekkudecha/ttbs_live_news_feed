/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { AUTH_EVENT, setCsrfToken, type AuthEventDetail } from "@/api/http"
import type { SessionInfo, User } from "@/api/types"

/*
 * The session lives on the server. The browser holds an HttpOnly cookie (invisible to JS) and,
 * in memory only, the CSRF token. On page load GET /auth/me restores both; nothing about the
 * session is written to localStorage or sessionStorage.
 */
interface SessionValue {
  /** undefined while the initial /auth/me check runs. */
  user: User | null | undefined
  /** Store a session returned by sign-in or a password change. */
  establish: (s: SessionInfo) => void
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [user, setUser] = useState<User | null | undefined>(undefined)

  const establish = useCallback((s: SessionInfo) => {
    setCsrfToken(s.csrfToken)
    setUser(s.user)
  }, [])

  const clear = useCallback(() => {
    setCsrfToken(null)
    setUser(null)
    qc.clear() // no previous user's data survives in the cache
  }, [qc])

  useEffect(() => {
    let alive = true
    api
      .me()
      .then((s) => alive && establish(s))
      .catch(() => alive && clear())
    return () => {
      alive = false
    }
  }, [establish, clear])

  useEffect(() => {
    const on = (e: Event) => {
      const { reason } = (e as CustomEvent<AuthEventDetail>).detail
      if (reason === "signed_out") clear()
      else setUser((u) => (u ? { ...u, mustChangePassword: true } : u))
    }
    window.addEventListener(AUTH_EVENT, on)
    return () => window.removeEventListener(AUTH_EVENT, on)
  }, [clear])

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      /* already ended server-side */
    }
    clear()
  }, [clear])

  return <SessionContext.Provider value={{ user, establish, signOut }}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used within SessionProvider")
  return ctx
}
