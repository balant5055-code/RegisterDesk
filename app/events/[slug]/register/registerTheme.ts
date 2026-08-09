// registerTheme — the surface tokens for /events/[slug]/register.
//
// RD-RT4.0. Deliberately NOT a 'use client' module: the registration route has both a
// SERVER surface (the pass picker and the blocked screens in page.tsx) and a CLIENT one
// (RegisterClient and everything under it), and both must paint on the same canvas with
// the same card language. A constant exported from a 'use client' module and imported by
// a server component arrives as a client reference, not a string — so the shared values
// live here, where both sides can read them as plain values.
//
// This file holds VALUES ONLY. No components, no state, no logic.

import type { CSSProperties } from 'react'

/**
 * THE canvas colour, mixed from the two tokens the design system already owns
 * (--muted / --background), and set as a CSS variable on the outermost wrapper of every
 * screen on this route.
 *
 * It is a variable rather than a utility because one descendant needs to paint the page
 * colour on top of a card: the summary ticket's punched perforation notches. Reading the
 * same variable keeps the illusion correct without hard-coding a hex, and dark mode
 * re-mixes itself because both inputs are themed.
 */
export const CANVAS_STYLE = {
  '--rd-canvas': 'color-mix(in oklab, var(--muted) 55%, var(--background))',
} as CSSProperties

export const CANVAS = 'bg-[var(--rd-canvas)]'

/** The page container — identical measure to the event page the attendee just left. */
export const PAGE = 'mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8'

/**
 * THE panel. One radius, one hairline, one two-part shadow: a 1px contact shadow that
 * keeps the edge crisp, plus a wide, very soft ambient shadow that does the lifting.
 * A single heavy shadow reads as a drop-shadow; this reads as elevation.
 */
export const PANEL =
  'rounded-2xl border border-border/70 bg-card ' +
  'shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_18px_36px_-28px_rgb(15_23_42_/_0.28)]'

export const PANEL_HEAD = 'border-b border-border/60 px-5 py-4 sm:px-6'
export const PANEL_BODY = 'px-5 py-5 sm:px-6'

/** One focus treatment for every custom control on the route, offset onto the canvas. */
export const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--rd-canvas)]'
