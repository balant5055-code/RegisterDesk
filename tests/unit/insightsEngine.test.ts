// RD-ANALYTICS-12-31 · the Insights Engine — a pure function over AnalyticsResponse.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// Every card cites a payload field and clears documented floors; a rule reads a key or
// finds nothing (which is the whole of its permission logic); one card per evidence field;
// deterministic ranking with a cap of six; one failing block never silences another; the
// module imports no data access. The fixtures are hand-built `AnalyticsResponse` objects,
// so each case says exactly which field it changed and what that must do to the cards.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildInsights, rangeLabels, RULE_COUNT, MAX_SURFACED,
  TREND_MIN_BASELINE, TREND_MIN_ABS_DELTA, TREND_MIN_PCT, TREND_STRONG_PCT,
  MONEY_MIN_BASELINE, NEARLY_FULL_PCT, AWAITING_MIN, PENDING_BACKLOG_MIN,
} from '@/lib/analytics/insightsRules'
import { NEARLY_FULL_PCT as DASHBOARD_NEARLY_FULL } from '@/lib/dashboard/insights'
import { computeDelta, compareMetric } from '@/lib/analytics/comparison'
import { unmeasuredCommunicationIntelligence } from '@/lib/analytics/communicationIntelligence'
import type { AnalyticsResponse, ComparedMetric, ChannelDelivery } from '@/lib/analytics/contract'

const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const ENGINE = code('lib/analytics/insightsRules.ts')
const UI     = code('components/analytics/insights/InsightsAnalytics.tsx')

const RANGE = { from: '2026-08-13', to: '2026-09-11', preset: '30d' as const }
const cmp = (value: number | null, baseline: number | null): ComparedMetric => compareMetric(value, baseline)
const money = (paise: number) => ({ ok: true as const, paise })
const gone  = { ok: false as const, reason: 'query_failed' as const }
const ch = (o: Partial<ChannelDelivery> = {}): ChannelDelivery => ({ sent: 0, delivered: 0, failed: 0, unknown: 0, queued: 0, skipped: 0, ...o })

