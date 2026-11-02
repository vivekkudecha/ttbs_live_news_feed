import { useEffect, useState } from "react"
import { toast } from "sonner"
import { FlaskConical, GripVertical, History, Loader2, Plus, Save, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { RichText } from "@/components/common/RichText"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useCompanies, useTemplates } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { fmtDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { OutputSection, TemplateVersion } from "@/api/types"

const sampleText: Record<string, string> = {
  key_signals: "Announced **3 new regional hubs** in **Nagpur and Surat**; hiring **400+ operations staff**.",
  opportunity: "**SD-WAN iFLX** with **Smart ILL** primary links and **Managed Wi-Fi** for new hubs.",
  outreach: "Approach **Head-IT** with a **multi-site SD-WAN design** aligned to hub go-live.",
  trigger: "Appointed **new CISO** (ex-large private bank) effective 28 Oct.",
  risk_or_mandate: "Board mandate to achieve **ISO 27001** and launch a **24×7 SOC** within 2 quarters.",
  play: "**Managed SOC** + **VAPT**; ask for a 30-min intro with the CISO.",
}

export default function Templates() {
  const { user } = useSession()
  const templates = useTemplates()
  const companies = useCompanies()
  const editable = can.runJobs(user!.role)
  const [tid, setTid] = useState("t1")
  const [draft, setDraft] = useState<TemplateVersion | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testCompany, setTestCompany] = useState("c21")

  const tpl = templates.data?.find((t) => t.id === tid)
  const active = tpl?.versions.find((v) => v.version === tpl.activeVersion)
  useEffect(() => {
    if (active) setDraft(structuredClone(active))
  }, [active])

  if (!templates.data || !tpl || !draft) return <Skeleton className="h-96" />

  const set = <K extends keyof TemplateVersion>(k: K, v: TemplateVersion[K]) => setDraft({ ...draft, [k]: v })
  const setSection = (i: number, patch: Partial<OutputSection>) =>
    set(
      "sections",
      draft.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    )
  const dirty = JSON.stringify(draft) !== JSON.stringify(active)

  const runTest = () => {
    setTestOpen(true)
    setTesting(true)
    setTimeout(() => setTesting(false), 1200)
  }

  return (
    <div>
      <PageHeader
        title="Output templates"
        description="Control what the research looks for and what the PAM receives. Every save creates a new immutable version; each run records the version it used."
        actions={
          editable && (
            <Button variant="outline" onClick={() => toast.info("New template wizard opens here (prototype)")}>
              <Plus /> New template
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[17rem_1fr]">
        <div className="space-y-2">
          {templates.data.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTid(t.id)}
              className={cn("w-full rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/50", t.id === tid && "border-brand-blue ring-2 ring-brand-blue/15")}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t.name}</p>
                <Badge variant="secondary">v{t.activeVersion}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
            </button>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {tpl.name}
              <Badge variant="outline" className="font-normal">
                editing from v{tpl.activeVersion}
              </Badge>
              {dirty && <Badge className="bg-warning/20 text-[color-mix(in_oklch,var(--warning),black_40%)] dark:text-warning">unsaved changes</Badge>}
            </CardTitle>
            <CardDescription>
              Window {draft.windowDays} days · {draft.model} · preset {draft.preset}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="format">
              <TabsList className="max-w-full overflow-x-auto">
                <TabsTrigger value="format">Output format</TabsTrigger>
                <TabsTrigger value="prompts">Research prompt</TabsTrigger>
                <TabsTrigger value="delivery">Delivery</TabsTrigger>
                <TabsTrigger value="versions">
                  <History /> Versions
                </TabsTrigger>
              </TabsList>

              <TabsContent value="format" className="space-y-4 pt-4">
                <p className="text-sm text-muted-foreground">
                  Sections become a JSON schema the model must fill in, and are rendered in that order in the email, Excel and portal.
                </p>
                {draft.sections.map((s, i) => (
                  <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[auto_15rem_1fr_auto] sm:items-start">
                    <GripVertical className="mt-2 hidden size-4 text-muted-foreground sm:block" />
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Label</Label>
                      <Input value={s.label} disabled={!editable} onChange={(e) => setSection(i, { label: e.target.value })} />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Instruction to the model</Label>
                      <Input value={s.instruction} disabled={!editable} onChange={(e) => setSection(i, { instruction: e.target.value })} />
                    </div>
                    {editable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="sm:mt-5"
                        aria-label="Remove section"
                        onClick={() => set("sections", draft.sections.filter((_, j) => j !== i))}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                ))}
                {editable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => set("sections", [...draft.sections, { key: `custom_${draft.sections.length}`, label: "New section", instruction: "1 short line" }])}
                  >
                    <Plus /> Add section
                  </Button>
                )}
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="grid gap-1.5">
                    <Label>Research window (days)</Label>
                    <Input type="number" value={draft.windowDays} disabled={!editable} onChange={(e) => set("windowDays", Number(e.target.value))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Depth preset</Label>
                    <Select value={draft.preset} disabled={!editable} onValueChange={(v) => set("preset", v as TemplateVersion["preset"])}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fast">Fast (lowest cost)</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High (deepest research)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Model</Label>
                    <Input value={draft.model} disabled={!editable} onChange={(e) => set("model", e.target.value)} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="prompts" className="space-y-4 pt-4">
                <div className="grid gap-1.5">
                  <Label>Research prompt</Label>
                  <Textarea rows={7} className="font-mono text-xs" value={draft.researchPrompt} disabled={!editable} onChange={(e) => set("researchPrompt", e.target.value)} />
                  <p className="text-xs text-muted-foreground">
                    Variables: <code>{"{{company}}"}</code> <code>{"{{window_start}}"}</code> <code>{"{{window_end}}"}</code> <code>{"{{window_days}}"}</code>
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Strict relevance filter</Label>
                  <Textarea rows={8} className="font-mono text-xs" value={draft.relevanceRules} disabled={!editable} onChange={(e) => set("relevanceRules", e.target.value)} />
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>TTBS offerings context</Label>
                    <Textarea rows={7} className="font-mono text-xs" value={draft.ttbsContext} disabled={!editable} onChange={(e) => set("ttbsContext", e.target.value)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Priority action prompt (per PAM)</Label>
                    <Textarea rows={7} className="font-mono text-xs" value={draft.priorityPrompt} disabled={!editable} onChange={(e) => set("priorityPrompt", e.target.value)} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="delivery" className="space-y-4 pt-4">
                <div className="grid gap-1.5">
                  <Label>Excel attachment columns</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {draft.excelColumns.map((c) => (
                      <Badge key={c} variant="secondary" className="h-6 px-2.5">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>WhatsApp template</Label>
                  <Input value="pam_signal_digest_v2 (Meta approved)" disabled />
                  <p className="text-xs text-muted-foreground">WhatsApp body text must match a Meta-approved template; new wording needs re-approval (1–2 days).</p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Email subject</Label>
                  <Input defaultValue="Your TTBS signals · {{window_start}} – {{window_end}} · {{signal_count}} actionable logos" disabled={!editable} />
                </div>
              </TabsContent>

              <TabsContent value="versions" className="pt-4">
                <ol className="space-y-2">
                  {tpl.versions.map((v) => (
                    <li key={v.version} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
                      <Badge variant={v.version === tpl.activeVersion ? "default" : "outline"}>v{v.version}</Badge>
                      <span className="font-medium">{v.note}</span>
                      <span className="text-xs text-muted-foreground">
                        {fmtDate(v.createdAt)} · {v.createdBy}
                      </span>
                      {v.version === tpl.activeVersion ? (
                        <Badge variant="secondary" className="ml-auto">
                          Active
                        </Badge>
                      ) : (
                        editable && (
                          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => toast.success(`Rolled back to v${v.version}`)}>
                            Restore
                          </Button>
                        )
                      )}
                    </li>
                  ))}
                </ol>
              </TabsContent>
            </Tabs>

            <div className="mt-6 flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={runTest}>
                <FlaskConical /> Test on 1 company
              </Button>
              {editable && (
                <Button
                  disabled={!dirty}
                  onClick={() => toast.success(`Saved as v${tpl.versions.length + 1}`, { description: "Schedules pinned to the old version keep using it until updated." })}
                >
                  <Save /> Save as v{tpl.versions.length + 1}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Test run · draft template</DialogTitle>
            <DialogDescription>Runs the draft against one company without saving or notifying anyone. Cost is logged as "test".</DialogDescription>
          </DialogHeader>
          <Select value={testCompany} onValueChange={(v) => { setTestCompany(v); runTest() }}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {companies.data?.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="min-h-40 rounded-lg border bg-muted/30 p-4 text-sm">
            {testing ? (
              <div className="flex h-32 items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Researching with {draft.preset} preset…
              </div>
            ) : (
              <div className="space-y-2">
                <p className="font-semibold uppercase tracking-wide">{companies.data?.find((c) => c.id === testCompany)?.name}</p>
                {draft.sections.map((s) => (
                  <p key={s.key} className="text-muted-foreground">
                    <span className="font-medium text-foreground">{s.label}:</span>{" "}
                    <RichText text={sampleText[s.key] ?? "Sample output for this section appears here."} />
                  </p>
                ))}
                <p className="pt-2 text-xs text-muted-foreground">8,412 tokens in · 1,106 out · $0.017 · 31.4 s</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
