'use client'

// RD-ANALYTICS-06 · the Overview's presentational vocabulary.
//
// ═══ THE DESIGN RULE THESE ENCODE ════════════════════════════════════════════
// Contrast comes from SURFACE ELEVATION and from SCALE, never from a colour field and
// never from a dark fill. A page of equal-weight cards reads flat no matter how the
// spacing is tuned, so the Overview has exactly ONE figure at real scale and everything
// else is small, dense and seamed with hairlines.
//
// ═══ AND THE DATA RULE ═══════════════════════════════════════════════════════
// Every value here is `number | null`, and null renders as an explicit unavailable mark —
// never as 0, never as "—" without a reason. The whole analytics architecture exists to
// preserve that distinction; a component that quietly coalesces would undo it at the last
// possible moment, where nobody would look for it.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import type { Delta } from '@/lib/dashboard/insights'

/** What an unmeasured value looks like. One spelling, used everywhere. */
export const UNAVAILABLE_MARK = '—'

export const nf = (n: number) => n.toLocaleString('en-IN')

/** Paise → ₹, whole rupees. Analytics never shows paise precision. */
export const inr = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
    .format(paise / 100)

/**
 * A delta chip.
 *
 * The DIRECTION is carried by an arrow glyph AND by the word in the accessible label, so
 * the meaning does not depend on colour — a red/green-only chip is invisible to a
 * red-green colour-blind reader and to anyone printing the page.
 *
 * A null `pct` renders nothing at all rather than "0%", because "up from nothing" is not a
 * percentage and `computeDelta` deliberately refuses to invent one.
 */
export function DeltaChip({ delta, className, invert }: {
  delta: Delta | null
  className?: string
  /**
   * RD-ANALYTICS-08 · the metric is one where UP is bad — cancellations, refunds.
   *
   * Only the COLOUR flips. The arrow still points the way the number moved and the label
   * still says "up", because the direction is a fact about the data; whether that fact is
   * good news is a property of the metric, and colour is the only channel that carries it.
   * Flipping the arrow instead would make the chip disagree with its own percentage.
   */
  invert?: boolean
}) {
  if (!delta || delta.pct === null) return null
  const up   = delta.direction === 'up'
  const flat = delta.direction === 'flat'
  const word = flat ? 'no change' : up ? 'up' : 'down'
  const good = invert ? !up : up
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-fs-2xs font-semibold tabular-nums',
        flat ? 'bg-muted text-muted-foreground'
             : good ? 'bg-[color:var(--success)]/[0.10] text-[color:var(--success)]'
                    : 'bg-[color:var(--destructive)]/[0.10] text-[color:var(--destructive)]',
        className,
      )}
      aria-label={`${Math.abs(delta.pct)} percent ${word} versus the previous period`}
    >
      <span aria-hidden>{flat ? '→' : up ? '↑' : '↓'}</span>
      {Math.abs(delta.pct)}%
    </span>
  )
}

/**
 * Movement WITHIN the selected window, stated beside the lifetime figure.
 *
 * ═══ WHY THIS IS SEPARATE FROM THE HEADLINE ══════════════════════════════════
 * The hero shows every confirmed registration the event has ever taken. A delta cannot
 * hang off that number: "480 ↑12%" would invite the reading that the event grew 12% —
 * when the 12% describes the last 30 days against the 30 before them, and the 480 describes
 * all time. Two different quantities, one visual unit.
 *
 * So the movement gets its own line and names its own window: how many arrived in the
 * period, and how that compares with the period before it. When there is no baseline the
 * chip is absent and the count still stands on its own.
 */
export function PeriodMovement({ value, delta, unit, windowLabel, baselineLabel, reason, invert }: {
  value: number | null
  delta: Delta | null
  unit: string
  /** Names the window itself: "last 30 days". */
  windowLabel: string
  /** Names the window before it: "the 30 days before". Kept separate because the two
   *  phrases cannot be built from one string without producing "vs previous last 30 days". */
  baselineLabel: string
  reason?: 'no_baseline' | 'outside_coverage' | 'not_measured' | 'disabled'
  /** RD-ANALYTICS-12-28 · passed straight to the chip: UP is bad for this metric. */
  invert?: boolean
}) {
  if (value === null) return null
  /**
   * A delta OBJECT is not the same thing as a showable comparison.
   *
   * `computeDelta` returns `pct: null` when the baseline was empty — "up from nothing" is
   * not a percentage — and `DeltaChip` renders nothing for it. Keying the phrase off the
   * object alone therefore printed a bare "vs the 30 days before" with no figure in front
   * of it, which is what an event with no registrations in either window looked like.
   */
  const showDelta = delta !== null && delta.pct !== null
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-fs-sm text-muted-foreground">
      <span>
        <span className="font-semibold tabular-nums text-foreground">{nf(value)}</span>
        {' '}{unit} in the {windowLabel}
      </span>
      {/* The chip and the phrase it qualifies are ONE wrapping unit: split across a line
          break, a bare "vs the 30 days before" reads as a stranded fragment. */}
      {showDelta
        ? <span className="inline-flex items-center gap-x-2">
            <DeltaChip delta={delta} invert={invert} /><span className="text-fs-xs">vs {baselineLabel}</span>
          </span>
        : reason === 'outside_coverage'
          ? <span className="text-fs-xs">no earlier period on record to compare</span>
          : null}
    </p>
  )
}

