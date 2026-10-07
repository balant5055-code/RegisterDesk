// ─── The sports editorial system ─────────────────────────────────────────────
//
// SPORTS-ONLY. Every section of the running template is a DIFFERENT composition —
// a masthead, an index, a timeline, a story, a route, a kit, a map, a masthead
// again — but they are one design system because they share these atoms:
//
//   · one page container (the framework's EVENT_CONTAINER — the same gutter every
//     other public surface uses, so the sports page never drifts off the grid),
//   · one band rhythm (SPORTS_BAND: 40 / 48 / 72px), white on white, separated by a
//     single hairline rather than by alternating background colours,
//   · one heading pattern (eyebrow → title → optional aside on the same baseline),
//   · one label scale (OVERLINE for state, FIELD for a datum's name),
//   · one index numeral (01, 02, 03 — tabular, muted, never decorative).
//
// ═══ 2026-09-25 · THE RACE-PROGRAMME PASS (owner: "premium, compact, a sports feel") ═══
// The page now reads like the printed programme of a major marathon, in the public
// site's editorial voice. Three atoms carry it, and every band inherits them:
//   · the START GRID — the cover's bronze tick ruler (a start line seen from above) now
//     flanks every eyebrow, so the running motif repeats down the whole page;
//   · the display face set LIGHT for every band title, with a bronze rule under it —
//     the same title voice as the rest of the public site;
//   · bronze serif programme numerals (01, 02, 03) for every index.
// The band rhythm is tighter (40 / 48 / 64px) — compact, never cramped.
//
// There is no card here, and no shadow, blur, gradient surface or coloured band. The
// only gradient on the page is a live Register CTA. Nothing in this file paints a
// colour that is not a token.
//
// Directive-free: these are pure presentational pieces so Server Components can use
// them (the story, the kit, the organizer, the sponsors and the essentials are all
// server-rendered; only the genuinely interactive sections are client islands).

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { EVENT_CONTAINER, SECTION_SCROLL_MT } from '@/components/event-templates/shared/ui/framework'

/**
 * Where a hash-scrolled section lands: below the fixed site header AND the sticky
 * section tabs (2026-09-25), so a tapped link never hides its own heading. Builds on
 * the framework offset; the later arbitrary value wins in cn().
 */
export const SPORTS_SCROLL_MT = cn(SECTION_SCROLL_MT, 'scroll-mt-[calc(var(--disc-nav-h,4.5rem)+4rem)]')

/** Band rhythm — 40 / 48 / 64px. Compact (owner, 2026-09-25), still deliberate air. */
export const SPORTS_BAND = 'py-10 sm:py-12 lg:py-16'

// ═══ THE TYPE SCALE (2026-09-25, owner: "font family and size are not consistent") ═══
// Measured before this pass: big numerals in 5 size/weight pairs (24/800, 28/800,
// 32/800, 32/500, hero/800), units in 3 styles, small-caps labels at 5 trackings, item
// titles half UPPERCASE and half not, body at 12/13/14px. Every role now has ONE style:
//
//   role            family    size        weight  case / tracking
//   band title      display   40 (≤28)    300     —              (SectionHead)
//   panel title     display   24          300     —              (RailHead)
//   eyebrow         sans      11          600     UP · 0.22em    (Eyebrow)
//   label / state   sans      11          600     UP · 0.14em    FIELD · OVERLINE
//   item title      sans      15          600     —              ITEM
//   value           sans      15          600     —              VALUE
//   numeral         sans      24–hero     600     tabular        NUM
//   unit            sans      12 (15 lg)  600     UP · 0.12em    UNIT · UNIT_LG
//   body            sans      14          400     —              BODY
//   caption         sans      12          400/500 —              CAPTION
//   index           sans      12          600     tabular        INDEX (bronze)
//
// FAMILY RULE (owner): the display face is for TITLES ONLY — the cover's event name,
// SectionHead and RailHead. Nothing inside a band is set in it.

/** Small uppercase type — a state, a tier, a group. Pair with `<Rule />` in front. */
export const OVERLINE = 'flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.14em]'

/** An item's title — a race-day moment, a story point, a course fact. */
export const ITEM = 'text-fs-md font-semibold leading-snug text-hero-ink'

