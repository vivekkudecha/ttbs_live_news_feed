/**
 * Pick an earlier upload to re-run. Lists saved uploads only (every run starts from one), with how
 * often each has been researched. Lets the user preview / edit the chosen upload's rows.
 */
import { useState } from "react"
import { Table2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useScopeOptions } from "@/api/hooks"
import { fmtDate } from "@/lib/format"
import type { ScopeOption } from "@/api/types"
import { DatasetGrid } from "./DatasetGrid"

const importIdOf = (key: string) => (key.startsWith("import:") ? key.slice("import:".length) : key)

export function UploadPicker({
  value,
  onChange,
  label = "Select records from previous history",
}: {
  value: string | null
  onChange: (importId: string, option: ScopeOption) => void
  label?: string
}) {
  const scopes = useScopeOptions()
  const [preview, setPreview] = useState(false)
  // Only saved uploads ("import:<id>"): anything else (e.g. an older server's "all") is not a run source.
  const uploads = (scopes.data ?? []).filter((s) => s.key.startsWith("import:"))

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Select
        value={value ? `import:${value}` : undefined}
        onValueChange={(key) => {
          const opt = uploads.find((u) => u.key === key)
          if (opt) onChange(importIdOf(key), opt)
          setPreview(false)
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={scopes.isLoading ? "Loading…" : uploads.length ? "Select an earlier upload" : "No saved uploads yet"} />
        </SelectTrigger>
        <SelectContent>
          {uploads.map((s) => (
            <SelectItem key={s.key} value={s.key}>
              <span className="truncate">{s.label}</span>
              <span className="tabular ml-2 text-xs text-muted-foreground">
                {s.count.toLocaleString("en-IN")} logos · {s.runs ? `run ${s.runs}× · last ${fmtDate(s.lastRunAt)}` : "never run"}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <div>
          <Button variant="link" size="sm" className="px-0" onClick={() => setPreview((p) => !p)}>
            <Table2 /> {preview ? "Hide data" : "Preview & edit this upload"}
          </Button>
          {preview && <DatasetGrid datasetId={value} pageSize={8} className="mt-2" />}
        </div>
      )}
    </div>
  )
}
