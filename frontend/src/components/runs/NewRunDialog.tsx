/**
 * "New research run". Every run starts from an upload: upload this run's Excel/CSV (the usual
 * case), or re-run an earlier upload with that upload's own logo → PAM mapping.
 */
import { useState } from "react"
import { History, Play, UploadCloud } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UploadPicker } from "@/components/datasets/DatasetPicker"
import { ResearchPlan } from "@/components/datasets/ResearchPlan"
import { UploadFlow } from "@/components/datasets/UploadFlow"
import type { ScopeOption } from "@/api/types"

export function NewRunDialog({ label = "New run" }: { label?: string }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState("upload")
  const [picked, setPicked] = useState<{ id: string; opt: ScopeOption } | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setPicked(null)
          setTab("upload")
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Play /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>New research run</DialogTitle>
          <DialogDescription>
            Each run researches the logos in one upload and sends every PAM their own results. Logos and PAMs already in the system are matched,
            not duplicated, and any change of owner is kept in the history.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="upload">
                <UploadCloud /> Upload a file
              </TabsTrigger>
              <TabsTrigger value="rerun">
                <History /> Re-run an earlier upload
              </TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="mt-4">
              <UploadFlow onDone={() => setOpen(false)} />
            </TabsContent>
            <TabsContent value="rerun" className="mt-4 space-y-5">
              <UploadPicker value={picked?.id ?? null} onChange={(id, opt) => setPicked({ id, opt })} />
              {picked && (
                <ResearchPlan
                  key={picked.id}
                  importId={picked.id}
                  label={picked.opt.label.split(" · ")[0]}
                  companies={picked.opt.count}
                  previousRuns={picked.opt.runs}
                  lastRunAt={picked.opt.lastRunAt}
                  onDone={() => setOpen(false)}
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
