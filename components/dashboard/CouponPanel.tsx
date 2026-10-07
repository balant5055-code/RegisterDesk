'use client'

// RD-DASH-07 · Coupon performance.
//
// ═══ WHAT THIS REPLACED ══════════════════════════════════════════════════════
// Three centred numbers over a list of four rows, every row wearing the same pink bar. The
// bar was the only visual on the card and it carried no information beyond its length —
// a coupon at 300/300 and one at 132/1200 were the same colour, so the one fact worth
// scanning for (which codes have run out) was invisible.
//
// Two of the numbers were also wrong. See lib/analytics/couponPerformance for the audit:
// "active" counted one of the validator's four gates, and the discount aggregate had no
// index, so it rendered as a dash.
//
// ═══ WHAT THE CARD IS FOR ════════════════════════════════════════════════════
// "Which codes are driving registrations, how much room is left in them, and can anyone
// still use them?" — answered top to bottom.
//
//   IMPACT     redemptions, and the money they gave away.
//   STANDING   one sentence: how many codes work right now.
//   RANKING    the top codes, each with a fuel gauge and its own state.
//
// ═══ WHY A BAR HERE AND A RANKING IN EVENT PERFORMANCE ═══════════════════════
// RD-DASH-05B deleted proportional bars from Event Performance because those values span
// orders of magnitude and share no denominator. A coupon meter is a different animal: it is
// `used / limit`, a REAL denominator per row, and the reader is asking how much is left. The
// meter answers exactly that, and its colour is what turns a list into a warning.
//
// Coupons with no limit get NO bar. A share of unlimited is not 0% and not 100%; it is not a
// share at all, so nothing is drawn and the row says "No limit" instead.

import { TicketPercent } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { SectionCard } from '@/components/dashboard/SectionCard'
import { COUPON_STATE_LABEL, COUPON_STATE_ORDER, type CouponState } from '@/lib/coupons/couponState'
import type { OrganizerCouponPerformance, OrganizerCouponRow } from '@/lib/analytics/couponPerformance'

const n = (v: number) => v.toLocaleString('en-IN')
/** Whole rupees. A dashboard reads better without paise; Finance keeps the precision. */
const inr = (paise: number) => '₹' + Math.round(paise / 100).toLocaleString('en-IN')

/** How many coupons the card lists. The rest are reported as a count, never dropped silently. */
export const COUPON_ROWS_SHOWN = 5

// ─── The palette ────────────────────────────────────────────────────────────────

/**
 * A usage LEVEL — how full the coupon is — addressed by meaning, never by position.
 *
 * Deliberately separate from `CouponState`, which is a lifecycle. A coupon can be 94% used
 * and expired; those are two different facts and they get two different visual channels
 * (the meter, and the chip beside the code). Collapsing them is how "16 active coupons"
 * ended up on a card where nothing could be redeemed.
 */
type UsageLevel = 'normal' | 'high' | 'exhausted' | 'over' | 'idle'

const levelFill = (l: UsageLevel) => `var(--coupon-${l}-fill)`
const levelTint = (l: UsageLevel) => `var(--coupon-${l}-tint)`
const levelInk  = (l: UsageLevel) => `var(--coupon-${l}-ink)`
const TRACK     = 'var(--dist-track)'

/**
 * Where a coupon sits on its own gauge. PURE.
 *
 * `idle` covers both ends of "nothing to show": no limit to measure against, and a limit
 * nobody has touched. Neither is a warning, and neither should wear a warning's colour.
 */
export function usageLevel(row: Pick<OrganizerCouponRow, 'uses' | 'maxUses' | 'percentUsed' | 'exceeded'>): UsageLevel {
  if (row.maxUses === null || row.uses === 0) return 'idle'
  if (row.exceeded) return 'over'
  const pct = row.percentUsed ?? 0
  if (pct >= 100) return 'exhausted'
  if (pct >= 75)  return 'high'
  return 'normal'
}

