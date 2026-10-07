// RD-ANALYTICS-08 · the Registrations module's derivations. PURE — no Firestore, no React.
//
// ═══ WHY THIS IS A MODULE AND NOT COMPONENT CODE ═════════════════════════════
// Every rule below is a statement about what the numbers MEAN, and each one has a failure
// mode that renders as a confident, wrong figure rather than as an error:
//
//   • a composition bar that reconciles to 100% while one of its states was never measured
//   • a payment split whose categories overlap, so the parts sum to more than the whole
//   • a "waitlisted: 0" row on an event whose organizer never enabled the waitlist
//   • a percentage computed against a denominator that is itself null
//
// A component can be looked at; it cannot be asserted about. Putting the arithmetic here
// means the rules are tested directly, and the UI's only job is to render what it is given.
//
// ═══ THE TWO POPULATIONS, KEPT APART ═════════════════════════════════════════
// `status` is the REGISTRATION lifecycle — confirmed / pending (awaiting approval) /
// cancelled / rejected / waitlisted. `paymentStatus` is the PAYMENT lifecycle — paid /
// not_required / pending (awaiting payment) / refund_pending / refunded. They are separate
// fields on the same document and answer different questions. RD-ANALYTICS-07 already had
// to fix one screen where both were called "Pending"; this module never merges them.

import type { AnalyticsResponse, Count, RegistrationAnalytics } from '@/lib/analytics/contract'

/** One slice of a breakdown. `value` is null when that state was not measured. */
export interface BreakdownRow {
  key:   string
  label: string
  value: Count
  /**
   * Share of the breakdown's denominator, 0–100, or null when it cannot be computed —
   * because the value is unmeasured, or because the denominator is null or zero.
   */
  pct:   number | null
  /** A stable token the UI maps to a colour. Never a colour value itself. */
  tone:  'primary' | 'warning' | 'danger' | 'neutral' | 'muted' | 'positive'
}

export interface Breakdown {
  rows: BreakdownRow[]
  /** The denominator every `pct` is taken against. Null ⇒ no percentage is offered. */
  total: Count
  /**
   * True when at least one state could not be measured.
   *
   * The bar must NOT be drawn as a complete whole in that case: the visible segments would
   * silently absorb the missing state's share and the reader would see a 100% composition
   * of a population that was never fully counted.
   */
  incomplete: boolean
  /**
   * Counts that the named states do not account for.
   *
   * Null when it cannot be computed. Non-zero means the denominator contains rows in a
   * state this breakdown does not name — reported rather than hidden, because silently
   * rescaling to the sum of the named parts is how a partial view becomes a total.
   */
  unaccounted: Count
}

/** Share of a total, or null if either side is unmeasured or the total is not positive. */
export function share(value: Count, total: Count): number | null {
  if (value === null || total === null || total <= 0) return null
  return Math.round((value / total) * 1000) / 10
}

/**
 * The registration lifecycle composition.
 *
 * ═══ THE DENOMINATOR ═════════════════════════════════════════════════════════
 * `total` — every registration in any state — and NOT the sum of the states shown. Using
 * the sum would make the bar reconcile to 100% by construction, which is precisely the
 * property that hides both an unmeasured state and a state this list does not name.
 *
 * ═══ WAITLIST ════════════════════════════════════════════════════════════════
 * Included only when the organizer enabled it. A disabled waitlist is not an empty
 * waitlist: "0 waitlisted" claims nobody queued, when in fact nobody could.
 */
export function statusComposition(
  r: RegistrationAnalytics,
  opts: { waitlistEnabled: boolean },
): Breakdown {
  const rows: BreakdownRow[] = [
    { key: 'confirmed',  label: 'Confirmed',            value: r.confirmed,  pct: null, tone: 'primary' },
    // Never bare "Pending" — see the payment split, which owns the other pending population.
    { key: 'pending',    label: 'Registration pending', value: r.pending,    pct: null, tone: 'warning' },
    { key: 'cancelled',  label: 'Cancelled',            value: r.cancelled,  pct: null, tone: 'danger'  },
    ...(opts.waitlistEnabled
      ? [{ key: 'waitlisted', label: 'Waitlisted', value: r.waitlisted, pct: null, tone: 'neutral' } as BreakdownRow]
      : []),
    { key: 'rejected',   label: 'Rejected',             value: r.rejected,   pct: null, tone: 'muted'   },
  ]
  return finalise(rows, r.total)
}

