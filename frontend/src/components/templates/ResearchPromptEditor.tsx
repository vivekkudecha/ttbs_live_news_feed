/**
 * Research prompt editor: every part of what the research AI is sent (system instruction, prompt,
 * TTBS context, output format & relevance rules, categories, news window) is editable here.
 * Saving creates a new numbered version; any version can be re-activated. Runs pin the active
 * version when they start, and cached answers from another version are never reused.
 */
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Copy, Eye, History, Loader2, Plus, RotateCcw, Save, Undo2, X } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useActivateResearchPrompt, usePreviewResearchPrompt, useResearchPrompt, useResearchPromptVersion, useSaveResearchPrompt } from "@/api/hooks"
import { ApiError, errorMessage } from "@/api/http"
import type { ResearchPromptInput, ResearchPromptState, ResearchPromptVersion } from "@/api/types"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type Form = Omit<ResearchPromptInput, "note">
type FieldErrors = Partial<Record<keyof Form, string>>

const toForm = (v: Form): Form => ({
  systemInstruction: v.systemInstruction,
  researchPrompt: v.researchPrompt,
  ttbsContext: v.ttbsContext,
  outputRules: v.outputRules,
  categories: [...v.categories],
  windowDays: v.windowDays,
})

const same = (a: Form, b: Form) =>
  a.systemInstruction === b.systemInstruction &&
  a.researchPrompt === b.researchPrompt &&
  a.ttbsContext === b.ttbsContext &&
  a.outputRules === b.outputRules &&
  a.windowDays === b.windowDays &&
  a.categories.join("\u0000") === b.categories.join("\u0000")

function fieldErrors(e: unknown): FieldErrors {
  const d = e instanceof ApiError ? (e.details as { fields?: FieldErrors } | undefined) : undefined
  return d?.fields ?? {}
}

export function ResearchPromptEditor({ canEdit }: { canEdit: boolean }) {
  const state = useResearchPrompt()
  if (state.isLoading) return <Skeleton className="h-[32rem]" />
  if (!state.data)
    return (
      <Alert variant="destructive">
        <AlertDescription>{errorMessage(state.error)}</AlertDescription>
      </Alert>
    )
  return <Editor key={state.data.active.version} state={state.data} canEdit={canEdit} />
}

