import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SheetClose } from "@/components/ui/sheet"

/** The drawer close button: top-right with the header's other controls, in theme colours. */
export function DrawerCloseButton() {
  return (
    <SheetClose asChild>
      <Button variant="outline" size="icon" className="size-8 text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-accent-foreground" aria-label="Close">
        <X />
      </Button>
    </SheetClose>
  )
}