/** A race numeral — a distance, a price, a date. Size is set by the caller. */
export const NUM = 'font-semibold leading-none tabular-nums tracking-[-0.035em] text-hero-ink'

/** The unit beside a numeral (KM, AUG 2026). */
export const UNIT = 'text-fs-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground'
export const UNIT_LG = 'text-fs-md font-semibold uppercase tracking-[0.12em] text-muted-foreground'

/** Secondary small print — a time's end, a price under a tab, a booking note. */
export const CAPTION = 'text-fs-xs text-muted-foreground'

/** The NAME of a datum (Age, Closing, Availability, Language …). */
export const FIELD = 'text-fs-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground'

/** The VALUE of a datum. */
export const VALUE = 'text-fs-md font-semibold leading-snug text-hero-ink'

/** Body copy inside a section. */
export const BODY = 'text-fs-base leading-relaxed text-muted-foreground'

/** An index numeral: 01, 02, 03 — bronze programme figures, tabular so the column
 *  never shifts. Sans, like every inner line (the display face is for titles only). */
export const INDEX = 'text-fs-xs font-semibold tabular-nums tracking-[0.04em] text-hero-accent-rule'

/** A quiet text action: icon + word, hairline underline on hover, action ring on focus. */
export const QUIET_ACTION =
  'inline-flex h-8 items-center gap-1.5 text-fs-sm font-semibold text-foreground underline-offset-4 transition-colors hover:text-action hover:underline focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2'

/** The 24px action rule that marks a state, a group or the selected row. */
export function Rule({ className }: { className?: string }) {
  return <span aria-hidden className={cn('h-px w-6 shrink-0 bg-action', className)} />
}

/** `01` for 1. */
export const idx = (n: number) => String(n + 1).padStart(2, '0')

/**
 * One band of the page. White, hairline-separated, scroll-anchored on the id the
 * section navigation and every existing deep link already use.
 */
export function SportsSection({
  id, className, containerClassName, children,
}: {
  id?:                 string
  className?:          string
  containerClassName?: string
  children:            ReactNode
}) {
  return (
    <section id={id} className={cn(SPORTS_SCROLL_MT, SPORTS_BAND, 'border-b border-border/60 bg-background', className)}>
      <div className={cn(EVENT_CONTAINER, containerClassName)}>{children}</div>
    </section>
  )
}

/**
 * The START GRID — the cover's tick ruler, on white: a bronze major tick every third
 * mark, hairline minors between. Decorative only.
 */
export function StartGrid({ ticks = 10, className }: { ticks?: number; className?: string }) {
  return (
    <span aria-hidden className={cn('flex items-end gap-[3px]', className)}>
      {Array.from({ length: ticks }).map((_, i) => (
        <span key={i} className={cn('w-px', i % 3 === 0 ? 'h-3 bg-hero-accent-rule/80' : 'h-1.5 bg-border-strong')} />
      ))}
    </span>
  )
}

/**
 * A centred eyebrow: the word between two start grids.
 *
 *        ▏▏▎▏▏▎▏▏▎  RACE DAY  ▎▏▏▎▏▏▎▏▏
 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-center justify-center gap-3.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow", className)}>
      <StartGrid className="hidden sm:flex" />
      <span aria-hidden className="h-px w-6 bg-hero-accent-rule sm:hidden" />
      {children}
      <span aria-hidden className="h-px w-6 bg-hero-accent-rule sm:hidden" />
      <StartGrid className="hidden -scale-x-100 sm:flex" />
    </p>
  )
}

/**
 * THE heading pattern for every band: centred eyebrow, centred display title, a short
 * accent rule beneath it, then the section's own sentence on a reading measure that
 * stays centred under the title. `aside` is a state or a count and sits under the rule,
 * still centred — the page never puts a second thing on the title's baseline.
 *
 *                ──────  CHOOSE YOUR CHALLENGE  ──────
 *                    Find Your Perfect Distance
 *                              ──────
 *            Every distance offers a different experience …
 */
