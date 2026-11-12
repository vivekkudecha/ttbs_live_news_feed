/**
 * Research AI settings (live backend): Perplexity and Google Gemini, ONE active at a time.
 * Per provider: enter API key → Load models (fetched with that key) → pick model provider + model →
 * Verify & save. Saving (or "Use for research") makes that provider the active AI and switches the
 * other off; its saved key stays so you can switch back without re-entering it.
 * Keys are write-only: after saving, only a hint like "pplx-…a1b2" is ever shown.
 */
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Bot, CircleCheck, CircleOff, Eye, EyeOff, KeyRound, ListRestart, Loader2, PlugZap, Power, ShieldCheck, Sparkles, Trash2 } from "lucide-react"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useActivateLlm, useLlmSettings, useLoadLlmModels, useRemoveLlmConfig, useSaveLlmConfig, useTestLlmConfig } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { AiProvider, LlmConfig, LlmModel } from "@/api/types"
import { ownerLabel, shortModel } from "@/lib/models"

const META: Record<AiProvider, { icon: typeof Bot; description: string; keyPlaceholder: string; keyHelp: string }> = {
  perplexity: {
    icon: Bot,
    description: "Perplexity Agent API with web search. Offers models from Anthropic, OpenAI, Google, xAI and others.",
    keyPlaceholder: "pplx-…",
    keyHelp: "perplexity.ai → Settings → API",
  },
  gemini: {
    icon: Sparkles,
    description: "Gemini API with Google Search grounding; cited sources come from Google Search.",
    keyPlaceholder: "AIza…",
    keyHelp: "aistudio.google.com → Get API key",
  },
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"

export function AiProviderSettings() {
  const settings = useLlmSettings()

  if (settings.isLoading) return <Skeleton className="h-72 w-full" />
  if (settings.isError || !settings.data)
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load AI settings: {errorMessage(settings.error)}</AlertDescription>
      </Alert>
    )

  const s = settings.data
  const active = s.providers.find((p) => p.active) ?? null

  return (
    <div className="space-y-4">
      {active ? (
        <Alert>
          <CircleCheck className="text-emerald-600" />
          <AlertTitle>
            Research runs use {active.label} · <code className="text-xs">{active.model}</code>
          </AlertTitle>
          <AlertDescription>Only one AI is active at a time. Saving or activating another provider switches research to it.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <CircleOff />
          <AlertTitle>No AI is active</AlertTitle>
          <AlertDescription>New research runs and schedules are blocked until a provider below is saved.</AlertDescription>
        </Alert>
      )}
      {s.mode === "fake" && (
        <Alert>
          <AlertDescription>
            The server runs in offline mode (<code className="text-xs">LLM_PROVIDER=fake</code>). Saved settings take effect once that is removed.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        {s.providers.map((cfg) => (
          <ProviderCard key={cfg.provider} cfg={cfg} activeLabel={active && !cfg.active ? active.label : null} />
        ))}
      </div>
    </div>
  )
}

function ProviderCard({ cfg: c, activeLabel }: { cfg: LlmConfig; activeLabel: string | null }) {
  const meta = META[c.provider]
  const Icon = meta.icon
  const loadModels = useLoadLlmModels()
  const save = useSaveLlmConfig()
  const activate = useActivateLlm()
  const test = useTestLlmConfig()
  const remove = useRemoveLlmConfig()

  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<LlmModel[] | null>(null)
  const [owner, setOwner] = useState("")
  const [model, setModel] = useState("")
  const [confirmRemove, setConfirmRemove] = useState(false)

  const owners = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of models ?? []) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1)
    return [...counts.entries()].sort(([a], [b]) => ownerLabel(a).localeCompare(ownerLabel(b)))
  }, [models])
  const ownerModels = useMemo(() => (models ?? []).filter((m) => m.provider === owner), [models, owner])

  const resetPicker = () => {
    setModels(null)
    setOwner("")
    setModel("")
  }

  const onKeyChange = (v: string) => {
    setApiKey(v)
    if (models) resetPicker() // models belong to the key they were loaded with
  }

  const onLoad = () =>
    loadModels.mutate(
      { provider: c.provider, apiKey: apiKey.trim() || undefined },
      {
        onSuccess: (res) => {
          setModels(res.models)
          const current = res.models.find((m) => m.id === c.model)
          setOwner(current?.provider ?? res.providers[0]?.key ?? "")
          setModel(current?.id ?? "")
          toast.success(`${res.models.length} ${c.label} models available`)
        },
        onError: (e) => toast.error("Could not load models", { description: errorMessage(e) }),
      },
    )

  const onSave = () =>
    save.mutate(
      { provider: c.provider, apiKey: apiKey.trim() || undefined, model },
      {
        onSuccess: (s) => {
          const saved = s.providers.find((p) => p.provider === c.provider)
          toast.success(`${c.label} is now the active AI`, { description: `${saved?.model} · verified in ${saved?.lastCheckLatencyMs ?? "?"} ms` })
          setApiKey("")
          setShowKey(false)
        },
        onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
      },
    )

  const onActivate = () =>
    activate.mutate(c.provider, {
      onSuccess: () => toast.success(`Research now uses ${c.label}`, { description: c.model ?? undefined }),
      onError: (e) => toast.error(`Could not switch to ${c.label}`, { description: errorMessage(e) }),
    })

  const onTest = () =>
    test.mutate(c.provider, {
      onSuccess: (r) =>
        r.ok
          ? toast.success("Connection OK", { description: `${c.label} answered in ${r.providers.find((p) => p.provider === c.provider)?.lastCheckLatencyMs} ms` })
          : toast.error("Connection failed", { description: r.error ?? "Unknown error" }),
      onError: (e) => toast.error("Test failed", { description: errorMessage(e) }),
    })

  const onRemove = () =>
    remove.mutate(c.provider, {
      onSuccess: () => {
        setConfirmRemove(false)
        resetPicker()
        toast.success(`${c.label} key removed`)
      },
      onError: (e) => toast.error("Not removed", { description: errorMessage(e) }),
    })

  const status = !c.configured ? "not_configured" : c.lastCheckOk === false ? "error" : "connected"
  const canLoad = !!apiKey.trim() || c.configured
  const dirty = !!apiKey.trim() || (!!model && model !== c.model) || (!!model && !c.active)

  return (
    <Card className={c.active ? "ring-2 ring-primary/40" : c.configured ? "" : "border-dashed"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" /> {c.label}
          {c.active ? <Badge>Active</Badge> : c.configured ? <Badge variant="secondary">Saved · off</Badge> : null}
        </CardTitle>
        <CardDescription>{meta.description}</CardDescription>
        <CardAction>
          <StatusBadge status={status} />
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        {c.configured && (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Model</dt>
                <dd className="flex items-center gap-2 font-medium">
                  <Badge variant="outline">{ownerLabel(c.modelProvider ?? "")}</Badge>
                  <code className="truncate text-xs" title={c.model ?? ""}>
                    {shortModel(c.model)}
                  </code>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">API key</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  <KeyRound className="size-3.5 text-muted-foreground" />
                  <code className="text-xs">{c.keyHint}</code>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last check</dt>
                <dd className="font-medium">
                  {c.lastCheckOk ? (
                    <span className="tabular">
                      OK · {c.lastCheckLatencyMs} ms · {when(c.verifiedAt)}
                    </span>
                  ) : (
                    <span className="text-destructive">Failed</span>
                  )}
                </dd>
              </div>
              {c.rateLimit && (
                <div>
                  <dt className="text-xs text-muted-foreground">Rate limit</dt>
                  <dd className="tabular font-medium" title={`Research is paced at ${c.rateLimit.pacedPerSecond} requests/s (90% of the limit), shared by every worker`}>
                    {c.rateLimit.limitPerSecond} req/s
                    <span className="block text-xs font-normal text-muted-foreground">
                      {c.rateLimit.source === "provider" ? `reported by ${c.label}` : "default until the provider reports your tier"}
                      {c.rateLimit.nextSlotInS > 1 && ` · paused ${Math.ceil(c.rateLimit.nextSlotInS)}s`}
                    </span>
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-foreground">Updated</dt>
                <dd className="font-medium">
                  {when(c.updatedAt)} · {c.updatedBy}
                </dd>
              </div>
            </dl>
            {c.lastCheckOk === false && c.lastCheckError && (
              <Alert variant="destructive">
                <AlertDescription>{c.lastCheckError}</AlertDescription>
              </Alert>
            )}
            {(
              <div className="flex flex-wrap gap-2">
                {!c.active && (
                  <Button size="sm" onClick={onActivate} disabled={activate.isPending}>
                    {activate.isPending ? <Loader2 className="animate-spin" /> : <Power />} Use for research
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onTest} disabled={test.isPending}>
                  {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmRemove(true)}>
                  <Trash2 /> Remove key
                </Button>
              </div>
            )}
          </>
        )}

        {(
          <>
            {c.configured && <Separator />}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">{c.configured ? "Change key or model" : `Connect ${c.label}`}</h3>

              <div className="space-y-2">
                <Label htmlFor={`${c.provider}-key`}>API key</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative flex-1">
                    <Input
                      id={`${c.provider}-key`}
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(e) => onKeyChange(e.target.value)}
                      placeholder={c.configured ? `Leave blank to keep ${c.keyHint}` : meta.keyPlaceholder}
                      className="pr-9 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                      aria-label={showKey ? "Hide key" : "Show key"}
                    >
                      {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  <Button variant="secondary" onClick={onLoad} disabled={!canLoad || loadModels.isPending}>
                    {loadModels.isPending ? <Loader2 className="animate-spin" /> : <ListRestart />} Load models
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Encrypted on the server (AES-256-GCM) and never shown again. Get a key at {meta.keyHelp}.
                </p>
              </div>

              {models && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Model provider</Label>
                    <Select
                      value={owner}
                      onValueChange={(p) => {
                        setOwner(p)
                        setModel("")
                      }}
                      disabled={owners.length <= 1}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose a provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {owners.map(([p, n]) => (
                          <SelectItem key={p} value={p}>
                            {ownerLabel(p)} <span className="text-muted-foreground">({n})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Model</Label>
                    <Select value={model} onValueChange={setModel} disabled={!owner}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {ownerModels.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <span className="font-mono text-xs">{m.id}</span>
                            {m.id === c.model && <Badge variant="secondary">current</Badge>}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {models && (
                <div className="space-y-2">
                  <Button onClick={onSave} disabled={!model || !dirty || save.isPending}>
                    {save.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                    {activeLabel ? `Verify, save & switch to ${c.label}` : "Verify & save"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Makes one tiny test call with this key and model before saving.
                    {activeLabel && ` ${activeLabel} will be switched off; its key stays saved.`}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the {c.label} key?</DialogTitle>
            <DialogDescription>
              {c.active
                ? "This is the active AI. New research runs and schedules will be blocked until another provider is activated, and runs in progress will fail their remaining companies."
                : "The saved key and model are deleted. The active AI is not affected."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="animate-spin" />} Remove key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
