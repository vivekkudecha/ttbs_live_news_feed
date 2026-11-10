/**
 * Readable research findings. The model writes key signals as one long paragraph with its source
 * URLs inline, e.g. "Raipur hospital running…; the Rs 700 crore fundraise… (https://a ; https://b)".
 * For display we take the URLs out (they are listed once, as sources) and split the text into points.
 */
import type { Source } from "@/api/types"

const URL_RE = /https?:\/\/[^\s)\];,]+/g

/** URLs mentioned in the text, in order, without duplicates. */
export function urlsIn(text: string | null | undefined): string[] {
  return [...new Set((text ?? "").match(URL_RE) ?? [])].map((u) => u.replace(/[.,]+$/, ""))
}

/** The text without its URLs (and the brackets / separators left around them). */
export function withoutUrls(text: string | null | undefined): string {
  return (text ?? "")
    .replace(URL_RE, "")
    .replace(/\(\s*(?:[;,|]\s*)*\)/g, "") // "( ; ; )" left by a URL list
    .replace(/\[\s*\]/g, "")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
}

/** Split into points at "; " and at sentence ends. Short fragments are kept with the point before. */
export function points(text: string | null | undefined): string[] {
  const clean = withoutUrls(text)
  if (!clean) return []
  const raw = clean.split(/;\s+|(?<=[a-z0-9)\]*%])\.\s+(?=\*{0,2}[A-Z])/)
  const out: string[] = []
  for (const piece of raw.map((p) => p.trim().replace(/[.;]+$/, "")).filter(Boolean)) {
    if (out.length && piece.length < 25) out[out.length - 1] += `; ${piece}`
    else out.push(piece[0].toUpperCase() + piece.slice(1))
  }
  return out
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "")
  } catch {
    return u
  }
}

/** The result's sources plus any URL only mentioned in its text, each with a short label. */
export function allSources(sources: Source[] | undefined, ...texts: (string | null | undefined)[]): { url: string; label: string }[] {
  const seen = new Set<string>()
  const out: { url: string; label: string }[] = []
  for (const s of sources ?? []) {
    if (!s?.url || seen.has(s.url)) continue
    seen.add(s.url)
    out.push({
      url: s.url,
      label: s.title && !/^https?:/.test(s.title) ? s.title : host(s.url),
    })
  }
  for (const u of texts.flatMap(urlsIn)) {
    if (seen.has(u)) continue
    seen.add(u)
    out.push({ url: u, label: host(u) })
  }
  return out
}
