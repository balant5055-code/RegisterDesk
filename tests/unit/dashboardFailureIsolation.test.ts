// RD-DASH-13 · FAILURE ISOLATION and the zero-vs-unavailable contract.
//
// ═══ THE RULE THIS FILE DEFENDS ══════════════════════════════════════════════
// A dashboard metric may report a zero ONLY when a zero was measured. When a read fails the
// metric must say so — as `null`, or through a companion flag the surface renders — and
// every UNRELATED metric must keep its real value.
//
// Both halves have been violated in production and both were measured:
//
//   • one failed waitlist count took `registrationTotals.confirmed` to 0 and emptied
//     Registration Status, Pass Distribution and Event Performance, while the
//     Confirmed-registrations KPI — reading the same counter document — kept its real
//     value. One screen, two answers, one of them a zero.
//   • a failed coupon read returned `[]`, and the card said "No coupons created yet".
//   • a failed today-check-in count and a genuinely unpublished event both resolved to
//     `null`, and the consumer wrote `?? 0` over both.
//
// The behavioural half is proved here with synthetic fixtures (no Firestore, no emulator).
// The route-level half — which needs a live backend to fail — is proved by the structural
// guards at the foot of this file plus the emulator matrix run during RD-DASH-13.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildDashboardAnalytics,
  type EventAnalyticsInput, type EventStatusCounts,
} from '@/lib/analytics/dashboardAnalytics'
import { resolveCheckInStatus } from '@/lib/dashboard/checkInStatus'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE   = strip(read('app/api/organizer/dashboard/route.ts'))
const ANALYT  = strip(read('lib/analytics/dashboardAnalytics.ts'))
const COUPONS = strip(read('lib/analytics/couponPerformance.ts'))
const PAGE    = strip(read('app/(dashboard)/dashboard/page.tsx'))
const CHARTS  = strip(read('components/dashboard/DashboardCharts.tsx'))
const COUPON_UI = strip(read('components/dashboard/CouponPanel.tsx'))

const status = (o: Partial<EventStatusCounts> = {}): EventStatusCounts => ({
  total: 100, confirmed: 80, pending: 5, cancelled: 10, rejected: 2, waitlisted: 3, ...o,
})
const ev = (o: Partial<EventAnalyticsInput> = {}): EventAnalyticsInput => ({
  slug: 'e1', eventName: 'Event One', status: status(),
  passConfirmed: { p1: 50, p2: 30 }, passCancelled: { p1: 6, p2: 4 },
  passValue: { p1: { salesPaise: 5000, cancelledPaise: 600 }, p2: { salesPaise: 3000, cancelledPaise: 400 } },
  passNames: { p1: 'Pass One', p2: 'Pass Two' }, statusLabel: 'Live', ...o,
})

// ─── E · a missing waitlist loses the waitlist, and nothing else ──────────────

