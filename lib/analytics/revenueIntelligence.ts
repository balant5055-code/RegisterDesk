// RD-ANALYTICS-12-26 · revenue intelligence derivations. PURE — no Firestore, no React.
//
// ═══ THE ONE RULE ════════════════════════════════════════════════════════════
// Every function here takes figures that were ALREADY measured by a canonical reader and
// does arithmetic on them. None issues a read, none has a fallback source, and none turns an
// unmeasured input into a number. A derived figure is published only when every input was
// measured — the same discipline `netRevenuePaise` established, applied to five more.
//
// ═══ WHY THESE ARE NOT IN eventAnalytics.ts ══════════════════════════════════
// That file reads. This file computes. Keeping the arithmetic pure is what lets every branch
// below — zero denominators, unmeasured inputs, empty windows — be proven in a unit test
// without a database, which for financial arithmetic is not a nicety.

import { money, gone, type MaybeMoney } from '@/lib/finance/gatewayFee'
import { rangeLengthDays, type AnalyticsDateRange } from '@/lib/analytics/dateRange'
import { compareMetric, type ComparisonUnavailable } from '@/lib/analytics/comparison'
import { REPORTING_TZ_OFFSET_MINUTES } from '@/lib/dashboard/dailyStats'
import type { Count, RevenueIntelligence } from '@/lib/analytics/contract'

/* ─────────────────────────────────────────────────────────── time bounds */

/**
 * The instants an IST day-key range spans, for a reader that filters by timestamp.
 *
 * ═══ WHY NOT `rangeBounds` FROM lib/reports/format ═══════════════════════════
 * That helper is documented as "inclusive UTC day bounds", and Analytics windows are IST
 * day keys. Using it here would put every refund made between midnight and 05:30 IST into
 * the wrong day — precisely the boundary error the revenue audit was asked to look for.
 * The offset is imported from the one place that defines it, so `dayKey` (instant → key)
 * and this function (key → instants) cannot disagree about where a day begins.
 */
export function istRangeBounds(range: AnalyticsDateRange): { from: Date; to: Date } {
  const offsetMs = REPORTING_TZ_OFFSET_MINUTES * 60_000
  return {
    from: new Date(Date.parse(`${range.from}T00:00:00.000Z`) - offsetMs),
    to:   new Date(Date.parse(`${range.to}T23:59:59.999Z`) - offsetMs),
  }
}

/* ─────────────────────────────────────────────────────────── derivations */

/**
 * Revenue velocity: confirmed revenue in the window, per day.
 *
 * The numerator is the PERIOD figure from the daily rollups — already windowed, already
 * IST, already the number the Overview's own comparison uses — so this cannot drift from
 * the trend the reader sees beside it. Lifetime revenue is never divided by anything here.
 *
 * Integer paise per day, truncated: a velocity of ₹1,234.56/day is reported as 123456,
 * which is what every other paise figure on this payload does with a fractional result.
 */
export function revenueVelocity(
  periodRevenuePaise: number | null | undefined,
  range: AnalyticsDateRange,
): RevenueIntelligence['velocity'] {
  const windowDays = rangeLengthDays(range.from, range.to)
  if (periodRevenuePaise === null || periodRevenuePaise === undefined || windowDays === null || windowDays <= 0) {
    return { perDayPaise: gone('query_failed'), windowDays, basis: 'period_rollup_revenue_per_day' }
  }
  return {
    perDayPaise: money(Math.trunc(periodRevenuePaise / windowDays)),
    windowDays,
    basis: 'period_rollup_revenue_per_day',
  }
}

/**
 * Average order value: confirmed revenue per PAID registration.
 *
 * ═══ THE DENOMINATOR, CHOSEN AND NAMED ═══════════════════════════════════════
 * Free registrations are confirmed registrations with `amount: 0`. Dividing by all confirmed
 * registrations would count each of them as a customer who paid nothing and report a figure
 * that falls as an event gives away more places — a number that reads as "buyers are worth
 * less" when the truth is "more people came for free". Paid registrations is the population
 * that actually placed an order, and the payload says so.
 *
 * Both inputs are lifetime, so the result is lifetime. Zero paid registrations is not a
 * division: the figure is unmeasured, never Infinity and never ₹0.
 */
