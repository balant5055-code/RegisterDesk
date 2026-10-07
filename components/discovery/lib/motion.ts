// Typed tuple required by Framer Motion v12 — plain number[] doesn't satisfy Easing
export const CUBIC: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94]

// Hide native scrollbars on horizontally-scrolling rails
export const HIDE_SCROLLBAR = { scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties

// ─── Animation Variants ───────────────────────────────────────────────────────

export const fadeUp = {
  hidden:  { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.42, ease: CUBIC } },
}

export const staggerChildren = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.04 } },
}

/**
 * A reveal that can only ever ADD motion: its `hidden` state is fully OPAQUE.
 *
 * `fadeUp.hidden` is `opacity: 0`, which is safe on the primary grid only because that grid
 * animates on mount. Anything gated on `whileInView` must not hide itself, because an
 * IntersectionObserver does not always fire: a full-page screenshot, a print/PDF render, or a
 * viewport short enough that the element never intersects all leave the content permanently
 * invisible — measured on this page, not theorised.
 */
export const riseIn = {
  hidden:  { opacity: 1, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: CUBIC } },
}
