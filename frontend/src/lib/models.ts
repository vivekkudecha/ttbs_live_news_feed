/** Model ids look like "anthropic/claude-haiku-5-5" (owner/name) on Perplexity, or "gemini-3.6-flash". */
const MODEL_OWNERS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  perplexity: "Perplexity",
  moonshotai: "Moonshot AI",
  "z-ai": "Z.ai",
  nvidia: "NVIDIA",
}
const PROVIDERS: Record<string, string> = { perplexity: "Perplexity", gemini: "Gemini", fake: "Offline test AI" }

export const ownerLabel = (k: string) => MODEL_OWNERS[k] ?? k.charAt(0).toUpperCase() + k.slice(1)
export const shortModel = (id: string | null | undefined) => (id?.includes("/") ? id.split("/").slice(1).join("/") : id) ?? ""
export const providerLabel = (k: string) => PROVIDERS[k] ?? ownerLabel(k)
/** "Anthropic via Perplexity", or just the provider when the model id has no owner. */
export const modelSource = (provider: string | null | undefined, model: string | null | undefined) => {
  const owner = model?.includes("/") ? ownerLabel(model.split("/")[0]) : null
  const via = provider ? providerLabel(provider) : null
  return owner && via ? `${owner} via ${via}` : (owner ?? via ?? "")
}
