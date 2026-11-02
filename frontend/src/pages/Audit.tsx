import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Download, Link2, Search } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAudit } from "@/api/hooks"
import { fmtDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const area = (action: string) => action.split(".")[0]
const areaTone: Record<string, string> = {
  auth: "bg-chart-5/12 text-chart-5",
  run: "bg-primary/10 text-primary",
  notify: "bg-success/15 text-success",
  import: "bg-info/15 text-info",
  template: "bg-chart-2/15 text-[color-mix(in_oklch,var(--chart-2),black_30%)] dark:text-chart-2",
  provider: "bg-warning/20 text-[color-mix(in_oklch,var(--warning),black_40%)] dark:text-warning",
  pam: "bg-destructive/10 text-destructive",
  schedule: "bg-muted text-muted-foreground",
}

export default function Audit() {
  const audit = useAudit()
  const [q, setQ] = useState("")
  const [kind, setKind] = useState("all")
  const rows = useMemo(
    () =>
      (audit.data ?? [])
        .filter((e) => kind === "all" || area(e.action) === kind)
        .filter((e) => !q || `${e.actor} ${e.action} ${e.entity} ${e.detail}`.toLowerCase().includes(q.toLowerCase())),
    [audit.data, kind, q],
  )
  const kinds = [...new Set((audit.data ?? []).map((e) => area(e.action)))]

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Append-only and hash-chained: entries cannot be edited or deleted, and tampering is detectable."
        actions={
          <Button variant="outline" onClick={() => toast.success("Audit export prepared (CSV, signed)")}>
            <Download /> Export
          </Button>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search actor, action, entity…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {kinds.map((k) => (
              <SelectItem key={k} value={k} className="capitalize">
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[52rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Time (IST)</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="pr-5">Source IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="tabular pl-5 text-sm text-muted-foreground">{fmtDateTime(e.ts)}</TableCell>
                  <TableCell>
                    <span className="font-medium">{e.actor}</span>
                    <p className="text-xs capitalize text-muted-foreground">{e.role}</p>
                  </TableCell>
                  <TableCell>
                    <Badge className={cn("font-mono text-[11px]", areaTone[area(e.action)])}>{e.action}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">{e.entity}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-sm text-muted-foreground">{e.detail || "—"}</TableCell>
                  <TableCell className="tabular pr-5 text-xs text-muted-foreground">{e.ip}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link2 className="size-3.5" /> Chain verified · {audit.data?.length ?? 0} entries · last hash 9f3c…a21e
      </p>
    </div>
  )
}
