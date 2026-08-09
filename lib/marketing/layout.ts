// Phase P.1.3 — Marketing layout configuration.
//
// Centralizes container widths (reused from the app design system), section
// vertical rhythm, and grid presets — all Tailwind classes, no arbitrary spacing
// beyond the standardized container widths. Components read from here so layout
// stays consistent and never duplicated.

import { container } from '@/lib/ds/containers'

/** Reuse the app's canonical containers — never introduce new max-widths. */
export const MARKETING_CONTAINER = {
  page:    container.page,     // 1280px shell
  content: container.content,  // 820px prose/legal/docs
} as const
export type MarketingContainer = keyof typeof MARKETING_CONTAINER

/** Section vertical rhythm. */
export const SECTION_SPACING = {
  // One rhythm for the whole marketing site. Symmetric padding → the inter-section
  // gap is the sum of adjacent paddings: 48px + 48px = 96px between sections
  // (40px + 40px = 80px on mobile).
  default: 'py-10 lg:py-12',
  compact: 'py-8 lg:py-10',
  hero:    'pt-24 sm:pt-28 lg:pt-32 pb-16 lg:pb-24',
} as const
export type SectionSpacing = keyof typeof SECTION_SPACING

/**
 * Footer vertical rhythm — ONE scale for the whole footer.
 *
 * The footer's spacing used to be picked per element (py-12/lg:py-16, then mt-10,
 * mt-10, gap-8, gap-14, mt-3.5, space-y-0.5), so no two gaps agreed and there was
 * no way to see the intended rhythm by reading it. These five values are the whole
 * system: every zone gap is `zone`, every column gap is `columnGap`, and nothing in
 * the footer components picks a vertical value of its own.
 */
export const FOOTER_RHYTHM = {
  /** The footer band's own top/bottom padding. */
  band:      'py-14 lg:py-16',
  /** Between the four zones (brand · navigation · capabilities · bottom bar). */
  zone:      'mt-12',
  /** The navigation column grid — wider row gap than column gap, so wrapped
      columns on narrow screens read as separate blocks, not one dense mass. */
  columnGap: 'gap-x-6 gap-y-10',
  /** A column heading to its list. */
  label:     'mt-4',
  /** Between link rows within a column. */
  rows:      'space-y-1',
} as const

/** Standard grid presets for marketing layouts. */
export const GRID = {
  features:  'grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6',
  modules:   'grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6',
  solutions: 'grid gap-5 sm:grid-cols-2 lg:grid-cols-3',
  pricing:   'grid gap-5 lg:grid-cols-3',
  twoCol:    'grid gap-10 lg:grid-cols-2 lg:gap-16',
} as const
export type GridPreset = keyof typeof GRID
