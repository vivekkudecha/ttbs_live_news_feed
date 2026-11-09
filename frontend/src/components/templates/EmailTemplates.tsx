/**
 * Email templates for PAM digests (live backend). Jinja2 templates rendered in a sandbox at send
 * time from the digest snapshot; exactly one is active; every save is a new version (restore any).
 * Optional AI summary: the active research AI writes `{{ ai_summary }}` from the digest facts,
 * with a prompt, length and failure policy set per template.
 */
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Bot, CheckCircle2, Copy, Eye, FilePlus2, History, Loader2, Power, Save, Sparkles, Trash2, Wand2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { PamPicker } from "@/components/pickers/Pickers"
import {
  useActivateEmailTemplate,
  useDeleteEmailTemplate,
  useEmailTemplateVersions,
  useEmailTemplates,
  usePreviewEmailTemplate,
  useRestoreEmailTemplate,
  useRuns,
  useSaveEmailTemplate,
} from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { EmailPreview, EmailTemplate, EmailTemplateInput } from "@/api/types"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const DEFAULT_AI_PROMPT =
  "Write a short executive summary for {pam_name}, a TTBS account manager, about this week's account signals. Name the 2-3 accounts to act on first and say why in one clause each, then one line on the overall theme. Plain sentences only, at most {max_words} words."

const VARIABLES: [string, string][] = [
  ["{{ pam.name }} / {{ pam.first_name }}", "Recipient PAM"],
  ["{{ run.window_start }} / {{ run.window_end }}", "News window"],
  ["{{ run.label }} / {{ run.id }}", "The research run"],
  ["{{ counts.signals }} / {{ counts.total }}", "Accounts with signals / researched"],
  ["{% for s in signals %}…{% endfor %}", "One entry per account with a signal"],
  ["{{ s.company }} {{ s.category }}", "Account and category"],
  ["{{ s.key_signals | rich }}", "Research text: **bold** and links kept, safely escaped"],
  ["{{ s.opportunity | rich }} {{ s.outreach | rich }}", "Opportunity and next step"],
  ["{% for src in s.sources %}{{ src.url }}{% endfor %}", "Cited sources"],
  ["{{ ai_summary }}", "AI summary (empty when off or failed)"],
  ["{{ generated_at }}", "Send date"],
]

const toInput = (t: EmailTemplate): EmailTemplateInput => ({
  name: t.name,
  description: t.description ?? "",
  subjectTpl: t.subjectTpl,
  htmlTpl: t.htmlTpl,
  textTpl: t.textTpl,
  aiEnabled: t.aiEnabled,
  aiPrompt: t.aiPrompt ?? "",
  aiMaxWords: t.aiMaxWords,
  aiOnFailure: t.aiOnFailure,
})

export function EmailTemplates() {
  const templates = useEmailTemplates()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<EmailTemplateInput | null>(null) // a new, unsaved template

  const list = useMemo(() => templates.data ?? [], [templates.data])
  useEffect(() => {
    if (!selected && !draft && list.length) setSelected(list.find((t) => t.active)?.id ?? list[0].id)
  }, [list, selected, draft])

  if (templates.isLoading) return <Skeleton className="h-96" />
  if (templates.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load email templates: {errorMessage(templates.error)}</AlertDescription>
      </Alert>
    )
  const current = list.find((t) => t.id === selected) ?? null
  const startNew = () => {
    const base = list.find((t) => t.active) ?? list[0]
    setSelected(null)
    setDraft({ ...(base ? toInput(base) : ({} as EmailTemplateInput)), name: `${base?.name ?? "Template"} (copy)` })
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="space-y-2">
        <Button variant="outline" className="w-full" onClick={startNew}>
          <FilePlus2 /> New template
        </Button>
        {draft && (
          <div className="rounded-lg border border-primary bg-primary/5 p-3 text-sm font-medium">
            {draft.name} <Badge variant="secondary">unsaved</Badge>
          </div>
        )}
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setDraft(null)
              setSelected(t.id)
            }}
            className={cn(
              "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
              t.id === selected && !draft && "border-primary bg-primary/5 ring-1 ring-primary",
            )}
            aria-pressed={t.id === selected && !draft}
          >
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
              {t.name}
              {t.active && <Badge>Active</Badge>}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              v{t.version} · {fmtDateTime(t.updatedAt)}
              {t.aiEnabled && (
                <Badge variant="outline" className="gap-1">
                  <Sparkles className="size-3" /> AI
                </Badge>
              )}
            </span>
          </button>
        ))}
      </div>
      {draft ? (
        <TemplateEditor key="new" initial={draft} onSaved={(t) => (setDraft(null), setSelected(t.id))} onCancel={() => setDraft(null)} />
      ) : current ? (
        <TemplateEditor key={`${current.id}:${current.version}`} template={current} initial={toInput(current)} onSaved={(t) => setSelected(t.id)} />
      ) : null}
    </div>
  )
}

