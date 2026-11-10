import { Mail, MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { DeliveryChannel } from "@/api/types"

const CHANNELS: { key: DeliveryChannel; label: string; hint: string; icon: typeof Mail }[] = [
  { key: "email", label: "Email", hint: "Digest to each PAM's inbox", icon: Mail },
  { key: "whatsapp", label: "WhatsApp", hint: "Short alert to each PAM", icon: MessageCircle },
]

/** Delivery channels as toggle tiles (any combination; at least one is required to start). */
export function ChannelPicker({ value, onChange }: { value: DeliveryChannel[]; onChange: (v: DeliveryChannel[]) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {CHANNELS.map((c) => {
        const on = value.includes(c.key)
        return (
          <button
            key={c.key}
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => onChange(on ? value.filter((x) => x !== c.key) : [...value, c.key])}
            className={cn(
              "flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all duration-200 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border-primary/60 bg-primary/[0.06]" : "bg-card opacity-80 hover:opacity-100",
            )}
          >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-md transition-colors", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
              <c.icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{c.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{c.hint}</span>
            </span>
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
