/**
 * Which companies a run or schedule covers: all active companies or one uploaded dataset.
 * Lets the user preview / edit the chosen dataset, or upload a new one without leaving the dialog.
 */
import { useState } from "react"
import { ArrowLeft, Table2, UploadCloud } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useScopeOptions } from "@/api/hooks"
import { DatasetGrid } from "./DatasetGrid"
import { UploadFlow } from "./UploadFlow"

export function DatasetPicker({ value, onChange, label = "Companies" }: { value: string; onChange: (key: string) => void; label?: string }) {
  const scopes = useScopeOptions()
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState(false)
  const datasetId = value.startsWith("import:") ? value.slice("import:".length) : null
  const datasets = scopes.data?.filter((s) => s.key.startsWith("import:")) ?? []

  if (uploading)
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <p className="font-medium">Upload a new dataset</p>
          <Button variant="ghost" size="sm" onClick={() => setUploading(false)}>
            <ArrowLeft /> Back
          </Button>
        </div>
        <UploadFlow
          onUse={(key) => {
            onChange(key)
            setUploading(false)
            void scopes.refetch()
          }}
        />
      </div>
    )

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          value={value}
          onValueChange={(v) => {
            onChange(v)
            setPreview(false)
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={scopes.isLoading ? "Loading…" : "Choose companies"} />
          </SelectTrigger>
          <SelectContent>
            {scopes.data
              ?.filter((s) => s.key === "all")
              .map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label} ({s.count.toLocaleString("en-IN")})
                </SelectItem>
              ))}
            {datasets.length > 0 && <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">Uploaded datasets</div>}
            {datasets.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label} ({s.count.toLocaleString("en-IN")})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" className="shrink-0" onClick={() => setUploading(true)}>
          <UploadCloud /> Upload new
        </Button>
      </div>
      {datasetId && (
        <div>
          <Button variant="link" size="sm" className="px-0" onClick={() => setPreview((p) => !p)}>
            <Table2 /> {preview ? "Hide data" : "Preview & edit this dataset"}
          </Button>
          {preview && <DatasetGrid datasetId={datasetId} pageSize={8} className="mt-2" />}
        </div>
      )}
    </div>
  )
}
