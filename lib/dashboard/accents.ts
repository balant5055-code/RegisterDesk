// RD-DASHBOARD-03 · The dashboard's semantic accent system.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// The previous dashboard expressed colour as inline Tailwind palette classes —
// `bg-emerald-50 text-emerald-700`, `bg-sky-50 text-sky-700`, and so on across ~20
// call sites. Three problems, and the third is the one that matters:
//
//   1. Unreadable in dark mode: a 50-weight surface glows against a dark canvas.
//   2. Untunable: changing "the green" meant finding every literal.
//   3. MEANINGLESS: nothing stopped green being revenue in one card, "healthy" in
//      another and "completed" in a third. Colour stopped being a signal and became
//      decoration — which is exactly what makes a dashboard look busy but read flat.
//
// So colour is addressed by MEANING here, never by hue. A component asks for the
// accent of *money* or *pending*, not for emerald or amber. The token layer
// (styles/tokens.css) owns what those look like, in both themes.
//
// The set is deliberately CLOSED. Six meanings plus neutral. A dashboard with
// fifteen accent colours has none.

export type AccentTone =
  | 'people'    // registrations, participants, attendees
  | 'money'     // revenue, wallet, settlement
  | 'event'     // events, schedule, capacity
  | 'verify'    // check-in, delivered, completed
  | 'pending'   // awaiting review, warnings, approaching deadlines
  | 'critical'  // blocked, failed, at capacity
  | 'neutral'   // no semantic charge

export interface AccentClasses {
  /** Icon tile: tinted surface + legible glyph. Correct on a WHITE card. */
  tile: string
  /**
   * SOLID icon chip — a bright 28px accent block with its own foreground.
   *
   * Both this and `tile` are kept, because they solve different grounds. `tile` is a
   * 50-weight swatch that reads correctly on a white card; once the card itself carries
   * a ~11% ground of the same hue, that swatch is LIGHTER than the card and the glyph
   * container reads as a hole punched in it. `chip` is what a tinted card uses.
   *
   * The foreground is per-tone rather than a blanket white: the product palette is not
   * uniform in luminance, and gold (#FFDE73) cannot carry white type at any size.
   */
  chip: string
  /** Foreground only — for a bare glyph, a dot or emphasised text. */
  fg:   string
  /**
   * BRIGHT solid fill — accent rules and progress meters only.
   *
   * Deliberately not `fg`: that value is 700-level so text clears AA on the 50-level
   * tint, and a 700 rule on a white card is what made the whole row read as muddy.
   * These are non-text fills, so they can be bright without costing any contrast.
   * Never use `bar` for text.
   */
  bar:  string
  /**
   * The card's GROUND — a ~5% tint of the same hue.
   *
   * Distinct from `tile`: that is a 50-weight swatch sized for a 28px icon container, and
   * stretched across a whole card it reads as a coloured panel rather than a white one
   * with a hint of meaning. One flat tint per card is what separates a premium dashboard
   * from a marketing tile, so there is no gradient here and no per-caller override.
   */
  surface: string
}

/**
 * Class triples per tone.
 *
 * Written as complete literals rather than composed at runtime because Tailwind
 * scans source text: `bg-accent-${tone}-bg` would never be emitted.
 */
const ACCENTS: Record<AccentTone, AccentClasses> = {
  people:   { tile: 'bg-accent-people-bg text-accent-people-fg',     fg: 'text-accent-people-fg',   bar: 'bg-accent-people-solid',   surface: 'bg-accent-people-surface', chip: 'bg-accent-people-chip text-accent-people-chip-fg'   },
  money:    { tile: 'bg-accent-money-bg text-accent-money-fg',       fg: 'text-accent-money-fg',    bar: 'bg-accent-money-solid',    surface: 'bg-accent-money-surface', chip: 'bg-accent-money-chip text-accent-money-chip-fg'    },
  event:    { tile: 'bg-accent-event-bg text-accent-event-fg',       fg: 'text-accent-event-fg',    bar: 'bg-accent-event-solid',    surface: 'bg-accent-event-surface', chip: 'bg-accent-event-chip text-accent-event-chip-fg'    },
  verify:   { tile: 'bg-accent-verify-bg text-accent-verify-fg',     fg: 'text-accent-verify-fg',   bar: 'bg-accent-verify-solid',   surface: 'bg-accent-verify-surface', chip: 'bg-accent-verify-chip text-accent-verify-chip-fg'   },
  pending:  { tile: 'bg-accent-pending-bg text-accent-pending-fg',   fg: 'text-accent-pending-fg',  bar: 'bg-accent-pending-solid',  surface: 'bg-accent-pending-surface', chip: 'bg-accent-pending-chip text-accent-pending-chip-fg'  },
  critical: { tile: 'bg-accent-critical-bg text-accent-critical-fg', fg: 'text-accent-critical-fg', bar: 'bg-accent-critical-solid', surface: 'bg-accent-critical-surface', chip: 'bg-accent-critical-chip text-accent-critical-chip-fg' },
  neutral:  { tile: 'bg-accent-neutral-bg text-accent-neutral-fg',   fg: 'text-accent-neutral-fg',  bar: 'bg-accent-neutral-solid',  surface: 'bg-accent-neutral-surface', chip: 'bg-accent-neutral-chip text-accent-neutral-chip-fg'  },
}

export function accent(tone: AccentTone): AccentClasses {
  return ACCENTS[tone]
}

