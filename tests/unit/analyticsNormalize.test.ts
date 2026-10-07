// RD-ANALYTICS-05 — the adapter boundary.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// The adapters are the one place where two producers become one shape, so they are the one
// place a rule established in RD-ANALYTICS-01/02/03 could be quietly undone by a `?? 0`.
// These tests assert the rules, not the renaming:
//
//   money is ABSENT without the permission — not null, not zero
//   an unmeasured count stays null through every mapping and every derived rate
//   no adapter reads Firestore, decides authorization, or imports UI
//   a metric with no baseline reports NO delta rather than a fabricated one

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Source with comments removed — prose about a rule must never satisfy or break a guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
import {
  normalizeEventAnalytics, normalizeDashboardAnalytics,
  type DashboardAnalyticsSource,
} from '@/lib/analytics/normalize'
import { presetRange } from '@/lib/analytics/dateRange'
import { COMPARISON_OFF } from '@/lib/analytics/comparison'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'
import { unmeasuredCommunicationIntelligence } from '@/lib/analytics/communicationIntelligence'

const RANGE = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))

const caps = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
  eventType: 'conference',
  registrationRules: null,
  applications: null,
  gate: { flags: { coupons: true, broadcast: true, certificates: true, donations: true },
          has: () => true } as unknown as AnalyticsModuleContext['gate'],
  financeAllowed: true,
  ...over,
})

const money = (paise: number) => ({ ok: true as const, paise })
const gone  = { ok: false as const, reason: 'query_failed' as const }

/** A complete EventAnalytics payload in its CURRENT (post RD-ANALYTICS-03) shape. */
const eventPayload = (over: Partial<EventAnalytics> = {}): EventAnalytics => ({
  eventId: 'my-event', eventName: 'My Event', lifecycleStatus: 'published', publishedAt: null,
  truncated: false,
  limits: { registrations: true, communications: true, reminders: true,
            certificates: true, ledger: true, passValue: true },
  financialAllowed: true,
  // RD-ANALYTICS-07 · the producer reports on a WINDOW and knows the one before it.
  range: RANGE,
  period:   { confirmed: 30, cancelled: 4, checkedIn: 12, revenuePaise: 200_000 },
  baseline: { confirmed: 24, cancelled: 6, checkedIn: 10, revenuePaise: 160_000 },
  coverageSince: '2026-01-01',
  coveragePartial: false,
  baselineOutsideCoverage: false,
  kpis: {
    registrations: 100, confirmed: 80, pending: 5, cancelled: 10, rejected: 3, waitlisted: 2,
    paid: 70, free: 10, paymentPending: 15, refunded: 4, refundPending: 1,
    checkedIn: 40, conversionPct: 70, capacity: 200, capacityUsedPct: 40, remaining: 120,
  },
  registrationsByDay: [{ date: '2026-06-14', label: '6/14', value: 3 },
                       { date: '2026-06-15', label: '6/15', value: 7 }],
  cancellationsByDay: [{ date: '2026-06-14', label: '6/14', value: 1 },
                       { date: '2026-06-15', label: '6/15', value: 0 }],
  revenueByDay:  [{ date: '2026-06-14', label: '6/14', value: 1000 },
                  { date: '2026-06-15', label: '6/15', value: 2000 }],
  paymentStatus: [{ label: 'paid', value: 70 }],
  passSales:     [{ label: 'General', value: 60 }, { label: 'VIP', value: 20 }],
  passRevenue:   [{ label: 'General', value: 60_000 }],
  couponUsage:   [],
  checkInsByDay: [{ date: '2026-06-15', label: '6/15', value: 40 }],
  funnel: [],
  financial: {
    confirmedRevenuePaise: money(500_000), grossPaise: money(510_000),
    platformFeePaise: money(10_000), gstPaise: money(1_800), gatewayFeePaise: money(9_000),
    netPaise: money(489_200), refundsPaise: money(20_000), refundCount: 4,
    communicationCostPaise: money(300), profitEstimatePaise: money(468_900),
  },
  communication: { sent: 50, failed: 2, delivered: 45, byTemplate: [] },
  reminders: { scheduled: 3, sent: 2, failed: 0, recipients: 100 },
  certificates: { issued: 30, downloaded: 12 },
  // RD-ANALYTICS-10 · operational capabilities come from the event's OWN configuration.
  operationalCapabilities: { identifiersEnabled: false, identifierLabel: null,
                             timingEnabled: false, timingLabel: null },
  identifierProgress: null,
  timingProgress:     null,
  // RD-ANALYTICS-12-28 · the intelligence block is assembled by the producer; the fixture
  // carries the unmeasured shape so the walker below can prove it stays null.
  communicationIntelligence: unmeasuredCommunicationIntelligence(RANGE),
  dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  ...over,
})

