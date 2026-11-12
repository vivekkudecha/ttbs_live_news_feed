import { useState } from "react"
import { toast } from "sonner"
import { Loader2, Mail, MessageCircle } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useUpdatePam } from "@/api/hooks"
import { errorMessage } from "@/api/http"
import type { PamCard, PamPatch } from "@/api/types"

type Draft = Required<PamPatch>

const fromPam = (p: PamCard): Draft => ({ name: p.name, email: p.email, whatsapp: p.whatsapp, notifyEmail: p.notifyEmail, notifyWhatsapp: p.notifyWhatsapp })

/** Only the fields that changed, trimmed. */
function changes(p: PamCard, d: Draft): PamPatch {
  const next: Draft = { ...d, name: d.name.trim(), email: d.email.trim(), whatsapp: d.whatsapp.trim() }
  const before = fromPam(p)
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => before[k as keyof Draft] !== v))
}

/** Edit a PAM's name, contact details and which channels their digests go to. */
export function EditPamDialog({ pam, onClose }: { pam: PamCard; onClose: () => void }) {
  const update = useUpdatePam()
  const [draft, setDraft] = useState<Draft>(() => fromPam(pam))
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const patch = changes(pam, draft)
  const dirty = Object.keys(patch).length > 0

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await update.mutateAsync({ id: pam.id, patch })
      toast.success("PAM updated", { description: draft.name.trim() })
      onClose()
    } catch (err) {
      toast.error("Could not update the PAM", { description: errorMessage(err) })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Edit {pam.name}</DialogTitle>
            <DialogDescription>
              Applies to the next digests. Uploads match PAMs by email, so the next upload listing this PAM sets their name and WhatsApp
              again.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="pam-name">Name</Label>
              <Input id="pam-name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={200} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pam-email">Email</Label>
              <Input id="pam-email" type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} maxLength={320} spellCheck={false} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pam-whatsapp">WhatsApp</Label>
              <Input id="pam-whatsapp" type="tel" value={draft.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} maxLength={40} placeholder="+91 98100 11001" />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Send digests by</legend>
            <ul className="divide-y rounded-md border">
              {(
                [
                  ["notifyEmail", "Email", Mail],
                  ["notifyWhatsapp", "WhatsApp", MessageCircle],
                ] as const
              ).map(([key, label, Icon]) => (
                <li key={key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <Label htmlFor={`pam-${key}`} className="flex items-center gap-2 font-normal">
                    <Icon className="size-4 text-muted-foreground" /> {label}
                  </Label>
                  <Switch id={`pam-${key}`} checked={draft[key]} onCheckedChange={(v) => set(key, v)} />
                </li>
              ))}
            </ul>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending || !dirty || !draft.name.trim() || !draft.email.trim()}>
              {update.isPending && <Loader2 className="animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
