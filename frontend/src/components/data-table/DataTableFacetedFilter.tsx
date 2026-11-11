import { Check, PlusCircle } from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export interface FacetOption {
  value: string
  label: string
  icon?: ReactNode
}

/**
 * Multi-select filter with live counts. Controlled: the server computes `counts`
 * (each facet counts rows matching every *other* active filter).
 */
export function DataTableFacetedFilter({
  title,
  options,
  value,
  onChange,
  counts,
}: {
  title: string
  options: FacetOption[]
  value: string[]
  onChange: (next: string[]) => void
  counts?: Record<string, number>
}) {
  const selected = new Set(value)

  const toggle = (v: string) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="font-normal">
          <PlusCircle className="opacity-60 max-2xl:hidden" />
          {title}
          {selected.size > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              {selected.size > 2 ? (
                <Badge variant="secondary" className="rounded-sm px-1.5 font-normal">
                  {selected.size} selected
                </Badge>
              ) : (
                options
                  .filter((o) => selected.has(o.value))
                  .map((o) => (
                    <Badge key={o.value} variant="secondary" className="rounded-sm px-1.5 font-normal">
                      {o.label}
                    </Badge>
                  ))
              )}
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const isSelected = selected.has(o.value)
                return (
                  <CommandItem key={o.value} onSelect={() => toggle(o.value)}>
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded-[4px] border",
                        isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input [&_svg]:invisible",
                      )}
                    >
                      <Check className="size-3" />
                    </span>
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                    <span className="tabular ml-auto text-xs text-muted-foreground">{(counts?.[o.value] ?? 0).toLocaleString("en-IN")}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {selected.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => onChange([])} className="justify-center text-center">
                    Clear filter
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
