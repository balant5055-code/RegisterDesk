'use client'

// RD-DASHBOARD-04 · KPI tiles.
//
// ═══ WHY THE PRIMARY THREE ARE FILLED ════════════════════════════════════════
// V1 got the hierarchy right (3 primary + 5 compact) but drew both tiers as outlined
// white cards. Correct information, no emphasis — the eye had nothing to land on, so
// a page of real numbers still read as a report.
//
// The three headline metrics now sit on a saturated fill. It is the cheapest possible
// signal for "these are the numbers that matter", and it is restricted to three by the
// `FilledTone` type — the fourth filled card would destroy the hierarchy it creates.
//
// The compact tier keeps the tinted-glyph treatment: present, scannable, quieter.
//
// ═══ THE FOUR STATES ARE UNCHANGED ═══════════════════════════════════════════
//   value · unavailable ("—" + reason) · restricted (lock) · with-context
// None may degrade to a zero, on either variant. A restricted primary card drops its
// fill deliberately — printing "Not available to your role" on a bold green panel
// reads as a value.

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Lock, Minus } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, kpiFill, ON_FILL, type AccentTone, type FilledTone } from '@/lib/dashboard/accents'
import { CardMotif, type MotifKind } from './CardMotif'
import type { Delta } from '@/lib/dashboard/insights'

export interface KpiTileProps {
  label: string
  /** Formatted value. Null when not measurable — pass `unavailable` or `restricted`. */
  value: string | null
  icon:  LucideIcon
  tone:  AccentTone
  /** The denominator or qualifier that makes the number mean something. */
  context?: string
  /** A second supporting fact, shown in the primary card's footer. */
  footer?: { icon?: LucideIcon; text: string }
  delta?: Delta | null
  deltaLabel?: string
  /** Could not be loaded. Renders an em dash and the reason — never 0. */
  unavailable?: boolean
  unavailableReason?: string
  /** The caller's role may not see this metric. */
  restricted?: boolean
  /** Decorative background figure. Absolutely positioned; never affects height. */
  motif?: MotifKind
  /**
   * What the figure MEASURES, surfaced on hover and to assistive tech.
   *
   * Two tiles on this dashboard both showed money and were both called "revenue"; a
   * legitimate difference in basis therefore read as a bug. Stating the basis where the
   * number is read is cheaper than a footnote nobody reaches.
   */
  valueTitle?: string
  href?: string
  variant?: 'primary' | 'compact'
  className?: string
}

function DeltaBadge({ delta, label, onFill }: { delta: Delta; label?: string; onFill: boolean }) {
  // A null pct means the previous period was zero. "Up ∞%" is not a statistic, so the
  // badge states only what it can defend.
  if (delta.pct === null) {
    if (delta.direction !== 'up') return null
    return (
      <span className={cn('text-fs-2xs font-medium', onFill ? ON_FILL.muted : 'text-accent-money-fg')}>
        New activity
      </span>
    )
  }

  const Icon = delta.direction === 'up' ? ArrowUpRight : delta.direction === 'down' ? ArrowDownRight : Minus

  // On a filled card the surrounding hue already carries the mood, so a second colour
  // would fight it — direction is shown by the arrow instead.
  const tone = onFill
    ? ''
    : delta.direction === 'up'   ? 'text-accent-money-fg'
    : delta.direction === 'down' ? 'text-accent-critical-fg'
    : 'text-muted-foreground'

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className={cn('inline-flex shrink-0 items-center gap-0.5 text-fs-2xs font-semibold', tone)}>
        <Icon className="size-3" aria-hidden />
        {Math.abs(delta.pct)}%
      </span>
      {label && (
        <span className={cn('truncate text-fs-2xs', onFill ? ON_FILL.muted : 'text-muted-foreground')}>
          {label}
        </span>
      )}
    </span>
  )
}

