import { Bot, Mail, MessageCircle, Send } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useChannels } from "@/api/hooks"
import { AiProviderSettings } from "@/components/integrations/AiProviderSettings"

export default function Integrations() {
  const channels = useChannels()

  return (
    <div className="space-y-8">
      <PageHeader
        title="Providers & channels"
        description="Pluggable adapters. Credentials are encrypted at rest (AES-GCM), never shown again after saving, and every change is audited."
      />

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Bot className="size-4 text-muted-foreground" /> Research AI (LLM + web search)
        </h2>
        <AiProviderSettings />
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Send className="size-4 text-muted-foreground" /> Notification channels
        </h2>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {channels.data?.map((c) => (
            <Card key={c.key}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {c.type === "email" ? <Mail className="size-4 text-muted-foreground" /> : <MessageCircle className="size-4 text-muted-foreground" />}
                  {c.name}
                </CardTitle>
                <CardDescription>{c.adapter}</CardDescription>
                <CardAction>
                  <Switch checked={c.enabled} disabled aria-label={`${c.name} enabled`} />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <StatusBadge status={c.status} />
                <dl className="space-y-1.5 text-sm">
                  {Object.entries(c.details).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="truncate text-right font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Email and WhatsApp delivery run on the console adapter for now: digests are queued, retried and logged by the worker, not sent.
        </p>
      </section>
    </div>
  )
}
