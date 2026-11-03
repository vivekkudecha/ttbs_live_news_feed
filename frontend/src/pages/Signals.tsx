import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { useWindowVirtualizer } from "@tanstack/react-virtual"
import { Download, Loader2, Search, Sparkles, Zap } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { StatusBadge } from "@/components/common/StatusBadge"
import { CategoryBadge, SignalSections } from "@/components/common/SignalCard"
import { RichText } from "@/components/common/RichText"
import { PamPicker } from "@/components/pickers/Pickers"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useRuns, useSignalsInfinite } from "@/api/hooks"
import { useDebounced } from "@/lib/use-debounced"
import { fmtDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ResearchStatus, SignalRow } from "@/api/types"

const categories = ["Expansion", "Funding", "Leadership", "Cybersecurity", "Digital", "Contract"]
const PAGE = 30

function SignalCardRow({ r, showPam, pamFilter }: { r: SignalRow; showPam: boolean; pamFilter: boolean }) {
  const p = r.priority
  return (
    <Card className="gap-0">
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {p && (
            <Badge variant="secondary" className="tabular font-medium" title="Priority rank within this PAM's digest">
              {pamFilter ? `#${p.rank}` : `PAM rank #${p.rank}`}
            </Badge>
          )}
          <Link to={`/companies?company=${r.companyId}`} className="font-semibold hover:text-brand-blue hover:underline">
            {r.companyName}
          </Link>
          <CategoryBadge category={r.category} />
          {r.status !== "signal" && <StatusBadge status={r.status} />}
          {r.cached && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              cached
            </Badge>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {r.industry}
            {showPam && ` · ${r.pamName}`}
          </span>
        </div>
        {r.status === "signal" ? (
          <>
            <SignalSections result={r} />
            {p && (
              <div className="space-y-1 rounded-lg bg-muted/60 px-4 py-3 text-sm leading-relaxed sm:ml-[12rem]">
                <p className="eyebrow flex items-center gap-1.5">
                  <Sparkles className="size-3.5 text-brand" /> Priority action
                </p>
                <p>
                  <span className="font-medium">Why now?</span> <RichText text={p.whyNow} />
                </p>
                <p>
                  <span className="font-medium">Action:</span> <RichText text={p.action} />
                </p>
              </div>
            )}
          </>
        ) : r.status === "failed" ? (
          <p className="text-sm text-destructive">{r.error} · will retry in next cycle or retry from the run page.</p>
        ) : r.status === "pending" ? (
          <p className="text-sm text-muted-foreground">Research in progress…</p>
        ) : (
          <p className="text-sm text-muted-foreground">Details not found: no TTBS-relevant news in this window.</p>
        )}
      </CardContent>
    </Card>
  )
}

export default function Signals() {
  const runs = useRuns()
  const usable = runs.data?.filter((r) => r.status !== "queued") ?? []
  const [runId, setRunId] = useState("")
  const activeRunId = runId || usable.find((r) => r.status === "completed" || r.status === "partial")?.id || usable[0]?.id || ""
  const [pamId, setPamId] = useState("")
  const [category, setCategory] = useState("all")
  const [status, setStatus] = useState<ResearchStatus | "all">("signal")
  const [search, setSearch] = useState("")
  const q = useDebounced(search, 250)
  const run = usable.find((r) => r.id === activeRunId)

  const feed = useSignalsInfinite({
    runId: activeRunId,
    pageSize: PAGE,
    status,
    category,
    pamId: pamId || undefined,
    search: q,
  })
  const rows = feed.data?.pages.flatMap((p) => p.rows) ?? []
  const first = feed.data?.pages[0]
  const counts = first?.counts

  // Window virtualisation: only cards near the viewport are mounted, however long the feed is.
  const listRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => setOffset(listRef.current?.offsetTop ?? 0), [first])
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 280,
    overscan: 5,
    gap: 16,
    scrollMargin: offset,
  })
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (lastIndex >= rows.length - 6 && feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage()
  }, [lastIndex, rows.length, feed])

  return (
    <div>
      <PageHeader
        title="Signals feed"
        description={run ? `${run.label} · window ${fmtDate(run.windowStart)} – ${fmtDate(run.windowEnd)} · template v${run.templateVersion}` : "Research results by logo"}
      />

      <div className="mb-4 flex flex-col gap-3">
        <Tabs value={status} onValueChange={(v) => setStatus(v as ResearchStatus | "all")}>
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="signal">Signals · {(counts?.signal ?? 0).toLocaleString("en-IN")}</TabsTrigger>
            <TabsTrigger value="no_signal">No signal · {(counts?.no_signal ?? 0).toLocaleString("en-IN")}</TabsTrigger>
            <TabsTrigger value="failed">Failed · {(counts?.failed ?? 0).toLocaleString("en-IN")}</TabsTrigger>
            {(counts?.pending ?? 0) > 0 && <TabsTrigger value="pending">In progress · {counts!.pending.toLocaleString("en-IN")}</TabsTrigger>}
            <TabsTrigger value="all">All · {(counts?.all ?? 0).toLocaleString("en-IN")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search signals by company" placeholder="Search company…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={activeRunId} onValueChange={setRunId}>
            <SelectTrigger className="w-full lg:w-60">
              <SelectValue placeholder="Run" />
            </SelectTrigger>
            <SelectContent>
              {usable.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.id} · {fmtDate(r.windowEnd)}
                  {r.status === "running" ? " (running)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {<PamPicker value={pamId} onChange={(id) => setPamId(id)} allLabel="All PAMs" className="w-full lg:w-56" />}
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All trigger types</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" className="h-9" onClick={() => toast.success("Excel export started", { description: "Generated on the server and emailed as a download link." })}>
            <Download /> Export Excel
          </Button>
        </div>
      </div>

      {runs.isSuccess && !activeRunId ? (
        <EmptyState icon={Zap} title="No research yet">
          Signals appear here once a research run has started. Upload the Excel under Imports and run research.
        </EmptyState>
      ) : !first ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Zap} title="No results match these filters">
          Try another run, trigger type or status.
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            Showing {rows.length.toLocaleString("en-IN")} of {first.total.toLocaleString("en-IN")} · loads more as you scroll
          </p>
          <div ref={listRef} className={cn("relative transition-opacity", feed.isPlaceholderData && "opacity-60")} style={{ height: virtualizer.getTotalSize() }}>
            {items.map((v) => (
              <div
                key={rows[v.index].id}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}
              >
                <SignalCardRow r={rows[v.index]} showPam pamFilter={!!pamId} />
              </div>
            ))}
          </div>
          {feed.isFetchingNextPage && (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading more…
            </p>
          )}
        </>
      )}
    </div>
  )
}