function TemplateEditor({
  template,
  initial,
  onSaved,
  onCancel,
}: {
  template?: EmailTemplate
  initial: EmailTemplateInput
  onSaved: (t: EmailTemplate) => void
  onCancel?: () => void
}) {
  const save = useSaveEmailTemplate()
  const activate = useActivateEmailTemplate()
  const del = useDeleteEmailTemplate()
  const [v, setV] = useState<EmailTemplateInput>(initial)
  const [note, setNote] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof EmailTemplateInput>(k: K, val: EmailTemplateInput[K]) => setV((x) => ({ ...x, [k]: val }))
  const dirty = JSON.stringify(v) !== JSON.stringify(initial) || !template

  const onSave = () =>
    save.mutate(
      { id: template?.id, data: { ...v, note: note.trim() || undefined } },
      {
        onSuccess: (t) => {
          toast.success(template ? `Saved as v${t.version}` : "Template created", {
            description: t.active ? "Active: new digests use it." : "Not active yet: activate it to use it for new digests.",
          })
          setNote("")
          onSaved(t)
        },
        onError: (e) => toast.error("Not saved", { description: errorMessage(e) }),
      },
    )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {template ? template.name : "New template"}
            {template && <Badge variant="secondary">v{template.version}</Badge>}
            {template?.active && <Badge>Active</Badge>}
          </CardTitle>
          <CardDescription>
            Jinja2, rendered in a sandbox when each email is sent. HTML is escaped automatically. Saving checks the template against sample data, so a typo in a
            variable name is caught here, not at send time.
          </CardDescription>
          {template && (
            <CardAction className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
                <History /> Versions
              </Button>
              {!template.active && (
                <Button
                  size="sm"
                  onClick={() =>
                    activate.mutate(template.id, {
                      onSuccess: () => toast.success(`“${template.name}” is now the active template`),
                      onError: (e) => toast.error("Not activated", { description: errorMessage(e) }),
                    })
                  }
                  disabled={activate.isPending || dirty}
                  title={dirty ? "Save your changes first" : undefined}
                >
                  {activate.isPending ? <Loader2 className="animate-spin" /> : <Power />} Activate
                </Button>
              )}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tpl-name">Name</Label>
              <Input id="tpl-name" value={v.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tpl-desc">Description</Label>
              <Input id="tpl-desc" value={v.description ?? ""} onChange={(e) => set("description", e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input id="tpl-subject" value={v.subjectTpl} onChange={(e) => set("subjectTpl", e.target.value)} className="font-mono text-xs" spellCheck={false} />
          </div>
          <Tabs defaultValue="html">
            <TabsList>
              <TabsTrigger value="html">HTML body</TabsTrigger>
              <TabsTrigger value="text">Plain-text body</TabsTrigger>
              <TabsTrigger value="vars">Variables</TabsTrigger>
            </TabsList>
            <TabsContent value="html" className="mt-3">
              <Textarea
                aria-label="HTML body template"
                value={v.htmlTpl}
                onChange={(e) => set("htmlTpl", e.target.value)}
                className="h-[28rem] field-sizing-fixed font-mono text-xs leading-relaxed"
                spellCheck={false}
              />
              <p className="mt-2 text-xs text-muted-foreground">Sent as the email body. Use inline styles: most mail clients ignore &lt;style&gt; blocks.</p>
            </TabsContent>
            <TabsContent value="text" className="mt-3">
              <Textarea
                aria-label="Plain-text body template"
                value={v.textTpl}
                onChange={(e) => set("textTpl", e.target.value)}
                className="h-[28rem] field-sizing-fixed font-mono text-xs leading-relaxed"
                spellCheck={false}
              />
              <p className="mt-2 text-xs text-muted-foreground">Used when the HTML body is empty, and kept with each sent email for the audit trail.</p>
            </TabsContent>
            <TabsContent value="vars" className="mt-3">
              <div className="divide-y rounded-lg border">
                {VARIABLES.map(([code, what]) => (
                  <div key={code} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <code className="text-xs">{code}</code>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {what}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Copy ${code}`}
                        onClick={() => navigator.clipboard?.writeText(code).then(() => toast.success("Copied"))}
                      >
                        <Copy className="size-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <AiSection v={v} set={set} />

      <PreviewSection v={v} />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1 space-y-2">
            <Label htmlFor="tpl-note">Change note (kept with this version)</Label>
            <Input id="tpl-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. shorter subject line" />
          </div>
          <Button onClick={onSave} disabled={!dirty || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} {template ? "Save new version" : "Create template"}
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {template && !template.active && (
            <Button variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </Button>
          )}
        </CardContent>
      </Card>

      {template && <VersionsDialog template={template} open={historyOpen} onOpenChange={setHistoryOpen} />}
      {template && (
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete “{template.name}”?</DialogTitle>
              <DialogDescription>The template and its version history are deleted. Emails already sent keep their rendered copy.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={del.isPending}
                onClick={() =>
                  del.mutate(template.id, {
                    onSuccess: () => {
                      setConfirmDelete(false)
                      toast.success("Template deleted")
                    },
                    onError: (e) => toast.error("Not deleted", { description: errorMessage(e) }),
                  })
                }
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function AiSection({ v, set }: { v: EmailTemplateInput; set: <K extends keyof EmailTemplateInput>(k: K, val: EmailTemplateInput[K]) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" /> AI summary
        </CardTitle>
        <CardDescription>
          The active research AI (Providers &amp; channels) writes a short summary for each PAM from their digest, once per email, without web search. It fills{" "}
          <code className="text-xs">{"{{ ai_summary }}"}</code> and its cost is recorded in FinOps.
        </CardDescription>
        <CardAction>
          <Switch checked={v.aiEnabled} onCheckedChange={(c) => set("aiEnabled", c)} aria-label="AI summary enabled" />
        </CardAction>
      </CardHeader>
      {v.aiEnabled && (
        <CardContent className="space-y-4">
          {!/\{\{\s*ai_summary/.test(v.htmlTpl + v.textTpl) && (
            <Alert>
              <AlertDescription>
                The template does not use <code className="text-xs">{"{{ ai_summary }}"}</code> yet, so the summary would be generated but not shown.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="ai-prompt">Instruction to the AI</Label>
            <Textarea
              id="ai-prompt"
              value={v.aiPrompt ?? ""}
              onChange={(e) => set("aiPrompt", e.target.value)}
              placeholder={DEFAULT_AI_PROMPT}
              className="min-h-24 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for the default. <code>{"{pam_name}"}</code> and <code>{"{max_words}"}</code> are filled in; the account facts are appended
              automatically.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ai-words">Maximum length</Label>
              <div className="flex items-center gap-2">
                <Input id="ai-words" type="number" min={20} max={400} value={v.aiMaxWords} onChange={(e) => set("aiMaxWords", e.target.valueAsNumber)} />
                <span className="text-xs text-muted-foreground">words</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>If the AI fails</Label>
              <Select value={v.aiOnFailure} onValueChange={(x) => set("aiOnFailure", x as EmailTemplateInput["aiOnFailure"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="send_without">Send without the summary</SelectItem>
                  <SelectItem value="hold">Hold the email and retry later</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function PreviewSection({ v }: { v: EmailTemplateInput }) {
  const preview = usePreviewEmailTemplate()
  const runs = useRuns()
  const [runId, setRunId] = useState("sample")
  const [pamId, setPamId] = useState("")
  const [withAi, setWithAi] = useState(false)
  const [out, setOut] = useState<EmailPreview | null>(null)

  const run = () =>
    preview.mutate(
      { ...v, runId: runId !== "sample" && pamId ? Number(runId) : undefined, pamId: runId !== "sample" && pamId ? Number(pamId) : undefined, withAi },
      { onSuccess: setOut, onError: (e) => toast.error("Preview failed", { description: errorMessage(e) }) },
    )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="size-4 text-muted-foreground" /> Preview
        </CardTitle>
        <CardDescription>Render this draft (saved or not) for sample data or a real PAM's digest from a run.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] md:items-end">
          <div className="space-y-2">
            <Label>Data</Label>
            <Select value={runId} onValueChange={setRunId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sample">Sample data</SelectItem>
                {(runs.data ?? []).slice(0, 25).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    Run #{r.id} · {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>PAM</Label>
            {runId === "sample" ? <Input disabled placeholder="Sample PAM" /> : <PamPicker value={pamId} onChange={(id) => setPamId(id)} />}
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <Checkbox checked={withAi} onCheckedChange={(c) => setWithAi(c === true)} disabled={!v.aiEnabled} />
            Run AI <span className="text-xs text-muted-foreground">(billable)</span>
          </label>
          <Button onClick={run} disabled={preview.isPending || (runId !== "sample" && !pamId)}>
            {preview.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />} Render
          </Button>
        </div>
        {out && (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <span className="text-muted-foreground">Subject </span>
              <span className="font-medium">{out.subject}</span>
              {out.sample && (
                <Badge variant="outline" className="ml-2">
                  sample data
                </Badge>
              )}
            </div>
            {out.aiError && (
              <Alert variant="destructive">
                <AlertDescription>AI summary failed: {out.aiError}</AlertDescription>
              </Alert>
            )}
            {out.ai && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-600" /> AI summary by {out.ai.provider} · {out.ai.model} · {out.ai.tokensIn + out.ai.tokensOut} tokens ·{" "}
                {out.ai.latencyMs} ms
              </p>
            )}
            <Tabs defaultValue={out.html ? "html" : "text"}>
              <TabsList>
                <TabsTrigger value="html" disabled={!out.html}>
                  HTML
                </TabsTrigger>
                <TabsTrigger value="text" disabled={!out.text}>
                  Plain text
                </TabsTrigger>
              </TabsList>
              <TabsContent value="html" className="mt-3">
                {/* Sandboxed (no scripts, no same-origin): the HTML is shown exactly as a mail client would get it. */}
                <iframe title="Email preview" sandbox="" srcDoc={out.html} className="h-[36rem] w-full rounded-lg border bg-white" />
              </TabsContent>
              <TabsContent value="text" className="mt-3">
                <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-lg border p-4 font-mono text-xs">{out.text}</pre>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function VersionsDialog({ template, open, onOpenChange }: { template: EmailTemplate; open: boolean; onOpenChange: (v: boolean) => void }) {
  const versions = useEmailTemplateVersions(open ? template.id : null)
  const restore = useRestoreEmailTemplate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Versions of “{template.name}”</DialogTitle>
          <DialogDescription>Restoring copies an old version into a new one; history is never rewritten.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60svh] divide-y overflow-y-auto rounded-lg border">
          {versions.isLoading && <Skeleton className="h-24" />}
          {(versions.data ?? []).map((ver) => (
            <div key={ver.version} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  v{ver.version} {ver.version === template.version && <Badge variant="secondary">current</Badge>}
                  {ver.aiEnabled && <Sparkles className="size-3.5 text-muted-foreground" aria-label="AI summary on" />}
                </div>
                <div className="text-xs text-muted-foreground">
                  {fmtDateTime(ver.createdAt)} · {ver.createdBy}
                  {ver.note && ` · ${ver.note}`}
                </div>
                <code className="block truncate text-xs text-muted-foreground">{ver.subjectTpl}</code>
              </div>
              {ver.version !== template.version && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restore.isPending}
                  onClick={() =>
                    restore.mutate(
                      { id: template.id, version: ver.version },
                      {
                        onSuccess: (t) => {
                          toast.success(`Restored v${ver.version} as v${t.version}`)
                          onOpenChange(false)
                        },
                        onError: (e) => toast.error("Not restored", { description: errorMessage(e) }),
                      },
                    )
                  }
                >
                  Restore
                </Button>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