export function KpiTile({
  label, value, icon: Icon, tone, context, footer, delta, deltaLabel,
  unavailable, unavailableReason, restricted, valueTitle, motif,
  href, variant = 'compact', className,
}: KpiTileProps) {
  // ═══ THE PRIMARY TIER IS FILLED AGAIN ══════════════════════════════════════
  // An earlier pass replaced the fills with ~5% tints, and the row read as four white
  // boxes; raising the tints to ~16% got it to "light pastel", which is not the same
  // thing as premium. The gradient is what the reference actually asks for.
  //
  // It stays restricted to the PRIMARY tier. Filling the compact strip as well would
  // give nine cards the same voice and destroy the hierarchy this exists to create.
  //
  // A restricted or unavailable card drops the fill deliberately: printing "Not available
  // to your role" on a bold gradient panel reads as a value.
  const fillTone: FilledTone | null =
    variant === 'primary' && !restricted && !unavailable && (tone === 'people' || tone === 'money')
      ? tone
      : null
  const filled = fillTone !== null
  // The top hairline signals tone on a light card. On a filled one the whole card is the
  // tone, so a second rule would just be a seam.
  const accentRule = !filled && !restricted && !unavailable
  const a = accent(restricted || unavailable ? 'neutral' : tone)

  const body = (
    <>
      {/* ═══ ICON AND TITLE ON ONE ROW ══════════════════════════════════════
          The label used to sit BELOW the glyph, so every card read as an orphaned icon
          with a caption under it and the eye had to travel twice to learn what the number
          measured. One row, `items-center`, and the title takes the remaining width. */}
      <div className={cn('relative flex items-center gap-2', variant === 'primary' && 'h-8')}>
        <span
          className={cn(
            'flex shrink-0 items-center justify-center',
            // 32px on the primary tier, 28px on the compact one. The primary height is
            // what fixes the header band, and the header band is what makes all four
            // title and value baselines land on the same pixel.
            variant === 'primary' ? 'size-8 rounded-surface' : 'size-7 rounded-control',
            // Primary cards sit on a ~11% ground, so their glyph needs the SOLID chip to
            // sit on top of it rather than sink into it. The compact tier keeps the
            // quieter 50-weight tile — that is what separates the two tiers.
            filled ? ON_FILL.tile : variant === 'primary' ? a.chip : a.tile,
          )}
          aria-hidden
        >
          <Icon className={variant === 'primary' ? 'size-4' : 'size-3.5'} />
        </span>
        <span
          title={valueTitle}
          className={cn(
            // MEDIUM, not semibold. When the title, the supporting line and the footer are
            // all semibold, nothing is emphasised and the card reads as a wall — the
            // number is the only thing here that should carry weight.
            'min-w-0 flex-1 truncate',
            variant === 'primary' ? 'text-fs-xs font-medium' : 'text-fs-2xs font-semibold',
            filled ? ON_FILL.muted : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {href && !restricted && (
          <ArrowRight
            className={cn(
              'size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5',
              filled ? 'text-[color:var(--kpi-on-fill-muted)]' : 'text-muted-foreground/35',
            )}
            aria-hidden
          />
        )}
      </div>

      {restricted ? (
        <p className="relative mt-2 flex items-center gap-1.5 text-fs-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          Not available to your role
        </p>
      ) : unavailable ? (
        <>
          <p className={cn('relative mt-2 font-semibold tabular-nums leading-none text-muted-foreground/45',
            variant === 'primary' ? 'text-fs-2xl' : 'text-fs-xl')}>—</p>
          <p className="mt-0.5 truncate text-fs-2xs text-muted-foreground">
            {unavailableReason ?? "Couldn't load"}
          </p>
        </>
      ) : (
        <>
          {/* A long WORD value ("Registration closed") is far wider than a numeric one at
              the same size and dominated its row. Values over ~12 characters step down one
              notch so the four cards stay balanced; numbers are unaffected. */}
          <p className={cn(
            'relative truncate font-bold tabular-nums tracking-tight',
            // A FIXED offset from the header band, never `mt-auto`. The value is the one
            // element the eye jumps to across all four cards, so its baseline is pinned
            // rather than pushed around by however much supporting copy each card has.
            variant === 'primary' ? 'mt-3' : 'mt-2 font-semibold',
            variant === 'primary'
              ? (typeof value === 'string' && value.length > 12 ? 'text-fs-xl' : 'text-fs-2xl')
              : 'text-fs-xl',
            filled ? 'text-[color:var(--kpi-on-fill)]' : 'text-foreground',
            // ⚠ MUST come after the `text-fs-*` class. `cn` is tailwind-merge, so a later
            // font-size utility wins its paired line-height and silently drops an earlier
            // `leading-none`. That is exactly what happened here: this value rendered at
            // line-height 42px while the other three tiles — which happen to list the two
            // classes the other way round — rendered 28px, putting the row's value
            // baselines 14px out of alignment.
            'leading-none',
          )}>
            {value}
          </p>

          {/* ═══ THE SUPPORTING BLOCK ABSORBS THE SLACK ═══════════════════════
              This used to be two tight lines with `mt-auto` on the footer, which dumped
              every spare pixel into ONE gap above the divider — ~64px of vacuum on the
              cards that carry less content than the licence tile. `flex-1` puts that space
              inside the block instead, so it reads as breathing room around the number
              rather than a hole above the footer. */}
          <div className={cn(
            'relative mt-1.5 flex min-w-0 flex-col gap-0.5',
            // `justify-center` matters as much as `flex-1`. With the content pinned to the
            // top of a grown block, every spare pixel still lands in ONE gap immediately
            // above the divider — the same hole, just relocated. Centring splits it, so it
            // reads as air around the supporting lines instead.
            variant === 'primary' && 'flex-1 justify-center',
          )}>
            <div className="flex min-h-4 min-w-0 items-center gap-2">
              {delta ? <DeltaBadge delta={delta} label={deltaLabel} onFill={filled} /> : null}
              {context && !delta && (
                <span className={cn('truncate text-fs-2xs', filled && 'font-medium',
                  filled ? ON_FILL.muted : 'text-muted-foreground')}>
                  {context}
                </span>
              )}
            </div>

            {/* A tile carrying BOTH a delta and a denominator gives the denominator its
                own line rather than making the two compete for one row. */}
            {context && delta && (
              <p className={cn('truncate text-fs-2xs', filled && 'font-medium',
                filled ? ON_FILL.muted : 'text-muted-foreground')}>
                {context}
              </p>
            )}
          </div>

          {/* Footer fact, separated by a hairline — the reference's "1 upcoming ·
              0 completed" band. Only rendered when the caller has a real second fact. */}
          {footer && (
            <span className={cn(
              'relative mt-auto flex items-center gap-1.5 border-t text-fs-2xs',
              variant === 'primary' ? 'pt-2.5' : 'pt-2',
              // Weight, not size: small light type on a saturated ground fails by stroke
              // thinness before it fails by ratio, and 500 costs no vertical space.
              filled ? cn('font-medium', ON_FILL.rule, ON_FILL.muted) : 'border-border text-muted-foreground',
            )}>
              {footer.icon && <footer.icon className="size-3 shrink-0" aria-hidden />}
              <span className="truncate">{footer.text}</span>
            </span>
          )}
        </>
      )}
    </>
  )

  const shell = cn(
    'relative flex h-full min-w-0 flex-col overflow-hidden rounded-surface transition-colors',
    variant === 'primary' ? 'p-3.5' : 'p-3',
    filled
      // No border: a hairline around a saturated card reads as a seam, and the gradient
      // already separates it from the canvas. The shadow is what gives the row its lift.
      ? 'shadow-[0_6px_20px_-8px_rgb(0_0_0_/_0.28)]'
      : cn(
          // A tinted GROUND, not a white box — the compact tier's treatment.
          'border border-border',
          restricted || unavailable ? 'bg-card' : cn('bg-card', a.surface),
          href && !restricted && 'hover:border-border-strong',
        ),
    href && !restricted && 'group',
    className,
  )

  const style = filled ? kpiFill(fillTone) : undefined
  // Identical treatment to LicenseTile's rule, so the four cards read as one set.
  const rule = accentRule
    ? <span className={cn('absolute inset-x-0 top-0 h-[3px]', a.bar)} aria-hidden />
    : null

  const withRule = (
    <>
      {rule}
      {motif && <CardMotif kind={motif} onFill={filled} className={filled ? undefined : a.fg} />}
      {body}
    </>
  )

  if (href && !restricted) {
    return (
      <Link
        href={href}
        style={style}
        className={cn(shell, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40')}
      >
        {withRule}
      </Link>
    )
  }
  return <div style={style} className={shell}>{withRule}</div>
}
