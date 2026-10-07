// RD-DASHBOARD-12 · The decorative wash behind a KPI card.
//
// ═══ IT USED TO BE LINE ART, AND THAT WAS THE PROBLEM ════════════════════════
// This component drew a large stroked figure per card — concentric rings for capacity, a
// node graph for registrations, a rising line for revenue, ledger rules for fees. Legible
// as illustration, which is exactly why it failed: a recognisable drawing behind a number
// competes with the number. Nine cards each carrying a different picture read as clutter,
// not as texture.
//
// It is now an abstract wash of soft overlapping circles. Nothing to recognise, nothing to
// read, nothing to compete with — felt rather than noticed.
//
// ═══ RADIAL GRADIENTS, NOT BLURRED DIVS ══════════════════════════════════════
// The obvious build is three absolutely-positioned circles with `blur-2xl`. That is 27
// filtered layers across nine cards, each forcing its own compositing pass, and the blur
// radius has to be retuned every time a circle changes size.
//
// A radial gradient IS a soft circle. One element per card, no filter, edges that fall off
// exactly as far as the stop says, and the shape is data rather than geometry.
//
// ═══ IT IS DECORATION, AND IT BEHAVES LIKE IT ════════════════════════════════
// `aria-hidden`, `pointer-events-none`, absolutely positioned, `inset-0` and clipped by
// the card's own `overflow-hidden`. It therefore cannot change a card's height, take
// focus, be read aloud, or intercept a click on the value above it.
//
// Opacity is fixed here rather than per-caller: a "subtle" wash that each card sets for
// itself is a wash that stops being subtle within two releases.

import { cn } from '@/lib/utils/cn'

export type MotifKind = 'capacity' | 'people' | 'revenue' | 'finance' | 'wallet' | 'time' | 'check'

/**
 * Circle placements per kind.
 *
 * The kinds no longer name a picture — they name an ARRANGEMENT. Keeping them varied stops
 * four cards in a row from carrying an identical wash, which is what makes the set read as
 * one component with different accents rather than one image repeated. Every circle is
 * anchored past an edge so the card crops it; a fully visible circle reads as a shape
 * someone placed, and the moment it does, it is an illustration again.
 *
 * Coordinates are percentages of the card, so the wash rescales with the card instead of
 * needing a breakpoint.
 */
// The third value is the FALLOFF — the stop at which the circle reaches full transparency,
// as a percentage of the gradient ray. It is not a radius: `radial-gradient(circle 62% …)`
// is invalid CSS, because a percentage size is only legal for `ellipse`, and an invalid
// size silently drops the entire declaration and paints nothing at all.
const ARRANGEMENTS: Record<MotifKind, Array<[x: string, y: string, falloff: string]>> = {
  capacity: [['84%', '102%', '72%'], ['62%', '124%', '52%'], ['106%', '10%', '48%']],
  people:   [['88%', '98%', '70%'], ['68%', '128%', '50%'], ['108%', '18%', '46%']],
  revenue:  [['86%', '108%', '74%'], ['102%', '46%', '46%'], ['66%', '130%', '44%']],
  finance:  [['92%', '100%', '70%'], ['72%', '126%', '50%'], ['112%', '22%', '44%']],
  wallet:   [['90%', '104%', '66%'], ['108%', '28%', '44%']],
  time:     [['86%', '100%', '68%'], ['110%', '34%', '42%']],
  check:    [['92%', '106%', '70%'], ['68%', '126%', '46%']],
}

/**
 * `currentColor` rather than a literal, so one gradient serves both grounds: white on a
 * saturated card, the accent's own ink on a light one. The caller sets the colour through
 * `className`; this only decides the shape.
 */
function wash(kind: MotifKind): string {
  return ARRANGEMENTS[kind]
    .map(([x, y, falloff]) => `radial-gradient(circle at ${x} ${y}, currentColor 0%, transparent ${falloff})`)
    .join(', ')
}

export function CardMotif({ kind, onFill, className }: {
  kind: MotifKind
  /**
   * The card behind this wash is a saturated gradient rather than a light tint.
   *
   * Changes both the colour and the strength: white lifts a saturated card, while on a
   * light card white would be invisible and the accent's own ink is what registers. The
   * light tier is weaker because it has far less contrast headroom to spend.
   */
  onFill?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 select-none',
        // Every circle is anchored to the right and bottom edges, so the wash is at its
        // weakest exactly where the glyph, value and labels sit. That is not only
        // composition — the verifier composites this layer over the card's own gradient
        // before scoring text contrast, and a wash that reached the type would show up
        // there as a contrast loss rather than staying invisible.
        onFill ? 'text-white opacity-[0.15]' : 'opacity-[0.08]',
        className,
      )}
      style={{ backgroundImage: wash(kind) }}
    />
  )
}
