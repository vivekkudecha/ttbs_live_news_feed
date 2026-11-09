import { useMemo } from "react"
import { ScrollText } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { EmptyState } from "@/components/common/EmptyState"
import { Page } from "@/components/common/layout"
import { SmartTable } from "@/components/data-table/SmartTable"
import { useServerTable } from "@/components/data-table/useSmartTable"
import { backend } from "@/api/http"
import type { AuditEntry } from "@/api/types"
import { auditColumns } from "@/components/audit/columns"

export default function Audit() {
  const columns = useMemo(auditColumns, [])
  const state = useServerTable<AuditEntry>({
    id: "audit",
    columns,
    queryKey: ["audit"],
    fetcher: (q) => backend.auditLog(q),
    defaultSort: { id: "ts", desc: true },
    pageSize: 50,
    defaultHidden: ["ip"],
    refetchInterval: 15_000,
    getRowId: (r) => r.id,
  })
  return (
    <Page>
      <PageHeader title="Audit log" description="Append-only and hash-chained: entries cannot be edited or deleted, and tampering is detectable." />
      <SmartTable
        state={state}
        toolbar={
          <p className="text-sm text-muted-foreground">
            <span className="tabular font-medium text-foreground">{state.total.toLocaleString("en-IN")}</span> entries · sort or filter any column from its header
          </p>
        }
        pageSizes={[25, 50, 100]}
        empty={
          <EmptyState icon={ScrollText} title="No entries match">
            Clear a filter to see more.
          </EmptyState>
        }
      />
    </Page>
  )
}