/** A quiet, fully measured, finance-authorized event. Nothing here clears a floor. */
const quiet = (over: Partial<AnalyticsResponse> = {}): AnalyticsResponse => ({
  scope: { eventId: 'draft-A', eventSlug: 'ev-a', eventName: 'A', eventType: 'conference', range: RANGE, comparison: { enabled: true, mode: 'previous_period' } as never },
  capabilities: { modules: ['overview', 'registrations', 'revenue', 'operations', 'communications', 'participants'], panels: ['coupons'] },
  coverage: { since: '2026-01-01', partial: false, unavailable: false },
  limits: { registrations: true, communications: true, certificates: true, ledger: true, passValue: true, reminders: true },
  financialAllowed: true,
  overview: { registrations: cmp(30, 28), checkedIn: cmp(0, 0), revenuePaise: cmp(3_000_000, 2_900_000), fillPct: 30 },
  registrations: {
    total: 120, confirmed: 100, pending: 5, cancelled: 12, rejected: 3, waitlisted: 0,
    paid: 80, free: 20, paymentPending: 5, refunded: 2, refundPending: 0,
    byDay: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, value: 1 })), cancelledByDay: [],
    period: { confirmed: cmp(30, 28), cancelled: cmp(3, 3) },
    byPass: [{ label: 'General', value: 60 }, { label: 'VIP', value: 40 }], byPassBasis: 'lifetime_confirmed',
    capacity: 400, capacityUsedPct: 25, remaining: 300,
  },
  revenue: {
    confirmedRevenue: money(10_000_000), netRevenue: money(9_800_000), grossCollected: money(10_000_000),
    platformFee: money(0), gst: money(0), gatewayFee: money(0), netSettlement: money(9_800_000),
    refunds: money(200_000), refundCount: 2, communicationCost: money(0), profitEstimate: money(9_800_000),
    byDay: [], byPass: [], byPassBasis: 'lifetime_confirmed',
    intelligence: {
      velocity: { perDayPaise: money(100_000), windowDays: 30, basis: 'period_rollup_revenue_per_day' },
      averageOrderValue: { paise: money(125_000), denominator: 80, basis: 'confirmed_revenue_per_paid_registration' },
      refundRate: { pct: 2, basis: 'completed_refunds_over_confirmed_revenue' },
      refundsInPeriod: { amount: money(100_000), count: 1, comparison: cmp(100_000, 100_000), basis: 'refund_ledger_by_refund_date' },
      beforeDiscount: { paise: money(10_500_000), discount: money(500_000), basis: 'confirmed_revenue_plus_discount_given' },
    },
  },
  operations: {
    checkedIn: 0, attendancePct: 0, byDay: [],
    attendance: { confirmed: 100, checkedIn: 0, pct: 0, awaited: 100, over: false },
    capacity: { configured: 400, confirmed: 100, usedPct: 25, remaining: 300, over: false },
  },
  communications: {
    sent: 500, delivered: 480, failed: 10, remindersScheduled: 0, remindersSent: 0,
    certificatesIssued: 0, certificatesDownloaded: 0,
    channels: [
      { key: 'email', label: 'Email', support: 'supported', delivery: ch({ sent: 500, delivered: 480, failed: 10, unknown: 0 }) },
      { key: 'whatsapp', label: 'WhatsApp', support: 'supported', delivery: ch() },
      { key: 'sms', label: 'SMS', support: 'not_implemented' },
      { key: 'push', label: 'Push', support: 'not_implemented' },
    ],
    totalMessages: 500,
    intelligence: {
      ...unmeasuredCommunicationIntelligence(RANGE),
      email: { bounces: 2, complaints: 0, basis: 'provider_webhook_error_reason' },
      whatsapp: { read: 0, walletSkipped: 0, basis: 'meta_status_and_wallet_skip_reason' },
      window: { ...unmeasuredCommunicationIntelligence(RANGE).window, attempted: cmp(200, 190), delivered: cmp(190, 180), notDelivered: cmp(5, 5) },
    },
  },
  participants: {
    composition: {
      source: { online: 110, walkin: 10, unrecorded: 0 },
      sourceByStatus: { confirmed: { online: 95, walkin: 5, unrecorded: 0 }, pending: { online: 5, walkin: 0, unrecorded: 0 }, cancelled: { online: 7, walkin: 5, unrecorded: 0 }, rejected: { online: 3, walkin: 0, unrecorded: 0 }, waitlisted: { online: 0, walkin: 0, unrecorded: 0 } },
      passMix: [{ label: 'General', value: 60, sharePct: 60 }, { label: 'VIP', value: 40, sharePct: 40 }],
      statusMix: null, identityRules: { limitPerEmail: false, limitPerMobile: false },
      basis: 'registration_source_field_and_status_counts',
    },
  },
  ...over,
})

const rules = (r: AnalyticsResponse) => buildInsights(r).insights.map(i => i.rule)
const regs  = (over: Partial<AnalyticsResponse['registrations']>) => quiet({ registrations: { ...quiet().registrations, ...over } })

