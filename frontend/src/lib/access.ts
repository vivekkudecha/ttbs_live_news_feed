import type { ModuleKey, PermLevel, User } from "@/api/types"

const RANK: Record<PermLevel, number> = { view: 1, manage: 2 }

/** Mirrors the server guard (backend/app/core/permissions.py). The UI uses it only to hide what
 * would be refused anyway: the server is the one that enforces access. */
export function can(user: User | null | undefined, module: ModuleKey, level: PermLevel = "view"): boolean {
  if (!user) return false
  if (user.role === "admin") return true
  const granted = user.permissions[module]
  return !!granted && RANK[granted] >= RANK[level]
}

export const isAdmin = (user: User | null | undefined) => user?.role === "admin"
