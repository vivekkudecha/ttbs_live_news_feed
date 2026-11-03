/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, type ReactNode } from "react"

/**
 * DOM slots in the top bar that pages render into (via portals) for their title,
 * description and page-level actions. Portals keep the page's own React tree, so
 * there is no state round-trip through the shell (and no re-render loop).
 */
interface Slots {
  title: HTMLElement | null
  actions: HTMLElement | null
  setTitle: (el: HTMLElement | null) => void
  setActions: (el: HTMLElement | null) => void
}

const TopbarContext = createContext<Slots | null>(null)

export function TopbarProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<HTMLElement | null>(null)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  return <TopbarContext.Provider value={{ title, actions, setTitle, setActions }}>{children}</TopbarContext.Provider>
}

export function useTopbarSlots() {
  const ctx = useContext(TopbarContext)
  if (!ctx) throw new Error("useTopbarSlots must be used within TopbarProvider")
  return ctx
}
