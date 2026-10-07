// RD-ANALYTICS-09 — Revenue Intelligence.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// Financial defects do not look like errors. They look like a number. Each rule below has
// a failure mode that renders as a confident, plausible, wrong rupee figure:
//
//   an unreadable ledger presented as ₹0 collected
//   a TRUNCATED ledger sum presented as a total
//   a gateway capture figure wearing the word "Revenue"
//   refund-pending amounts subtracted as if the money had gone back
//   a rupee subtraction performed in floating point at the presentation layer
//   a lifetime figure carrying a period comparison chip
//   any financial byte at all reaching a caller without `transactions`

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  inrPaise, displayMoney, moneyUnavailableNote, revenueHeadlines, gatewayRows,
  gatewayAvailability, periodRevenue, revenueByPass, payingPopulation,
} from '@/lib/analytics/revenueModel'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import { presetRange } from '@/lib/analytics/dateRange'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { RevenueAnalytics } from '@/lib/analytics/contract'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'

/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const RANGE = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))
const m  = (paise: number) => ({ ok: true as const, paise })
const no = (reason: 'query_failed' | 'out_of_budget') => ({ ok: false as const, reason })

const caps = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
  eventType: 'conference', registrationRules: null, applications: null,
  gate: { flags: { coupons: true, broadcast: true, certificates: true, donations: true },
          has: () => true } as unknown as AnalyticsModuleContext['gate'],
  financeAllowed: true,
  ...over,
})

const producer = (over: Partial<EventAnalytics> = {}): EventAnalytics => ({
  eventId: 'e', eventName: 'E', lifecycleStatus: 'published', publishedAt: null,
  truncated: false,
  limits: { registrations: true, communications: true, reminders: true,
            certificates: true, ledger: true, passValue: true },
  financialAllowed: true,
  range: RANGE,
  period:   { confirmed: 10, cancelled: 2, checkedIn: 0, revenuePaise: 250_000 },
  baseline: { confirmed: 8,  cancelled: 4, checkedIn: 0, revenuePaise: 200_000 },
  coverageSince: '2026-01-01', coveragePartial: false, baselineOutsideCoverage: false,
  kpis: { registrations: 100, confirmed: 60, pending: 10, cancelled: 20, rejected: 5,
          waitlisted: 5, paid: 55, free: 20, paymentPending: 15, refunded: 6,
          refundPending: 4, checkedIn: 0, conversionPct: 60, capacity: 200,
          capacityUsedPct: 30, remaining: 140 },
  registrationsByDay: [{ date: '2026-06-15', label: '6/15', value: 10 }],
  cancellationsByDay: [{ date: '2026-06-15', label: '6/15', value: 2 }],
  revenueByDay:       [{ date: '2026-06-15', label: '6/15', value: 250_000 }],
  passRevenue:        [{ label: 'General', value: 300_000 }, { label: 'VIP', value: 100_000 }],
  paymentStatus: [], passSales: [{ label: 'General', value: 60 }],
  couponUsage: [], checkInsByDay: [], funnel: [],
  financial: {
    confirmedRevenuePaise: m(500_000),
    netRevenuePaise:       m(480_000),
    grossPaise: m(510_000), platformFeePaise: m(10_000), gstPaise: m(1_800),
    gatewayFeePaise: m(9_000), netPaise: m(489_200),
    refundsPaise: m(20_000), refundCount: 4,
    communicationCostPaise: m(300), profitEstimatePaise: m(468_900),
  },
  communication: null, reminders: null, certificates: null,
  // RD-ANALYTICS-10 · operational capabilities come from the event's OWN configuration.
  operationalCapabilities: { identifiersEnabled: false, identifierLabel: null,
                             timingEnabled: false, timingLabel: null },
  identifierProgress: null,
  timingProgress:     null,
  dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  ...over,
})

const run = (p?: Partial<EventAnalytics>, c?: Partial<AnalyticsModuleContext>) =>
  normalizeEventAnalytics({
    analytics: producer(p), range: RANGE, capabilities: caps(c), eventId: 'draft-A',
  })

const rev = (over: Partial<RevenueAnalytics> = {}): RevenueAnalytics =>
  ({ ...run().revenue!, ...over })

// ─── A/D · Canonical revenue and the net formula ──────────────────────────────

