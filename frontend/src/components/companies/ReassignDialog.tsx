import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { PamPicker } from "@/components/pickers/Pickers"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { useCompanyDetail, useReassign } from "@/api/hooks"
import { useSession } from "@/context/session"
import type { PamOption } from "@/api/types"

/** Manual reassignment of one or more logos to another active PAM (recorded as reason = manual). */
export function ReassignDialog({ companyIds, open, onOpenChange, onDone }: { companyIds: string[]; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const { user } = useSession()
  const reassign = useReassign()
  const [target, setTarget] = useState<{ id: string; pam?: PamOption }>({ id: "" })
  // For a single logo, show its name and exclude its current PAM from the picker.
  const single = useCompanyDetail(open && companyIds.length === 1 ? companyIds[0] : null)
  const company = single.data?.company

  const close = (o: boolean) => {
    if (!o) setTarget({ id: "" })
    onOpenChange(o)
  }

  const submit = async () => {
    await reassign.mutateAsync({ companyIds, toPamId: target.id, actor: user!.username })
    const name = target.pam?.name ?? "the new PAM"
    toast.success(company ? `${company.name} reassigned to ${name}` : `${companyIds.length} logos reassigned to ${name}`, {
      description: "History is kept; the new PAM receives these logos from the next cycle.",
    })
    close(false)
    onDone?.()
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign PAM</DialogTitle>
          <DialogDescription>
            {company ? (
              <>
                Move <span className="font-medium text-foreground">{company.name}</span> to another PAM.
              </>
            ) : (
              `Move ${companyIds.length} logos to another PAM.`
            )}{" "}
            Past results stay with the company.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="reassign-pam">New PAM</Label>
          <PamPicker id="reassign-pam" className="h-10 w-full" value={target.id} onChange={(id, pam) => setTarget({ id, pam })} activeOnly excludeId={company?.pamId ?? undefined} />
          {target.pam && (
            <p className="text-xs text-muted-foreground">
              Currently {target.pam.load}/{target.pam.capacity} logos
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!target.id || reassign.isPending}>
            {reassign.isPending && <Loader2 className="animate-spin" />}
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
