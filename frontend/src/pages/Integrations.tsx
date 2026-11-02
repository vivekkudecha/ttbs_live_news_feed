import { toast } from "sonner"
import { Bot, KeyRound, Mail, MessageCircle, PlugZap, Send } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useChannels, useProviders } from "@/api/hooks"
import { can, useSession } from "@/context/session"

export default function Integrations() {
  const { user } = useSession()
  const providers = useProviders()
  const channels = useChannels()
  const editable = can.admin(user!.role)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Providers & channels"
        description="Pluggable adapters. Credentials are encrypted at rest (AES-GCM), never shown again after saving, and every change is audited."
      />

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Bot className="size-4 text-muted-foreground" /> Research providers (LLM + web search)
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          {providers.data?.map((p) => (
            <Card key={p.key} className={p.status === "not_configured" ? "border-dashed" : ""}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {p.name}
                  {p.isDefault && <Badge>Default</Badge>}
                </CardTitle>
                <CardDescription>{p.note ?? <code className="text-xs">{p.model}</code>}</CardDescription>
                <CardAction>
                  <StatusBadge status={p.status} />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                {p.status === "connected" ? (
                  <>
                    <dl className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Rate limit</dt>
                        <dd className="tabular font-medium">{p.rps} req/s</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Input / 1K</dt>
                        <dd className="tabular font-medium">${p.priceInPer1k}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Output / 1K</dt>
                        <dd className="tabular font-medium">${p.priceOutPer1k}</dd>
                      </div>
                    </dl>
                    <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
                      <KeyRound className="size-4 text-muted-foreground" />
                      <code className="text-xs">{p.maskedKey}</code>
                      <span className="ml-auto text-xs text-muted-foreground">rotated 30 Oct</span>
                    </div>
                    {editable && (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => toast.success("Connection OK", { description: "Perplexity responded in 412 ms" })}>
                          <PlugZap /> Test connection
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => toast.info("Key rotation dialog opens here (prototype)")}>
                          <KeyRound /> Rotate key
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  editable && (
                    <Button variant="outline" size="sm" onClick={() => toast.info(`${p.name} setup opens here (prototype)`)}>
                      Configure
                    </Button>
                  )
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Send className="size-4 text-muted-foreground" /> Notification channels
        </h2>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {channels.data?.map((c) => (
            <Card key={c.key} className={c.status === "not_configured" ? "border-dashed" : ""}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {c.type === "email" ? <Mail className="size-4 text-muted-foreground" /> : <MessageCircle className="size-4 text-muted-foreground" />}
                  {c.name}
                </CardTitle>
                <CardDescription>{c.adapter}</CardDescription>
                <CardAction>
                  <Switch checked={c.enabled} disabled={!editable} aria-label={`Enable ${c.name}`} onCheckedChange={() => toast.info("Channel toggled (prototype)")} />
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
                {editable && c.status === "connected" && (
                  <Button variant="outline" size="sm" onClick={() => toast.success(`Test ${c.type} sent to ${user!.username}`)}>
                    <Send /> Send test
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}
