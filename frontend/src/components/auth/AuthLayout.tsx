import type { ReactNode } from "react"
import { Radio, Send, Sparkles } from "lucide-react"
import { Logo } from "@/components/common/Logo"
import { cn } from "@/lib/utils"

const points = [
  { icon: Sparkles, text: "AI research on every logo, every cycle" },
  { icon: Radio, text: "Live progress while a run is researching" },
  { icon: Send, text: "Digests to each PAM by email and WhatsApp" },
]

/** Sign-in style pages: brand panel on large screens, a single focused column everywhere. */
export function AuthLayout({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden border-r bg-card lg:flex lg:flex-col lg:justify-between lg:p-12 3xl:p-16">
        {/* Soft brand glows; decorative only. */}
        <div className="pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-brand-blue/15 blur-3xl motion-safe:animate-pulse" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-40 right-0 size-[24rem] rounded-full bg-brand/15 blur-3xl" aria-hidden="true" />
        <Logo size="lg" className="relative" />
        <div className="relative max-w-lg space-y-8">
          <h2 className="text-4xl font-medium leading-tight tracking-tight 3xl:text-5xl">
            Know <span className="text-brand-gradient">why now</span> for every account.
          </h2>
          <ul className="space-y-4">
            {points.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-muted-foreground">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-muted-foreground">Tata Tele Business Services · Internal sales tool</p>
      </aside>

      <main className="flex flex-col">
        <div className="h-1 bg-brand-gradient lg:hidden" aria-hidden="true" />
        <div className="flex flex-1 items-center justify-center px-4 py-12">
          <div className={cn("enter w-full max-w-[26rem]", className)}>
            <Logo size="lg" className="lg:hidden" />
            {children}
          </div>
        </div>
        <p className="px-4 pb-6 text-center text-sm text-muted-foreground lg:hidden">Tata Tele Business Services · Internal sales tool</p>
      </main>
    </div>
  )
}