describe('an unreadable waitlist does not cascade', () => {
  const withWaitlist    = buildDashboardAnalytics([ev()])
  const withoutWaitlist = buildDashboardAnalytics([ev({ status: status({ waitlisted: null, total: null }) })])

  it('keeps every counter-derived figure exactly as it was', () => {
    // These four come from the counter document, which the waitlist query never touches.
    for (const k of ['confirmed', 'pending', 'cancelled', 'rejected'] as const) {
      expect(withoutWaitlist.totals[k]).toBe(withWaitlist.totals[k])
    }
    expect(withoutWaitlist.totals.confirmed).toBe(80)
  })

  it('keeps Pass Distribution and Event Performance whole', () => {
    expect(withoutWaitlist.passDistribution).toEqual(withWaitlist.passDistribution)
    expect(withoutWaitlist.passTotals).toEqual(withWaitlist.passTotals)
    expect(withoutWaitlist.eventPerformance).toEqual(withWaitlist.eventPerformance)
    expect(withoutWaitlist.eventPerformanceMeta).toEqual(withWaitlist.eventPerformanceMeta)
  })

  it('reports the waitlist and the total as UNAVAILABLE, never as zero', () => {
    expect(withoutWaitlist.totals.waitlisted).toBeNull()
    expect(withoutWaitlist.totals.total).toBeNull()
    expect(withoutWaitlist.waitlistUnavailable).toBe(true)
    // The whole point: not 0.
    expect(withoutWaitlist.totals.waitlisted).not.toBe(0)
    expect(withoutWaitlist.totals.total).not.toBe(0)
  })

  it('does not claim the EVENT was unavailable', () => {
    // `statusUnavailable` means "this event contributed nothing at all". A missing waitlist
    // is not that, and conflating them is what emptied four panels.
    expect(withoutWaitlist.statusUnavailable).toBe(false)
    expect(withoutWaitlist.eventPerformance.length).toBe(1)
  })

  it('withholds every share rather than dividing by an unknown whole', () => {
    expect(withWaitlist.registrationStatus.every(r => r.share !== null)).toBe(true)
    expect(withoutWaitlist.registrationStatus.every(r => r.share === null)).toBe(true)
    // …and the rows themselves are still there, with their real counts.
    const confirmed = withoutWaitlist.registrationStatus.find(r => r.label === 'Confirmed')
    expect(confirmed?.count).toBe(80)
  })

  it('drops the Waitlisted ROW rather than printing a measured-looking 0', () => {
    expect(withoutWaitlist.registrationStatus.map(r => r.label)).not.toContain('Waitlisted')
    expect(withWaitlist.registrationStatus.map(r => r.label)).toContain('Waitlisted')
  })

  it('poisons the total for the whole scope when only ONE event is missing a waitlist', () => {
    const mixed = buildDashboardAnalytics([
      ev({ slug: 'a' }),
      ev({ slug: 'b', status: status({ waitlisted: null, total: null }) }),
    ])
    // A sum missing a part is not a smaller total — it is not a total.
    expect(mixed.totals.total).toBeNull()
    expect(mixed.totals.waitlisted).toBeNull()
    expect(mixed.totals.confirmed).toBe(160)      // …and the rest still adds up
    expect(mixed.waitlistUnavailable).toBe(true)
  })

  it('an event that failed ENTIRELY is still reported as unavailable', () => {
    const none = buildDashboardAnalytics([ev({ status: null })])
    expect(none.statusUnavailable).toBe(true)
    expect(none.totals.confirmed).toBe(0)   // nothing was contributed — a structural zero
  })
})

// ─── §4 · the figures the client used to compute ──────────────────────────────

