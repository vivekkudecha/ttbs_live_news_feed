import { FileText } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { PageHeader } from "@/components/common/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useTemplates } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { Page } from "@/components/common/layout"

/** The research prompt every run uses (read-only: it lives in backend/app/research/prompts.py). */
export default function Templates() {
  const templates = useTemplates()

  if (templates.isLoading) return <Skeleton className="h-96" />
  const tpl = templates.data?.[0]
  const v = tpl?.versions.find((x) => x.version === tpl.activeVersion)
  if (!tpl || !v)
    return (
      <EmptyState icon={FileText} title="Template not available">
        {templates.isError ? errorMessage(templates.error) : "The backend returned no template."}
      </EmptyState>
    )

  return (
    <Page>
      <PageHeader title="Output templates" description="What the research looks for and the exact format each company's result comes back in." />

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {tpl.name} <Badge variant="secondary">v{v.version}</Badge> <Badge variant="outline">Read-only</Badge>
          </CardTitle>
          <CardDescription>{tpl.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Research window</dt>
              <dd className="font-medium">{v.windowDays} days</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Model (active research AI)</dt>
              <dd className="truncate font-medium">{v.model ? <code className="text-xs">{v.model}</code> : "No AI connected"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Result columns</dt>
              <dd className="font-medium">{v.excelColumns.length}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Output sections</CardTitle>
          <CardDescription>Each company's answer is parsed into these fields.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {v.sections.map((s) => (
            <div key={s.key} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-4">
              <span className="w-56 shrink-0 text-sm font-medium">{s.label}</span>
              <span className="text-sm text-muted-foreground">{s.instruction}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Tabs defaultValue="prompt">
        <TabsList>
          <TabsTrigger value="prompt">Research prompt</TabsTrigger>
          <TabsTrigger value="rules">Relevance rules &amp; format</TabsTrigger>
          <TabsTrigger value="context">TTBS context</TabsTrigger>
          <TabsTrigger value="system">System instruction</TabsTrigger>
        </TabsList>
        {(
          [
            ["prompt", v.researchPrompt],
            ["rules", v.relevanceRules],
            ["context", v.ttbsContext],
            ["system", v.priorityPrompt],
          ] as const
        ).map(([key, text]) => (
          <TabsContent key={key} value={key}>
            <Card>
              <CardContent>
                <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre>
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  )
}