const dashboardPayload = (over: Partial<DashboardAnalyticsSource> = {}): DashboardAnalyticsSource => ({
  scope: { mode: 'all', eventId: null, eventSlug: null, eventName: null, eventType: null },
  registrationTotals: { total: 100, confirmed: 80, pending: 5, waitlisted: 2, cancelled: 10, rejected: 3 },
  events: [
    { registered: 40, capacity: 100, fillPct: 40, revenuePaise: 1000 },
    { registered: 20, capacity: null, fillPct: 0,  revenuePaise: 500 },   // uncapped
  ],
  trendDays: [
    { date: '2026-05-01', count: 99, revenuePaise: 9_900 },               // before the range
    { date: '2026-06-14', count: 3,  revenuePaise: 1_000 },
    { date: '2026-06-15', count: 7,  revenuePaise: 2_000 },
  ],
  trendRanges: [{ days: 7, registrations: { total: 10, delta: { pct: 25, direction: 'up' } },
                  revenue: { totalPaise: 3_000, delta: { pct: 10, direction: 'up' } } }],
  trendUnavailable: false,
  coverage: { since: '2026-01-01', partial: false },
  checkIn: { checkedIn: 40 },
  ...over,
})

// ─── A · Event Analytics → contract ───────────────────────────────────────────

describe('RD-ANALYTICS-05 · normalizeEventAnalytics', () => {
  const run = (p?: Partial<EventAnalytics>, c?: Partial<AnalyticsModuleContext>) =>
    normalizeEventAnalytics({
      analytics: eventPayload(p), range: RANGE, capabilities: caps(c), eventId: 'draft-A',
    })

  it('1 · every registration count maps across unchanged', () => {
    const r = run().registrations
    expect(r).toMatchObject({
      total: 100, confirmed: 80, pending: 5, cancelled: 10, rejected: 3, waitlisted: 2,
      paid: 70, free: 10, paymentPending: 15, refunded: 4, refundPending: 1,
      capacity: 200, capacityUsedPct: 40, remaining: 120,
    })
  })

  it('2 · the day series carries the DATE, not just a display label', () => {
    // The date used to be discarded, leaving the position in the array as the only clue.
    expect(run().registrations.byDay).toEqual([
      { date: '2026-06-14', value: 3 }, { date: '2026-06-15', value: 7 },
    ])
  })

  it('3 · attendance is measured against CONFIRMED, not against every registration', () => {
    // A cancelled or waitlisted row was never expected to attend; counting it would
    // depress the rate for a reason that has nothing to do with attendance.
    expect(run().operations.attendancePct).toBe(50)   // 40 / 80
  })

  it('4 · scope, range, coverage and capabilities travel with the payload', () => {
    const r = run()
    expect(r.scope.range).toEqual(RANGE)
    // RD-ANALYTICS-07 · coverage provenance is no longer hard-coded to null.
    expect(r.coverage.since).toBe('2026-01-01')
    expect(r.coverage.partial).toBe(false)
    expect(r.scope.eventId).toBe('draft-A')
    expect(r.scope.eventSlug).toBe('my-event')
    expect(r.scope.eventType).toBe('conference')
    expect(r.scope.comparison).toEqual(COMPARISON_OFF)
    expect(r.capabilities.modules).toContain('overview')
  })

  it('5 · limits are carried through verbatim — completeness is not re-decided here', () => {
    const r = run({ limits: { registrations: true, communications: false, reminders: false,
                              certificates: false, ledger: false, passValue: false } })
    expect(r.limits).toEqual({
      registrations: true, communications: false, certificates: false,
      ledger: false, passValue: false, reminders: false,
    })
  })

  it('6 · an unreadable day series is null, and coverage says so', () => {
    const r = run({ registrationsByDay: null })
    expect(r.registrations.byDay).toBeNull()
    expect(r.coverage.unavailable).toBe(true)
  })
})