/**
 * The payment composition.
 *
 * ═══ WHY THESE CATEGORIES CANNOT DOUBLE-COUNT ════════════════════════════════
 * Every row is a distinct value of the single `paymentStatus` field, so a registration
 * belongs to exactly one. That is a property of the source, not a convention this function
 * imposes — and it is the reason a price-derived split (`amount == 0` vs `amount > 0`, which
 * `getRegistrationSplit` also offers) is NOT used here: "free" by price and "not_required"
 * by payment status are different populations, and mixing them would let one registration
 * appear in two rows.
 *
 * The denominator is again `total`, so an event with rows in a payment state this list does
 * not name reports the remainder rather than rescaling.
 */
export function paymentComposition(r: RegistrationAnalytics): Breakdown {
  const rows: BreakdownRow[] = [
    { key: 'paid',           label: 'Paid',            value: r.paid,           pct: null, tone: 'positive' },
    { key: 'free',           label: 'Free',            value: r.free,           pct: null, tone: 'neutral'  },
    // The OTHER pending population. Named for the thing that has not happened.
    { key: 'paymentPending', label: 'Awaiting payment', value: r.paymentPending, pct: null, tone: 'warning' },
    { key: 'refundPending',  label: 'Refund in progress', value: r.refundPending, pct: null, tone: 'muted' },
    { key: 'refunded',       label: 'Refunded',        value: r.refunded,       pct: null, tone: 'danger'   },
  ]
  return finalise(rows, r.total)
}

/** Attach percentages and completeness. Shared so both breakdowns obey identical rules. */
function finalise(rows: BreakdownRow[], total: Count): Breakdown {
  const incomplete = rows.some(x => x.value === null)
  const named = rows.reduce<number | null>(
    (acc, x) => (acc === null || x.value === null ? null : acc + x.value), 0)
  return {
    rows: rows.map(x => ({ ...x, pct: share(x.value, total) })),
    total,
    incomplete,
    // Only computable when every named state WAS measured — otherwise the shortfall could
    // be an unnamed state or the unmeasured one, and there is no way to tell which.
    unaccounted: named === null || total === null ? null : Math.max(0, total - named),
  }
}

/**
 * Rows a proportion bar may actually draw.
 *
 * Segments are widths, and a width is a claim about a share. Only measured, positive states
 * qualify; an unmeasured state has no width to draw and must be named in the legend
 * instead, never rendered as a zero-width segment that reads as "none of these".
 */
export function drawableSegments(b: Breakdown): { key: string; tone: BreakdownRow['tone']; pct: number }[] {
  const drawable = b.rows.filter(x => x.value !== null && x.value > 0)
  const sum = drawable.reduce((n, x) => n + (x.value ?? 0), 0)
  if (sum <= 0) return []
  // Widths are taken against the DRAWN sum so the bar fills its track, while the legend's
  // percentages remain against the real denominator. The two are different questions:
  // "how is the drawn part divided" and "what share of everything is this".
  return drawable.map(x => ({ key: x.key, tone: x.tone, pct: ((x.value ?? 0) / sum) * 100 }))
}

/**
 * Is the waitlist a real category for this event?
 *
 * Read from the resolved capability panels rather than re-derived from the registration
 * rules, so the module cannot disagree with the gate that decides whether a Waitlist panel
 * exists at all. `lib/analytics/modules.ts` already consults `eventHasWaitlist` for that.
 */
export function waitlistEnabled(data: AnalyticsResponse): boolean {
  return data.capabilities.panels.includes('waitlist')
}

/**
 * The pass/category distribution, with its basis made explicit.
 *
 * Percentages are taken against the sum of the passes shown, because that is the only
 * denominator that is true for this figure: `byPass` counts CONFIRMED registrations per
 * pass, so comparing it to `total` (every status) would report a share of a population it
 * does not measure. The caller is told the basis so it can caption the panel truthfully.
 */
export function passDistribution(r: RegistrationAnalytics): {
  rows: { label: string; value: number; pct: number | null }[]
  total: number
  basis: RegistrationAnalytics['byPassBasis']
} {
  const total = r.byPass.reduce((n, p) => n + p.value, 0)
  return {
    rows: r.byPass.map(p => ({ label: p.label, value: p.value, pct: share(p.value, total || null) })),
    total,
    basis: r.byPassBasis,
  }
}
