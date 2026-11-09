/**
 * Route transitions: the outgoing page fades/slides out, the incoming one fades/rises in.
 * `useOutlet()` is captured per location so the leaving page keeps rendering its own content
 * during its exit animation.
 */
import { useState } from "react"
import { useLocation, useOutlet } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"

const EASE = [0.2, 0.8, 0.2, 1] as const

function Frozen({ outlet }: { outlet: React.ReactNode }) {
  const [frozen] = useState(outlet)
  return <>{frozen}</>
}

export function PageTransition() {
  const location = useLocation()
  const outlet = useOutlet()
  // Query-string changes (filters, drawers) are not page changes: key on the path only.
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        // Transform settles to "none" at rest, so fixed/sticky children behave normally afterwards.
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE } }}
        exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease: "easeIn" } }}
      >
        <Frozen outlet={outlet} />
      </motion.div>
    </AnimatePresence>
  )
}