// ─── C · Null preservation ────────────────────────────────────────────────────

describe('RD-ANALYTICS-05 · unavailable never becomes zero', () => {
  it('7 · a fully unmeasured event produces nulls, not a zeroed event', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload({
        kpis: { registrations: null, confirmed: null, pending: null, cancelled: null,
                rejected: null, waitlisted: null, paid: null, free: null, paymentPending: null,
                refunded: null, refundPending: null, checkedIn: null, conversionPct: null,
                capacity: null, capacityUsedPct: null, remaining: null },
        registrationsByDay: null, cancellationsByDay: null, checkInsByDay: null,
        period:   { confirmed: null, cancelled: null, checkedIn: null },
        baseline: null,
        communication: null, reminders: null, certificates: null,
      }),
      range: RANGE, capabilities: caps(), eventId: null,
    })
    // RE-ANCHORED (RD-ANALYTICS-08). `registrations` now carries two non-count members —
    // `period`, a pair of ComparedMetrics, and `byPassBasis`, a literal describing what
    // `byPass` measures. Walking every value and demanding null would have forced those to
    // be nulled, which would delete the very provenance this phase added. The counts are
    // therefore named, and the period metrics are checked for the stronger property: an
    // unmeasured window yields no value AND no delta, never a zero and never a percentage.
    const COUNTS = ['total', 'confirmed', 'pending', 'cancelled', 'rejected', 'waitlisted',
                    'paid', 'free', 'paymentPending', 'refunded', 'refundPending',
                    'capacity', 'capacityUsedPct', 'remaining'] as const
    for (const key of COUNTS) expect(r.registrations[key], key).toBeNull()
    expect(r.registrations.byDay).toBeNull()
    expect(r.registrations.cancelledByDay).toBeNull()
    for (const m of [r.registrations.period.confirmed, r.registrations.period.cancelled]) {
      expect(m.value).toBeNull()
      expect(m.delta).toBeNull()
      expect(m.unavailable).toBe('not_measured')
    }
    expect(r.operations.checkedIn).toBeNull()
    expect(r.operations.attendancePct).toBeNull()
    // RE-ANCHORED (RD-ANALYTICS-11). `channels` is a STRUCTURAL member — the four channels
    // the product names, and whether the platform can send on each — and that list does not
    // depend on this event having been read. Demanding it be null would have deleted the one
    // thing an unmeasured event can still say honestly: SMS is unsupported here regardless.
    // The rule is applied where it belongs — every FIGURE is null, on every channel.
    // RE-ANCHORED (RD-ANALYTICS-12-28). `intelligence` is structural too — it names its
    // bases and its window — so it is walked for FIGURES rather than demanded null.
    for (const [k, v] of Object.entries(r.communications)) {
      if (k === 'channels' || k === 'intelligence') continue
      expect(v, k).toBeNull()
    }
    const i = r.communications.intelligence
    for (const v of [i.campaigns.created, i.campaigns.completed, i.campaigns.scheduled,
                     i.composition.broadcast, i.composition.automatic, i.email.bounces,
                     i.email.complaints, i.whatsapp.read, i.whatsapp.walletSkipped,
                     i.window.attempted.value, i.window.velocity.perDay, i.channelMix]) {
      expect(v).toBeNull()
    }
    for (const chan of r.communications.channels) {
      expect(chan.delivery, chan.key).toBeUndefined()
    }
    expect(r.communications.channels.map(c => c.support))
      .toEqual(['supported', 'supported', 'not_implemented', 'not_implemented'])
  })

  it('8 · a derived rate is null when EITHER input is unmeasured', () => {
    expect(normalizeEventAnalytics({
      analytics: eventPayload({ kpis: { ...eventPayload().kpis, confirmed: null } }),
      range: RANGE, capabilities: caps(), eventId: null,
    }).operations.attendancePct).toBeNull()

    expect(normalizeEventAnalytics({
      analytics: eventPayload({ kpis: { ...eventPayload().kpis, checkedIn: null } }),
      range: RANGE, capabilities: caps(), eventId: null,
    }).operations.attendancePct).toBeNull()
  })

  it('9 · a zero denominator is unknown, not 0%', () => {
    expect(normalizeEventAnalytics({
      analytics: eventPayload({ kpis: { ...eventPayload().kpis, confirmed: 0, checkedIn: 0 } }),
      range: RANGE, capabilities: caps(), eventId: null,
    }).operations.attendancePct).toBeNull()
  })

  it('10 · the adapter source contains no `?? 0` coalescing on a count', () => {
    // Comment-stripped: this module DOCUMENTS the rule in prose, and prose stating a rule
    // must not be mistaken for code breaking it.
    expect(code('lib/analytics/normalize.ts')).not.toMatch(/\?\?\s*0\b/)
  })
})

