import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * A rendered email, isolated in an iframe (no scripts run: `allow-same-origin` only lets us read its
 * height). It grows to the email's full height, so the page scrolls once instead of a box in a box.
 */
export function EmailFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const [height, setHeight] = useState<number | null>(null)
  return (
    <iframe
      title={title}
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument
        if (doc) setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) + 2)
      }}
      style={height ? { height } : undefined}
      className={cn("block min-h-64 w-full rounded-xl border bg-white", !height && "h-[32rem]", className)}
    />
  )
}
