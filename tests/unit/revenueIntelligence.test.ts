// RD-ANALYTICS-12-26 · revenue intelligence — the derivations, and the two foundation fixes.
//
// ═══ WHAT THESE GUARD AGAINST ══════════════════════════════════════════════════
// Not arithmetic. A derived financial figure fails by being CONFIDENT about something that
// was never measured: an AOV of ₹0 because nobody paid, a velocity of ₹0 because the window
// could not be read, a refund rate of 0% on a free event, a "before discount" that equals
// revenue because the discount read silently failed. Every case below is one of those.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { money, gone } from '@/lib/finance/gatewayFee'
import { presetRange, customRange } from '@/lib/analytics/dateRange'
import { dayKey, REPORTING_TZ_OFFSET_MINUTES } from '@/lib/dashboard/dailyStats'
import {
  istRangeBounds, revenueVelocity, averageOrderValue, refundRate, refundsInPeriod,
  revenueBeforeDiscount, displayVelocity,
} from '@/lib/analytics/revenueIntelligence'
import { intelligenceRows, refundIntelligence, inrPaise } from '@/lib/analytics/revenueModel'
import type { RevenueAnalytics, RevenueIntelligence } from '@/lib/analytics/contract'

const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments stripped — prose that names a thing it avoids must not fail a check about using it. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const NOW = Date.parse('2026-06-15T12:00:00Z')
const R30 = presetRange('30d', NOW)

/* ══════════════════════════════════════════════════════ F-1 · coupon false zero */

describe('F-1 · a failed coupon read is not "₹0 of discount given"', () => {
  it('the Analytics call site now flags the failure instead of substituting a measured zero', () => {
    const s = src('lib/analytics/eventAnalytics.ts')
    // The bare substitution is gone …
    expect(s).not.toContain('.catch(() => EMPTY_COUPON_PERFORMANCE)')
    // … and the replacement carries the flag, exactly as the dashboard's does.
    expect(s).toMatch(/\.catch\(\(\) => \(\{ \.\.\.EMPTY_COUPON_PERFORMANCE, discountUnavailable: true \}\)\)/)
  })

  it('the dashboard call site is unchanged and still flags too — the two now agree', () => {
    expect(src('app/api/organizer/dashboard/route.ts'))
      .toMatch(/\.catch\(\(\) => \(\{ \.\.\.EMPTY_ORGANIZER_COUPON_PERFORMANCE, unavailable: true \}\)\)/)
  })

  it('the inner reader still distinguishes a failed discount aggregate from a zero one', () => {
    const s = src('lib/analytics/couponPerformance.ts')
    expect(s).toContain('discountUnavailable = true')
    expect(s).toContain('discountUnavailable: false')
  })

  it('an unavailable discount propagates into "before discount" rather than becoming zero', () => {
    const r = revenueBeforeDiscount(money(500_000), 0, true)
    expect(r.discount.ok).toBe(false)
    expect(r.paise.ok).toBe(false)
    // The forbidden outcome: unmeasured discount presented as "no discount".
    expect(r).not.toMatchObject({ paise: { ok: true, paise: 500_000 } })
  })

  it('a legitimately zero discount IS measured, and before-discount equals revenue', () => {
    const r = revenueBeforeDiscount(money(500_000), 0, false)
    expect(r.discount).toEqual({ ok: true, paise: 0 })
    expect(r.paise).toEqual({ ok: true, paise: 500_000 })
  })
})

/* ══════════════════════════════════════════════════════ F-2 · counter decrement */

