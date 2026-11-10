import { CalendarPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScheduleDialog } from "./ScheduleDialog"

/** The one way to start research: opens the New schedule wizard. */
export function NewScheduleButton({ label = "New schedule" }: { label?: string }) {
  return (
    <ScheduleDialog
      trigger={
        <Button variant="brand">
          <CalendarPlus /> {label}
        </Button>
      }
    />
  )
}