describe('RD-ANALYTICS-09 · the canonical figures', () => {
  it('1 · confirmed revenue reaches the contract unchanged from the canonical reader', () => {
    expect(run().revenue!.confirmedRevenue).toEqual(m(500_000))
    // …and is NOT the gateway gross, which is a different population.
    expect(run().revenue!.grossCollected).toEqual(m(510_000))
    expect(run().revenue!.confirmedRevenue).not.toEqual(run().revenue!.grossCollected)
  })

  it('2 · net revenue is confirmed revenue LESS completed refunds — in integer paise', () => {
    const r = run().revenue!
    expect(r.netRevenue).toEqual(m(500_000 - 20_000))
    expect(r.netRevenue.ok && Number.isInteger(r.netRevenue.paise)).toBe(true)
  })

  it('3 · net revenue is WITHHELD when either input is unmeasured', () => {
    const noRevenue = run({ financial: { ...producer().financial!,
      confirmedRevenuePaise: no('query_failed'), netRevenuePaise: no('query_failed') } })
    expect(noRevenue.revenue!.netRevenue.ok).toBe(false)
  })

  it('4 · the producer never subtracts across an unmeasured side', () => {
    // The guard is on the producer's own arithmetic, not on a fixture.
    const src = code('lib/analytics/eventAnalytics.ts')
    // RD-FIN-02 · net subtracts only refunds of STILL-confirmed registrations — both sides measured.
    expect(src).toContain('confirmedRevenueMoney.ok && refundsVsConfirmed.ok')
    expect(src).toContain('netMoney.ok && refundsMoney.ok && commMoney.ok')
  })

  it('5 · the profit formula is unchanged: net settlement − refunds − comms', () => {
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toContain('money(netMoney.paise - refundsMoney.paise - commMoney.paise)')
  })
})

// ─── B/C/O · Refunds ──────────────────────────────────────────────────────────

describe('RD-ANALYTICS-09 · refunds', () => {
  it('6 · completed refunds and refund-PENDING are different rows from different sources', () => {
    const r = run()
    // Money: the refund ledger. Count: registration payment status. Never mixed.
    expect(r.revenue!.refunds).toEqual(m(20_000))
    expect(r.revenue!.refundCount).toBe(4)
    expect(r.registrations.refundPending).toBe(4)
    const pending = payingPopulation(r.registrations).find(x => x.key === 'refundPending')
    expect(pending?.definition).toMatch(/not yet completed/i)
  })

  it('7 · a pending refund is never subtracted from revenue', () => {
    // netRevenue uses `refunds` (completed) only. 4 pending refunds change nothing.
    expect(run().revenue!.netRevenue).toEqual(m(480_000))
  })

  it('8 · a refund-only event reports a NEGATIVE net rather than clamping to zero', () => {
    // Clamping would hide a real accounting state behind a comfortable number.
    const r = run({ financial: { ...producer().financial!,
      confirmedRevenuePaise: m(10_000), refundsPaise: m(25_000),
      netRevenuePaise: m(10_000 - 25_000) } })
    expect(r.revenue!.netRevenue).toEqual(m(-15_000))
  })
})

// ─── K · Failed and truncated financial reads ─────────────────────────────────

