'use client'

// Shared motion-enabled anchor surface.
//
// The ONE place marketing link rows / link cards get their hover, keyboard-focus
// and press motion, driven by the centralized INTERACTION tokens. Pages pass
// their own className (layout, colors, focus ring) exactly as they would to a
// plain <a> — this owns motion and nothing else.
//
// Motion is fully suppressed under prefers-reduced-motion; the element still
// renders and still receives every CSS hover/focus style the consumer applies,
// so nothing that carries meaning depends on the animation.
//
//   <MotionLink href="mailto:…" className="group flex items-center gap-3 …">…</MotionLink>

import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import { INTERACTION } from '@/lib/marketing/motion'

export function MotionLink({ children, ...props }: HTMLMotionProps<'a'>) {
  const reduce = useReducedMotion()
  return (
    <motion.a
      whileHover={reduce ? undefined : INTERACTION.hover}
      whileFocus={reduce ? undefined : INTERACTION.focus}
      whileTap={reduce ? undefined : INTERACTION.tap}
      transition={INTERACTION.transition}
      {...props}
    >
      {children}
    </motion.a>
  )
}
