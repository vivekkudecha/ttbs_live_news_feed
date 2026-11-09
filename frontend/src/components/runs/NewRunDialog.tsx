/**
 * "New research run". Every run starts from an upload: upload this run's Excel/CSV (the usual
 * case), or re-run an earlier upload with that upload's own logo → PAM mapping.
 *
 * Layout: fixed header (title + source switch), one scrolling body, nothing wider than the dialog
 * (wide tables scroll inside their own box).
 */
import { useMemo, useState } from "react"
import { ArrowLeft, Building2, CalendarDays, Check, ChevronDown, FileSpreadsheet, History, Play, Radar, Search, Sparkles, Table2, UploadCloud } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { DatasetGrid } from "@/components/datasets/DatasetGrid"
import { ResearchPlan } from "@/components/datasets/ResearchPlan"
import { UploadFlow } from "@/components/datasets/UploadFlow"
import { useScopeOptions } from "@/api/hooks"
import { fmtDate, fmtDateTime, fmtUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ScopeOption } from "@/api/types"

type Source = "upload" | "rerun"
const PER_COMPANY_USD = 0.0125
const n = (x: number) => x.toLocaleString("en-IN")
const importIdOf = (key: string) => (key.startsWith("import:") ? key.slice("import:".length) : key)
/** "name · 09 Nov 2026, 13:59" → ["name", "09 Nov 2026, 13:59"] */
const splitLabel = (label: string) => {
  const i = label.lastIndexOf(" · ")
  return i > 0 ? [label.slice(0, i), label.slice(i + 3)] : [label, ""]
}