// ─── Registrations ──────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-31 · registration trends', () => {
  it('1 · the quiet fixture produces no card at all', () => {
    const r = buildInsights(quiet())
    expect(r.insights).toEqual([])
    expect(r.evaluated).toBe(RULE_COUNT)
  })

  it('2 · strong growth: baseline ≥ 20, |Δ| ≥ 10, pct ≥ 40 ⇒ a positive card on the period field', () => {
    const r = buildInsights(regs({ period: { confirmed: cmp(60, 40), cancelled: cmp(0, 0) } }))
    const c = r.insights.find(i => i.rule === 'registrations_growth')!
    expect(c.severity).toBe('positive')
    expect(c.evidence).toMatchObject({ field: 'registrations.period.confirmed', window: 'period', unit: 'count', value: 60, baseline: 40, coverage: { partial: false } })
    expect(c.evidence.delta).toEqual(computeDelta(60, 40))
    expect(c.evidence.thresholds).toEqual({ minBaseline: TREND_MIN_BASELINE, minAbsDelta: TREND_MIN_ABS_DELTA, minPct: TREND_MIN_PCT, strongPct: TREND_STRONG_PCT })
    expect(c.title).toContain('in the last 30 days')
    expect(c.summary).toContain('the 30 days before')
  })

  it('3 · strong decline ⇒ warning; moderate change ⇒ info', () => {
    expect(buildInsights(regs({ period: { confirmed: cmp(24, 40), cancelled: cmp(0, 0) } })).insights[0]).toMatchObject({ rule: 'registrations_decline', severity: 'warning' })
    expect(buildInsights(regs({ period: { confirmed: cmp(50, 40), cancelled: cmp(0, 0) } })).insights[0]).toMatchObject({ rule: 'registrations_growth', severity: 'info' })
  })

  it('4 · weak change (under the pct floor) ⇒ nothing', () => {
    expect(rules(regs({ period: { confirmed: cmp(52, 48), cancelled: cmp(0, 0) } }))).not.toContain('registrations_growth')
  })

  it('5 · small baseline: 10 → 20 is +100% and is NOT a card', () => {
    expect(rules(regs({ period: { confirmed: cmp(20, 10), cancelled: cmp(0, 0) } }))).not.toContain('registrations_growth')
  })

  it('6 · absolute floor: 40 → 47 is +18% but only 7 seats ⇒ nothing', () => {
    expect(rules(regs({ period: { confirmed: cmp(47, 40), cancelled: cmp(0, 0) } }))).not.toContain('registrations_growth')
  })

  it('7 · zero baseline: the payload\'s delta has no pct, so nothing fires — computeDelta is not re-implemented', () => {
    const m = cmp(60, 0)
    expect(m.delta).toEqual({ pct: null, direction: 'up' })
    expect(rules(regs({ period: { confirmed: m, cancelled: cmp(0, 0) } }))).not.toContain('registrations_growth')
    expect(ENGINE).not.toMatch(/\/ ?(m|mv|metric)\.baseline|computeDelta\(/)
  })

  it('8 · unavailable baseline (any reason) ⇒ nothing; partial coverage on the window ⇒ nothing', () => {
    for (const reason of ['no_baseline', 'outside_coverage', 'not_measured', 'disabled'] as const) {
      expect(rules(regs({ period: { confirmed: compareMetric(60, null, reason), cancelled: cmp(0, 0) } }))).not.toContain('registrations_growth')
    }
    const partial = quiet({ coverage: { since: '2026-09-01', partial: true, unavailable: false }, registrations: { ...quiet().registrations, period: { confirmed: cmp(60, 40), cancelled: cmp(0, 0) } } })
    expect(rules(partial)).not.toContain('registrations_growth')
  })

  it('9 · a rise in cancellations is a card with an action; a fall is not', () => {
    expect(buildInsights(regs({ period: { confirmed: cmp(30, 28), cancelled: cmp(40, 20) } })).insights[0]).toMatchObject({ rule: 'cancellations_rise', severity: 'warning', action: { label: 'Review recent cancellations' } })
    expect(rules(regs({ period: { confirmed: cmp(30, 28), cancelled: cmp(20, 40) } }))).not.toContain('cancellations_rise')
  })
})

// ─── Capacity ───────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-31 · capacity', () => {
  it('10 · the floor is the Dashboard\'s own constant, imported not re-declared', () => {
    expect(NEARLY_FULL_PCT).toBe(DASHBOARD_NEARLY_FULL)
    expect(ENGINE).toContain("import { NEARLY_FULL_PCT } from '@/lib/dashboard/insights'")
    expect(ENGINE).not.toMatch(/=\s*85\b/)
  })

  it('11 · 85% ⇒ approaching (warning); 100% ⇒ reached (critical); over ⇒ exceeded (critical)', () => {
    expect(buildInsights(regs({ capacityUsedPct: 85, confirmed: 340, remaining: 60 })).insights[0]).toMatchObject({ rule: 'capacity_approaching', severity: 'warning', evidence: { field: 'registrations.capacityUsedPct', value: 85, thresholds: { nearlyFullPct: 85, capacity: 400 } } })
    expect(buildInsights(regs({ capacityUsedPct: 100, confirmed: 400, remaining: 0 })).insights[0]).toMatchObject({ rule: 'capacity_reached', severity: 'critical' })
    expect(buildInsights(regs({ capacityUsedPct: 105, confirmed: 420, remaining: -20 })).insights[0]).toMatchObject({ rule: 'capacity_exceeded', severity: 'critical' })
  })

  it('12 · no capacity, or an unmeasured percentage ⇒ no capacity card', () => {
    expect(rules(regs({ capacity: null, capacityUsedPct: null, remaining: null, confirmed: 400 }))).not.toContain('capacity_approaching')
    expect(rules(regs({ capacity: 400, capacityUsedPct: null, confirmed: 400 }))).not.toContain('capacity_reached')
  })

  it('13 · the copy says registrations, never participants', () => {
    const c = buildInsights(regs({ capacityUsedPct: 90, confirmed: 360, remaining: 40 })).insights[0]
    expect(`${c.title} ${c.summary}`).not.toMatch(/participant/i)
  })
})