/**
 * The rail-scale version of the same idea.
 *
 * A `RailMetric` shows a LIFETIME figure, so its own `delta` slot is left unused on this
 * page — a chip there would attach a windowed percentage to an all-time number, which is
 * the exact misreading `PeriodMovement` exists to prevent. This renders the period figure
 * and its chip together inside the metric's sub-line, where the two belong to each other.
 */
export function RailMovement({ text, delta, className }: {
  text: string
  delta: Delta | null
  className?: string
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1', className)}>
      {text}
      <DeltaChip delta={delta} />
    </span>
  )
}

/**
 * The page's single dominant figure.
 *
 * One element at real scale is what stops an analytics page reading as a uniform grey
 * field. Everything else on the Overview is 11–15px; this is the exception, and there is
 * deliberately only one of it per column.
 */
export function HeroMetric({
  label, value, unavailableNote, delta, footnote,
}: {
  label: string
  /** Pre-formatted, or null when the source could not be measured. */
  value: string | null
  /** Shown INSTEAD of a figure when null — says why, not just that. */
  unavailableNote?: string
  delta?: Delta | null
  footnote?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      {value === null ? (
        <p className="mt-2 text-fs-lg font-medium text-muted-foreground">
          {UNAVAILABLE_MARK}
          <span className="ml-2 text-fs-sm font-normal">{unavailableNote ?? 'Not available'}</span>
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* `leading-none` LAST — tailwind-merge resolves last-wins by argument order, and a
              font-size utility carries its own line-height that would otherwise win. */}
          <span className={cn('font-bold tracking-tight text-foreground tabular-nums',
                              'text-[length:var(--fs-4xl)]', 'leading-none')}>
            {value}
          </span>
          {delta ? <DeltaChip delta={delta} /> : null}
        </div>
      )}
      {footnote ? <p className="mt-2 text-fs-sm text-muted-foreground">{footnote}</p> : null}
    </div>
  )
}

/**
 * A supporting figure in the stat rail.
 *
 * Deliberately NOT a card: these sit inside one composed container separated by hairlines,
 * because a row of individually-bordered boxes beside an uncarded column reads as
 * assembled from parts rather than designed.
 */
export function RailMetric({
  label, value, unavailableNote, sub, delta,
}: {
  label: string
  value: string | null
  unavailableNote?: string
  sub?: ReactNode
  delta?: Delta | null
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      {value === null ? (
        <p className="mt-1.5 text-fs-md font-medium text-muted-foreground">
          {UNAVAILABLE_MARK}
          {unavailableNote ? <span className="ml-1.5 text-fs-xs font-normal">{unavailableNote}</span> : null}
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
          <span className={cn('font-semibold text-foreground tabular-nums',
                              'text-[length:var(--fs-xl)]', 'leading-none')}>
            {value}
          </span>
          {delta ? <DeltaChip delta={delta} /> : null}
        </div>
      )}
      {sub ? <p className="mt-1.5 text-fs-xs text-muted-foreground">{sub}</p> : null}
    </div>
  )
}

/**
 * A precise capacity meter.
 *
 * Two rules that a generic progress bar gets wrong:
 *   • an event with NO capacity has no percentage — it renders as a stated absence, not
 *     as a 0% track, which would read as "nobody has registered".
 *   • the fill is clamped at 100 for WIDTH but the figure is not, so an oversubscribed
 *     event reports 104% honestly while the bar stays inside its track.
 */
export function CapacityMeter({ pct, registered, capacity }: {
  pct: number | null
  registered: number | null
  capacity: number | null
}) {
  if (capacity === null || pct === null) {
    return (
      <p className="text-fs-sm text-muted-foreground">
        Capacity not configured for this event.
      </p>
    )
  }
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn('font-semibold text-foreground tabular-nums',
                            'text-[length:var(--fs-xl)]', 'leading-none')}>{pct}%</span>
        <span className="text-fs-xs tabular-nums text-muted-foreground">
          {registered === null ? UNAVAILABLE_MARK : nf(registered)} / {nf(capacity)}
        </span>
      </div>
      <div
        className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Capacity filled: ${pct} percent`}
      >
        <div
          className="h-full rounded-full bg-[color:var(--primary)]"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  )
}

/**
 * A section shell.
 *
 * One hairline-bordered container per section, with the heading inside it — so the page is
 * a small number of composed regions rather than a scatter of floating cards.
 */
export function Section({
  title, subtitle, action, children, className,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card', className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-fs-md font-semibold text-foreground">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-fs-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

/**
 * A module that could not be loaded, said plainly.
 *
 * Distinct from "empty": empty means measured and zero, this means we could not measure.
 * The two must never look the same, which is the whole reason the contract keeps them
 * apart all the way from the aggregate that failed.
 */
export function UnavailableNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-5 py-6 text-fs-sm text-muted-foreground" role="status">
      {children}
    </p>
  )
}

/** Measured, and genuinely nothing yet. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-fs-sm text-muted-foreground">{children}</p>
}
