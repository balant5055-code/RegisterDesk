// Shared entrance-animation primitives for the auth screens (organizer + admin).
// Extracted so AuthCard/AuthFooter and the login wrappers reference ONE source
// of truth for easing and the fade-up variant — no per-page duplication.

import type { Variants } from 'framer-motion'

export const EASE = [0.22, 1, 0.36, 1] as const

// Fade + rise. Driven by a parent `stagger` container (initial="hidden"
// animate="show"); when rendered without such a parent it simply appears.
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
}