// ─── Operations ─────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-31 · operations', () => {
  const ops = (attendance: AnalyticsResponse['operations']['attendance']) =>
    quiet({ operations: { ...quiet().operations, attendance } })

  it('14 · attendance low: ≥ 50 confirmed, something scanned, under 50% ⇒ info with "so far"', () => {
    const c = buildInsights(ops({ confirmed: 200, checkedIn: 40, pct: 20, awaited: 160, over: false })).insights.find(i => i.rule === 'attendance_low')!
    expect(c.severity).toBe('info')
    expect(c.title).toContain('so far')
    expect(c.evidence.field).toBe('operations.attendance.pct')
  })

  it('15 · nothing scanned yet ⇒ no attendance card — an upcoming event is not "low attendance"', () => {
    expect(rules(ops({ confirmed: 200, checkedIn: 0, pct: 0, awaited: 200, over: false }))).not.toContain('attendance_low')
    expect(rules(ops({ confirmed: 200, checkedIn: 0, pct: 0, awaited: 200, over: false }))).not.toContain('awaiting_large')
  })

  it('16 · awaiting arrival ≥ 100 with a scan recorded ⇒ warning with a preparation action', () => {
    const c = buildInsights(ops({ confirmed: 300, checkedIn: 150, pct: 50, awaited: 150, over: false })).insights.find(i => i.rule === 'awaiting_large')!
    expect(c).toMatchObject({ severity: 'warning', evidence: { field: 'operations.attendance.awaited', value: 150, thresholds: { awaitingMin: AWAITING_MIN } } })
    expect(c.action?.label).toMatch(/Prepare check-in capacity/)
  })

  it('17 · over-attendance is an observation, and no-show is never a word', () => {
    const c = buildInsights(ops({ confirmed: 100, checkedIn: 104, pct: 104, awaited: -4, over: true })).insights.find(i => i.rule === 'attendance_over')!
    expect(c.severity).toBe('info')
    for (const src of [ENGINE, UI]) expect(src).not.toMatch(/no[- ]?show/i)
    expect(ENGINE).not.toMatch(/checkinHistory|checkedInBy|operatorUid/)
  })
})