function Editor({ state, canEdit }: { state: ResearchPromptState; canEdit: boolean }) {
  const active = state.active
  const [form, setForm] = useState<Form>(() => toForm(active))
  const [base, setBase] = useState<{ form: Form; label: string }>(() => ({ form: toForm(active), label: `v${active.version}` }))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [tab, setTab] = useState("prompt")
  const [saveOpen, setSaveOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const dirty = !same(form, toForm(active))
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: undefined }))
  }
  const load = (v: Form, label: string) => {
    setForm(toForm(v))
    setBase({ form: toForm(v), label })
    setErrors({})
  }

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", h)
    return () => window.removeEventListener("beforeunload", h)
  }, [dirty])

  const tabError = (keys: (keyof Form)[]) => keys.some((k) => errors[k])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Research prompt <Badge variant="secondary">v{active.version} live</Badge>
            {dirty && canEdit && <Badge variant="outline">Unsaved changes{base.label !== `v${active.version}` ? ` · from ${base.label}` : ""}</Badge>}
            {dirty && !canEdit && <Badge variant="outline">Viewing {base.label}</Badge>}
            {!canEdit && <Badge variant="outline">Read-only</Badge>}
          </CardTitle>
          <CardDescription>
            Sent to the active research AI for every company. Last {active.version === 1 && active.createdBy === "system" ? "set" : "changed"} by{" "}
            {active.activatedBy ?? active.createdBy} · {fmtDateTime(active.activatedAt ?? active.createdAt)}
            {active.note && ` · “${active.note}”`}
          </CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History /> Versions ({state.versions.length})
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
              <Eye /> Preview
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <AlertDescription>
              Saving creates a new version. New runs use the active version; runs already in progress keep the version they started with.
              Results cached under another version are not reused, so the first run after a change researches every company again.
            </AlertDescription>
          </Alert>
          {!canEdit && dirty && (
            <Button variant="outline" size="sm" onClick={() => load(active, `v${active.version}`)}>
              <Undo2 /> Back to live v{active.version}
            </Button>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!dirty} onClick={() => setSaveOpen(true)}>
                <Save /> Save as v{Math.max(...state.versions.map((v) => v.version)) + 1}…
              </Button>
              <Button variant="outline" disabled={!dirty} onClick={() => load(active, `v${active.version}`)}>
                <Undo2 /> Discard changes
              </Button>
              <Button
                variant="ghost"
                disabled={same(form, state.defaults)}
                onClick={() => {
                  load(state.defaults, "built-in default")
                  toast.info("Built-in default loaded into the editor", { description: "Save it to make it live." })
                }}
              >
                <RotateCcw /> Load built-in default
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="prompt" className={cn(tabError(["researchPrompt"]) && "text-destructive")}>
              Research prompt
            </TabsTrigger>
            <TabsTrigger value="rules" className={cn(tabError(["outputRules"]) && "text-destructive")}>
              Output format &amp; rules
            </TabsTrigger>
            <TabsTrigger value="context" className={cn(tabError(["ttbsContext"]) && "text-destructive")}>
              TTBS context
            </TabsTrigger>
            <TabsTrigger value="system" className={cn(tabError(["systemInstruction"]) && "text-destructive")}>
              System instruction
            </TabsTrigger>
            <TabsTrigger value="settings" className={cn(tabError(["categories", "windowDays"]) && "text-destructive")}>
              Categories &amp; window
            </TabsTrigger>
          </TabsList>

          <TabsContent value="prompt" className="mt-4">
            <TextField
              id="rp-prompt"
              label="Research prompt"
              hint="The main instruction for each company. Must include {company}, {window_start}, {window_end}, {ttbs_context} and {output_rules}."
              value={form.researchPrompt}
              onChange={(v) => set("researchPrompt", v)}
              error={errors.researchPrompt}
              readOnly={!canEdit}
              rows={22}
            />
          </TabsContent>
          <TabsContent value="rules" className="mt-4">
            <TextField
              id="rp-rules"
              label="Output format & relevance rules"
              hint={`Inserted where {output_rules} appears. The answer format must keep the lines ${state.requiredLabels.join(" ")} — results are read from them.`}
              value={form.outputRules}
              onChange={(v) => set("outputRules", v)}
              error={errors.outputRules}
              readOnly={!canEdit}
              rows={26}
            />
          </TabsContent>
          <TabsContent value="context" className="mt-4">
            <TextField
              id="rp-context"
              label="TTBS context"
              hint="What TTBS sells. Inserted where {ttbs_context} appears; the AI uses it to judge relevance."
              value={form.ttbsContext}
              onChange={(v) => set("ttbsContext", v)}
              error={errors.ttbsContext}
              readOnly={!canEdit}
              rows={12}
            />
          </TabsContent>
          <TabsContent value="system" className="mt-4">
            <TextField
              id="rp-system"
              label="System instruction"
              hint="The AI's role and ground rules, sent separately from the prompt (up to 4,000 characters)."
              value={form.systemInstruction}
              onChange={(v) => set("systemInstruction", v)}
              error={errors.systemInstruction}
              readOnly={!canEdit}
              rows={6}
            />
          </TabsContent>
          <TabsContent value="settings" className="mt-4 space-y-6">
            <CategoriesField
              value={form.categories}
              onChange={(v) => set("categories", v)}
              error={errors.categories}
              readOnly={!canEdit}
              max={state.limits.maxCategories}
            />
            <div className="max-w-xs space-y-2">
              <Label htmlFor="rp-window">News window (days)</Label>
              <Input
                id="rp-window"
                type="number"
                min={state.limits.windowDays[0]}
                max={state.limits.windowDays[1]}
                value={Number.isFinite(form.windowDays) ? form.windowDays : ""}
                onChange={(e) => set("windowDays", e.target.valueAsNumber)}
                readOnly={!canEdit}
                aria-invalid={!!errors.windowDays}
              />
              <p className={cn("text-xs", errors.windowDays ? "text-destructive" : "text-muted-foreground")}>
                {errors.windowDays ??
                  `How far back each run looks for news, ending on the run's start date (${state.limits.windowDays[0]}–${state.limits.windowDays[1]}).`}
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <PlaceholderPanel state={state} />
      </div>

      <SaveDialog open={saveOpen} onOpenChange={setSaveOpen} form={form} onErrors={(e) => {
        setErrors(e)
        const first = (Object.keys(e) as (keyof Form)[])[0]
        const tabOf: Record<keyof Form, string> = {
          researchPrompt: "prompt", outputRules: "rules", ttbsContext: "context", systemInstruction: "system", categories: "settings", windowDays: "settings",
        }
        if (first) setTab(tabOf[first])
      }} />
      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} form={form} dirty={dirty} activeVersion={active.version} />
      <VersionsDialog open={historyOpen} onOpenChange={setHistoryOpen} state={state} canEdit={canEdit} onLoad={(v) => load(v, `v${v.version}`)} />
    </div>
  )
}

