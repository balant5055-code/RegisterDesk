// HeroBackground — the shared, reusable premium hero backdrop (RD-ST5.6).
//
// Replaces the photographic hero backdrop. No imagery, no canvas, no Lottie, no
// external library — three pure-CSS layers over a white base:
//
//   1. Brand orbs   — large radial gradients (~720–860px) in the RegisterDesk brand
//                     channels at 5–8% alpha. Radial gradients rather than
//                     filter: blur() on a solid circle: a gradient is rasterised once,
//                     whereas an animated blur filter re-rasterises every frame.
//   2. Mesh         — three overlapping brand radials at 4% total opacity.
//   3. Grain        — an inline SVG feTurbulence tile at 1.5% opacity.
//
// Only `transform` and `opacity` animate, so the whole field stays on the compositor.
// Motion is opt-IN behind `prefers-reduced-motion: no-preference` (see globals.css),
// matching the existing rd-aurora / rd-atmo convention — reduced-motion users get the
// identical static composition, not a degraded one.
//
// Presentational and hook-free, so it renders on the server wherever its parent does.

import { cn } from '@/lib/utils/cn'

export interface HeroBackgroundProps {
  /** Extra classes for the positioning layer (e.g. a z-index for the host stack). */
  className?: string
}

export function HeroBackground({ className }: HeroBackgroundProps) {
  return (
    <div aria-hidden className={cn('rd-hero-bg', className)}>
      <span className="rd-hero-orb rd-hero-orb--a" />
      <span className="rd-hero-orb rd-hero-orb--b" />
      <span className="rd-hero-orb rd-hero-orb--c" />
      <span className="rd-hero-mesh" />
      <span className="rd-hero-noise" />
    </div>
  )
}

/**
 * The soft radial that sits behind the registration card and draws the eye to it.
 * Render as the first child of a `relative` wrapper; the card paints over it, leaving
 * only a halo at the edges.
 */
export function HeroCardGlow({ className }: HeroBackgroundProps) {
  return <span aria-hidden className={cn('rd-hero-cardglow', className)} />
}