describe('F-2 · the guarded counter decrement, pinned as deliberately deferred', () => {
  const s = src('lib/firebase/firestore/registrations.ts')

  it('the guard is unchanged: non-negative invariant, decrement skipped rather than clamped', () => {
    // Pinned verbatim so a future edit is a decision, not a drift. RD-12-26 analysed the
    // alternatives (clamp, unguarded) and found none is uniformly closer to ledger truth —
    // only reconciliation is. See the implementation report, §C.
    expect(s).toContain('if (amt > 0 && currentRev >= amt)   updates.revenuePaise                = FieldValue.increment(-amt)')
  })

  it('the decrement is transactional and reads the counter inside the transaction', () => {
    // Concurrency is handled by Firestore's transaction retry, not by the guard. The guard
    // exists for DATA inconsistency, which its own comment says reconciliation heals.
    expect(s).toContain('txn.update(counterRef, updates)')
    expect(s).toContain("if (reg.status === 'confirmed')")
    expect(s).toContain('reconciliation heals any residual drift')
  })

  it('idempotency: the same transaction flips the registration out of confirmed', () => {
    // A second cancel sees status 'cancelled' and takes the non-confirmed branch, so the
    // revenue can never be decremented twice for one registration.
    expect(s).toMatch(/status:\s+'cancelled',/)
  })

  it('reconciliation for this counter exists and is scheduled', () => {
    expect(src('lib/reconciliation/events.ts')).toContain("'revenuePaise'")
    expect(src('.github/workflows/cron-maintenance.yml')).toContain('global-reconciliation')
  })

  it('Analytics does not read the counter for revenue, so it cannot inherit the drift', () => {
    const a = src('lib/analytics/eventAnalytics.ts')
    expect(a).toContain('sumConfirmedRevenueFromLedgerChecked(eventId)')
    expect(a).not.toMatch(/counter\??\.revenuePaise/)
  })
})

/* ══════════════════════════════════════════════════════ IST bounds */

describe('istRangeBounds · analytics day keys become IST instants, not UTC midnights', () => {
  it('the start of an IST day is 18:30 UTC the day before', () => {
    const { from, to } = istRangeBounds(customRange('2026-06-10', '2026-06-12')!)
    expect(from.toISOString()).toBe('2026-06-09T18:30:00.000Z')
    expect(to.toISOString()).toBe('2026-06-12T18:29:59.999Z')
  })

  it('round-trips through dayKey — the two directions share one offset', () => {
    const range = customRange('2026-01-01', '2026-01-01')!
    const { from, to } = istRangeBounds(range)
    expect(dayKey(from)).toBe('2026-01-01')
    expect(dayKey(to)).toBe('2026-01-01')
    // And one millisecond either side is the neighbouring day.
    expect(dayKey(from.getTime() - 1)).toBe('2025-12-31')
    expect(dayKey(to.getTime() + 1)).toBe('2026-01-02')
    expect(REPORTING_TZ_OFFSET_MINUTES).toBe(330)
  })

  it('does not use the UTC-bounded reports helper', () => {
    expect(code('lib/analytics/revenueIntelligence.ts')).not.toContain('rangeBounds')
    expect(code('lib/analytics/revenueIntelligence.ts')).not.toContain('lib/reports/format')
  })
})

/* ══════════════════════════════════════════════════════ velocity */

describe('revenueVelocity · period revenue per day, never lifetime', () => {
  it('divides the period figure by the window length, in integer paise', () => {
    const v = revenueVelocity(3_000_000, R30)
    expect(v.windowDays).toBe(30)
    expect(v.perDayPaise).toEqual({ ok: true, paise: 100_000 })
    expect(v.basis).toBe('period_rollup_revenue_per_day')
  })

  it('truncates a fractional paise-per-day, as every other paise figure does', () => {
    expect(revenueVelocity(1_000_001, R30).perDayPaise).toEqual({ ok: true, paise: 33_333 })
  })

  it('a measured zero period is ₹0/day, measured', () => {
    expect(revenueVelocity(0, R30).perDayPaise).toEqual({ ok: true, paise: 0 })
  })

  it('an unmeasured period is unmeasured velocity, never ₹0/day', () => {
    expect(revenueVelocity(null, R30).perDayPaise.ok).toBe(false)
    expect(revenueVelocity(undefined, R30).perDayPaise.ok).toBe(false)
    expect(displayVelocity(revenueVelocity(null, R30), inrPaise)).toBeNull()
  })

  it('a single-day window divides by one', () => {
    const one = customRange('2026-06-15', '2026-06-15')!
    expect(revenueVelocity(45_000, one)).toMatchObject({ windowDays: 1, perDayPaise: { ok: true, paise: 45_000 } })
  })

  it('a window that cannot be measured yields no velocity and says how many days it tried', () => {
    const bad = { from: '2026-06-15', to: '2026-06-10', preset: 'custom' as const }
    const v = revenueVelocity(1_000, bad)
    expect(v.perDayPaise.ok).toBe(false)
    expect(v.windowDays).toBeNull()
  })

  it('renders with its unit so it cannot be read as a total', () => {
    expect(displayVelocity(revenueVelocity(3_000_000, R30), inrPaise)).toBe('₹1,000/day')
  })
})