export function averageOrderValue(
  confirmedRevenue: MaybeMoney,
  paidRegistrations: Count,
): RevenueIntelligence['averageOrderValue'] {
  const basis = 'confirmed_revenue_per_paid_registration' as const
  if (!confirmedRevenue.ok) {
    return { paise: gone(confirmedRevenue.reason), denominator: paidRegistrations, basis }
  }
  if (paidRegistrations === null || paidRegistrations <= 0) {
    return { paise: gone('query_failed'), denominator: paidRegistrations, basis }
  }
  return {
    paise: money(Math.trunc(confirmedRevenue.paise / paidRegistrations)),
    denominator: paidRegistrations,
    basis,
  }
}

/**
 * Refund rate: completed refunds as a share of confirmed revenue, in percent.
 *
 * A share of MONEY, not of registrations — "12% of revenue went back", which is the figure
 * an organizer reconciles against. Null when either side is unmeasured, and null when
 * confirmed revenue is zero: a free event with a refund on record is not a 100% (or
 * infinite) refund rate, it is a rate with no meaningful denominator.
 */
export function refundRate(
  refunds: MaybeMoney,
  confirmedRevenue: MaybeMoney,
): RevenueIntelligence['refundRate'] {
  const basis = 'completed_refunds_over_confirmed_revenue' as const
  if (!refunds.ok || !confirmedRevenue.ok || confirmedRevenue.paise <= 0) return { pct: null, basis }
  return { pct: Math.round((refunds.paise / confirmedRevenue.paise) * 1000) / 10, basis }
}

/**
 * Refunds inside the window, with their comparison against the preceding window.
 *
 * The comparison obeys the same rule as every other one on this payload: a baseline that
 * starts before the analytics record began is refused rather than compared against, and the
 * reason travels with the metric. `compareMetric` already returns no delta for a null side,
 * so an unmeasured baseline cannot manufacture a percentage.
 */
export function refundsInPeriod(
  period:   { amount: MaybeMoney; count: Count },
  baseline: { amount: MaybeMoney; count: Count } | null,
  baselineReason: ComparisonUnavailable,
): RevenueIntelligence['refundsInPeriod'] {
  const value    = period.amount.ok ? period.amount.paise : null
  const baseVal  = baseline && baseline.amount.ok ? baseline.amount.paise : null
  return {
    amount:     period.amount,
    count:      period.count,
    comparison: compareMetric(value, baseVal, baselineReason),
    basis:      'refund_ledger_by_refund_date',
  }
}

/**
 * Ticket value at list price: confirmed revenue plus the discount that was given.
 *
 * Deliberately NOT named revenue. Confirmed revenue is what was charged; this is what would
 * have been charged without coupons, and it exists so the discount can be read as a share of
 * something. Unmeasured when the discount could not be read (F-1), so a failed coupon read
 * cannot present itself as "no discount was given".
 */
export function revenueBeforeDiscount(
  confirmedRevenue: MaybeMoney,
  discountGivenPaise: number,
  discountUnavailable: boolean,
): RevenueIntelligence['beforeDiscount'] {
  const basis = 'confirmed_revenue_plus_discount_given' as const
  const discount: MaybeMoney = discountUnavailable ? gone('query_failed') : money(discountGivenPaise)
  if (!confirmedRevenue.ok) return { paise: gone(confirmedRevenue.reason), discount, basis }
  if (!discount.ok)         return { paise: gone(discount.reason), discount, basis }
  return { paise: money(confirmedRevenue.paise + discount.paise), discount, basis }
}

/**
 * Formats a velocity for display, with its unit. `null` when unmeasured — never "₹0/day".
 */
export function displayVelocity(v: RevenueIntelligence['velocity'], inr: (paise: number) => string): string | null {
  return v.perDayPaise.ok ? `${inr(v.perDayPaise.paise)}/day` : null
}
