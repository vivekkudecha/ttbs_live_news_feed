import { FileText, Mail, Search } from "lucide-react"
import { EmptyState } from "@/components/common/EmptyState"
import { PageHeader } from "@/components/common/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useTemplates } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import { Page } from "@/components/common/layout"
import { EmailTemplates } from "@/components/templates/EmailTemplates"
import { ResearchPromptEditor } from "@/components/templates/ResearchPromptEditor"
import { useSession } from "@/context/session"
import { can } from "@/lib/access"

/** Output templates: the email digest templates and the research prompt (both editable with the integrations module). */
export default function Templates() {
  const { user } = useSession()
  const email = can(user, "integrations")
  return (
    <Page>
      <PageHeader
        title="Output templates"
        description="How each PAM's digest email looks and what the research AI is asked for each company. Both are versioned; changes apply to the next run."
      />
      <Tabs defaultValue={email ? "email" : "research"}>
        <TabsList>
          {email && (
            <TabsTrigger value="email">
              <Mail /> Email templates
            </TabsTrigger>
          )}
          <TabsTrigger value="research">
            <Search /> Research prompt
          </TabsTrigger>
        </TabsList>
        {email && (
          <TabsContent value="email" className="mt-4">
            <EmailTemplates />
          </TabsContent>
        )}
        <TabsContent value="research" className="mt-4">
          {email ? <ResearchPromptEditor canEdit={can(user, "integrations", "manage")} /> : <ResearchTemplate />}
        </TabsContent>
      </Tabs>
    </Page>
  )
}

/** Read-only summary of the live research prompt, for users without the integrations module. */
function ResearchTemplate() {
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
    <div className="space-y-6">
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
    </div>
  )
}
