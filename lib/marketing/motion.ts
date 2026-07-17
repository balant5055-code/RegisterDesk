// Phase P.1.3 — Marketing motion utilities.
//
// Shared Framer Motion variants ONLY (plain data — no components, no 'use client').
// Client section components (later phases) consume these and must respect
// prefers-reduced-motion (see REDUCED_MOTION_NOTE). Centralized so motion is
// consistent and never re-declared per section.

import type { Variants, Transition } from 'framer-motion'

/** App-wide easing curve (matches the dashboard's existing EASE). */
export const EASE = [0.22, 1, 0.36, 1] as const

export const DURATION = {
  micro:    0.15,
  entrance: 0.4,
  reveal:   0.5,
} as const

const ease = EASE as unknown as Transition['ease']

/** Fade + rise — the default reveal for headings, cards, media. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show:   { opacity: 1, y: 0, transition: { duration: DURATION.reveal, ease } },
}

/** Plain fade — for backgrounds / large media where motion should be subtle. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show:   { opacity: 1, transition: { duration: DURATION.entrance, ease } },
}

/** Parent that staggers its children's reveal. */
export const stagger: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
}

/** Standard whileInView viewport config — reveal once, when 30% visible. */
export const VIEWPORT_ONCE = { once: true, amount: 0.3 } as const

/**
 * REDUCED_MOTION_NOTE: section components must read `useReducedMotion()` from
 * framer-motion and, when true, render the final state with no y-offset / parallax
 * (apply `show` immediately, skip `hidden`). The animation budget is one hero
 * accent + reveal-on-scroll per section; never infinite loops.
 */
export const REDUCED_MOTION_NOTE = 'Honor prefers-reduced-motion via useReducedMotion().'
