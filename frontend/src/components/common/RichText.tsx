import { Fragment } from "react"

/**
 * Renders the model's light markdown (**bold**) as React nodes.
 * Never uses innerHTML: model output is untrusted (prompt injection via web pages).
 */
export function RichText({ text }: { text?: string }) {
  if (!text) return null
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-foreground">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function safeHref(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined
  } catch {
    return undefined
  }
}