// ─── Revenue ────────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-31 · revenue', () => {
  it('18 · authorized growth ⇒ positive when strong; decline ⇒ warning; evidence is in paise', () => {
    const up = buildInsights(quiet({ overview: { ...quiet().overview, revenuePaise: cmp(3_000_000, 2_000_000) } })).insights.find(i => i.rule === 'revenue_growth')!
    expect(up).toMatchObject({ severity: 'positive', evidence: { field: 'overview.revenuePaise', unit: 'paise', value: 3_000_000, baseline: 2_000_000 } })
    expect(up.summary).toMatch(/₹20,000 .* → ₹30,000/)
    const down = buildInsights(quiet({ overview: { ...quiet().overview, revenuePaise: cmp(2_000_000, 3_000_000) } })).insights.find(i => i.rule === 'revenue_decline')!
    expect(down.severity).toBe('warning')
  })

  it('19 · money floors: ₹5,000 → ₹9,000 is +80% and is NOT a card', () => {
    expect(rules(quiet({ overview: { ...quiet().overview, revenuePaise: cmp(900_000, 500_000) } }))).not.toContain('revenue_growth')
    expect(MONEY_MIN_BASELINE).toBe(1_000_000)
  })

  it('20 · a payload without money keys (no `transactions`) produces no revenue card of any kind', () => {
    const base = quiet({ overview: { ...quiet().overview, revenuePaise: cmp(3_000_000, 2_000_000) } })
    const rest: Partial<AnalyticsResponse> = { ...base }; delete rest.revenue
    const unauthorized = { ...rest, financialAllowed: false, overview: { registrations: base.overview.registrations, checkedIn: base.overview.checkedIn, fillPct: 30 } } as AnalyticsResponse
    const out = buildInsights(unauthorized)
    expect(out.insights.map(i => i.rule).filter(r => /revenue|refund|discount/.test(r))).toEqual([])
    expect(JSON.stringify(out)).not.toMatch(/paise|₹/)
    expect(out.evaluated).toBe(RULE_COUNT)   // the rules still RAN; they found nothing
  })

  it('21 · unavailable money (`ok:false`) and a zero-revenue event produce no revenue card', () => {
    const rev = quiet().revenue!
    const gone_ = quiet({ revenue: { ...rev, confirmedRevenue: gone, intelligence: { ...rev.intelligence, refundRate: { pct: 40, basis: 'completed_refunds_over_confirmed_revenue' } } } })
    expect(rules(gone_)).not.toContain('refund_rate_high')
    const zero = quiet({ overview: { ...quiet().overview, revenuePaise: cmp(0, 0) }, revenue: { ...rev, confirmedRevenue: money(0) } })
    expect(rules(zero).filter(r => /revenue|refund/.test(r))).toEqual([])
  })

  it('22 · refunds rise needs ≥ 3 refunds AND the money floors; refund rate ≥ 10% on ≥ ₹10,000 warns', () => {
    const rev = quiet().revenue!
    const rise = quiet({ revenue: { ...rev, intelligence: { ...rev.intelligence, refundsInPeriod: { amount: money(2_000_000), count: 5, comparison: cmp(2_000_000, 1_000_000), basis: 'refund_ledger_by_refund_date' } } } })
    expect(buildInsights(rise).insights.find(i => i.rule === 'refunds_rise')).toMatchObject({ severity: 'warning', evidence: { basis: 'refund_ledger_by_refund_date', thresholds: { minRefundCount: 3 } } })
    const two = quiet({ revenue: { ...rev, intelligence: { ...rev.intelligence, refundsInPeriod: { amount: money(2_000_000), count: 2, comparison: cmp(2_000_000, 1_000_000), basis: 'refund_ledger_by_refund_date' } } } })
    expect(rules(two)).not.toContain('refunds_rise')
    const rate = quiet({ revenue: { ...rev, intelligence: { ...rev.intelligence, refundRate: { pct: 12, basis: 'completed_refunds_over_confirmed_revenue' } } } })
    expect(buildInsights(rate).insights.find(i => i.rule === 'refund_rate_high')).toMatchObject({ severity: 'warning', evidence: { value: 12, unit: 'pct' } })
  })

  it('23 · discount-heavy needs the coupons panel and ≥ 20% of value before discount', () => {
    const rev = quiet().revenue!
    const heavy = { ...rev, intelligence: { ...rev.intelligence, beforeDiscount: { paise: money(10_000_000), discount: money(3_000_000), basis: 'confirmed_revenue_plus_discount_given' as const } } }
    expect(rules(quiet({ revenue: heavy }))).toContain('discount_heavy')
    expect(rules(quiet({ revenue: heavy, capabilities: { modules: ['revenue'], panels: [] } }))).not.toContain('discount_heavy')
  })
})