// ─── D/E · Financial authorization ────────────────────────────────────────────

describe('RD-ANALYTICS-05 · money is absent, not zeroed', () => {
  it('11 · an unauthorized payload has NO revenue key at all', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload({ financial: undefined, financialAllowed: false,
                                revenueByDay: undefined, passRevenue: undefined }),
      range: RANGE, capabilities: caps({ financeAllowed: false }), eventId: null,
    })
    // `in` rather than a truthiness check: `revenue: null` would still disclose that
    // revenue exists and was withheld.
    expect('revenue' in r).toBe(false)
    expect('revenuePaise' in r.overview).toBe(false)
    expect(r.financialAllowed).toBe(false)
    expect(JSON.stringify(r)).not.toMatch(/Paise|revenue/i)
  })

  it('12 · an authorized payload carries every canonical financial figure', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload(), range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(r.revenue).toBeDefined()
    expect(r.revenue!.confirmedRevenue).toEqual(money(500_000))
    expect(r.revenue!.grossCollected).toEqual(money(510_000))
    expect(r.revenue!.refunds).toEqual(money(20_000))
    expect(r.revenue!.refundCount).toBe(4)
    // The two are distinct populations and must not have been collapsed.
    expect(r.revenue!.confirmedRevenue).not.toEqual(r.revenue!.grossCollected)
  })

  it('13 · an unavailable money figure stays `gone` — it is not turned into ₹0', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload({ financial: { ...eventPayload().financial!, grossPaise: gone,
                                             profitEstimatePaise: gone } }),
      range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(r.revenue!.grossCollected.ok).toBe(false)
    expect(r.revenue!.profitEstimate.ok).toBe(false)
  })

  it('14 · the Revenue MODULE disappears for an unauthorized caller', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload({ financial: undefined, financialAllowed: false }),
      range: RANGE, capabilities: caps({ financeAllowed: false }), eventId: null,
    })
    expect(r.capabilities.modules).not.toContain('revenue')
    expect(r.capabilities.panels).not.toContain('coupons')
  })

  it('15 · the dashboard adapter withholds revenue on the same rule', () => {
    const allowed = normalizeDashboardAnalytics({
      data: dashboardPayload(), range: RANGE, capabilities: caps(),
    })
    const denied = normalizeDashboardAnalytics({
      data: dashboardPayload(), range: RANGE, capabilities: caps({ financeAllowed: false }),
    })
    expect(allowed.overview.revenuePaise?.value).toBe(3_000)
    expect('revenuePaise' in denied.overview).toBe(false)
  })
})

// ─── B · Dashboard → contract ─────────────────────────────────────────────────

