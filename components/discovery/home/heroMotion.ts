// ─── Landing hero — the carousel's motion score ──────────────────────────────
//
// Every duration, delay and offset the hero animates with, in one file. It is separated
// from HeroCopy for a specific reason: the choreography is a set of numbers that has
// to stay in proportion, and numbers that must stay in proportion are unreadable when
// they are scattered through JSX two hundred lines apart.
//
// ═══ THE SCORE ═══════════════════════════════════════════════════════════════
// Five phases, staggered so the eye is led down the column rather than shown five things
// at once:
//
//   1  eyebrow      60ms   400ms
//   2  headline    140ms   600ms   ← the statement; longest travel, longest settle
//   3  description 220ms   500ms
//   4  indicator   240ms   300ms   (owned by HeroCopy, listed here for the timeline)
//   5  highlights  300ms   440ms   staggered 60ms apart
//
// The headline is ONE motion element, deliberately. Animating it per word or per line is
// the reflex, and it reads as a title sequence rather than as a page: an editorial hero
// reveals a whole statement, not letters arriving.
//
// Travel is always UPWARD on both enter and exit, whichever control was used.
// Direction-aware motion reads as a filmstrip being dragged; constant travel reads as one
// statement replacing another.
//
// ═══ REDUCED MOTION ══════════════════════════════════════════════════════════
// The reduced set keeps the SAME phase order and the same delays, so the composition
// still assembles in the same reading order — it simply does it with opacity alone: no
// translate, no blur. The design does not change, only the movement.

import type { Variants, TargetAndTransition, Transition } from 'framer-motion'

/** styles/tokens.css --ease-emphasized. Decelerating, no overshoot. */
export const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

const ENTER_Y = 20
const ENTER_BLUR = 7
const EXIT_Y = -16
const EXIT_BLUR = 5
const EXIT_DURATION = 0.3

/** One element's rise. `duration` is the settle; the delay comes from the parent stagger. */
const rise = (duration: number): Variants => ({
  initial: { opacity: 0, y: ENTER_Y, filter: `blur(${ENTER_BLUR}px)` },
  enter:   { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration, ease: EASE } },
  exit:    { opacity: 0, y: EXIT_Y, filter: `blur(${EXIT_BLUR}px)`, transition: { duration: EXIT_DURATION, ease: 'easeIn' } },
})

const fade = (duration: number): Variants => ({
  initial: { opacity: 0 },
  enter:   { opacity: 1, transition: { duration } },
  exit:    { opacity: 0, transition: { duration: 0.2 } },
})

/** Parent timelines. Children inherit `enter`/`exit` and are offset by the stagger. */
const copyGroup: Variants = {
  initial: {},
  enter: { transition: { delayChildren: 0.06, staggerChildren: 0.08 } },
  exit:  { transition: { staggerChildren: 0.04, staggerDirection: -1 } },
}
const highlightGroup: Variants = {
  initial: {},
  // Phase 5 starts after the description has settled, so the row reads as a footnote to
  // the statement rather than as part of it.
  enter: { transition: { delayChildren: 0.3, staggerChildren: 0.06 } },
  exit:  { transition: { staggerChildren: 0.03, staggerDirection: -1 } },
}

export interface HeroMotion {
  copyGroup: Variants
  highlightGroup: Variants
  eyebrow: Variants
  headline: Variants
  description: Variants
  highlight: Variants
  /** The indicator numeral's own small update — phase 4. It is not a variant set: the
   *  numeral has no exit (the old digit is simply replaced), so it is spread onto the
   *  element directly rather than driven by the parent timeline. */
  numeral: { initial: TargetAndTransition; animate: TargetAndTransition; transition: Transition }
}

export const HERO_MOTION: HeroMotion = {
  copyGroup,
  highlightGroup,
  eyebrow:     rise(0.4),
  headline:    rise(0.6),
  description: rise(0.5),
  highlight:   rise(0.44),
  numeral: {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay: 0.24, ease: EASE },
  },
}

export const HERO_MOTION_REDUCED: HeroMotion = {
  copyGroup,
  highlightGroup,
  eyebrow:     fade(0.3),
  headline:    fade(0.35),
  description: fade(0.3),
  highlight:   fade(0.3),
  numeral: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.2, delay: 0.2 },
  },
}