/** What the pill on the right of a row says. Never a fabricated percentage. */
function usageLabel(row: OrganizerCouponRow): string {
  if (row.maxUses === null)  return 'No limit'
  if (row.uses === 0)        return 'Unused'
  // The TRUE percentage, including past 100. The bar width is clamped; this figure is not.
  return `${row.percentUsed}%`
}

// ─── One coupon ─────────────────────────────────────────────────────────────────

function CouponRow({ row, showEvent, showState }: {
  row: OrganizerCouponRow
  showEvent: boolean
  /** False when every listed coupon shares one state — the card says it once, above. */
  showState: boolean
}) {
  const level = usageLevel(row)
  const label = usageLabel(row)

  /**
   * The supporting line beneath the meter, assembled rather than hard-coded.
   *
   * The lifecycle is printed only when it tells the rows APART: five rows each captioned
   * "Expired", under a headline already reading "16 of 16 have expired", is five repetitions
   * of one fact.
   *
   * "Over limit" replaces "Limit reached" rather than joining it — a coupon past its cap has
   * necessarily reached it, so printing both says one thing twice. It survives on its own
   * whenever the state is something else (expired AND over, say), because being past a cap is
   * a fact an organizer needs regardless of what else is true.
   */
  const notes: Array<{ text: string; strong?: boolean; grow?: boolean }> = [
    ...(row.exceeded ? [{ text: 'Over limit', strong: true }]
      : showState ? [{ text: COUPON_STATE_LABEL[row.state], strong: row.state !== 'redeemable' }]
      : []),
    ...(row.exceeded && showState && row.state !== 'exhausted'
      ? [{ text: COUPON_STATE_LABEL[row.state], strong: true }] : []),
    ...(showEvent ? [{ text: row.eventName, grow: true }] : []),
  ]

  // The spoken sentence carries every fact the row shows, in the order it shows them, so a
  // screen reader gets the whole row rather than four disconnected numbers.
  const spoken = [
    `Coupon ${row.code}`,
    row.maxUses === null
      ? `${n(row.uses)} redemptions, no usage limit`
      : `${n(row.uses)} redemptions out of ${n(row.maxUses)}, ${row.percentUsed} percent used`,
    row.exceeded ? 'over its limit' : '',
    COUPON_STATE_LABEL[row.state],
    showEvent ? row.eventName : '',
  ].filter(Boolean).join(', ')

  return (
    <li className="py-2" role="group" aria-label={spoken}>
      <div className="flex items-baseline gap-2">
        {/* Monospace: a coupon code is a string to be READ CHARACTER BY CHARACTER and typed
            back. Proportional type makes O/0 and I/l ambiguous in exactly the place that
            matters.

            WRAPPED, never truncated. Measured at 390px: a 25-character code needs 176px into
            a 171px column, and a truncated code is one you cannot type. `break-all` is safe
            because a code has no words to break. */}
        <span className="min-w-0 flex-1 break-all font-mono text-fs-xs font-semibold text-foreground">
          {row.code}
        </span>
        <span className="shrink-0 text-fs-xs font-semibold tabular-nums text-foreground">
          {row.maxUses === null ? n(row.uses) : `${n(row.uses)} / ${n(row.maxUses)}`}
        </span>
        <span
          className="w-16 shrink-0 rounded-control py-0.5 text-center text-fs-2xs font-semibold tabular-nums"
          style={{ background: levelTint(level), color: levelInk(level) }}
        >{label}</span>
      </div>

      {/* aria-hidden: the row group already speaks every figure, so the meter would otherwise
          be announced a second time as a bare number with no unit. */}
      {row.maxUses !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-pill" style={{ background: TRACK }} aria-hidden>
          <div
            className="h-full rounded-pill"
            // WIDTH is clamped; the FIGURE above is not. A bar cannot be 104% long, but the
            // pill can and does say 104% — which is the whole point of unclamping the source.
            style={{
              width: `${Math.min(100, Math.max(row.percentUsed ?? 0, row.uses > 0 ? 2 : 0))}%`,
              backgroundImage: levelFill(level),
            }}
          />
        </div>
      )}

      {notes.length > 0 && (
        <p className="mt-1 flex items-baseline gap-1.5 text-fs-2xs text-muted-foreground">
          {notes.map((note, i) => (
            <span key={note.text} className={cn('flex items-baseline gap-1.5', note.grow ? 'min-w-0' : 'shrink-0')}>
              {/* A separator BETWEEN items, never before the first — two labels sitting side
                  by side with only whitespace between them read as one phrase. */}
              {i > 0 && <span aria-hidden>·</span>}
              <span className={cn(note.grow && 'truncate', note.strong && 'font-medium text-foreground')}>
                {note.text}
              </span>
            </span>
          ))}
        </p>
      )}
    </li>
  )
}