describe('RD-ANALYTICS-05 · normalizeDashboardAnalytics', () => {
  const run = (p?: Partial<DashboardAnalyticsSource>, c?: Partial<AnalyticsModuleContext>) =>
    normalizeDashboardAnalytics({ data: dashboardPayload(p), range: RANGE, capabilities: caps(c) })

  it('16 · status totals map across, preserving their existing nullability', () => {
    expect(run().registrations).toMatchObject({
      total: 100, confirmed: 80, pending: 5, cancelled: 10, rejected: 3, waitlisted: 2,
    })
    expect(run({ registrationTotals: { total: null, confirmed: 80, pending: 5,
      waitlisted: null, cancelled: 10, rejected: 3 } }).registrations).toMatchObject({
      total: null, waitlisted: null,
    })
  })

  it('17 · fields this producer does not measure are NULL, never zero', () => {
    // A workspace payload has no payment-status split and no per-pass data. Reporting 0
    // paid registrations would be a claim; null is the fact.
    const r = run().registrations
    expect(r.paid).toBeNull()
    expect(r.free).toBeNull()
    expect(r.paymentPending).toBeNull()
    expect(r.refunded).toBeNull()
    expect(r.refundPending).toBeNull()
    expect(r.byPass).toEqual([])
  })

  it('18 · the day series is clipped to the requested range', () => {
    // The producer always ships 90 days; the contract carries the window that was asked for.
    const byDay = run().registrations.byDay!
    expect(byDay.map(p => p.date)).toEqual(['2026-06-14', '2026-06-15'])
    expect(byDay.every(p => p.date >= RANGE.from && p.date <= RANGE.to)).toBe(true)
  })

  it('19 · an unreadable trend is null, not a flat line of zeros', () => {
    const r = run({ trendUnavailable: true })
    expect(r.registrations.byDay).toBeNull()
    expect(r.coverage.unavailable).toBe(true)
  })

  it('20 · fill rate counts only events that HAVE a capacity', () => {
    // 40/100 from the capped event; the uncapped one has nothing to be a percentage of.
    expect(run().overview.fillPct).toBe(40)
    expect(run().registrations.capacity).toBe(100)
  })

  it('21 · with no capped events at all, fill rate is unknown rather than 0%', () => {
    const r = run({ events: [{ registered: 20, capacity: null, fillPct: 0, revenuePaise: 0 }] })
    expect(r.overview.fillPct).toBeNull()
    expect(r.registrations.capacity).toBeNull()
  })

  it('22 · rollup coverage is carried through', () => {
    expect(run().coverage).toEqual({ since: '2026-01-01', partial: false, unavailable: false })
    expect(run({ coverage: { since: '2026-06-01', partial: true } }).coverage.partial).toBe(true)
  })

  it('23 · the workspace scope is expressed as a null event, not a fabricated one', () => {
    expect(run().scope.eventId).toBeNull()
    expect(run().scope.eventName).toBeNull()
  })
})

