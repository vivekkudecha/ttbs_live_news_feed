import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useCompanies, usePams, useReassign } from "@/api/hooks"
import { useSession } from "@/context/session"

/** Manual reassignment of one or more logos to another active PAM (recorded as reason = manual). */
export function ReassignDialog({ companyIds, open, onOpenChange, onDone }: { companyIds: string[]; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const { user } = useSession()
  const pams = usePams()
  const companies = useCompanies()
  const reassign = useReassign()
  const [target, setTarget] = useState("")

  const selected = companies.data?.filter((c) => companyIds.includes(c.id)) ?? []
  const load = (pid: string) => companies.data?.filter((c) => c.pamId === pid).length ?? 0
  const single = selected.length === 1 ? selected[0] : null

  const submit = async () => {
    await reassign.mutateAsync({ companyIds, toPamId: target, actor: user!.username })
    const name = pams.data?.find((p) => p.id === target)?.name
    toast.success(single ? `${single.name} reassigned to ${name}` : `${companyIds.length} logos reassigned to ${name}`, {
      description: "History is kept; the new PAM receives these logos from the next cycle.",
    })
    setTarget("")
    onOpenChange(false)
    onDone?.()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTarget("")
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign PAM</DialogTitle>
          <DialogDescription>
            {single ? (
              <>
                Move <span className="font-medium text-foreground">{single.name}</span> to another PAM.
              </>
            ) : (
              `Move ${companyIds.length} logos to another PAM.`
            )}{" "}
            Past results stay with the company.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="reassign-pam">New PAM</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="reassign-pam" className="h-10 w-full">
              <SelectValue placeholder="Choose a PAM" />
            </SelectTrigger>
            <SelectContent>
              {pams.data
                ?.filter((p) => p.active && (!single || p.id !== single.pamId))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span>{p.name}</span>
                    <span className="text-muted-foreground">
                      · {p.region} · {load(p.id)}/{p.capacity}
                    </span>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!target || reassign.isPending}>
            {reassign.isPending && <Loader2 className="animate-spin" />}
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
