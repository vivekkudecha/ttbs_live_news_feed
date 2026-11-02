import { useState } from "react"
import { toast } from "sonner"
import { ArrowRight, Loader2, Mail, MessageCircle, MoreHorizontal, Phone, Shuffle, UserMinus } from "lucide-react"
import { PageHeader } from "@/components/common/PageHeader"
import { StatusBadge } from "@/components/common/StatusBadge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { planRebalance } from "@/api/client"
import { useCompanies, useDeactivatePam, usePams } from "@/api/hooks"
import { can, useSession } from "@/context/session"
import { initials, pct } from "@/lib/format"
import type { Pam } from "@/api/types"

export default function Pams() {
  const { user } = useSession()
  const pams = usePams()
  const companies = useCompanies()
  const deactivate = useDeactivatePam()
  const [target, setTarget] = useState<Pam | null>(null)
  const editable = can.admin(user!.role)

  const load = (id: string) => companies.data?.filter((c) => c.pamId === id).length ?? 0
  const plan = target && pams.data && companies.data ? planRebalance(target.id, pams.data, companies.data) : null
  const name = (id: string) => pams.data?.find((p) => p.id === id)?.name ?? id
  const cname = (id: string) => companies.data?.find((c) => c.id === id)?.name ?? id

  const confirm = async () => {
    if (!target) return
    const res = await deactivate.mutateAsync({ pamId: target.id, actor: user!.username })
    toast.success(`${target.name} deactivated`, {
      description: `${res.moves.length} companies auto-reassigned. New PAMs receive them from the next cycle.`,
    })
    setTarget(null)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="PAMs"
        description="Sales owners for logos. Each PAM gets one digest per cycle covering all their companies."
      />
      <Alert>
        <Shuffle />
        <AlertTitle>Automatic rebalancing is on</AlertTitle>
        <AlertDescription>
          When a PAM leaves (deactivated here or missing from an import), their logos move automatically to the least-loaded active PAM in the same
          region, then the same segment, within capacity. History and past results stay with each company.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {pams.data?.map((p) => {
          const n = load(p.id)
          const u = pct(n, p.capacity)
          return (
            <Card key={p.id} className={p.active ? "" : "opacity-70"}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Avatar className="size-10">
                    <AvatarFallback className="bg-primary/10 font-semibold text-primary">{initials(p.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <CardTitle className="truncate">{p.name}</CardTitle>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.region} · {p.segment}
                    </p>
                  </div>
                </div>
                <CardAction className="flex items-center gap-1">
                  <StatusBadge status={p.active ? "active" : "inactive"} />
                  {editable && p.active && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => toast.info("Edit PAM form opens here (prototype)")}>Edit details</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setTarget(p)}>
                          <UserMinus /> Deactivate (PAM left)
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-1.5 flex justify-between text-xs">
                    <span className="text-muted-foreground">Logos</span>
                    <span className="tabular font-medium">
                      {n} / {p.capacity}
                    </span>
                  </div>
                  <Progress value={u} className="h-1.5" />
                </div>
                <div className="space-y-1.5 text-sm text-muted-foreground">
                  <p className="flex items-center gap-2 truncate">
                    <Mail className="size-3.5 shrink-0" /> {p.email}
                  </p>
                  <p className="flex items-center gap-2">
                    <Phone className="size-3.5 shrink-0" /> {p.whatsapp}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Badge variant={p.notifyEmail ? "secondary" : "outline"} className="font-normal">
                    <Mail /> Email {p.notifyEmail ? "on" : "off"}
                  </Badge>
                  <Badge variant={p.notifyWhatsapp ? "secondary" : "outline"} className="font-normal">
                    <MessageCircle /> WhatsApp {p.notifyWhatsapp ? "on" : "off"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Deactivate {target?.name}?</DialogTitle>
            <DialogDescription>
              Their {plan?.moves.length ?? 0} logos are reassigned automatically as shown. This runs as a single transaction and is recorded in the
              audit log.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80 rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Company</TableHead>
                  <TableHead>New PAM</TableHead>
                  <TableHead className="pr-4">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan?.moves.map((m) => (
                  <TableRow key={m.companyId}>
                    <TableCell className="whitespace-normal pl-4 font-medium">{cname(m.companyId)}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <ArrowRight className="size-3.5 text-muted-foreground" />
                        {name(m.toPamId)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal pr-4 text-xs text-muted-foreground">{m.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirm} disabled={deactivate.isPending}>
              {deactivate.isPending && <Loader2 className="animate-spin" />}
              Deactivate &amp; rebalance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