// ─── H · Comparison ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-05 · comparison metadata', () => {
  it('24 · the server-resolved 7-day delta is PASSED THROUGH, never recomputed', () => {
    const r = normalizeDashboardAnalytics({
      data: dashboardPayload(), range: RANGE, capabilities: caps(),
    })
    expect(r.overview.registrations.value).toBe(10)
    expect(r.overview.registrations.delta).toEqual({ pct: 25, direction: 'up' })
  })

  it('25 · a producer WITH a baseline reports a real delta over PERIOD totals', () => {
    // RE-ANCHORED (RD-ANALYTICS-07). RD-ANALYTICS-05 asserted that no delta was ever
    // produced, because the producer resolved one window. It now resolves two, so the rule
    // under test becomes the sharper one: the delta compares PERIOD against PERIOD — never
    // the lifetime headline against a windowed baseline, which would divide two different
    // quantities and call the result growth.
    const r = normalizeEventAnalytics({
      analytics: eventPayload(), range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(r.overview.registrations.value).toBe(30)      // period, not the lifetime 80
    expect(r.overview.registrations.baseline).toBe(24)
    expect(r.overview.registrations.delta).toEqual({ pct: 25, direction: 'up' })
    expect(r.overview.checkedIn.delta).toEqual({ pct: 20, direction: 'up' })
  })

  it('25b · a producer with NO baseline still invents nothing', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload({ baseline: null }), range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(r.overview.registrations.delta).toBeNull()
    expect(r.overview.registrations.baseline).toBeNull()
    // …and says why, rather than leaving the reader to guess.
    expect(r.overview.registrations.unavailable).toBe('no_baseline')
  })

  it('25c · a baseline outside coverage is reported as such, never compared to zero', () => {
    const r = normalizeEventAnalytics({
      analytics: eventPayload({ baseline: null, baselineOutsideCoverage: true }),
      range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(r.overview.registrations.delta).toBeNull()
    expect(r.overview.registrations.unavailable).toBe('outside_coverage')
  })

  it('25c2 · the reason describes the BASELINE window, not the current one', () => {
    // ═══ THE DEFECT THIS PREVENTS ══════════════════════════════════════════════
    // A 7-day window can sit entirely inside recorded history while the 7 days before it
    // lie entirely outside it. Reading the reason off the CURRENT window's coverage then
    // told the reader "no earlier period on record" — phrased as though the event had
    // never run before — about an event whose earlier months simply were not rolled up.
    const insideButUnbacked = normalizeEventAnalytics({
      analytics: eventPayload({ baseline: null, coveragePartial: false, baselineOutsideCoverage: true }),
      range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(insideButUnbacked.coverage.partial).toBe(false)
    expect(insideButUnbacked.overview.registrations.unavailable).toBe('outside_coverage')

    // …and the mirror image: a clipped current window whose baseline IS backed still
    // compares, because a partial current window is not itself a reason to refuse.
    const clippedButComparable = normalizeEventAnalytics({
      analytics: eventPayload({ coveragePartial: true, baselineOutsideCoverage: false }),
      range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(clippedButComparable.coverage.partial).toBe(true)
    expect(clippedButComparable.overview.registrations.delta).not.toBeNull()
  })

  it('25d · the revenue comparison is period-over-period and needs the permission', () => {
    const allowed = normalizeEventAnalytics({
      analytics: eventPayload(), range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(allowed.overview.revenuePaise?.value).toBe(200_000)
    expect(allowed.overview.revenuePaise?.delta).toEqual({ pct: 25, direction: 'up' })

    // Without the permission the producer omits period revenue entirely, so no financial
    // comparison can be built from it.
    const denied = normalizeEventAnalytics({
      analytics: eventPayload({
        financial: undefined, financialAllowed: false,
        period:   { confirmed: 30, checkedIn: 12 },
        baseline: { confirmed: 24, checkedIn: 10 },
      }),
      range: RANGE, capabilities: caps({ financeAllowed: false }), eventId: null,
    })
    expect('revenuePaise' in denied.overview).toBe(false)
    expect(JSON.stringify(denied)).not.toMatch(/Paise/)
  })

  it('26 · comparison defaults to OFF rather than to a silently chosen baseline', () => {
    const r = normalizeDashboardAnalytics({
      data: dashboardPayload({ trendRanges: [] }), range: RANGE, capabilities: caps(),
    })
    expect(r.scope.comparison).toEqual(COMPARISON_OFF)
    expect(r.overview.registrations.delta).toBeNull()
  })
})

// ─── F/K/L · Capabilities and the two documented boundaries ──────────────────

describe('RD-ANALYTICS-05 · capability mapping and honest boundaries', () => {
  it('27 · timing appears where the EVENT enabled it — sports or not', () => {
    // RE-ANCHORED (RD-ANALYTICS-10). The old rule keyed on `eventType`, which offered the
    // panel to a sports event with timing switched off and denied it to every other event
    // that had switched it on. The capability decides now.
    const run = (c: Partial<AnalyticsModuleContext>) => normalizeEventAnalytics({
      analytics: eventPayload(), range: RANGE, capabilities: caps(c), eventId: null,
    }).capabilities.panels

    expect(run({ eventType: 'sports',     timingEnabled: true  })).toContain('timing')
    expect(run({ eventType: 'conference', timingEnabled: true  })).toContain('timing')
    expect(run({ eventType: 'sports',     timingEnabled: false })).not.toContain('timing')
    expect(run({ eventType: 'conference' })).not.toContain('timing')
  })

  it('28 · PARTICIPANTS is never fabricated by either adapter', () => {
    // No form-field → semantic-type mapping exists, so manufacturing buckets out of
    // arbitrary formResponses JSON would be inventing demographics.
    const e = normalizeEventAnalytics({
      analytics: eventPayload(), range: RANGE, capabilities: caps({ hasParticipantData: true }),
      eventId: null,
    })
    const d = normalizeDashboardAnalytics({ data: dashboardPayload(), range: RANGE, capabilities: caps() })
    expect('participants' in e).toBe(false)
    expect('participants' in d).toBe(false)
  })

  it('29 · no daily ATTENDANCE series is invented on the dashboard path', () => {
    // The payload carries no per-day check-in column; spreading one total across the
    // window would be inventing attendance history.
    const d = normalizeDashboardAnalytics({ data: dashboardPayload(), range: RANGE, capabilities: caps() })
    expect(d.operations.byDay).toBeNull()
    // The EVENT path DOES have the column, so it is filled there.
    const e = normalizeEventAnalytics({
      analytics: eventPayload(), range: RANGE, capabilities: caps(), eventId: null,
    })
    expect(e.operations.byDay).toEqual([{ date: '2026-06-15', value: 40 }])
  })
})

// ─── M · Structural guarantees ────────────────────────────────────────────────

describe('RD-ANALYTICS-05 · the adapters stay adapters', () => {
  const SRC = readFileSync(resolve(process.cwd(), 'lib/analytics/normalize.ts'), 'utf8')

  it('30 · no Firestore read, no admin SDK, no route import', () => {
    expect(SRC).not.toMatch(/firebase\/admin|adminDb|collection\(|\.get\(\)/)
    // Importing the dashboard ROUTE would drag server code into every client consumer.
    expect(SRC).not.toMatch(/from '@\/app\//)
  })

  it('31 · no authorization decision — the entitlement is an INPUT', () => {
    expect(SRC).not.toMatch(/permissions\.includes|authorizeWorkspace|requireEventScope/)
    expect(SRC).toMatch(/financeAllowed/)
  })

  it('32 · no React, no UI, no icons', () => {
    expect(SRC).not.toMatch(/from 'react'|lucide-react|className/)
  })

  it('33 · the event producer still has no registration scan behind the adapter', () => {
    // RD-ANALYTICS-03 must not be regressed by this phase.
    // Comment-stripped: the module DESCRIBES the removed scan in prose, and a description
    // of a defect must not be mistaken for the defect.
    const producer = code('lib/analytics/eventAnalytics.ts')
    expect(producer).not.toMatch(/collection\('registrations'\)/)
    // RE-ANCHORED (RD-ANALYTICS-09) — see the twin guards in analyticsOverview and
    // analyticsRegistrations. `limit(CAP + 1)` is now the payment ledger's overflow probe,
    // so the rule names the collection instead of banning the shape.
    for (const hit of producer.match(/collection\('[a-zA-Z]+'\)[\s\S]{0,140}?limit\(CAP \+ 1\)/g) ?? []) {
      expect(hit).toMatch(/platformTransactions|emailLogs/)
    }
    // RE-ANCHORED AGAIN (RD-ANALYTICS-11). `emailLogs` now carries a bounded read too — the
    // template breakdown, which has no aggregate. Widening the collection list alone would
    // weaken the guard, so the rule it always meant is asserted directly: EVERY bounded read
    // detects its own overflow and lowers the flag that gates what it publishes.
    expect(producer).toContain('ledgerTruncated = true')
    expect(producer).toContain('commTruncated = true')
  })

  it('34 · the analytics dashboard uses the canonical event context, not its own picker', () => {
    const page = readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/reports/page.tsx'), 'utf8')
    expect(page).toContain("from '@/components/dashboard/EventContextProvider'")
    expect(page).toContain("from '@/components/dashboard/EventSelector'")
    expect(page).not.toMatch(/^function EventSelector\(/m)
    // …and its window options derive from the shared preset table.
    expect(page).toContain('PRESET_DAYS')
  })
})
