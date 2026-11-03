import { useState } from "react"
import { CheckCheck, FileSpreadsheet, Mail, MessageCircle, Paperclip, Table2 } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { RichText } from "@/components/common/RichText"
import { Logo } from "@/components/common/Logo"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDigest, usePamJobs, useRuns } from "@/api/hooks"
import { EmptyState } from "@/components/common/EmptyState"
import { PamPicker } from "@/components/pickers/Pickers"
import { fmtDate } from "@/lib/format"
import type { PamOption, PriorityAction, ResearchResult, Run } from "@/api/types"

const plain = (s?: string) => (s ?? "").replace(/\*\*/g, "")

/** View model for the three previews, built from one server call (`digest(runId, pamId)`). */
interface DigestData {
  run: Run
  pam: PamOption
  mine: ResearchResult[]
  signals: ResearchResult[]
  priority: PriorityAction[]
  name: (id: string) => string
}

function EmailPreview({ d }: { d: DigestData }) {
  return (
    <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="space-y-1 border-b bg-muted/40 px-4 py-3 text-xs sm:px-6">
        <p>
          <span className="inline-block w-14 text-muted-foreground">From</span> TTBS Signals &lt;signals@ttbs.example&gt;
        </p>
        <p>
          <span className="inline-block w-14 text-muted-foreground">To</span> {d.pam.name} &lt;{d.pam.email}&gt;
        </p>
        <p>
          <span className="inline-block w-14 text-muted-foreground">Subject</span>
          <span className="font-medium">
            Your TTBS signals · {fmtDate(d.run.windowStart)} – {fmtDate(d.run.windowEnd)} · {d.signals.length} actionable logos
          </span>
        </p>
        <p className="flex items-center gap-1 pt-1 text-primary">
          <Paperclip className="size-3" /> {d.pam.name.split(" ")[0]}_signals_{d.run.id}.xlsx
        </p>
      </div>
      <div className="px-4 py-5 sm:px-6">
        <Logo />
      </div>
      <div className="h-0.5 bg-brand-gradient" aria-hidden="true" />
      <div className="space-y-8 px-4 py-8 text-sm leading-relaxed sm:px-8">
        <div>
          <p>Hi {d.pam.name.split(" ")[0]},</p>
          <p className="mt-2 text-muted-foreground">
            We researched <strong className="text-foreground">{d.mine.length} logos</strong> you own for news between {fmtDate(d.run.windowStart)} and{" "}
            {fmtDate(d.run.windowEnd)}. <strong className="text-foreground">{d.signals.length}</strong> have a TTBS-relevant trigger. Your prioritized
            actions are below; the full results are attached.
          </p>
        </div>

        <div>
          <h3 className="eyebrow mb-3">Priority actions</h3>
          <ol className="space-y-3">
            {d.priority.map((p) => (
              <li key={p.companyId} className="flex gap-3 rounded-lg border p-3">
                <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">{p.rank}</span>
                <div>
                  <p className="font-semibold">{d.name(p.companyId)}</p>
                  <p className="mt-1 text-muted-foreground">
                    <span className="font-medium text-foreground">Why now?</span> {p.whyNow}
                  </p>
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Action:</span> {p.action}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <h3 className="eyebrow mb-3">News feed results</h3>
          <div className="divide-y rounded-lg border">
            {d.signals.map((r) => (
              <div key={r.id} className="space-y-1 p-3">
                <p className="font-semibold uppercase tracking-wide">{d.name(r.companyId)}</p>
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Key signals:</span> <RichText text={r.keySignals} />
                </p>
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Opportunity type:</span> <RichText text={r.opportunity} />
                </p>
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Recommended outreach approach:</span> <RichText text={r.outreach} />
                </p>
                <p className="text-xs text-primary">{r.sources.map((s) => s.title).join(" · ")}</p>
              </div>
            ))}
          </div>
          {d.mine.length > d.signals.length && (
            <p className="mt-2 text-xs text-muted-foreground">
              {d.mine.length - d.signals.length} other logos had no qualifying news in this window (listed in the attachment).
            </p>
          )}
        </div>

        <p className="border-t pt-4 text-xs text-muted-foreground">
          Generated automatically by TTBS Signals from public sources. Verify before outreach. You receive this because you are the assigned PAM for
          these logos.
        </p>
      </div>
    </div>
  )
}

function WhatsAppPreview({ d }: { d: DigestData }) {
  const top = d.priority.slice(0, 3)
  return (
    <div className="mx-auto w-full max-w-sm rounded-[2rem] border-8 border-foreground/85 bg-[#efe7dd] shadow-xl dark:bg-[#0b141a]">
      <div className="flex items-center gap-2 rounded-t-[1.4rem] bg-[#0b5e54] px-4 py-3 text-white">
        <div className="flex size-8 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">TS</div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">TTBS Signals</p>
          <p className="text-xs opacity-75">Business account</p>
        </div>
      </div>
      <div className="space-y-2 p-3 pb-6">
        <div className="mx-auto w-fit rounded-md bg-white/80 px-2 py-0.5 text-xs text-neutral-600 dark:bg-white/10 dark:text-neutral-300">TODAY</div>
        <div className="max-w-[88%] rounded-lg rounded-tl-none bg-white p-1.5 text-[14.5px] text-neutral-900 shadow-sm dark:bg-[#202c33] dark:text-neutral-100">
          <div className="flex items-center gap-2 rounded-md bg-neutral-100 p-2.5 dark:bg-[#111b21]">
            <FileSpreadsheet className="size-8 text-[#1d6f42]" />
            <div className="min-w-0">
              <p className="truncate text-[14.5px] font-medium">{d.pam.name.split(" ")[0]}_signals_{d.run.id}.xlsx</p>
              <p className="text-xs text-neutral-500">XLSX · 48 kB</p>
            </div>
          </div>
          <div className="space-y-1.5 px-1.5 pb-1 pt-2">
            <p>
              Hi {d.pam.name.split(" ")[0]} 👋 Your TTBS signals for <b>{fmtDate(d.run.windowStart)} – {fmtDate(d.run.windowEnd)}</b> are ready.
            </p>
            <p>
              📊 <b>{d.signals.length}</b> of {d.mine.length} logos have actionable triggers.
            </p>
            <p>🔥 Top priorities:</p>
            {top.map((p) => (
              <p key={p.companyId}>
                {p.rank}. <b>{d.name(p.companyId)}</b>: {plain(d.mine.find((r) => r.companyId === p.companyId)?.category)}
              </p>
            ))}
            <p>Full details are in the attached file and your email.</p>
            <p className="flex items-center justify-end gap-1 text-xs text-neutral-500">
              06:43 <CheckCheck className="size-3.5 text-sky-500" />
            </p>
          </div>
          <div className="border-t border-neutral-200 py-1.5 text-center text-[14.5px] font-medium text-sky-600 dark:border-white/10">Open TTBS Signals</div>
        </div>
      </div>
    </div>
  )
}

function ExcelPreview({ d }: { d: DigestData }) {
  const ordered = [...d.priority.map((p) => d.mine.find((r) => r.companyId === p.companyId)!), ...d.mine.filter((r) => !d.priority.some((p) => p.companyId === r.companyId))]
  return (
    <Card className="py-0">
      <CardContent className="overflow-x-auto p-0">
        <Table className="min-w-[56rem]">
          <TableHeader>
            <TableRow className="bg-[#1d6f42] hover:bg-[#1d6f42]">
              <TableHead className="text-white">Company</TableHead>
              <TableHead className="text-white">News Feed Results</TableHead>
              <TableHead className="text-white">Priority Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((r) => {
              const p = d.priority.find((x) => x.companyId === r.companyId)
              return (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="w-56 whitespace-normal font-medium">{d.name(r.companyId).toUpperCase()}</TableCell>
                  <TableCell className="whitespace-normal text-xs leading-relaxed text-muted-foreground">
                    {r.status === "signal" ? (
                      <>
                        Key signals: {plain(r.keySignals)}
                        <br />
                        Opportunity type: {plain(r.opportunity)}
                        <br />
                        Recommended outreach approach: {plain(r.outreach)}
                      </>
                    ) : (
                      ""
                    )}
                  </TableCell>
                  <TableCell className="w-72 whitespace-normal text-xs leading-relaxed text-muted-foreground">
                    {p && (
                      <>
                        Why now? {p.whyNow}
                        <br />
                        Action: {p.action}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export default function Digest() {
  const runs = useRuns()
  const completed = runs.data?.filter((r) => r.status === "completed" || r.status === "partial") ?? []
  const [runId, setRunId] = useState("")
  const [pamSel, setPamSel] = useState("")
  const activeRun = completed.find((r) => r.id === runId) ?? completed[0]
  // Default to the first PAM in the run until one is picked.
  const firstJob = usePamJobs(pamSel ? "" : (activeRun?.id ?? ""), { page: 0, pageSize: 1 })
  const pamId = pamSel || firstJob.data?.rows[0]?.pamId || ""
  const digest = useDigest(activeRun?.id ?? "", pamId)

  if (runs.isLoading) return <Skeleton className="h-96" />
  if (!activeRun)
    return (
      <EmptyState icon={Mail} title="No digests yet">
        A digest is built for each PAM when a research run finishes. Upload the Excel under Imports and run research to see one here.
      </EmptyState>
    )
  if (!digest.data) {
    if (digest.isLoading || firstJob.isLoading) return <Skeleton className="h-96" />
    return (
      <EmptyState icon={Mail} title="Nothing to show for this PAM">
        This PAM had no logos in the selected run.
      </EmptyState>
    )
  }

  const { rows, pam, job } = digest.data
  const names = new Map(rows.map((r) => [r.companyId, r.companyName]))
  const d: DigestData = {
    run: digest.data.run,
    pam,
    mine: rows,
    signals: rows.filter((r) => r.status === "signal"),
    priority: rows
      .filter((r) => r.priority)
      .map((r) => ({ runId: r.runId, pamId: r.pamId, companyId: r.companyId, rank: r.priority!.rank, whyNow: r.priority!.whyNow, action: r.priority!.action }))
      .sort((a, b) => a.rank - b.rank),
    name: (id) => names.get(id) ?? id,
  }

  return (
    <div>
      <PageHeader
        title="PAM digest preview"
        description="Exactly what the PAM receives: one email with all their logos plus an Excel attachment, and a WhatsApp summary with the same file."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={activeRun.id} onValueChange={setRunId}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {completed.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.id} · {fmtDate(r.windowEnd)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <PamPicker value={pamId} onChange={(id) => id && setPamSel(id)} className="w-64" />
        {job && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground sm:ml-auto">
            <Mail className="size-3.5" /> <StatusBadge status={job.email} />
            <MessageCircle className="ml-1 size-3.5" /> <StatusBadge status={job.whatsapp} />
          </div>
        )}
      </div>
      <Tabs defaultValue="email">
        <TabsList>
          <TabsTrigger value="email">
            <Mail /> Email
          </TabsTrigger>
          <TabsTrigger value="whatsapp">
            <MessageCircle /> WhatsApp
          </TabsTrigger>
          <TabsTrigger value="excel">
            <Table2 /> Excel attachment
          </TabsTrigger>
        </TabsList>
        <TabsContent value="email" className="pt-4">
          <EmailPreview d={d} />
        </TabsContent>
        <TabsContent value="whatsapp" className="pt-4">
          <WhatsAppPreview d={d} />
          <p className="mx-auto mt-4 max-w-sm text-center text-xs text-muted-foreground">
            Sent with Meta-approved template <code>pam_signal_digest_v2</code> and a document header, as WhatsApp requires for business-initiated
            messages.
          </p>
        </TabsContent>
        <TabsContent value="excel" className="pt-4">
          <ExcelPreview d={d} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