function TextField(props: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  error?: string
  readOnly: boolean
  rows: number
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">{props.value.length.toLocaleString()} chars</span>
      </div>
      <Textarea
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        readOnly={props.readOnly}
        rows={props.rows}
        spellCheck={false}
        aria-invalid={!!props.error}
        className="font-mono text-xs leading-relaxed"
      />
      <p className={cn("text-xs", props.error ? "text-destructive" : "text-muted-foreground")}>{props.error ?? props.hint}</p>
    </div>
  )
}

function CategoriesField({ value, onChange, error, readOnly, max }: { value: string[]; onChange: (v: string[]) => void; error?: string; readOnly: boolean; max: number }) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const c = draft.trim()
    if (!c) return
    if (value.some((x) => x.toLowerCase() === c.toLowerCase())) {
      toast.info(`“${c}” is already a category`)
      return
    }
    onChange([...value, c])
    setDraft("")
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="rp-category">Categories</Label>
      <div className="flex flex-wrap gap-2">
        {value.map((c) => (
          <Badge key={c} variant="secondary" className="gap-1 pr-1">
            {c}
            {!readOnly && (
              <button type="button" className="rounded-sm p-0.5 hover:bg-background" aria-label={`Remove ${c}`} onClick={() => onChange(value.filter((x) => x !== c))}>
                <X className="size-3" />
              </button>
            )}
          </Badge>
        ))}
        {value.length === 0 && <span className="text-sm text-muted-foreground">No categories</span>}
      </div>
      {!readOnly && (
        <div className="flex max-w-sm gap-2">
          <Input
            id="rp-category"
            value={draft}
            maxLength={40}
            placeholder="Add a category"
            onChange={(e) => setDraft(e.target.value.replace(",", ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                add()
              }
            }}
          />
          <Button type="button" variant="outline" onClick={add} disabled={!draft.trim() || value.length >= max}>
            <Plus /> Add
          </Button>
        </div>
      )}
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ??
          `The AI picks one per signal (fills {categories}); signals are filtered and reported by these. Up to ${max}. Renaming a category does not change past results.`}
      </p>
    </div>
  )
}

function PlaceholderPanel({ state }: { state: ResearchPromptState }) {
  const copy = (t: string) =>
    navigator.clipboard?.writeText(t).then(
      () => toast.success(`Copied ${t}`),
      () => toast.error("Could not copy"),
    )
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-sm">Placeholders</CardTitle>
        <CardDescription>Filled in for each company. Click to copy.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {state.placeholders.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => copy(`{${p.key}}`)}
            className="flex w-full items-start gap-2 rounded-md border p-2 text-left hover:bg-muted"
          >
            <Copy className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <code className="text-xs font-medium">{`{${p.key}}`}</code>
              {p.required && (
                <Badge variant="outline" className="ml-1 px-1 py-0 text-2xs">
                  required
                </Badge>
              )}
              <span className="block text-xs text-muted-foreground">{p.description}</span>
            </span>
          </button>
        ))}
        <p className="pt-2 text-xs text-muted-foreground">
          Answers must keep these lines: {state.requiredLabels.map((l) => <code key={l} className="mr-1">{l}</code>)}
        </p>
      </CardContent>
    </Card>
  )
}