/**
 * Saturated fills for the THREE primary KPI cards.
 *
 * Only three tones have one, and that is the point: a filled card is the loudest
 * element on the page, so the set is restricted to the headline metrics. Anything
 * else asking for a fill is a hierarchy mistake, and the type makes it impossible.
 *
 * Written as inline gradients rather than Tailwind classes because the stops live in
 * CSS variables that flip for dark mode — `bg-[linear-gradient(...)]` would bake the
 * light values into the class name.
 */
export type FilledTone = 'capacity' | 'people' | 'money' | 'fees'

/**
 * The gradient, plus the ink the card's whole subtree should use.
 *
 * ═══ WHY IT REDEFINES THE SEMANTIC TOKENS ════════════════════════════════════
 * The three primary cards are built from ordinary classes — `text-foreground`,
 * `text-muted-foreground`, `border-border`, `bg-muted`. Painting a gradient behind them
 * would leave every one of those dark-on-dark, and the alternative is threading an
 * `onFill` flag through ~40 elements across three components.
 *
 * Instead the card REDEFINES those four tokens for its own subtree. `text-foreground`
 * still says "the primary text colour"; on a filled card that colour is now the on-fill
 * ink. Nothing downstream changes, and a card can never end up half-converted.
 *
 * `--background` is deliberately NOT overridden: the licence card's upgrade button
 * relies on `bg-background` staying a real light surface.
 */
export function kpiFill(tone: FilledTone): React.CSSProperties {
  return {
    // A SOLID base first, then the gradient over it. The base is what guarantees a filled
    // card is never a white box: these cards draw no `bg-*` class and no border, so with
    // `background-image` alone a token that fails to resolve leaves the card transparent
    // — white text on the white canvas. Order matters; background-color paints under
    // background-image, so this costs nothing when the gradient does resolve.
    backgroundColor: `var(--kpi-${tone}-base)`,
    // The whole gradient lives in the token, not just its endpoints: the stop POSITIONS
    // are what keep the bright end off the type (see styles/tokens.css), so they have to
    // travel with the colours rather than being reassembled here.
    backgroundImage: `var(--kpi-${tone}-fill)`,
    color: `var(--kpi-${tone}-ink)`,
    // Consumed by the ON_FILL fragments below.
    '--kpi-on-fill':       `var(--kpi-${tone}-ink)`,
    '--kpi-on-fill-muted': `var(--kpi-${tone}-ink-muted)`,
    '--kpi-on-fill-tile':  `var(--kpi-${tone}-ink-tile)`,
    '--kpi-on-fill-rule':  `var(--kpi-${tone}-ink-rule)`,
    // Consumed by every plain semantic class already inside the card.
    '--foreground':        `var(--kpi-${tone}-ink)`,
    '--muted-foreground':  `var(--kpi-${tone}-ink-muted)`,
    '--border':            `var(--kpi-${tone}-ink-rule)`,
    '--muted':             `var(--kpi-${tone}-ink-tile)`,
  } as React.CSSProperties
}

/** Class fragments for content printed on a filled card. */
export const ON_FILL = {
  /** Secondary copy — labels, context lines. */
  muted: 'text-[color:var(--kpi-on-fill-muted)]',
  /**
   * The translucent icon container.
   *
   * `ring-inset` rather than `border`: a real border adds 2px to a 32px box, and the four
   * cards' header rows have to agree to the pixel for their title and value baselines to
   * line up. An inset ring draws the same hairline and occupies no space.
   */
  tile:  'bg-[color:var(--kpi-on-fill-tile)] text-[color:var(--kpi-on-fill)] ring-1 ring-inset ring-white/25',
  /** Hairline divider between the value block and the footer. */
  rule:  'border-[color:var(--kpi-on-fill-rule)]',
} as const

/**
 * Capacity fill → tone.
 *
 * The one place a number becomes a colour, so a 96%-full event reads the same amber
 * everywhere it appears. Thresholds match `NEARLY_FULL_PCT` in the insights engine —
 * the bar and the alert must agree, or the dashboard argues with itself.
 */
export function capacityTone(pct: number | null): AccentTone {
  if (pct === null) return 'neutral'
  if (pct >= 100) return 'critical'
  if (pct >= 85)  return 'pending'
  return 'verify'
}

/**
 * Registration status → tone.
 *
 * Shared by the donut, its legend and any status chip, so one status can never be
 * drawn two colours on one screen.
 */
export function statusTone(label: string): AccentTone {
  switch (label.toLowerCase()) {
    case 'confirmed':  return 'verify'
    case 'pending':    return 'pending'
    case 'waitlisted': return 'people'
    case 'cancelled':  return 'critical'
    case 'rejected':   return 'critical'
    default:           return 'neutral'
  }
}

/**
 * Hex values for the SVG chart primitives, which take colours as attributes rather
 * than classes.
 *
 * ⚠ These are the LIGHT-theme values. They are used only where an SVG cannot read a
 * CSS variable through a class; anything that can use `accent()` must, so the two
 * stay in step. Kept adjacent to the token definitions for exactly that reason.
 */
export const ACCENT_HEX: Record<AccentTone, string> = {
  people:   '#1D4ED8',
  money:    '#047857',
  event:    '#6D28D9',
  verify:   '#0F766E',
  pending:  '#B45309',
  critical: '#B91C1C',
  neutral:  '#475569',
}