describe('business arithmetic is resolved server-side', () => {
  it('pass totals are summed over EVERY pass, including the folded remainder', () => {
    const a = buildDashboardAnalytics([ev()])
    expect(a.passTotals.confirmed).toBe(a.passDistribution.reduce((t, p) => t + p.count, 0))
    expect(a.passTotals.cancelled).toBe(a.passDistribution.reduce((t, p) => t + p.cancelled, 0))
    expect(a.passTotals.confirmed).toBe(80)
    expect(a.passTotals.cancelled).toBe(10)
  })

  it('withholds the money total the moment ANY contributing pass is unmeasured', () => {
    const measured   = buildDashboardAnalytics([ev()])
    expect(measured.passTotals.salesPaise).toBe(8000)
    const unmeasured = buildDashboardAnalytics([ev({ passValue: null })])
    // Null, not a smaller number — an understatement presented confidently is the failure.
    expect(unmeasured.passTotals.salesPaise).toBeNull()
    expect(unmeasured.passValueUnavailable).toBe(true)
  })

  it('shares are taken against the authoritative total and sum to 100', () => {
    const a = buildDashboardAnalytics([ev()])
    const sum = a.registrationStatus.reduce((t, r) => t + (r.share ?? 0), 0)
    expect(Math.round(sum)).toBe(100)
    expect(a.registrationStatus.find(r => r.label === 'Confirmed')?.share).toBeCloseTo(80, 5)
  })

  it('claims no share when the denominator is zero', () => {
    const empty = buildDashboardAnalytics([ev({
      status: status({ total: 0, confirmed: 0, pending: 0, cancelled: 0, rejected: 0, waitlisted: 0 }),
      passConfirmed: {}, passCancelled: {}, passValue: {},
    })])
    expect(empty.registrationStatus).toEqual([])
  })

  it('the panel no longer divides, and the page no longer computes a check-in rate', () => {
    expect(CHARTS).not.toContain('/ regTotals.total')
    expect(CHARTS).toContain('share={sRow.share}')
    expect(CHARTS).toContain('const passCancelledTotal = passTotals.cancelled')
    expect(PAGE).not.toMatch(/todayCheckins \/ overview\.totalRegistrations/)
    expect(PAGE).toContain('overview.todayCheckinShare')
    expect(ROUTE).toContain('todayCheckinShare')
    // The trend panel reads resolved windows instead of reducing the series twice.
    const TREND = strip(read('components/dashboard/TrendPanel.tsx'))
    expect(TREND).not.toMatch(/computeDelta\(/)
    expect(TREND).toContain('ranges.find(r => r.days === range)')
  })
})

// ─── A/B/C/D · the four false-zero sites ──────────────────────────────────────

describe('a failed read is never a zero', () => {
  it("A · today's check-ins distinguish a measured zero from an unread count", () => {
    // An unpublished event genuinely has none; a failed aggregate is not the same fact.
    expect(ROUTE).toContain('? Promise.resolve({ ok: true as const, n: 0 })')
    expect(ROUTE).toContain('.catch(() => ({ ok: false as const, n: 0 }))')
    expect(ROUTE).toContain('todayCheckinsAgg.ok ? todayCheckinsAgg.n : null')
    expect(ROUTE).not.toContain('todayCheckinsAgg?.data().count ?? 0')
    // …and the tile has a first-class state for it.
    expect(PAGE).toContain('unavailable={overview.todayCheckins === null}')
  })

  it('A · the today count names an order that a DEPLOYED index can serve', () => {
    // Exposing the failure immediately revealed that it WAS failing: verified against the
    // live project, `(organizerUid[, eventSlug], checkedInAt >=)` with no explicit order
    // returns FAILED_PRECONDITION, because an inequality implies ASCENDING and the deployed
    // composite indexes are DESC. The old `?? 0` had been printing "0 · No check-ins yet
    // today" over that failure on every load.
    //
    // Naming DESC matches an index that already exists — no new index, no deployment — and
    // changes nothing about what is counted: `orderBy` excludes documents lacking the field,
    // and the inequality already excluded those.
    expect(ROUTE).toMatch(/\.where\('checkedInAt', '>=', todayStart\)[\s\S]{0,900}\.orderBy\('checkedInAt', 'desc'\)[\s\S]{0,40}\.count\(\)/)
    const IDX = JSON.parse(read('firestore.indexes.json')) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }>
    }
    const has = (fields: string[]) => IDX.indexes.some(i =>
      i.collectionGroup === 'registrations'
      && i.fields.length === fields.length
      && i.fields.every((f, n) => `${f.fieldPath} ${f.order === 'DESCENDING' ? 'DESC' : 'ASC'}` === fields[n]))
    expect(has(['organizerUid ASC', 'checkedInAt DESC'])).toBe(true)
    expect(has(['organizerUid ASC', 'eventSlug ASC', 'checkedInAt DESC'])).toBe(true)
  })

  it('B · a failed revenue aggregate is unavailable, not ₹0', () => {
    expect(ROUTE).not.toMatch(/\.then\(r => r\.data\(\)\.s \?\? 0\)\.catch\(\(\) => 0\)/)
    expect(ROUTE).toContain('.catch(() => null)))')
    expect(ROUTE).toContain('const revenueUnavailable = scopedSlugs.some(slug => revBySlug.get(slug) === null)')
    expect(ROUTE).toMatch(/const totalRevPaise: number \| null = revenueUnavailable/)
    expect(PAGE).toContain('unavailable={finance.allowed && overview.totalRevenuePaise == null}')
  })

  it('C · an unreadable coupon collection is not an empty one', () => {
    expect(COUPONS).toContain('let readFailed = false')
    expect(COUPONS).toContain('readFailed = true')
    expect(COUPONS).toContain('unavailable: readFailed,')
    expect(COUPONS).toMatch(/unavailable: boolean/)
    // The card must SAY so rather than falling into "No coupons created yet".
    expect(COUPON_UI).toContain('Coupon data unavailable')
    expect(COUPON_UI).toContain('unavailable && totalCoupons === 0')
  })

  it('D · the load-bearing counter read fails explicitly instead of manufacturing zeros', () => {
    // Catching it and carrying on would render a workspace with no registrations and no
    // revenue — a lie rather than an outage. It returns a coded, retryable 503.
    expect(ROUTE).toContain("code:  'COUNTERS_UNAVAILABLE'")
    expect(ROUTE).toContain('{ status: 503 }')
    expect(ROUTE).toContain('adminDb.getAll(...counterRefs).catch(() => null)')
    expect(PAGE).toContain("errorCode === 'COUNTERS_UNAVAILABLE'")
    // The two reads BESIDE it degrade on their own and must not take the page down.
    expect(ROUTE).toContain('adminDb.getAll(...certRefs).catch(() => [])')
    expect(ROUTE).toContain('adminDb.getAll(...licenseRefs).catch(() => [])')
  })

  it('the check-in card still reports unavailable for an unreadable shard fold', () => {
    const ADMIN = strip(read('lib/dashboard/checkInStatusAdmin.ts'))
    expect(ADMIN).toMatch(/if \(shards === null\) return \{ \.\.\.EMPTY_CHECK_IN, state: 'unavailable' \}/)
    // …and an event with a real, measured zero is a different state entirely.
    const zero = resolveCheckInStatus({
      checkedIn: 0, confirmed: 0, passCheckedIn: {}, passConfirmed: {}, passNames: {}, supported: true,
    })
    expect(zero.state).toBe('no_confirmed')
  })
})

