// RD-ANALYTICS-12-31 · the Insights Engine. PURE — no Firestore, no fetch, no React, no clock.
//
// ═══ THE ARCHITECTURE, IN ONE LINE ═══════════════════════════════════════════
//
//     AnalyticsResponse  →  buildInsights(response)  →  Insight[]
//
// Every figure an insight cites is a field of the payload the page already fetched, which
// was produced from aggregates and rollups and AUTHORIZED before any protected read. This
// module therefore reads nothing, computes no canonical metric, and decides no permission:
// a money rule finds the `revenue` key or it finds nothing, and "nothing" is the whole of
// its permission logic. A derived figure (attendance rate, AOV, a delta) is READ from the
// payload where the owning module already publishes it — never rebuilt from its inputs.
//
// ═══ WHY A RULE MAY STAY SILENT ══════════════════════════════════════════════
// The audit's (RD-ANALYTICS-12-30) whole point is that "value > 0" and "value changed" are
// not insights. A comparative rule fires only when the payload's own `ComparedMetric` has a
// delta (so a zero or unmeasured baseline, a window outside coverage, or a disabled
// comparison already produced NO delta upstream — `computeDelta` is never re-implemented
// here), AND the baseline, the absolute change and the percentage change all clear the
// documented floors below, AND the current window is fully covered. These floors are
// business floors, written down as constants and pinned by test. They are not statistical
// significance tests, and no copy produced here may claim they are.
//
// ═══ WHAT THIS MODULE SHARES WITH THE DASHBOARD ══════════════════════════════
// `lib/dashboard/insights.ts` already owns the platform's attention vocabulary and its
// capacity rule. The severity words and `NEARLY_FULL_PCT` are imported from there, not
// re-declared: one definition of "nearly full" on the whole platform.

import { NEARLY_FULL_PCT } from '@/lib/dashboard/insights'
import { COMMUNICATION_BALANCE_HREF } from '@/lib/wallet/communicationBalance'
import { ANALYTICS_ROUTE_CANONICAL, REPORTS_ROUTE_CANONICAL } from '@/lib/analytics/routes'
import { rangeLengthDays, type AnalyticsDateRange } from '@/lib/analytics/dateRange'
import { deliveryRate, unconfirmedShare } from '@/lib/analytics/communicationsModel'
import type { ComparedMetric } from '@/lib/analytics/comparison'
import type {
  AnalyticsResponse, Insight, InsightEvidence, InsightRuleId, InsightSeverity,
} from '@/lib/analytics/contract'
import type { AnalyticsModuleKey } from '@/lib/analytics/modules'

// ─── Floors ──────────────────────────────────────────────────────────────────
//
// Each constant is a documented business floor from the RD-12-30 audit (§13). Both the
// absolute and the percentage floors are required for every trend rule; the baseline floor
// is required for every comparison. Lowering one is a product decision, not a tuning knob.

/** Below this many seats / check-ins / messages in the baseline, a doubling is noise. */
export const TREND_MIN_BASELINE     = 20
/** A change must be visible in seats, not only in percent. */
export const TREND_MIN_ABS_DELTA    = 10
/** Rounding and weekly seasonality live under this. */
export const TREND_MIN_PCT          = 15
/** Promotes an informational trend to positive (up) or warning (down). */
export const TREND_STRONG_PCT       = 40
/** ₹10,000 — a percentage on small money is meaningless. */
export const MONEY_MIN_BASELINE     = 1_000_000
/** ₹2,500. */
export const MONEY_MIN_ABS_DELTA    = 250_000
/** Refund rate that warrants a look, with confirmed revenue at or above MONEY_MIN_BASELINE. */
export const REFUND_RATE_WARN_PCT   = 10
/** A single refund is not a pattern. */
export const REFUNDS_MIN_COUNT      = 3
/** Discount given as a share of value before discount. */
export const DISCOUNT_HEAVY_PCT     = 20
/** Delivery rate below this, over at least DELIVERY_MIN_KNOWN confirmed outcomes. */
export const DELIVERY_RATE_WARN_PCT = 90
export const DELIVERY_MIN_KNOWN     = 100
/** Unconfirmed share at or above this, over at least COMM_MIN_SENT sent — a missing webhook, honestly read. */
export const UNCONFIRMED_INFO_PCT   = 50
export const COMM_MIN_SENT          = 100
/** Bounces as a share of email sent, over at least COMM_MIN_SENT sent. */
export const BOUNCE_WARN_PCT        = 2
/** Confirmed registrations still awaiting arrival, once something has been scanned. */
export const AWAITING_MIN           = 100
/** Attendance below this, with at least ATTENDANCE_MIN_CONFIRMED confirmed and a scan recorded. */
export const ATTENDANCE_LOW_PCT     = 50
export const ATTENDANCE_MIN_CONFIRMED = 50
export const PENDING_BACKLOG_MIN    = 20
/** Walk-in share of at least this, over at least COMPOSITION_MIN registrations. */
export const WALKIN_SHARE_INFO_PCT  = 25
export const COMPOSITION_MIN        = 50
/** One pass holding this share of confirmed seats, with at least two passes. */
export const PASS_CONCENTRATION_PCT = 80
/** One day holding this share of the window's registrations, over at least CONCENTRATION_MIN_DAYS covered days. */
export const CONCENTRATION_DAY_PCT  = 40
export const CONCENTRATION_MIN_DAYS = 14
export const CONCENTRATION_MIN_SUM  = 50
/** The surface shows at most this many; the rest exist only as the count of what was checked. */
export const MAX_SURFACED           = 6
/** Re-exported so a consumer can see the capacity floor is the Dashboard's own. */
export { NEARLY_FULL_PCT }