/* ══════════════════════════════════════════════════════ AOV */

describe('averageOrderValue · confirmed revenue per PAID registration', () => {
  it('normal: revenue over paid count, truncated to paise', () => {
    const a = averageOrderValue(money(1_000_000), 3)
    expect(a.paise).toEqual({ ok: true, paise: 333_333 })
    expect(a.denominator).toBe(3)
    expect(a.basis).toBe('confirmed_revenue_per_paid_registration')
  })

  it('zero denominator is unmeasured — never Infinity, never NaN, never ₹0', () => {
    const a = averageOrderValue(money(500_000), 0)
    expect(a.paise.ok).toBe(false)
    expect(a.denominator).toBe(0)
    expect(JSON.stringify(a)).not.toMatch(/Infinity|NaN/)
  })

  it('a free-only event has no paid registrations and therefore no AOV', () => {
    // Confirmed revenue is a measured ₹0 (the free registrations are real), but there is no
    // order to average, so the figure is absent rather than "₹0 per order".
    expect(averageOrderValue(money(0), 0).paise.ok).toBe(false)
  })

  it('a pending-only population has no paid registrations either', () => {
    expect(averageOrderValue(money(0), 0).paise.ok).toBe(false)
  })

  it('an unmeasured paid count is an unmeasured AOV', () => {
    expect(averageOrderValue(money(500_000), null).paise.ok).toBe(false)
  })

  it('unmeasured revenue propagates its reason', () => {
    const a = averageOrderValue(gone('out_of_budget'), 10)
    expect(a.paise).toEqual({ ok: false, reason: 'out_of_budget' })
  })

  it('refunds do NOT change AOV — the numerator is refund-stable by definition', () => {
    // Two events, same sales, one had a refund. AOV is what a buyer paid, not what stayed.
    expect(averageOrderValue(money(900_000), 9).paise).toEqual({ ok: true, paise: 100_000 })
  })
})

/* ══════════════════════════════════════════════════════ refund rate */

describe('refundRate · refunds as a share of confirmed revenue', () => {
  it('normal: one decimal, percent of money', () => {
    expect(refundRate(money(125_000), money(1_000_000)).pct).toBe(12.5)
  })

  it('zero refunds on real revenue is a measured 0%', () => {
    expect(refundRate(money(0), money(1_000_000)).pct).toBe(0)
  })

  it('zero confirmed revenue has no rate — not 0%, not 100%, not Infinity', () => {
    expect(refundRate(money(0), money(0)).pct).toBeNull()
    expect(refundRate(money(5_000), money(0)).pct).toBeNull()
  })

  it('either side unmeasured means no rate', () => {
    expect(refundRate(gone('out_of_budget'), money(1_000_000)).pct).toBeNull()
    expect(refundRate(money(1), gone('query_failed')).pct).toBeNull()
  })

  it('rounds rather than truncates the percentage', () => {
    expect(refundRate(money(1), money(3)).pct).toBe(33.3)
    expect(refundRate(money(2), money(3)).pct).toBe(66.7)
  })
})

/* ══════════════════════════════════════════════════════ refunds in period */