// ─── Communications ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-31 · communications', () => {
  const comms = (over: Partial<AnalyticsResponse['communications']>) => quiet({ communications: { ...quiet().communications, ...over } })

  it('24 · delivery rate below 90% over ≥ 100 known outcomes ⇒ warning, via the module\'s own deliveryRate', () => {
    const c = buildInsights(comms({ channels: [
      { key: 'email', label: 'Email', support: 'supported', delivery: ch({ sent: 1_000, delivered: 800, failed: 150, unknown: 50 }) },
      { key: 'sms', label: 'SMS', support: 'not_implemented' },
    ] })).insights.find(i => i.rule === 'comm_delivery_low')!
    expect(c.evidence.value).toBe(84)                   // 800 ÷ (800 + 150) — unknown is NOT in the divisor
    expect(c.evidence.field).toBe('communications.channels[email].delivery')
    expect(c.summary).toMatch(/Timed-out sends are not counted as failures/)
    expect(ENGINE).toContain("import { deliveryRate, unconfirmedShare } from '@/lib/analytics/communicationsModel'")
  })

  it('25 · unknown is never folded into failed: 50 timeouts on 950 delivered leave the rate at 100%', () => {
    expect(rules(comms({ channels: [{ key: 'email', label: 'Email', support: 'supported', delivery: ch({ sent: 1_000, delivered: 950, failed: 0, unknown: 50 }) }] }))).not.toContain('comm_delivery_low')
  })

  it('26 · unsupported channels are skipped even when someone hands them numbers', () => {
    expect(rules(comms({ channels: [{ key: 'sms', label: 'SMS', support: 'not_implemented', delivery: ch({ sent: 1_000, delivered: 100, failed: 900 }) }] }))).not.toContain('comm_delivery_low')
    expect(ENGINE).not.toMatch(/'sms'|'push'|spend|costPaise/)
  })

  it('27 · wallet-held ≥ 1 ⇒ warning; bounces ≥ 2% of ≥ 100 sent ⇒ warning; unconfirmed ≥ 50% ⇒ info', () => {
    const intel = quiet().communications.intelligence
    expect(buildInsights(comms({ intelligence: { ...intel, whatsapp: { read: 0, walletSkipped: 4, basis: 'meta_status_and_wallet_skip_reason' } } })).insights.find(i => i.rule === 'comm_wallet_held')).toMatchObject({ severity: 'warning', evidence: { value: 4 } })
    expect(buildInsights(comms({ intelligence: { ...intel, email: { bounces: 20, complaints: 1, basis: 'provider_webhook_error_reason' } } })).insights.find(i => i.rule === 'comm_bounces')).toMatchObject({ severity: 'warning', evidence: { value: 20, thresholds: { bounceWarnPct: 2 } } })
    const thin = comms({ channels: [{ key: 'email', label: 'Email', support: 'supported', delivery: ch({ sent: 1_000, delivered: 4, failed: 0 }) }] })
    expect(buildInsights(thin).insights.find(i => i.rule === 'comm_unconfirmed_high')).toMatchObject({ severity: 'info', evidence: { value: 100 } })
  })

  it('28 · volume change rides the 12-28 window ComparedMetric with the count floors', () => {
    const intel = quiet().communications.intelligence
    const c = buildInsights(comms({ intelligence: { ...intel, window: { ...intel.window, attempted: cmp(400, 200) } } })).insights.find(i => i.rule === 'comm_volume_growth')!
    expect(c.evidence).toMatchObject({ field: 'communications.intelligence.window.attempted', window: 'period', value: 400, baseline: 200 })
  })
})

