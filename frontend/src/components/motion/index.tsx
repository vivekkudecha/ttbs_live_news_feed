/** Small motion building blocks shared by pages (all respect the OS "reduce motion" setting). */
import type { ReactNode } from "react"
import { motion, type HTMLMotionProps } from "motion/react"

export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const

/** Fades and rises in once when mounted. */
export function FadeIn({ delay = 0, y = 8, children, ...props }: HTMLMotionProps<"div"> & { delay?: number; y?: number; children?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT, delay }} {...props}>
      {children}
    </motion.div>
  )
}

/** Container whose <StaggerItem> children enter one after another. */
export function Stagger({ gap = 0.05, children, ...props }: HTMLMotionProps<"div"> & { gap?: number; children?: ReactNode }) {
  return (
    <motion.div initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: gap } } }} {...props}>
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children, ...props }: HTMLMotionProps<"div"> & { children?: ReactNode }) {
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } } }}
      {...props}
    >
      {children}
    </motion.div>
  )
}
