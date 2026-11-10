import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"

/** Search input for a table toolbar. */
export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label={label} placeholder={placeholder} className="pl-8" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