export function NewRunDialog({ label = "New run" }: { label?: string }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<Source>("upload")
  const [picked, setPicked] = useState<{ id: string; opt: ScopeOption } | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setPicked(null)
          setSource("upload")
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="brand">
          <Play /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {/* Header */}
        <div className="relative shrink-0 border-b bg-[image:var(--surface-wash)]">
          <div className="h-1 w-full bg-brand-gradient" />
          <DialogHeader className="flex-row items-start gap-4 px-6 pb-4 pt-5 text-left">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-md shadow-brand/25">
              <Radar className="size-5" />
            </div>
            <div className="min-w-0 space-y-1 pr-8">
              <DialogTitle className="text-lg">New research run</DialogTitle>
              <DialogDescription>
                Research every logo in one upload and send each PAM their own signals. Existing logos and PAMs are matched, never duplicated.
              </DialogDescription>
            </div>
          </DialogHeader>
          {open && (
            <div role="radiogroup" aria-label="Where the logos come from" className="grid gap-3 px-6 pb-5 sm:grid-cols-2">
              <SourceCard
                active={source === "upload"}
                onClick={() => setSource("upload")}
                icon={UploadCloud}
                title="Upload a new file"
                hint="Excel or CSV with logos and their PAMs"
              />
              <SourceCard
                active={source === "rerun"}
                onClick={() => setSource("rerun")}
                icon={History}
                title="Re-run an earlier upload"
                hint="Same logos, same PAM mapping, fresh news"
              />
            </div>
          )}
        </div>

        {/* Body: the only scrolling area; min-w-0 keeps wide tables inside their own scroll box */}
        {open && (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
            {source === "upload" ? (
              <div key="upload" className="min-w-0 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
                <UploadFlow onDone={() => setOpen(false)} />
              </div>
            ) : picked ? (
              <PickedUpload key={picked.id} picked={picked} onChange={() => setPicked(null)} onDone={() => setOpen(false)} />
            ) : (
              <UploadList onPick={(id, opt) => setPicked({ id, opt })} />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SourceCard({ active, onClick, icon: Icon, title, hint }: { active: boolean; onClick: () => void; icon: typeof Play; title: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-primary bg-primary/[0.06] shadow-md ring-1 ring-primary",
      )}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg transition-colors",
          active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-primary",
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <span
        className={cn(
          "ml-auto grid size-5 shrink-0 place-items-center rounded-full border transition-all",
          active ? "scale-100 border-primary bg-primary text-primary-foreground" : "scale-90 border-muted-foreground/30",
        )}
      >
        {active && <Check className="size-3" />}
      </span>
    </button>
  )
}

type Filter = "all" | "new" | "ran"

/** Searchable cards of saved uploads (newest first, as the server lists them). */
function UploadList({ onPick }: { onPick: (importId: string, opt: ScopeOption) => void }) {
  const scopes = useScopeOptions()
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const uploads = useMemo(() => (scopes.data ?? []).filter((s) => s.key.startsWith("import:")), [scopes.data])
  const shown = uploads.filter(
    (u) => (filter === "all" || (filter === "new" ? u.runs === 0 : u.runs > 0)) && u.label.toLowerCase().includes(q.trim().toLowerCase()),
  )
  const counts = { all: uploads.length, new: uploads.filter((u) => u.runs === 0).length, ran: uploads.filter((u) => u.runs > 0).length }

  return (
    <div className="space-y-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search uploads by name or date" className="h-10 pl-9" aria-label="Search uploads" />
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Filter uploads">
          {(
            [
              ["all", "All"],
              ["new", "Never run"],
              ["ran", "Run before"],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                filter === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {l} <span className="tabular text-muted-foreground">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {scopes.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
          <FileSpreadsheet className="size-8 text-muted-foreground" />
          <p className="font-medium">{uploads.length ? "No uploads match" : "No saved uploads yet"}</p>
          <p className="text-sm text-muted-foreground">{uploads.length ? "Try another search or filter." : "Upload a file first; it can be re-run any time after."}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((u, i) => {
            const [name, when] = splitLabel(u.label)
            return (
              <button
                key={u.key}
                type="button"
                onClick={() => onPick(importIdOf(u.key), u)}
                style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                className="group flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-all duration-200 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <FileSpreadsheet className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{name}</span>
                    {when && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarDays className="size-3" /> Uploaded {when}
                      </span>
                    )}
                  </span>
                  {u.runs === 0 ? (
                    <Badge className="shrink-0 bg-brand-gradient text-white">
                      <Sparkles /> New
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="shrink-0">
                      Run {u.runs}×
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Building2 className="size-3.5" /> <b className="tabular font-semibold text-foreground">{n(u.count)}</b> logos
                  </span>
                  <span>{u.runs ? `Last run ${fmtDate(u.lastRunAt)}` : "Never researched"}</span>
                  <span className="ml-auto font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">Select →</span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The chosen upload: summary, optional review/edit of its rows, then the launch options. */
function PickedUpload({ picked, onChange, onDone }: { picked: { id: string; opt: ScopeOption }; onChange: () => void; onDone: () => void }) {
  const [review, setReview] = useState(false)
  const { opt } = picked
  const [name, when] = splitLabel(opt.label)
  const stats: [string, string][] = [
    ["Logos", n(opt.count)],
    ["Previous runs", opt.runs ? n(opt.runs) : "None"],
    ["Last run", opt.lastRunAt ? fmtDateTime(opt.lastRunAt) : "—"],
    ["Est. cost", `≤ ${fmtUsd(opt.count * PER_COMPANY_USD)}`],
  ]

  return (
    <div className="min-w-0 space-y-5 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <div className="relative overflow-hidden rounded-xl border bg-card">
        <div className="absolute inset-y-0 left-0 w-1 bg-brand-gradient" />
        <div className="flex flex-wrap items-center gap-3 p-4 pl-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <FileSpreadsheet className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{name}</p>
            {when && <p className="text-xs text-muted-foreground">Uploaded {when}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={onChange}>
            <ArrowLeft /> Change upload
          </Button>
        </div>
        <dl className="grid grid-cols-2 border-t sm:grid-cols-4">
          {stats.map(([k, v], i) => (
            <div key={k} className={cn("px-5 py-3", i > 0 && "sm:border-l", i % 2 === 1 && "border-l", i >= 2 && "border-t sm:border-t-0")}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="tabular truncate text-base font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="min-w-0 rounded-xl border">
        <button
          type="button"
          onClick={() => setReview((r) => !r)}
          aria-expanded={review}
          className="flex w-full items-center gap-3 rounded-xl p-4 text-left transition-colors hover:bg-muted/50"
        >
          <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Table2 className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Review &amp; edit logos</span>
            <span className="block text-xs text-muted-foreground">Optional · fix a company, PAM or WhatsApp number, or drop rows before running</span>
          </span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200", review && "rotate-180")} />
        </button>
        {review && (
          <div className="min-w-0 border-t p-4 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <DatasetGrid datasetId={picked.id} pageSize={8} />
          </div>
        )}
      </div>

      <div className="rounded-xl border p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Play className="size-4 text-primary" /> When should it run?
        </p>
        <ResearchPlan importId={picked.id} label={name} companies={opt.count} previousRuns={opt.runs} lastRunAt={opt.lastRunAt} onDone={onDone} />
      </div>
    </div>
  )
}