// ─── Labels ──────────────────────────────────────────────────────────────────

export interface RangeLabels {
  /** "last 30 days" */
  windowLabel: string
  /** "the 30 days before" */
  baselineLabel: string
}

/** The same phrases `useAnalyticsScope` derives, so a summary and the page header agree. */
export function rangeLabels(range: AnalyticsDateRange): RangeLabels {
  const days = rangeLengthDays(range.from, range.to)
  return {
    windowLabel:   days === null ? 'selected period' : `last ${days} days`,
    baselineLabel: days === null ? 'the preceding period' : `the ${days} days before`,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const nf  = (n: number) => n.toLocaleString('en-IN')
const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, positive: 2, info: 3 }

/**
 * Rule priority INSIDE a severity: operational urgency first, then material money, then
 * supported change, then observations. Lower is earlier. Documented in the report (§9).
 */
const RULE_PRIORITY: Record<InsightRuleId, number> = {
  capacity_exceeded: 0, capacity_reached: 1, capacity_approaching: 2,
  awaiting_large: 3, pending_backlog: 4, comm_delivery_low: 5, comm_wallet_held: 6, comm_bounces: 7,
  refunds_rise: 10, refund_rate_high: 11, revenue_decline: 12,
  registrations_decline: 20, cancellations_rise: 21, checkins_decline: 22, comm_volume_decline: 23,
  revenue_growth: 30, registrations_growth: 31, checkins_growth: 32, comm_volume_growth: 33,
  attendance_low: 40, attendance_over: 41, discount_heavy: 42, comm_unconfirmed_high: 43,
  day_concentration: 50, pass_concentration: 51, source_walkin_share: 52,
}

const moduleHref = (m: AnalyticsModuleKey) => `${ANALYTICS_ROUTE_CANONICAL}/${m}`

/**
 * A comparative reading that passed the floors, or null.
 *
 * The delta is the payload's — `computeDelta` already refused a zero baseline (pct null)
 * and the producer already refused an unavailable or out-of-coverage baseline (delta
 * null). What is decided here is only whether the change is large enough to be worth a
 * card, on all three floors at once.
 */
function movement(
  m: ComparedMetric | undefined,
  floors: { minBaseline: number; minAbs: number; minPct: number },
  coveragePartial: boolean,
): { value: number; baseline: number; pct: number; abs: number; up: boolean } | null {
  if (!m || m.value === null || m.baseline === null || !m.delta || m.delta.pct === null) return null
  if (coveragePartial) return null
  if (m.baseline < floors.minBaseline) return null
  const abs = m.value - m.baseline
  if (Math.abs(abs) < floors.minAbs) return null
  if (Math.abs(m.delta.pct) < floors.minPct) return null
  return { value: m.value, baseline: m.baseline, pct: m.delta.pct, abs, up: abs > 0 }
}

const COUNT_FLOORS = { minBaseline: TREND_MIN_BASELINE, minAbs: TREND_MIN_ABS_DELTA, minPct: TREND_MIN_PCT }
const MONEY_FLOORS = { minBaseline: MONEY_MIN_BASELINE, minAbs: MONEY_MIN_ABS_DELTA, minPct: TREND_MIN_PCT }

type Ctx = {
  r: AnalyticsResponse
  labels: RangeLabels
  coverage: InsightEvidence['coverage']
  base: (field: string, window: InsightEvidence['window'], unit: InsightEvidence['unit'], value: number | null,
         thresholds: Record<string, number>, extra?: Partial<InsightEvidence>) => InsightEvidence
}

type Rule = (c: Ctx) => Omit<Insight, 'id' | 'scope'> | null

const trendCard = (
  c: Ctx, field: string, unit: 'count' | 'paise', m: ComparedMetric | undefined,
  floors: typeof COUNT_FLOORS, noun: string,
  ids: { up: InsightRuleId; down: InsightRuleId }, module: AnalyticsModuleKey,
  severityFor: (up: boolean, strong: boolean) => InsightSeverity,
  basis?: string,
): Omit<Insight, 'id' | 'scope'> | null => {
  const mv = movement(m, floors, c.coverage.partial)
  if (!mv) return null
  const strong = Math.abs(mv.pct) >= TREND_STRONG_PCT
  const fmt = unit === 'paise' ? inr : nf
  const verb = mv.up ? 'rose' : 'fell'
  return {
    rule: mv.up ? ids.up : ids.down,
    severity: severityFor(mv.up, strong),
    title: `${noun} ${verb} ${Math.abs(mv.pct)}% in the ${c.labels.windowLabel}`,
    summary: `${fmt(mv.baseline)} in ${c.labels.baselineLabel} → ${fmt(mv.value)} in the ${c.labels.windowLabel}.`,
    evidence: c.base(field, 'period', unit, mv.value, {
      minBaseline: floors.minBaseline, minAbsDelta: floors.minAbs, minPct: floors.minPct, strongPct: TREND_STRONG_PCT,
    }, { baseline: mv.baseline, delta: m!.delta, basis }),
    module,
  }
}

// ─── Rules ───────────────────────────────────────────────────────────────────
//
// Each rule reads its own fields and returns one card or null. A rule never throws for a
// missing key: absence IS the answer. Order here is not display order (see ranking).

const RULES: Rule[] = [
  // Registrations — period vs previous period, from the module's own ComparedMetric.
  c => trendCard(c, 'registrations.period.confirmed', 'count', c.r.registrations.period.confirmed, COUNT_FLOORS,
    'Confirmed registrations', { up: 'registrations_growth', down: 'registrations_decline' }, 'registrations',
    (up, strong) => (strong ? (up ? 'positive' : 'warning') : 'info')),

  c => {
    const card = trendCard(c, 'registrations.period.cancelled', 'count', c.r.registrations.period.cancelled, COUNT_FLOORS,
      'Cancellations', { up: 'cancellations_rise', down: 'cancellations_rise' }, 'registrations',
      (_up, strong) => (strong ? 'warning' : 'info'))
    // Only a RISE in cancellations is worth a card; a fall is good news nobody needs alerting to.
    if (!card || card.evidence.delta?.direction !== 'up') return null
    return { ...card, action: { label: 'Review recent cancellations', href: moduleHref('registrations') } }
  },

  // Check-ins — period vs previous, from the overview's ComparedMetric.
  c => trendCard(c, 'overview.checkedIn', 'count', c.r.overview.checkedIn, COUNT_FLOORS,
    'Check-ins', { up: 'checkins_growth', down: 'checkins_decline' }, 'operations',
    (up, strong) => (strong && up ? 'positive' : 'info')),

  // Capacity — lifetime, the Dashboard's own floor. One card: the most severe state.
  c => {
    const cap = c.r.registrations.capacity
    const pct = c.r.registrations.capacityUsedPct
    const confirmed = c.r.registrations.confirmed
    if (cap === null || cap <= 0 || pct === null || confirmed === null) return null
    const over = c.r.operations.capacity?.over === true || (c.r.registrations.remaining !== null && c.r.registrations.remaining < 0)
    const thresholds = { nearlyFullPct: NEARLY_FULL_PCT, capacity: cap }
    const base = (v: number) => c.base('registrations.capacityUsedPct', 'lifetime', 'pct', v, thresholds)
    const action = { label: 'Review capacity and waitlist settings', href: moduleHref('registrations') }
    if (over) return {
      rule: 'capacity_exceeded', severity: 'critical', module: 'registrations', action,
      title: 'Confirmed registrations exceed the configured capacity',
      summary: `${nf(confirmed)} confirmed against a capacity of ${nf(cap)} — ${nf(Math.abs(c.r.registrations.remaining ?? 0))} over, all time.`,
      evidence: base(pct),
    }
    if (pct >= 100) return {
      rule: 'capacity_reached', severity: 'critical', module: 'registrations', action,
      title: 'Capacity reached',
      summary: `${nf(confirmed)} of ${nf(cap)} seats are confirmed, all time.`,
      evidence: base(pct),
    }
    if (pct >= NEARLY_FULL_PCT) return {
      rule: 'capacity_approaching', severity: 'warning', module: 'registrations', action,
      title: `Approaching capacity — ${pct}% filled`,
      summary: `${nf(confirmed)} of ${nf(cap)} seats are confirmed, all time; ${nf(c.r.registrations.remaining ?? cap - confirmed)} remain.`,
      evidence: base(pct),
    }
    return null
  },

  // Attendance — lifetime snapshot; only once something has been scanned, so an upcoming
  // event is never told its attendance is low. There is no event instant in the payload.
  c => {
    const a = c.r.operations.attendance
    if (a.pct === null || a.confirmed === null || a.checkedIn === null) return null
    if (a.over) return {
      rule: 'attendance_over', severity: 'info', module: 'operations',
      title: 'More check-ins than confirmed registrations',
      summary: `${nf(a.checkedIn)} checked in against ${nf(a.confirmed)} confirmed — registrations cancelled after admission stay counted.`,
      evidence: c.base('operations.attendance.pct', 'lifetime', 'pct', a.pct, {}),
    }
    if (a.checkedIn <= 0 || a.confirmed < ATTENDANCE_MIN_CONFIRMED || a.pct >= ATTENDANCE_LOW_PCT) return null
    return {
      rule: 'attendance_low', severity: 'info', module: 'operations',
      title: `${a.pct}% of confirmed registrations have checked in so far`,
      summary: `${nf(a.checkedIn)} of ${nf(a.confirmed)} confirmed, all time — the rest are awaiting arrival.`,
      evidence: c.base('operations.attendance.pct', 'lifetime', 'pct', a.pct,
        { attendanceLowPct: ATTENDANCE_LOW_PCT, minConfirmed: ATTENDANCE_MIN_CONFIRMED }),
    }
  },

  c => {
    const a = c.r.operations.attendance
    if (a.awaited === null || a.checkedIn === null || a.checkedIn <= 0 || a.awaited < AWAITING_MIN) return null
    return {
      rule: 'awaiting_large', severity: 'warning', module: 'operations',
      title: `${nf(a.awaited)} confirmed registrations are awaiting arrival`,
      summary: `${nf(a.checkedIn)} have checked in so far; ${nf(a.awaited)} confirmed seats have not yet been scanned.`,
      evidence: c.base('operations.attendance.awaited', 'lifetime', 'count', a.awaited, { awaitingMin: AWAITING_MIN }),
      action: { label: 'Prepare check-in capacity for the remaining arrivals', href: moduleHref('operations') },
    }
  },

  // Revenue — every rule below reads a key that does not exist without `transactions`.
  c => trendCard(c, 'overview.revenuePaise', 'paise', c.r.overview.revenuePaise, MONEY_FLOORS,
    'Confirmed revenue', { up: 'revenue_growth', down: 'revenue_decline' }, 'revenue',
    (up, strong) => (up ? (strong ? 'positive' : 'info') : 'warning')),

  c => {
    const ri = c.r.revenue?.intelligence.refundsInPeriod
    if (!ri || ri.count === null || ri.count < REFUNDS_MIN_COUNT) return null
    const card = trendCard(c, 'revenue.intelligence.refundsInPeriod.comparison', 'paise', ri.comparison, MONEY_FLOORS,
      'Refunds', { up: 'refunds_rise', down: 'refunds_rise' }, 'revenue', () => 'warning', ri.basis)
    if (!card || card.evidence.delta?.direction !== 'up') return null
    card.evidence.thresholds.minRefundCount = REFUNDS_MIN_COUNT
    return { ...card, action: { label: 'Review recent refunds', href: REPORTS_ROUTE_CANONICAL } }
  },

  c => {
    const rr = c.r.revenue?.intelligence.refundRate
    const cr = c.r.revenue?.confirmedRevenue
    if (!rr || rr.pct === null || !cr?.ok || cr.paise < MONEY_MIN_BASELINE || rr.pct < REFUND_RATE_WARN_PCT) return null
    return {
      rule: 'refund_rate_high', severity: 'warning', module: 'revenue',
      title: `Refunds equal ${rr.pct}% of confirmed revenue`,
      summary: `Completed refunds against ${inr(cr.paise)} of confirmed revenue, all time.`,
      evidence: c.base('revenue.intelligence.refundRate.pct', 'lifetime', 'pct', rr.pct,
        { refundRateWarnPct: REFUND_RATE_WARN_PCT, minConfirmedRevenuePaise: MONEY_MIN_BASELINE }, { basis: rr.basis }),
      action: { label: 'Review recent refunds', href: REPORTS_ROUTE_CANONICAL },
    }
  },

  c => {
    const bd = c.r.revenue?.intelligence.beforeDiscount
    if (!bd || !bd.paise.ok || !bd.discount.ok || bd.paise.paise <= 0) return null
    if (!c.r.capabilities.panels.includes('coupons')) return null
    const pct = Math.round((bd.discount.paise / bd.paise.paise) * 100)
    if (pct < DISCOUNT_HEAVY_PCT) return null
    return {
      rule: 'discount_heavy', severity: 'info', module: 'revenue',
      title: `Coupons discounted ${pct}% of ticket value`,
      summary: `${inr(bd.discount.paise)} of discount given against ${inr(bd.paise.paise)} before discount, all time.`,
      evidence: c.base('revenue.intelligence.beforeDiscount.discount', 'lifetime', 'paise', bd.discount.paise,
        { discountHeavyPct: DISCOUNT_HEAVY_PCT }, { basis: bd.basis }),
    }
  },

  // Communications — the 12-28 window and the 12-11 rates, read through the module's own functions.
  c => trendCard(c, 'communications.intelligence.window.attempted', 'count', c.r.communications.intelligence.window.attempted,
    COUNT_FLOORS, 'Messages attempted', { up: 'comm_volume_growth', down: 'comm_volume_decline' }, 'communications',
    () => 'info'),

  c => {
    // One card for the worst supported channel below the floor — SMS/Push have no delivery and are skipped.
    let worst: { key: string; label: string; pct: number; denominator: number } | null = null
    for (const ch of c.r.communications.channels) {
      if (ch.support !== 'supported' || !ch.delivery) continue
      const rate = deliveryRate(ch.delivery)
      if (rate.pct === null || rate.denominator === null || rate.denominator < DELIVERY_MIN_KNOWN || rate.pct >= DELIVERY_RATE_WARN_PCT) continue
      if (!worst || rate.pct < worst.pct) worst = { key: ch.key, label: ch.label, pct: rate.pct, denominator: rate.denominator }
    }
    if (!worst) return null
    return {
      rule: 'comm_delivery_low', severity: 'warning', module: 'communications',
      title: `${worst.label} delivery rate is ${worst.pct}%`,
      summary: `Of ${nf(worst.denominator)} ${worst.label} messages with a confirmed outcome, ${worst.pct}% were delivered — all time. Timed-out sends are not counted as failures.`,
      evidence: c.base(`communications.channels[${worst.key}].delivery`, 'lifetime', 'pct', worst.pct,
        { deliveryRateWarnPct: DELIVERY_RATE_WARN_PCT, minKnownOutcomes: DELIVERY_MIN_KNOWN }),
      action: { label: 'Review recent campaign delivery performance', href: moduleHref('communications') },
    }
  },

  c => {
    let worst: { key: string; label: string; pct: number; sent: number } | null = null
    for (const ch of c.r.communications.channels) {
      if (ch.support !== 'supported' || !ch.delivery) continue
      const u = unconfirmedShare(ch.delivery)
      if (u.pct === null || u.denominator === null || u.denominator < COMM_MIN_SENT || u.pct < UNCONFIRMED_INFO_PCT) continue
      if (!worst || u.pct > worst.pct) worst = { key: ch.key, label: ch.label, pct: u.pct, sent: u.denominator }
    }
    if (!worst) return null
    return {
      rule: 'comm_unconfirmed_high', severity: 'info', module: 'communications',
      title: `${worst.pct}% of ${worst.label} messages have no delivery confirmation`,
      summary: `${nf(worst.sent)} sent, all time; a high unconfirmed share usually means provider callbacks are not reaching the platform, not that messages failed.`,
      evidence: c.base(`communications.channels[${worst.key}].delivery`, 'lifetime', 'pct', worst.pct,
        { unconfirmedInfoPct: UNCONFIRMED_INFO_PCT, minSent: COMM_MIN_SENT }),
    }
  },

  c => {
    const email = c.r.communications.channels.find(ch => ch.key === 'email')
    const sent = email?.delivery?.sent ?? null
    const b = c.r.communications.intelligence.email.bounces
    if (sent === null || b === null || sent < COMM_MIN_SENT || b <= 0) return null
    const pct = Math.round((b / sent) * 100)
    if (pct < BOUNCE_WARN_PCT) return null
    return {
      rule: 'comm_bounces', severity: 'warning', module: 'communications',
      title: `${nf(b)} email bounces — ${pct}% of email sent`,
      summary: `Reported by the email provider, all time, any bounce type. Complaints: ${c.r.communications.intelligence.email.complaints === null ? 'not measured' : nf(c.r.communications.intelligence.email.complaints)}.`,
      evidence: c.base('communications.intelligence.email.bounces', 'lifetime', 'count', b,
        { bounceWarnPct: BOUNCE_WARN_PCT, minSent: COMM_MIN_SENT }, { basis: c.r.communications.intelligence.email.basis }),
      action: { label: 'Review recent campaign delivery performance', href: moduleHref('communications') },
    }
  },

  c => {
    const w = c.r.communications.intelligence.whatsapp.walletSkipped
    if (w === null || w <= 0) return null
    return {
      rule: 'comm_wallet_held', severity: 'warning', module: 'communications',
      title: `${nf(w)} WhatsApp messages so far were not sent for lack of capacity`,
      summary: 'Never sent because neither the event’s WhatsApp capacity nor a legacy balance covered them — not a delivery failure.',
      evidence: c.base('communications.intelligence.whatsapp.walletSkipped', 'lifetime', 'count', w, { min: 1 },
        { basis: c.r.communications.intelligence.whatsapp.basis }),
      action: { label: 'Review communication usage', href: COMMUNICATION_BALANCE_HREF },
    }
  },

  // Participants (12-29) — registrations, never people.
  c => {
    const s = c.r.participants?.composition.source
    if (!s || s.online === null || s.walkin === null || s.unrecorded === null) return null
    const total = s.online + s.walkin + s.unrecorded
    if (total < COMPOSITION_MIN) return null
    const pct = Math.round((s.walkin / total) * 100)
    if (pct < WALKIN_SHARE_INFO_PCT) return null
    return {
      rule: 'source_walkin_share', severity: 'info', module: 'participants',
      title: `${pct}% of registrations were created at the gate`,
      summary: `${nf(s.walkin)} walk-in of ${nf(total)} registrations, all time.`,
      evidence: c.base('participants.composition.source.walkin', 'lifetime', 'count', s.walkin,
        { walkinShareInfoPct: WALKIN_SHARE_INFO_PCT, minRegistrations: COMPOSITION_MIN }, { basis: c.r.participants!.composition.basis }),
    }
  },

  c => {
    const mix = c.r.participants?.composition.passMix
    const confirmed = c.r.registrations.confirmed
    if (!mix || mix.length < 2 || confirmed === null || confirmed < COMPOSITION_MIN) return null
    const top = mix.reduce((a, b) => (b.sharePct > a.sharePct ? b : a))
    if (top.sharePct < PASS_CONCENTRATION_PCT || top.label === 'Other passes') return null
    return {
      rule: 'pass_concentration', severity: 'info', module: 'participants',
      title: `${top.sharePct}% of confirmed registrations are on one pass`,
      summary: `"${top.label}" holds ${nf(top.value)} of ${nf(confirmed)} confirmed registrations, all time.`,
      evidence: c.base('participants.composition.passMix', 'lifetime', 'pct', top.sharePct,
        { passConcentrationPct: PASS_CONCENTRATION_PCT, minConfirmed: COMPOSITION_MIN, minPasses: 2 }),
    }
  },

  c => {
    const p = c.r.registrations.pending
    if (p === null || p < PENDING_BACKLOG_MIN) return null
    return {
      rule: 'pending_backlog', severity: 'warning', module: 'registrations',
      title: `${nf(p)} registrations are awaiting approval`,
      summary: 'Pending registrations hold no seat until they are approved.',
      evidence: c.base('registrations.pending', 'lifetime', 'count', p, { pendingBacklogMin: PENDING_BACKLOG_MIN }),
      action: { label: 'Review pending registrations', href: moduleHref('registrations') },
    }
  },

  // Day concentration — a neutral observation over the window's own series; never "a spike".
  c => {
    const days = c.r.registrations.byDay
    if (!days || days.length < CONCENTRATION_MIN_DAYS || c.coverage.partial) return null
    const sum = days.reduce((s, d) => s + d.value, 0)
    if (sum < CONCENTRATION_MIN_SUM) return null
    const top = days.reduce((a, b) => (b.value > a.value ? b : a))
    const pct = Math.round((top.value / sum) * 100)
    if (pct < CONCENTRATION_DAY_PCT) return null
    return {
      rule: 'day_concentration', severity: 'info', module: 'registrations',
      title: `${pct}% of the ${c.labels.windowLabel}' registrations arrived on ${top.date}`,
      summary: `${nf(top.value)} of ${nf(sum)} confirmed registrations in the ${c.labels.windowLabel} came on a single day.`,
      evidence: c.base('registrations.byDay', 'period', 'count', top.value,
        { concentrationDayPct: CONCENTRATION_DAY_PCT, minCoveredDays: CONCENTRATION_MIN_DAYS, minSum: CONCENTRATION_MIN_SUM }),
    }
  },
]

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface InsightsResult {
  insights: Insight[]
  /** How many rules were evaluated — so an empty state can say what was checked. */
  evaluated: number
  /** Candidates that fired before deduplication and the cap. */
  candidates: number
}

/**
 * The engine. Deterministic, total, and O(rules): the same payload always yields the same
 * cards in the same order. A rule that throws is dropped alone — one malformed field must
 * not blank the page.
 *
 * Deduplication: one card per `evidence.field`, keeping the most severe, then the highest
 * rule priority. Ranking: severity, then rule priority, then absolute movement (larger
 * first), then id — never by text. Cap: MAX_SURFACED.
 */
export function buildInsights(r: AnalyticsResponse, labels: RangeLabels = rangeLabels(r.scope.range)): InsightsResult {
  const coverage = { partial: r.coverage.partial, since: r.coverage.since }
  const ctx: Ctx = {
    r, labels, coverage,
    base: (field, window, unit, value, thresholds, extra) => ({
      field, unit, window, range: r.scope.range, value, coverage, thresholds, ...(extra ?? {}),
    }),
  }
  const scope = { eventSlug: r.scope.eventSlug ?? '', eventId: r.scope.eventId }
  const candidates: Insight[] = []
  for (const rule of RULES) {
    let card: ReturnType<Rule> = null
    try { card = rule(ctx) } catch { card = null }
    if (!card) continue
    candidates.push({
      ...card,
      id: `${card.rule}:${scope.eventSlug}:${r.scope.range.from}:${r.scope.range.to}`,
      scope,
    })
  }

  const byField = new Map<string, Insight>()
  for (const i of candidates) {
    const cur = byField.get(i.evidence.field)
    if (!cur || compare(i, cur) < 0) byField.set(i.evidence.field, i)
  }
  const ranked = [...byField.values()].sort(compare)
  return { insights: ranked.slice(0, MAX_SURFACED), evaluated: RULES.length, candidates: candidates.length }
}

function compare(a: Insight, b: Insight): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (s !== 0) return s
  const p = RULE_PRIORITY[a.rule] - RULE_PRIORITY[b.rule]
  if (p !== 0) return p
  const ma = magnitude(a), mb = magnitude(b)
  if (ma !== mb) return mb - ma
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Absolute movement for a comparative card; the cited value otherwise. */
function magnitude(i: Insight): number {
  const e = i.evidence
  if (e.baseline !== undefined && e.baseline !== null && e.value !== null) return Math.abs(e.value - e.baseline)
  return e.value ?? 0
}

/** The number of rules the engine knows — for the empty state and the tests. */
export const RULE_COUNT = RULES.length