describe('refundsInPeriod · windowed refunds with a coverage-honest comparison', () => {
  it('a measured period against a measured baseline yields a delta', () => {
    const r = refundsInPeriod(
      { amount: money(20_000), count: 2 },
      { amount: money(10_000), count: 1 },
      'no_baseline',
    )
    expect(r.amount).toEqual({ ok: true, paise: 20_000 })
    expect(r.count).toBe(2)
    expect(r.comparison.delta).not.toBeNull()
    expect(r.comparison.unavailable).toBeUndefined()
  })

  it('a baseline outside coverage produces NO delta and carries the reason', () => {
    const r = refundsInPeriod({ amount: money(20_000), count: 2 }, null, 'outside_coverage')
    expect(r.comparison.delta).toBeNull()
    expect(r.comparison.unavailable).toBe('outside_coverage')
  })

  it('an unmeasured period is unmeasured, even with a measured baseline', () => {
    const r = refundsInPeriod({ amount: gone('out_of_budget'), count: 40 }, { amount: money(1), count: 1 }, 'no_baseline')
    expect(r.amount.ok).toBe(false)
    expect(r.comparison.delta).toBeNull()
    expect(r.comparison.unavailable).toBe('not_measured')
  })

  it('zero refunds against zero refunds is measured, and not a percentage', () => {
    const r = refundsInPeriod({ amount: money(0), count: 0 }, { amount: money(0), count: 0 }, 'no_baseline')
    expect(r.amount).toEqual({ ok: true, paise: 0 })
    // computeDelta refuses "up from nothing": pct is null, never +0%.
    expect(r.comparison.delta?.pct ?? null).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════ before discount */

describe('revenueBeforeDiscount · list price is not called revenue', () => {
  it('adds a measured discount to measured revenue', () => {
    const r = revenueBeforeDiscount(money(900_000), 100_000, false)
    expect(r.paise).toEqual({ ok: true, paise: 1_000_000 })
    expect(r.discount).toEqual({ ok: true, paise: 100_000 })
    expect(r.basis).toBe('confirmed_revenue_plus_discount_given')
  })

  it('unmeasured revenue propagates its reason', () => {
    expect(revenueBeforeDiscount(gone('out_of_budget'), 100, false).paise).toEqual({ ok: false, reason: 'out_of_budget' })
  })
})

/* ══════════════════════════════════════════════════════ presentation */

describe('presentation · the rows say what they were divided by', () => {
  const intelligence: RevenueIntelligence = {
    velocity: { perDayPaise: money(100_000), windowDays: 30, basis: 'period_rollup_revenue_per_day' },
    averageOrderValue: { paise: money(250_000), denominator: 40, basis: 'confirmed_revenue_per_paid_registration' },
    refundRate: { pct: 4.2, basis: 'completed_refunds_over_confirmed_revenue' },
    refundsInPeriod: { amount: money(30_000), count: 3, comparison: { value: 30_000, baseline: 20_000, delta: { pct: 50, direction: 'up' } }, basis: 'refund_ledger_by_refund_date' },
    beforeDiscount: { paise: money(1_100_000), discount: money(100_000), basis: 'confirmed_revenue_plus_discount_given' },
  }
  const revenue = { intelligence } as unknown as RevenueAnalytics

  it('AOV names its denominator in the definition', () => {
    const aov = intelligenceRows(revenue, 'last 30 days').find(r => r.key === 'aov')!
    expect(aov.definition).toContain('40 paid registrations')
    expect(aov.definition).toContain('all time')
  })

  it('velocity carries a unit suffix and the window', () => {
    const v = intelligenceRows(revenue, 'last 30 days').find(r => r.key === 'velocity')!
    expect(v.suffix).toBe('/day')
    expect(v.definition).toContain('last 30 days')
  })

  it('before-discount states the discount it added', () => {
    const b = intelligenceRows(revenue, 'w').find(r => r.key === 'beforeDiscount')!
    expect(b.definition).toContain('₹1,000')
  })

  it('an unreadable discount is said in words, not shown as zero', () => {
    const r = { intelligence: { ...intelligence, beforeDiscount: revenueBeforeDiscount(money(1), 0, true) } } as unknown as RevenueAnalytics
    const b = intelligenceRows(r, 'w').find(r => r.key === 'beforeDiscount')!
    expect(b.definition).toContain('could not be read')
    expect(b.money?.ok).toBe(false)
  })

  it('a payload without the block renders no rows — never rows claiming ₹0', () => {
    expect(intelligenceRows({} as unknown as RevenueAnalytics, 'w')).toEqual([])
    expect(refundIntelligence({} as unknown as RevenueAnalytics)).toBeNull()
  })

  it('refund rate null is passed through as null, for the UI to render as absent', () => {
    const r = { intelligence: { ...intelligence, refundRate: { pct: null, basis: 'completed_refunds_over_confirmed_revenue' as const } } } as unknown as RevenueAnalytics
    expect(refundIntelligence(r)?.ratePct).toBeNull()
  })

  it('the UI never renders a percentage for a null rate', () => {
    const ui = src('components/analytics/revenue/RevenueAnalytics.tsx')
    expect(ui).toMatch(/refunds\.ratePct === null\s*\?/)
    expect(ui).toContain('needs measured revenue above zero')
  })
})

/* ══════════════════════════════════════════════════════ contract discipline */

describe('the intelligence block obeys the payload rules', () => {
  it('is carried through normalize unchanged', () => {
    expect(src('lib/analytics/normalize.ts')).toContain('intelligence: f.intelligence')
  })

  it('is inside the financial section, so it is absent without `transactions`', () => {
    const c = src('lib/analytics/contract.ts')
    const revenueBlock = c.slice(c.indexOf('/** Financial. This whole section'), c.indexOf('export interface RevenueIntelligence'))
    expect(revenueBlock).toContain('intelligence:     RevenueIntelligence')
    expect(revenueBlock).toContain('This whole section is ABSENT without `transactions`')
  })

  it('issues no new registration scan — the refund reads are the canonical reader, windowed', () => {
    const a = code('lib/analytics/eventAnalytics.ts')
    expect(a).not.toMatch(/limit\(5001\)|limit\(10000\)/)
    // RE-ANCHORED (RD-ANALYTICS-12-32). The three windows are three in-memory derivations of
    // ONE acquisition; the windows themselves are unchanged.
    expect((a.match(/readRefundSource\(\{ organizerUid, eventSlug: eventId \}\)/g) ?? [])).toHaveLength(1)
    expect((a.match(/refundTotalsFromRead\(refundSource, \{ organizerUid, eventSlug: eventId/g) ?? [])).toHaveLength(3)
    expect(a).toContain('istRangeBounds(activeRange)')
    expect(a).toContain('istRangeBounds(priorRange)')
    // The baseline read is skipped when the baseline would be refused anyway.
    expect(a).toContain('refundSource && priorRange && !baselineOutsideCoverage')
  })

  it('every new read is gated on includeFinancial, so a denied caller costs nothing', () => {
    const a = src('lib/analytics/eventAnalytics.ts')
    // RE-ANCHORED (RD-ANALYTICS-12-32). The gate moved to the single acquisition; the two
    // derivations are gated on its result, which is null for a denied caller.
    expect(a).toMatch(/const refundSource = includeFinancial\s*\?/)
    expect(a).toMatch(/const refundsPeriod = refundSource\s*\?/)
    expect(a).toMatch(/const refundsBaseline = refundSource &&/)
  })

  it('the derivation module is pure — no database, no clock, no network', () => {
    const m = src('lib/analytics/revenueIntelligence.ts')
    for (const forbidden of ['adminDb', 'firebase', 'fetch(', 'Date.now', 'process.env', 'server-only']) {
      expect(m, forbidden).not.toContain(forbidden)
    }
  })
})
