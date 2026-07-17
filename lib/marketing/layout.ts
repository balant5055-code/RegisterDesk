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

/** Standard grid presets for marketing layouts. */
export const GRID = {
  features:  'grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6',
  modules:   'grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6',
  solutions: 'grid gap-5 sm:grid-cols-2 lg:grid-cols-3',
  pricing:   'grid gap-5 lg:grid-cols-3',
  twoCol:    'grid gap-10 lg:grid-cols-2 lg:gap-16',
} as const
export type GridPreset = keyof typeof GRID