describe('RD-ANALYTICS-09 · an unreadable ledger is never ₹0', () => {
  it('9 · a failed gateway read renders a reason, not a figure', () => {
    // All five gateway figures come from ONE read, so they share a fate — the producer
    // derives every one through `ledgerMoney`. Overriding a subset would be a state the
    // system cannot actually reach.
    const gone = no('query_failed')
    const r = rev({ grossCollected: gone, platformFee: gone, gst: gone,
                    gatewayFee: gone, netSettlement: gone })
    expect(displayMoney(r.grossCollected)).toBeNull()
    expect(moneyUnavailableNote(r.grossCollected)).toBe('could not be read')
    expect(gatewayAvailability(r).anyMeasured).toBe(false)
    // The producer's single derivation is what guarantees the shared fate.
    const src = code('lib/analytics/eventAnalytics.ts')
    expect((src.match(/ledgerMoney\(/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('10 · a TRUNCATED ledger says so — a partial sum is not a total', () => {
    const r = rev({ grossCollected: no('out_of_budget') })
    expect(displayMoney(r.grossCollected)).toBeNull()
    expect(moneyUnavailableNote(r.grossCollected)).toBe('too many ledger entries to total safely')
  })

  it('11 · the producer reads CAP + 1 so overflow is DETECTABLE', () => {
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toContain('.limit(CAP + 1)')
    expect(src).toContain('ptx.docs.length > CAP')
    expect(src).toContain("gone(ledgerTruncated ? 'out_of_budget' : 'query_failed')")
  })

  it('12 · a truncated ledger also lowers `limits.ledger`', () => {
    // The flag and the figures must agree; a consumer trusting one over the other is how a
    // partial total gets rendered under a "complete" badge.
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toContain('ledger:         !includeFinancial || ledgerAvailable')
    expect(src).toContain('ledgerTruncated = true')
  })
})

// ─── E/F · Financial authorization ────────────────────────────────────────────

describe('RD-ANALYTICS-09 · the financial boundary', () => {
  it('13 · without `transactions` the revenue key is ABSENT, not null', () => {
    const out = normalizeEventAnalytics({
      analytics: producer({ financial: undefined, financialAllowed: false,
                            revenueByDay: undefined, passRevenue: undefined,
                            period: { confirmed: 10, cancelled: 2, checkedIn: 0 },
                            baseline: { confirmed: 8, cancelled: 4, checkedIn: 0 } }),
      range: RANGE, capabilities: caps({ financeAllowed: false }), eventId: 'draft-A',
    })
    expect('revenue' in out).toBe(false)
    expect(out.financialAllowed).toBe(false)
  })

  it('14 · no money survives serialization for an unauthorized caller', () => {
    const out = normalizeEventAnalytics({
      analytics: producer({ financial: undefined, financialAllowed: false,
                            revenueByDay: undefined, passRevenue: undefined,
                            period: { confirmed: 10, cancelled: 2, checkedIn: 0 },
                            baseline: { confirmed: 8, cancelled: 4, checkedIn: 0 } }),
      range: RANGE, capabilities: caps({ financeAllowed: false }), eventId: 'draft-A',
    })
    const json = JSON.stringify(out)
    for (const probe of [/Paise/, /revenue/i, /refund[sC]/, /profit/i, /gateway/i, /settlement/i]) {
      expect(json, String(probe)).not.toMatch(probe)
    }
  })

  it('15 · the period revenue comparison is omitted too', () => {
    const out = normalizeEventAnalytics({
      analytics: producer({ financial: undefined, financialAllowed: false,
                            period: { confirmed: 10, cancelled: 2, checkedIn: 0 },
                            baseline: { confirmed: 8, cancelled: 4, checkedIn: 0 } }),
      range: RANGE, capabilities: caps({ financeAllowed: false }), eventId: 'draft-A',
    })
    expect('revenuePaise' in out.overview).toBe(false)
    expect(periodRevenue(out)).toBeNull()
  })

  it('16 · the module never becomes a second authorization boundary', () => {
    const ui = code('components/analytics/revenue/RevenueAnalytics.tsx')
    // It renders what it was SENT. It must not decide entitlement from a permission list.
    expect(ui).not.toMatch(/permissions|transactions'\]|hasPermission/)
    expect(ui).toContain('data.revenue')
    const page = code('app/(dashboard)/dashboard/analytics/revenue/page.tsx')
    expect(page).not.toMatch(/permission|authorize/i)
  })
})

// ─── G/H/I/J · Range, comparison, coverage ────────────────────────────────────

describe('RD-ANALYTICS-09 · period, comparison and coverage', () => {
  it('17 · the period revenue figure is the WINDOW, not the lifetime total', () => {
    const out = run()
    expect(out.revenue!.confirmedRevenue).toEqual(m(500_000))   // lifetime
    expect(out.overview.revenuePaise!.value).toBe(250_000)      // window
    expect(out.overview.revenuePaise!.baseline).toBe(200_000)
    expect(out.overview.revenuePaise!.delta).toEqual({ pct: 25, direction: 'up' })
  })

  it('18 · a ZERO baseline yields no percentage — never +∞%', () => {
    const out = run({ baseline: { confirmed: 8, cancelled: 4, checkedIn: 0, revenuePaise: 0 } })
    expect(out.overview.revenuePaise!.baseline).toBe(0)
    expect(out.overview.revenuePaise!.delta?.pct).toBeNull()
    expect(JSON.stringify(out.overview)).not.toMatch(/Infinity|NaN/)
  })

  it('19 · zero in both windows is flat, and a drop to zero is a real −100%', () => {
    const flat = run({ period: { confirmed: 0, cancelled: 0, checkedIn: 0, revenuePaise: 0 },
                       baseline: { confirmed: 0, cancelled: 0, checkedIn: 0, revenuePaise: 0 } })
    expect(flat.overview.revenuePaise!.delta?.pct).toBeNull()

    const dropped = run({ period: { confirmed: 0, cancelled: 0, checkedIn: 0, revenuePaise: 0 } })
    expect(dropped.overview.revenuePaise!.delta).toEqual({ pct: -100, direction: 'down' })
  })

  it('20 · an unmeasured window reports not_measured, and a pre-coverage baseline says why', () => {
    const unmeasured = run({ period: { confirmed: null, cancelled: null, checkedIn: null, revenuePaise: null },
                             baseline: null, revenueByDay: null })
    expect(unmeasured.overview.revenuePaise!.value).toBeNull()
    expect(unmeasured.overview.revenuePaise!.unavailable).toBe('not_measured')
    expect(unmeasured.revenue!.byDay).toBeNull()

    const outside = run({ baseline: null, baselineOutsideCoverage: true })
    expect(outside.overview.revenuePaise!.delta).toBeNull()
    expect(outside.overview.revenuePaise!.unavailable).toBe('outside_coverage')
  })

  it('21 · the revenue series and the period total describe the SAME rows', () => {
    const out = run()
    const summed = (out.revenue!.byDay ?? []).reduce((n, p) => n + p.valuePaise, 0)
    expect(summed).toBe(out.overview.revenuePaise!.value)
  })

  it('22 · the module reuses the shared comparison rather than deriving a second one', () => {
    const src = code('lib/analytics/revenueModel.ts')
    expect(src).toContain('data.overview.revenuePaise')
    expect(src).not.toContain('computeDelta')
    expect(src).not.toContain('previousPeriod')
  })
})

// ─── L · Pass revenue ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-09 · revenue by pass', () => {
  it('23 · shares use the passes\' own total, and the basis is LIFETIME', () => {
    const d = revenueByPass(run().revenue!)
    expect(d.totalPaise).toBe(400_000)
    expect(d.rows.find(r => r.label === 'General')?.pct).toBe(75)
    expect(d.basis).toBe('lifetime_confirmed')
    const ui = code('components/analytics/revenue/RevenueAnalytics.tsx')
    expect(ui).toContain('all time — not limited to the selected period')
  })

  it('24 · an incomplete per-pass read publishes nothing rather than a partial split', () => {
    // The producer only fills passRevenue when aggregateValueByPass reports complete.
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toContain('passRevenue: passValue.complete ? toPoints(passRev).slice(0, 8) : []')
  })

  it('25 · a zero total yields no percentages rather than a divide-by-zero', () => {
    const d = revenueByPass(rev({ byPass: [{ label: 'Free', valuePaise: 0 }] }))
    expect(d.rows[0].pct).toBeNull()
  })
})

// ─── Terminology ──────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-09 · terminology', () => {
  it('26 · every money row carries its own definition', () => {
    for (const row of [...revenueHeadlines(run().revenue!), ...gatewayRows(run().revenue!)]) {
      expect(row.definition.length, row.key).toBeGreaterThan(10)
    }
  })

  it('27 · no gateway figure is called bare "Revenue"', () => {
    for (const row of gatewayRows(run().revenue!)) {
      expect(row.label, row.key).not.toBe('Revenue')
      expect(row.label, row.key).not.toBe('Confirmed revenue')
    }
    expect(gatewayRows(run().revenue!).map(r => r.label))
      .toEqual(['Gross collected', 'Platform fee', 'GST on platform fee', 'Gateway fee', 'Net settlement'])
  })

  it('28 · paying-population rows are COUNTS and never carry money', () => {
    const rows = payingPopulation(run().registrations)
    for (const r of rows) expect(typeof r.value === 'number' || r.value === null).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/Paise|₹/)
  })
})

// ─── §16 · Financial display ──────────────────────────────────────────────────

describe('RD-ANALYTICS-09 · currency handling', () => {
  it('29 · paise become rupees ONCE, at the presentation boundary', () => {
    expect(inrPaise(12_500_000)).toBe('₹1,25,000')
    expect(inrPaise(845_000)).toBe('₹8,450')
    expect(inrPaise(0)).toBe('₹0')
  })

  it('30 · no float arithmetic touches a canonical financial figure', () => {
    for (const p of ['lib/analytics/revenueModel.ts',
                     'components/analytics/revenue/RevenueAnalytics.tsx']) {
      const src = code(p)
      expect(src, p).not.toMatch(/parseFloat|toFixed\(2\)/)
      // The only division is the one inside the formatter.
      if (p.endsWith('.tsx')) expect(src).not.toMatch(/\/\s*100\b/)
    }
  })

  it('31 · an unavailable figure never formats as ₹0', () => {
    expect(displayMoney(no('query_failed'))).toBeNull()
    expect(displayMoney(undefined)).toBeNull()
    expect(displayMoney(m(0))).toBe('₹0')      // a MEASURED zero still shows
  })
})

// ─── P · No unbounded transaction read ────────────────────────────────────────

describe('RD-ANALYTICS-09 · read behaviour', () => {
  it('32 · the module adds no data access of its own', () => {
    for (const p of ['lib/analytics/revenueModel.ts',
                     'components/analytics/revenue/RevenueAnalytics.tsx']) {
      const src = code(p)
      expect(src, p).not.toMatch(/adminDb|collection\(|firebase|\.limit\(/)
    }
  })

  it('33 · exactly ONE platformTransactions read exists, and it is bounded', () => {
    const src = code('lib/analytics/eventAnalytics.ts')
    expect((src.match(/collection\('platformTransactions'\)/g) ?? [])).toHaveLength(1)
    expect(src).toContain(".where('entityId', '==', eventId).limit(CAP + 1)")
  })

  it('34 · the financial read is skipped entirely without the permission', () => {
    const src = code('lib/analytics/eventAnalytics.ts')
    // The ternary is the gate: no permission, no query object at all.
    expect(src).toContain('const ptx = includeFinancial')
  })
})

// ─── M/N · Empty and free events ──────────────────────────────────────────────

describe('RD-ANALYTICS-09 · empty and free events', () => {
  it('35 · an event with no financial activity shows measured zeros, not blanks', () => {
    const out = run({ financial: {
      confirmedRevenuePaise: m(0), netRevenuePaise: m(0), grossPaise: m(0),
      platformFeePaise: m(0), gstPaise: m(0), gatewayFeePaise: m(0), netPaise: m(0),
      refundsPaise: m(0), refundCount: 0, communicationCostPaise: m(0),
      profitEstimatePaise: m(0),
    }, revenueByDay: [], passRevenue: [] })
    const r = out.revenue!
    expect(displayMoney(r.confirmedRevenue)).toBe('₹0')
    expect(gatewayAvailability(r).anyMeasured).toBe(true)
    expect(revenueByPass(r).rows).toEqual([])
  })

  it('36 · a FREE event still reports its confirmed revenue as a real ₹0', () => {
    const out = run({ financial: { ...producer().financial!,
      confirmedRevenuePaise: m(0), netRevenuePaise: m(0), refundsPaise: m(0), refundCount: 0 } })
    const headlines = revenueHeadlines(out.revenue!)
    expect(headlines.find(h => h.key === 'confirmed')?.money).toEqual(m(0))
    expect(headlines.find(h => h.key === 'net')?.money).toEqual(m(0))
  })
})

// ─── UI contract ──────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-09 · the module UI', () => {
  const UI = code('components/analytics/revenue/RevenueAnalytics.tsx')

  it('37 · no lifetime money figure carries a comparison chip', () => {
    // The headline metric component takes a row, not a delta.
    expect(UI).toContain('function MoneyMetric({ row }')
    const metric = UI.slice(UI.indexOf('function MoneyMetric'), UI.indexOf('function ProfitNote'))
    expect(metric).not.toContain('DeltaChip')
    // The only chip sits with the period figure, in the trend header.
    expect(UI).toContain('<DeltaChip delta={period.delta} />')
  })

  it('38 · an unmeasured figure renders a mark and a reason, never ₹0', () => {
    expect(UI).toContain('UNAVAILABLE_MARK')
    expect(UI).toContain('moneyUnavailableNote')
    expect(UI).not.toMatch(/\?\?\s*0/)
  })

  it('39 · the profit estimate appears only when the producer published one', () => {
    expect(UI).toContain('if (!revenue.profitEstimate.ok) return null')
    // …and its formula is on screen, not implied by the label.
    expect(UI).toContain('net settlement less completed refunds less communication spend')
  })

  it('40 · a caller with no financial access is told, not shown an empty page', () => {
    expect(UI).toContain('function NoFinancialAccess')
    expect(UI).toContain('requires the Transactions permission')
  })

  it('41 · coverage and ledger completeness are both disclosed', () => {
    expect(UI).toContain('data.limits.ledger')
    expect(UI).toContain('daily analytics begin')
  })

  it('42 · the chart caption names the days DRAWN, not the days requested', () => {
    expect(UI).toContain('function drawnRange')
    expect(UI).toContain('s[0].date')
  })
})