function SaveDialog({ open, onOpenChange, form, onErrors }: { open: boolean; onOpenChange: (v: boolean) => void; form: Form; onErrors: (e: FieldErrors) => void }) {
  const save = useSaveResearchPrompt()
  const [note, setNote] = useState("")
  const [activate, setActivate] = useState(true)
  useEffect(() => {
    if (open) {
      setNote("")
      setActivate(true)
    }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save research prompt</DialogTitle>
          <DialogDescription>Creates a new version. Earlier versions stay in the history and can be re-activated.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rp-note">What changed (optional)</Label>
            <Input id="rp-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added Cloud category, stricter leadership rule" />
          </div>
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <Switch id="rp-activate" checked={activate} onCheckedChange={setActivate} />
            <div>
              <Label htmlFor="rp-activate">Make it live now</Label>
              <p className="text-xs text-muted-foreground">
                {activate ? "The next run uses this version." : "Saved as a draft version; the current version stays live."}
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { ...form, note: note.trim() || undefined, activate },
                {
                  onSuccess: (v) => {
                    toast.success(`Saved as v${v.version}${v.active ? " — now live" : ""}`)
                    onOpenChange(false)
                  },
                  onError: (e) => {
                    onErrors(fieldErrors(e))
                    toast.error("Not saved", { description: errorMessage(e) })
                    onOpenChange(false)
                  },
                },
              )
            }
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreviewDialog({ open, onOpenChange, form, dirty, activeVersion }: { open: boolean; onOpenChange: (v: boolean) => void; form: Form; dirty: boolean; activeVersion: number }) {
  const preview = usePreviewResearchPrompt()
  const [company, setCompany] = useState("Pine Labs Pvt Ltd")
  const run = () => preview.mutate({ company, draft: dirty ? form : undefined, version: dirty ? undefined : activeVersion })
  const { mutate, reset } = preview
  useEffect(() => {
    if (open) mutate({ company, draft: dirty ? form : undefined, version: dirty ? undefined : activeVersion })
    else reset()
    // Re-render only when the dialog opens; the company field has its own button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const d = preview.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Preview {dirty ? "(unsaved edits)" : `v${activeVersion}`}</DialogTitle>
          <DialogDescription>Exactly what the research AI receives for one company. Nothing is sent to the AI.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-2">
            <Label htmlFor="rp-company">Company</Label>
            <Input id="rp-company" value={company} maxLength={300} onChange={(e) => setCompany(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
          <Button variant="outline" onClick={run} disabled={preview.isPending}>
            {preview.isPending ? <Loader2 className="animate-spin" /> : <Eye />} Render
          </Button>
        </div>
        {preview.isError && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(preview.error)}</AlertDescription>
          </Alert>
        )}
        {d && (
          <div className="min-w-0 space-y-3">
            <p className="text-xs text-muted-foreground">
              Window {d.windowStart} → {d.windowEnd} · {d.characters.toLocaleString()} characters · ≈{d.approxTokens.toLocaleString()} input tokens per company
            </p>
            <div>
              <div className="mb-1 text-xs font-medium">System instruction</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">{d.system}</pre>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium">Prompt</div>
              <pre className="max-h-[45svh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{d.prompt}</pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function VersionsDialog({
  open,
  onOpenChange,
  state,
  canEdit,
  onLoad,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  state: ResearchPromptState
  canEdit: boolean
  onLoad: (v: ResearchPromptVersion) => void
}) {
  const activate = useActivateResearchPrompt()
  const [selected, setSelected] = useState<number | null>(null)
  const full = useResearchPromptVersion(selected)
  useEffect(() => {
    if (!open) setSelected(null)
  }, [open])
  const pending = useMemo(() => (selected != null && full.isFetching ? selected : null), [selected, full.isFetching])

  useEffect(() => {
    if (selected != null && full.data && full.data.version === selected) {
      onLoad(full.data)
      toast.info(`v${selected} loaded into the editor`, { description: "Edit it, then save it as a new version." })
      setSelected(null)
      onOpenChange(false)
    }
  }, [selected, full.data, onLoad, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Research prompt versions</DialogTitle>
          <DialogDescription>Versions never change once saved. Activate one to make it live again, or load it into the editor to build on it.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60svh] divide-y overflow-y-auto rounded-lg border">
          {state.versions.map((v) => (
            <div key={v.version} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  v{v.version} {v.active && <Badge variant="secondary">live</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {fmtDateTime(v.createdAt)} · {v.createdBy}
                  {v.note && ` · ${v.note}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {v.windowDays}-day window · {v.categories.join(", ")}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" disabled={pending != null} onClick={() => setSelected(v.version)}>
                  {pending === v.version ? <Loader2 className="animate-spin" /> : null} {canEdit ? "Load" : "View"}
                </Button>
                {canEdit && !v.active && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={activate.isPending}
                    onClick={() =>
                      activate.mutate(v.version, {
                        onSuccess: () => {
                          toast.success(`v${v.version} is live`)
                          onOpenChange(false)
                        },
                        onError: (e) => toast.error("Not activated", { description: errorMessage(e) }),
                      })
                    }
                  >
                    Activate
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