export function SectionHead({
  eyebrow, title, lead, aside, className,
}: {
  eyebrow:    string
  title:      string
  lead?:      ReactNode
  aside?:     ReactNode
  className?: string
}) {
  return (
    <header className={cn("text-center", className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mx-auto mt-3 max-w-[24ch] text-balance font-display text-fs-3xl font-light tracking-[-0.015em] text-hero-ink leading-[1.1] sm:text-fs-display-sm">
        {title}
      </h2>
      <span aria-hidden className="mx-auto mt-4 block h-px w-10 bg-hero-accent-rule" />
      {lead && <div className={cn("mx-auto mt-3 max-w-[62ch] text-balance", BODY)}>{lead}</div>}
      {aside && <div className="mt-4 flex justify-center">{aside}</div>}
    </header>
  )
}

/**
 * THE RAIL (2026-09-25, owner: "two columns — the right one sticky"). From lg the body
 * of the page is a wide reading column and a narrow sticky rail beside it; the rail
 * holds compact PANELS (the venue, the race kit). A panel is a hairline frame on the
 * page ground — no shadow, no fill — with a left-aligned eyebrow and a display title.
 * Scroll-anchored on the same ids the section navigation uses.
 */
export const RAIL_PANEL = 'rounded-panel border border-border/70 bg-card p-5'

export function RailHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="text-center sm:text-left">
      <p className="flex items-center justify-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow sm:justify-start">
        <span aria-hidden className="h-px w-6 bg-hero-accent-rule sm:hidden" />
        <StartGrid ticks={7} className="hidden sm:flex" />
        {eyebrow}
        <span aria-hidden className="h-px w-6 bg-hero-accent-rule sm:hidden" />
      </p>
      <h2 className="mt-1.5 font-display text-fs-xl font-light tracking-[-0.01em] text-hero-ink leading-tight">{title}</h2>
      <span aria-hidden className="mx-auto mt-2.5 block h-px w-8 bg-hero-accent-rule sm:mx-0" />
    </header>
  )
}

/**
 * A COLUMN heading — for a band split into two columns (Hosted By | Proudly Supported
 * By). Left-aligned: start grid + eyebrow, the display title (a title, so the display
 * face), a bronze rule. One step smaller than a band title, one step larger than a panel.
 */
export function ColumnHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="text-center sm:text-left">
      <p className="flex items-center justify-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow sm:justify-start">
        <span aria-hidden className="h-px w-6 bg-hero-accent-rule sm:hidden" />
        <StartGrid ticks={7} className="hidden sm:flex" />
        {eyebrow}
        <span aria-hidden className="h-px w-6 bg-hero-accent-rule sm:hidden" />
      </p>
      <h2 className="mt-2 font-display text-fs-2xl font-light tracking-[-0.01em] text-hero-ink leading-tight sm:text-fs-3xl">{title}</h2>
      <span aria-hidden className="mx-auto mt-3 block h-px w-10 bg-hero-accent-rule sm:mx-0" />
    </header>
  )
}

/** An outlined control — a contact route shown as a button, not a bare link. */
export const OUTLINE_ACTION =
  'inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border/70 bg-card px-3.5 text-fs-sm font-semibold text-hero-ink transition-colors hover:border-action/40 hover:text-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2'

/** Where the rail sticks: just under the site header, with breathing room. */
export const RAIL_STICKY = 'lg:sticky lg:top-[calc(var(--disc-nav-h,4.5rem)+1.5rem)] lg:self-start'

/**
 * Organisers sometimes paste a maps URL into the venue NAME field (this event's name
 * ends in "… Google Map - https://maps.app.goo.gl/…"). Splitting it lets the heading
 * read as a name while the link stays available as an action: nothing is dropped,
 * nothing is rewritten, and a name without a URL passes through untouched.
 */
export function splitVenueName(raw?: string): { name: string; url: string } {
  const value = (raw ?? '').trim()
  const m = /https?:\/\/\S+/.exec(value)
  if (!m) return { name: value, url: '' }
  const name = value.slice(0, m.index).replace(/[\s.,;:–—-]*(google\s*maps?|maps?\s*link|location)?[\s.,;:–—-]*$/i, '').trim()
  return { name: name || value, url: m[0] }
}