// ─── §2 · the budget is allocated deterministically, then executed in parallel ─

describe('the aggregate budget survives parallelisation', () => {
  it('is charged in a PLAN, before any read is issued', () => {
    expect(ROUTE).toContain('const cancelledPlan: string[] = []')
    expect(ROUTE).toContain('const valuePlan: string[] = []')
    expect(ROUTE).toMatch(/passBudget\.remaining -= ids\.length/)
    expect(ROUTE).toMatch(/passBudget\.remaining -= cost/)
    // The plan walks the SAME sets in the SAME order the serial loops did.
    expect(ROUTE).toContain('for (const slug of lookupSlugs) {')
    expect(ROUTE).toContain('for (const slug of scopedSlugs) {')
  })

  it('preserves the rule that an over-budget event is skipped WITHOUT consuming budget', () => {
    // A later, smaller event can still fit — the serial helpers behaved that way and the
    // plan must not quietly become "stop at the first event that does not fit".
    expect(ROUTE).toContain('if (ids.length > passBudget.remaining) { cancelledByPass.set(slug, null); continue }')
    expect(ROUTE).toContain('if (cost > passBudget.remaining) { valueByPass.set(slug, null); continue }')
  })

  it('executes under a ceiling rather than opening every event at once', () => {
    expect(ROUTE).toContain('const EVENT_CONCURRENCY = 6')
    expect(ROUTE).toContain('mapWithConcurrency(cancelledPlan, EVENT_CONCURRENCY')
    expect(ROUTE).toContain('mapWithConcurrency(valuePlan, EVENT_CONCURRENCY')
    // The helpers are handed a pre-paid allowance so they cannot re-charge or race for it.
    expect(ROUTE).toContain('const prepaid = ()')
  })

  it('no `for … await` over events remains in the aggregate paths', () => {
    expect(ROUTE).not.toMatch(/for \(const slug of lookupSlugs\) \{[\s\S]{0,300}await aggregateCancelledByPass/)
    expect(ROUTE).not.toMatch(/for \(const slug of scopedSlugs\) \{[\s\S]{0,300}await aggregateValueByPass/)
  })

  it('getAttendeePaid issues its sums concurrently, under a cap, with the same result', () => {
    const FIN = strip(read('lib/finance/financeAnalytics.ts'))
    expect(FIN).not.toMatch(/for \(const status of statuses\) \{[\s\S]{0,200}for \(const slug of eventSlugs\)/)
    expect(FIN).toContain('const CONCURRENCY = 12')
    expect(FIN).toContain('statuses.flatMap(status => eventSlugs.map')
    // byStatus is still emitted in the CALLER's status order — surfaces read it positionally.
    expect(FIN).toContain('for (const status of statuses) {')
  })
})

// ─── §3 · reads that existed only for unrendered payload ──────────────────────

describe('reads without a consumer are gone', () => {
  it('the walletTransactions read and recentTransactions left together', () => {
    expect(ROUTE).not.toContain("adminDb.collection('walletTransactions')")
    expect(ROUTE).not.toContain('recentTransactions,')
    // The wallet BALANCE is still read — it is on screen.
    expect(ROUTE).toContain('getWalletBalance(uid)')
  })

  it('the attendance fold covers the selected event only', () => {
    expect(ROUTE).toContain('const shardSlugs = scoped && selectedSlug ? [selectedSlug] : []')
    expect(ROUTE.match(/getAttendanceShardSums\(/g)?.length).toBe(1)
    // `checkedIn` is not part of the dashboard's status shape any more, which is what made
    // the per-event fold unnecessary.
    expect(ANALYT).toContain('export interface EventStatusCounts')
    expect(ANALYT).not.toMatch(/checkedIn/)
  })

  it('the refund attribution filter is unchanged — only its shape is parallel', () => {
    const REF = strip(read('lib/refunds/registrationRefunds.ts'))
    expect(REF).toContain('intent.organizerUid !== organizerUid) return null')
    expect(REF).toContain('eventSlug && intent.eventSlug !== eventSlug) return null')
    expect(REF).toContain('Promise.all(withOrder.map')
  })
})
