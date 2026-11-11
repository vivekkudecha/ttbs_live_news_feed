import type { ReactNode } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** The card-styled bar above a server table (Companies, PAMs): search · filters · (right) actions. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-xs", className)}>{children}</div>
}

/**
 * Toolbar search: gives up width first (breaks lines at 8rem, then grows into the free space up to 18rem),
 * so the toolbar stays one row on laptops. Clearable.
 */
export function ToolbarSearch({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="relative w-full sm:w-auto sm:min-w-32 sm:max-w-72 sm:flex-[1_1_8rem]">
      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label={label} placeholder={placeholder} className="border-transparent bg-muted/60 pl-9 pr-8 focus-visible:bg-card" value={value} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
