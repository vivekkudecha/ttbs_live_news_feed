import { useState, type ReactNode } from "react"
import { Check, ChevronsUpDown, Loader2, PlusCircle, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useCompanySearch, usePamSearch, usePamsById } from "@/api/hooks"
import { useDebounced } from "@/lib/use-debounced"
import { cn } from "@/lib/utils"
import type { CompanyOption, PamOption } from "@/api/types"

/*
 * Server-backed pickers. With 5,000 PAMs and 10,000 logos a plain <Select> would mount
 * thousands of DOM nodes and filter on the UI thread. These query the server as you type
 * (debounced, max 30 results) and never render more than one screen of options.
 */

function SearchShell({
  open,
  onOpenChange,
  trigger,
  query,
  setQuery,
  loading,
  placeholder,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  trigger: ReactNode
  query: string
  setQuery: (q: string) => void
  loading: boolean
  placeholder: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <div className="relative">
            <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
            {loading && <Loader2 className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
          </div>
          <CommandList className="max-h-72">
            {children}
            {footer}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const pamMeta = (p: PamOption) => `${p.segment} · ${p.load}/${p.capacity} logos`

/** Single PAM selector. `value=""` with `allLabel` acts as "All PAMs". */
export function PamPicker({
  value,
  onChange,
  placeholder = "Choose a PAM",
  allLabel,
  activeOnly,
  excludeId,
  className,
  id,
}: {
  value: string
  onChange: (id: string, pam?: PamOption) => void
  placeholder?: string
  allLabel?: string
  activeOnly?: boolean
  excludeId?: string
  className?: string
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const q = useDebounced(query, 200)
  const results = usePamSearch(q, { activeOnly, excludeId }, open)
  const selected = usePamsById(value ? [value] : [])
  const label = value ? (selected.data?.[0]?.name ?? "…") : (allLabel ?? placeholder)

  return (
    <SearchShell
      open={open}
      onOpenChange={setOpen}
      query={query}
      setQuery={setQuery}
      loading={results.isFetching}
      placeholder="Search 5,000 PAMs by name, email or segment"
      trigger={
        <Button id={id} variant="outline" role="combobox" aria-expanded={open} className={cn("h-9 justify-between font-normal", !value && !allLabel && "text-muted-foreground", className)}>
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      }
    >
      <CommandEmpty>{results.isFetching ? "Searching…" : "No PAM matches."}</CommandEmpty>
      <CommandGroup>
        {allLabel && (
          <CommandItem value="__all" onSelect={() => (onChange(""), setOpen(false))}>
            <Check className={cn("size-4", value ? "opacity-0" : "opacity-100")} />
            {allLabel}
          </CommandItem>
        )}
        {results.data?.map((p) => (
          <CommandItem key={p.id} value={p.id} onSelect={() => (onChange(p.id, p), setOpen(false))}>
            <Check className={cn("size-4", value === p.id ? "opacity-100" : "opacity-0")} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="tabular shrink-0 text-xs text-muted-foreground">{pamMeta(p)}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </SearchShell>
  )
}

/** Multi-select PAM filter for tables (same look as the faceted filters). */
export function PamMultiFilter({ value, onChange, title = "PAM" }: { value: string[]; onChange: (ids: string[]) => void; title?: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const q = useDebounced(query, 200)
  const results = usePamSearch(q, {}, open)
  const selected = usePamsById(value)
  const set = new Set(value)
  const toggle = (id: string) => onChange(set.has(id) ? value.filter((x) => x !== id) : [...value, id])

  return (
    <SearchShell
      open={open}
      onOpenChange={setOpen}
      query={query}
      setQuery={setQuery}
      loading={results.isFetching}
      placeholder="Search PAMs"
      trigger={
        <Button variant="outline" size="sm" className="h-9 border-dashed font-normal">
          <PlusCircle className="opacity-60" />
          {title}
          {value.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <Badge variant="secondary" className="rounded-sm px-1.5 font-normal">
                {value.length === 1 ? (selected.data?.[0]?.name ?? "1 selected") : `${value.length} selected`}
              </Badge>
            </>
          )}
        </Button>
      }
      footer={
        value.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__clear" onSelect={() => onChange([])} className="justify-center">
                <X className="size-3.5" /> Clear filter
              </CommandItem>
            </CommandGroup>
          </>
        )
      }
    >
      <CommandEmpty>No PAM matches.</CommandEmpty>
      {!q && selected.data && selected.data.length > 0 && (
        <CommandGroup heading="Selected">
          {selected.data.map((p) => (
            <CommandItem key={`sel-${p.id}`} value={`sel-${p.id}`} onSelect={() => toggle(p.id)}>
              <span className="flex size-4 items-center justify-center rounded-[4px] border border-primary bg-primary text-primary-foreground">
                <Check className="size-3" />
              </span>
              <span className="truncate">{p.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      <CommandGroup heading={q ? "Results" : "PAMs"}>
        {results.data
          ?.filter((p) => q || !set.has(p.id))
          .map((p) => (
            <CommandItem key={p.id} value={p.id} onSelect={() => toggle(p.id)}>
              <span className={cn("flex size-4 items-center justify-center rounded-[4px] border", set.has(p.id) ? "border-primary bg-primary text-primary-foreground" : "border-input [&_svg]:invisible")}>
                <Check className="size-3" />
              </span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.segment}</span>
            </CommandItem>
          ))}
      </CommandGroup>
    </SearchShell>
  )
}

/** Single company selector (10,000 logos). */
export function CompanyPicker({ value, onChange, className }: { value: CompanyOption | null; onChange: (c: CompanyOption) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const q = useDebounced(query, 200)
  const results = useCompanySearch(q, open)
  return (
    <SearchShell
      open={open}
      onOpenChange={setOpen}
      query={query}
      setQuery={setQuery}
      loading={results.isFetching}
      placeholder="Search 10,000 logos"
      trigger={
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn("h-9 w-full justify-between font-normal", className)}>
          <span className="truncate">{value?.name ?? "Choose a company"}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      }
    >
      <CommandEmpty>No company matches.</CommandEmpty>
      <CommandGroup>
        {results.data?.map((c) => (
          <CommandItem key={c.id} value={c.id} onSelect={() => (onChange(c), setOpen(false))}>
            <Check className={cn("size-4", value?.id === c.id ? "opacity-100" : "opacity-0")} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-xs text-muted-foreground">{c.industry}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </SearchShell>
  )
}