// ─── Participants ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-31 · participants (registrations, never people)', () => {
  it('29 · walk-in share ≥ 25% of ≥ 50 registrations ⇒ observation', () => {
    const c = buildInsights(quiet({ participants: { composition: { ...quiet().participants!.composition, source: { online: 60, walkin: 40, unrecorded: 0 } } } })).insights.find(i => i.rule === 'source_walkin_share')!
    expect(c).toMatchObject({ severity: 'info', evidence: { field: 'participants.composition.source.walkin', value: 40 } })
    expect(c.title).toMatch(/of registrations/)
  })

  it('30 · pass concentration ≥ 80% with ≥ 2 passes ⇒ observation; the remainder row never wins', () => {
    const comp = quiet().participants!.composition
    expect(buildInsights(quiet({ participants: { composition: { ...comp, passMix: [{ label: 'General', value: 90, sharePct: 90 }, { label: 'VIP', value: 10, sharePct: 10 }] } } })).insights.find(i => i.rule === 'pass_concentration')).toMatchObject({ evidence: { value: 90 } })
    expect(rules(quiet({ participants: { composition: { ...comp, passMix: [{ label: 'General', value: 10, sharePct: 10 }, { label: 'Other passes', value: 90, sharePct: 90 }] } } }))).not.toContain('pass_concentration')
  })

  it('31 · pending backlog ≥ 20 ⇒ warning with an approval action', () => {
    expect(buildInsights(regs({ pending: 25 })).insights.find(i => i.rule === 'pending_backlog')).toMatchObject({ severity: 'warning', evidence: { thresholds: { pendingBacklogMin: PENDING_BACKLOG_MIN } }, action: { label: 'Review pending registrations' } })
  })

  it('32 · no participants block ⇒ no composition card; and no unique/returning/demographic word anywhere', () => {
    const rest: Partial<AnalyticsResponse> = { ...quiet() }; delete rest.participants
    expect(rules(rest as AnalyticsResponse).filter(r => /source|pass_/.test(r))).toEqual([])
    for (const src of [ENGINE, UI]) {
      expect(src).not.toMatch(/unique participants|\breturning\b|demograph|\bage\b|\bgender\b|\bcity\b|formResponses|attendee\./i)
    }
  })

  it('33 · day concentration needs ≥ 14 covered days, Σ ≥ 50 and one day ≥ 40%', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-08-${String(13 + (i % 18)).padStart(2, '0')}`, value: i === 5 ? 60 : 2 }))
    const c = buildInsights(regs({ byDay: days })).insights.find(i => i.rule === 'day_concentration')!
    expect(c.evidence).toMatchObject({ field: 'registrations.byDay', window: 'period', value: 60, thresholds: { minCoveredDays: 14, minSum: 50 } })
    expect(rules(regs({ byDay: days.slice(0, 10) }))).not.toContain('day_concentration')
    expect(rules(quiet({ coverage: { since: '2026-09-01', partial: true, unavailable: false }, registrations: { ...quiet().registrations, byDay: days } }))).not.toContain('day_concentration')
  })
})

// ─── Dedup, ranking, cap, provenance, isolation, purity ─────────────────────

describe('RD-ANALYTICS-12-31 · engine discipline', () => {
  const busy = (): AnalyticsResponse => {
    const q = quiet()
    return quiet({
      registrations: { ...q.registrations, period: { confirmed: cmp(80, 40), cancelled: cmp(40, 20) }, capacityUsedPct: 105, confirmed: 420, remaining: -20, pending: 30 },
      overview: { ...q.overview, checkedIn: cmp(80, 40), revenuePaise: cmp(4_000_000, 2_000_000) },
      operations: { ...q.operations, attendance: { confirmed: 420, checkedIn: 100, pct: 24, awaited: 320, over: false } },
      communications: { ...q.communications, intelligence: { ...q.communications.intelligence, whatsapp: { read: 0, walletSkipped: 3, basis: 'meta_status_and_wallet_skip_reason' }, email: { bounces: 20, complaints: 0, basis: 'provider_webhook_error_reason' }, window: { ...q.communications.intelligence.window, attempted: cmp(400, 200) } } },
      participants: { composition: { ...q.participants!.composition, source: { online: 60, walkin: 60, unrecorded: 0 } } },
    })
  }

  it('34 · at most six are surfaced, deterministically, in severity → priority → magnitude → id order', () => {
    const a = buildInsights(busy()), b = buildInsights(busy())
    expect(a.insights.length).toBe(MAX_SURFACED)
    expect(a.candidates).toBeGreaterThan(MAX_SURFACED)
    expect(a.insights.map(i => i.id)).toEqual(b.insights.map(i => i.id))
    expect(a.insights.map(i => i.rule)).toEqual([
      'capacity_exceeded', 'awaiting_large', 'pending_backlog', 'comm_wallet_held', 'comm_bounces', 'cancellations_rise',
    ])
    expect(a.insights.map(i => i.severity)).toEqual(['critical', 'warning', 'warning', 'warning', 'warning', 'warning'])
  })

  it('35 · one card per evidence field: the capacity states collapse to the most severe', () => {
    const r = buildInsights(regs({ capacityUsedPct: 105, confirmed: 420, remaining: -20 }))
    expect(r.insights.filter(i => i.evidence.field === 'registrations.capacityUsedPct')).toHaveLength(1)
    expect(r.insights[0].rule).toBe('capacity_exceeded')
  })

  it('36 · every card carries full provenance, and its field resolves to a real value in the payload', () => {
    const payload = busy()
    for (const i of buildInsights(payload).insights) {
      expect(i.id).toBe(`${i.rule}:ev-a:${RANGE.from}:${RANGE.to}`)
      expect(i.scope).toEqual({ eventSlug: 'ev-a', eventId: 'draft-A' })
      expect(i.evidence.range).toEqual(RANGE)
      expect(i.evidence.coverage).toEqual({ partial: false, since: '2026-01-01' })
      expect(Object.keys(i.evidence.thresholds).length).toBeGreaterThanOrEqual(0)
      expect(['lifetime', 'period']).toContain(i.evidence.window)
      // The cited path exists on the payload (bracketed channel paths resolve to the channel entry).
      const path = i.evidence.field.replace(/\[(\w+)\]/, '.$1')
      const resolved = path.split('.').reduce<unknown>((o, k) => {
        if (o === null || typeof o !== 'object') return undefined
        if (Array.isArray(o)) return (o as { key?: string }[]).find(x => x.key === k)
        return (o as Record<string, unknown>)[k]
      }, payload)
      expect(resolved, i.evidence.field).not.toBeUndefined()
    }
  })

  it('37 · failure isolation: revenue absent, communications null, participants absent — the others still fire', () => {
    const q = busy()
    const rest: Partial<AnalyticsResponse> = { ...q }; delete rest.revenue; delete rest.participants
    const broken = {
      ...rest, financialAllowed: false,
      overview: { registrations: q.overview.registrations, checkedIn: q.overview.checkedIn, fillPct: null },
      communications: { ...q.communications, channels: q.communications.channels.map(c => ({ ...c, delivery: undefined })), intelligence: unmeasuredCommunicationIntelligence(RANGE), totalMessages: null },
    } as AnalyticsResponse
    const out = rules(broken)
    expect(out).toContain('capacity_exceeded')
    expect(out).toContain('awaiting_large')
    expect(out).toContain('pending_backlog')
    expect(out.filter(r => /revenue|refund|comm_|source|pass_/.test(r))).toEqual([])
  })

  it('38 · a rule that throws on a malformed field is dropped alone', () => {
    const q = busy()
    const malformed = { ...q, communications: null } as unknown as AnalyticsResponse
    const out = rules(malformed)
    expect(out).toContain('capacity_exceeded')
    expect(out.filter(r => r.startsWith('comm_'))).toEqual([])
  })

  it('39 · the engine is pure: no Firebase, no fetch, no Date, no randomness; and it is O(rules)', () => {
    expect(ENGINE).not.toMatch(/firebase|adminDb|fetch\(|Date\.now|new Date|Math\.random|process\.env/)
    const payload = busy()
    const t = performance.now()
    for (let i = 0; i < 1_000; i++) buildInsights(payload)
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('40 · labels default to the scope\'s own range wording, matching the page header', () => {
    expect(rangeLabels(RANGE)).toEqual({ windowLabel: 'last 30 days', baselineLabel: 'the 30 days before' })
    expect(rangeLabels({ from: 'x', to: 'y', preset: 'custom' })).toEqual({ windowLabel: 'selected period', baselineLabel: 'the preceding period' })
  })

  it('41 · lifetime and period never share a sentence: windowed cards say the window, lifetime cards say all time', () => {
    for (const i of buildInsights(busy()).insights) {
      const text = `${i.title} ${i.summary}`
      if (i.evidence.window === 'period') expect(text).toMatch(/last 30 days/)
      else expect(text).toMatch(/all time|so far|awaiting arrival|held for wallet|Pending registrations/)
    }
  })

  it('42 · the copy never claims statistical significance, and the UI never prints a field path', () => {
    for (const src of [ENGINE, UI]) expect(src).not.toMatch(/statistically significant|confidence score|AI-generated|powered by AI/i)
    expect(UI).not.toMatch(/\{e\.field\}|evidence\.field\}/)
    expect(UI).toMatch(/No significant changes detected/)
    expect(UI).not.toMatch(/lack permission|hidden because/i)
  })
})