// ─── The card ───────────────────────────────────────────────────────────────────

export function CouponPanel({ coupons, scopeLabel, href = '/dashboard/analytics' }: {
  coupons: OrganizerCouponPerformance
  /** What this card covers — it follows the Event Selector, like every scoped panel. */
  scopeLabel: string
  href?: string
}) {
  const {
    totalCoupons, totalRedemptions, totalDiscountPaise, discountUnavailable, discountRestricted,
    redeemableCoupons, stateCounts, rows, partial, unavailable, statesPartial, spansEvents,
  } = coupons

  const shown = rows.slice(0, COUPON_ROWS_SHOWN)
  /**
   * Only worth naming the event per row when the card spans more than one.
   *
   * RD-DASH-15 · read from the resolver, which decided it over EVERY coupon it read.
   * `rows` is now capped for the wire, so deriving it here would flip the label on a
   * workspace whose top rows happen to share an event.
   */
  const showEvent = spansEvents

  /**
   * One sentence about whether the codes work — the most actionable fact on the card.
   *
   * The audited workspace is exactly why this exists: sixteen coupons, every one `active`,
   * every one past its `validUntil`. "16 active" was true of a field and false of the world.
   * This says what an attendee typing a code would actually meet.
   */
  const standing = (() => {
    if (totalCoupons === 0) return null
    // ═══ RD-DASH-15 · THIS SENTENCE IS ABOUT THE WHOLE SET ════════════════════
    // Every branch below divides a STATE count by `totalCoupons`. `totalCoupons` is
    // exact (an aggregate answers it), but the state counts cover only the coupons that
    // were read — so past the document budget "None can be redeemed right now" would be
    // a claim about thousands of coupons on the evidence of a hundred. The card says
    // what it actually knows instead.
    if (statesPartial) return `Showing the ${n(shown.length)} most redeemed of ${n(totalCoupons)} coupons.`
    if (redeemableCoupons === totalCoupons) return `All ${n(totalCoupons)} can be redeemed right now.`
    if (redeemableCoupons > 0) return `${n(redeemableCoupons)} of ${n(totalCoupons)} can be redeemed right now.`
    // Nothing works — say WHY, using the state that accounts for most of them.
    const [top] = COUPON_STATE_ORDER
      .filter(s => s !== 'redeemable' && stateCounts[s] > 0)
      .sort((a, b) => stateCounts[b] - stateCounts[a])
    const reason: Record<Exclude<CouponState, 'redeemable'>, string> = {
      exhausted: 'have reached their limit',
      expired:   'have expired',
      scheduled: 'have not started yet',
      inactive:  'are switched off',
    }
    return top
      ? `None can be redeemed right now — ${n(stateCounts[top])} of ${n(totalCoupons)} ${reason[top as Exclude<CouponState, 'redeemable'>]}.`
      : 'None can be redeemed right now.'
  })()

  return (
    <SectionCard
      title="Coupon performance"
      leading={
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent('pending').tile)} aria-hidden>
          <TicketPercent className="size-3.5" />
        </span>
      }
      href={href}
      hrefLabel="Analytics"
      className="h-full"
      bodyClassName="flex flex-col"
    >
      {/* ═══ RD-DASH-13 · READ FAILURE IS NOT AN EMPTY COLLECTION ═══════════════
          A coupon subcollection that could not be READ used to return [] and land in the
          "No coupons created yet" state below — a statement about the organizer's
          workspace made on the strength of a failed query. The two are now different
          states, and this one is announced rather than implied. */}
      {unavailable && totalCoupons === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center" role="status">
          <p className="text-fs-sm font-medium text-foreground">Coupon data unavailable</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            These coupons could not be read just now, so nothing here is shown as zero.
          </p>
        </div>
      ) : totalCoupons === 0 ? (
        // A genuine absence, not a failure and not a zero — the organizer has not made one yet.
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <p className="text-fs-sm font-medium text-foreground">No coupons created yet</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            Create a coupon on an event to start tracking redemptions and discounts.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 px-4 py-3">
          {unavailable && (
            <p role="status" className="text-fs-2xs text-muted-foreground">
              Some events&rsquo; coupons could not be read, so these counts are{' '}
              <span className="font-medium text-foreground">incomplete</span> rather than final.
            </p>
          )}
          {/* ── IMPACT ── */}
          <div>
            <div className="flex items-baseline gap-2.5">
              <span className="text-fs-2xl font-semibold tabular-nums tracking-tight text-foreground leading-none">
                {n(totalRedemptions)}
              </span>
              <span className="min-w-0 text-fs-2xs text-muted-foreground">
                redemptions across {n(totalCoupons)} {totalCoupons === 1 ? 'coupon' : 'coupons'}
              </span>
            </div>
            <p className="mt-1 text-fs-2xs text-muted-foreground">{scopeLabel} · all time</p>
          </div>

          {/* ── DISCOUNT · money, kept secondary to the activity above it ── */}
          <div className="flex items-baseline justify-between gap-3 rounded-surface px-2.5 py-2"
               style={{ background: levelTint('idle') }}>
            <span className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Discount given
            </span>
            {discountRestricted ? (
              // RD-DASH-12 · a PERMISSION decision, not a measurement failure. The server did
              // not read the aggregate at all, so there is no figure to withhold — and the
              // "missing index" copy below would be a false explanation for this state.
              <span className="shrink-0 text-fs-2xs text-muted-foreground" title="Discount totals are limited to finance roles.">
                Not available to your role
              </span>
            ) : discountUnavailable ? (
              // NEVER ₹0. A missing aggregate is an absence of measurement, and printing zero
              // there would claim the coupons cost the organizer nothing.
              <span className="shrink-0 text-fs-2xs text-muted-foreground" title="This total needs a Firestore index that is not deployed yet.">
                Unavailable
              </span>
            ) : (
              <span className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">
                {inr(totalDiscountPaise)}
              </span>
            )}
          </div>

          {/* ── STANDING ── */}
          {standing && (
            <p className="text-fs-2xs text-muted-foreground">
              <span className="font-medium text-foreground">{standing}</span>
            </p>
          )}

          {/* ── RANKING ──
                 Ordered by redemptions, descending — the resolver ranks them, and this list
                 does not re-sort. "Which codes are driving registrations" is the question, so
                 volume is the axis; usage percentage would put a 1-of-1 coupon above a
                 1,126-of-1,200 one. */}
          <ul className="divide-y divide-border/70">
            {shown.map(c => (
              <CouponRow
                key={`${c.eventSlug}:${c.code}`}
                row={c}
                showEvent={showEvent}
                // A label that is identical on every row distinguishes nothing. When the
                // listed coupons share one state the sentence above has already said it.
                showState={new Set(shown.map(r => r.state)).size > 1}
              />
            ))}
          </ul>

          {/* Says what is NOT on screen. A top-N list that does not admit it is a top-N list
              reads as the whole set. */}
          <dl className="mt-auto flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
            <dt className="truncate text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {rows.length > shown.length ? `Top ${shown.length} by redemptions` : 'Ranked by redemptions'}
            </dt>
            <dd className="shrink-0 text-fs-2xs text-muted-foreground">
              {/* RD-DASH-15 · `totalCoupons`, not `rows.length`: the rows are capped for
                  the wire and would understate the set the footer is counting. */}
              {partial ? 'most recent events' : `${n(totalCoupons)} total`}
            </dd>
          </dl>
        </div>
      )}
    </SectionCard>
  )
}
