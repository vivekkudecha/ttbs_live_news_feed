import { Link } from "react-router-dom"
import { CalendarPlus } from "lucide-react"
import { Button } from "@/components/ui/button"

/** The one way to start research: opens the New schedule wizard page. */
export function NewScheduleButton({ label = "New schedule" }: { label?: string }) {
  return (
    <Button variant="brand" asChild>
      <Link to="/schedules/new">
        <CalendarPlus /> {label}
      </Link>
    </Button>
  )
}
