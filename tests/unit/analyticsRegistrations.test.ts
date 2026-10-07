// RD-ANALYTICS-08 — Registrations Intelligence.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// Every rule here has a failure mode that renders as a confident, wrong number rather than
// as an error — which is why they are asserted directly rather than inferred from a
// screenshot:
//
//   a composition that reconciles to 100% while a state was never measured
//   a payment split whose categories overlap, so the parts exceed the whole
//   a "waitlisted: 0" row on an event whose organizer never enabled the waitlist
//   a lifetime per-pass tally captioned as period data
//   a percentage taken against a null or zero denominator
//   a delta computed against a baseline that does not exist

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  statusComposition, paymentComposition, drawableSegments, passDistribution,
  waitlistEnabled, share,
} from '@/lib/analytics/registrationsModel'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import { presetRange } from '@/lib/analytics/dateRange'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { AnalyticsResponse, RegistrationAnalytics } from '@/lib/analytics/contract'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'

/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const RANGE = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))

const reg = (over: Partial<RegistrationAnalytics> = {}): RegistrationAnalytics => ({
  total: 100, confirmed: 60, pending: 10, cancelled: 20, rejected: 5, waitlisted: 5,
  paid: 55, free: 20, paymentPending: 15, refunded: 6, refundPending: 4,
  byDay: [{ date: '2026-06-14', value: 3 }, { date: '2026-06-15', value: 7 }],
  cancelledByDay: [{ date: '2026-06-14', value: 1 }, { date: '2026-06-15', value: 0 }],
  period: {
    confirmed: { value: 10, baseline: 8, delta: { pct: 25, direction: 'up' } },
    cancelled: { value: 1,  baseline: 2, delta: { pct: 50, direction: 'down' } },
  },
  byPass: [{ label: 'General', value: 40 }, { label: 'VIP', value: 20 }],
  byPassBasis: 'lifetime_confirmed',
  capacity: 200, capacityUsedPct: 30, remaining: 140,
  ...over,
})

// ─── A · Registration KPI semantics ───────────────────────────────────────────

describe('RD-ANALYTICS-08 · KPI semantics', () => {
  it('1 · the two "pending" populations are never merged', () => {
    const s = statusComposition(reg(), { waitlistEnabled: true })
    const p = paymentComposition(reg())
    // The lifecycle one is approval; the payment one is money. Different rows, different
    // words, and neither is called bare "Pending".
    expect(s.rows.find(r => r.key === 'pending')?.label).toBe('Registration pending')
    expect(p.rows.find(r => r.key === 'paymentPending')?.label).toBe('Awaiting payment')
    const labels = [...s.rows, ...p.rows].map(r => r.label)
    expect(labels).not.toContain('Pending')
    // …and they count different things, so they must not be the same number by accident.
    expect(s.rows.find(r => r.key === 'pending')?.value).toBe(10)
    expect(p.rows.find(r => r.key === 'paymentPending')?.value).toBe(15)
  })

  it('2 · every lifecycle state the product has is represented', () => {
    const keys = statusComposition(reg(), { waitlistEnabled: true }).rows.map(r => r.key)
    expect(keys).toEqual(['confirmed', 'pending', 'cancelled', 'waitlisted', 'rejected'])
  })
})

// ─── B · Status composition ───────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · status composition', () => {
  it('3 · percentages are taken against TOTAL, not against the sum of the parts', () => {
    // 60 + 10 + 20 + 5 + 5 = 100 here, but the denominator must be `total` regardless, or
    // a state the list does not name would be silently absorbed into the others.
    const b = statusComposition(reg(), { waitlistEnabled: true })
    expect(b.total).toBe(100)
    expect(b.rows.find(r => r.key === 'confirmed')?.pct).toBe(60)
    expect(b.unaccounted).toBe(0)
  })

  it('4 · an unnamed remainder is REPORTED, never rescaled away', () => {
    // total 100, named states sum to 70 → 30 rows are in a state this list does not show.
    const b = statusComposition(
      reg({ confirmed: 60, pending: 10, cancelled: 0, rejected: 0, waitlisted: 0 }),
      { waitlistEnabled: true })
    expect(b.unaccounted).toBe(30)
    expect(b.rows.find(r => r.key === 'confirmed')?.pct).toBe(60)   // not 85.7
  })

  it('5 · an unmeasured state makes the composition incomplete, not 100%', () => {
    const b = statusComposition(reg({ cancelled: null }), { waitlistEnabled: true })
    expect(b.incomplete).toBe(true)
    expect(b.rows.find(r => r.key === 'cancelled')?.value).toBeNull()
    expect(b.rows.find(r => r.key === 'cancelled')?.pct).toBeNull()
    // The shortfall cannot be attributed — it may be the unmeasured state or an unnamed
    // one — so no remainder is claimed either.
    expect(b.unaccounted).toBeNull()
  })

  it('6 · a null denominator yields no percentages at all', () => {
    const b = statusComposition(reg({ total: null }), { waitlistEnabled: true })
    for (const r of b.rows) expect(r.pct).toBeNull()
    expect(b.unaccounted).toBeNull()
  })

  it('7 · only measured, positive states are drawn as segments', () => {
    const b = statusComposition(reg({ cancelled: null, rejected: 0 }), { waitlistEnabled: true })
    const keys = drawableSegments(b).map(s => s.key)
    // An unmeasured state has no width to draw, and a zero one would read as "none".
    expect(keys).not.toContain('cancelled')
    expect(keys).not.toContain('rejected')
    expect(keys).toContain('confirmed')
    // Widths fill the track exactly, so the bar is never a partial-looking sliver.
    const sum = drawableSegments(b).reduce((n, s) => n + s.pct, 0)
    expect(Math.round(sum)).toBe(100)
  })
})

// ─── I · Waitlist disabled ────────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · waitlist', () => {
  it('8 · a disabled waitlist yields NO waitlisted row — not a zero', () => {
    const off = statusComposition(reg(), { waitlistEnabled: false })
    expect(off.rows.map(r => r.key)).not.toContain('waitlisted')
    // A zero would claim nobody queued, when in fact nobody could.
    expect(JSON.stringify(off.rows)).not.toMatch(/Waitlisted/)
  })

  it('9 · availability is read from the resolved capability panels, not re-derived', () => {
    const base = { capabilities: { modules: [], panels: [] } } as unknown as AnalyticsResponse
    const withWaitlist = { capabilities: { modules: [], panels: ['waitlist'] } } as unknown as AnalyticsResponse
    expect(waitlistEnabled(base)).toBe(false)
    expect(waitlistEnabled(withWaitlist)).toBe(true)
    // The module must not consult the raw rules itself; one resolver decides this.
    expect(code('lib/analytics/registrationsModel.ts')).not.toContain('eventHasWaitlist')
  })
})

// ─── C · Payment split ────────────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · payment split', () => {
  it('10 · every row is a distinct paymentStatus, so nothing double-counts', () => {
    const b = paymentComposition(reg())
    expect(b.rows.map(r => r.key))
      .toEqual(['paid', 'free', 'paymentPending', 'refundPending', 'refunded'])
    const sum = b.rows.reduce((n, r) => n + (r.value ?? 0), 0)
    // 55 + 20 + 15 + 4 + 6 = 100, and it may not EXCEED the population.
    expect(sum).toBeLessThanOrEqual(b.total ?? Infinity)
  })

  it('11 · the split is built on paymentStatus, never on the price-derived free/paid', () => {
    // `getRegistrationSplit` also offers free = (amount === 0) and paid = total - free.
    // Mixing a price bucket with a status bucket would let one registration appear twice.
    const src = code('lib/analytics/registrationsModel.ts')
    expect(src).toContain('r.paymentPending')
    expect(src).not.toMatch(/amount\s*===?\s*0/)
  })

  it('12 · an unmeasured payment state does not become zero', () => {
    const b = paymentComposition(reg({ refunded: null }))
    expect(b.rows.find(r => r.key === 'refunded')?.value).toBeNull()
    expect(b.incomplete).toBe(true)
  })

  it('13 · this module publishes COUNTS — no money field is derived here', () => {
    const src = code('lib/analytics/registrationsModel.ts')
    expect(src).not.toMatch(/Paise/)
    expect(code('components/analytics/registrations/RegistrationsAnalytics.tsx')).not.toMatch(/Paise|inr\(/)
  })
})

// ─── share() ──────────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · share', () => {
  it('14 · refuses every denominator that cannot carry a percentage', () => {
    expect(share(5, 0)).toBeNull()
    expect(share(5, null)).toBeNull()
    expect(share(null, 100)).toBeNull()
    expect(share(0, 100)).toBe(0)        // measured and genuinely none — a real 0%
    expect(share(1, 3)).toBe(33.3)
  })
})

// ─── G · Pass distribution ────────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · pass distribution', () => {
  it('15 · per-pass shares use the passes\' own sum, not the whole population', () => {
    // byPass counts CONFIRMED only, so `total` (every status) is the wrong denominator.
    const d = passDistribution(reg())
    expect(d.total).toBe(60)
    expect(d.rows.find(r => r.label === 'General')?.pct).toBe(66.7)
  })

  it('16 · the basis travels with the figure and is LIFETIME, not the period', () => {
    expect(passDistribution(reg()).basis).toBe('lifetime_confirmed')
    // The UI must caption it as such rather than under the selected window.
    const ui = code('components/analytics/registrations/RegistrationsAnalytics.tsx')
    expect(ui).toContain('all time — not limited to the selected period')
  })

  it('17 · an event with no pass counts renders nothing rather than a zero row', () => {
    const d = passDistribution(reg({ byPass: [] }))
    expect(d.rows).toEqual([])
    expect(d.total).toBe(0)
  })
})

// ─── D/E/F · Range, comparison, zero baselines ────────────────────────────────

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
  financialAllowed: false,
  range: RANGE,
  period:   { confirmed: 10, cancelled: 2, checkedIn: 0 },
  baseline: { confirmed: 8,  cancelled: 4, checkedIn: 0 },
  coverageSince: '2026-01-01', coveragePartial: false, baselineOutsideCoverage: false,
  kpis: { registrations: 100, confirmed: 60, pending: 10, cancelled: 20, rejected: 5,
          waitlisted: 5, paid: 55, free: 20, paymentPending: 15, refunded: 6,
          refundPending: 4, checkedIn: 0, conversionPct: 60, capacity: 200,
          capacityUsedPct: 30, remaining: 140 },
  registrationsByDay: [{ date: '2026-06-15', label: '6/15', value: 10 }],
  cancellationsByDay: [{ date: '2026-06-15', label: '6/15', value: 2 }],
  paymentStatus: [], passSales: [{ label: 'General', value: 60 }],
  couponUsage: [], checkInsByDay: [], funnel: [],
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
  }).registrations

describe('RD-ANALYTICS-08 · period, comparison and coverage', () => {
  it('18 · period totals are the WINDOW, never the lifetime figure', () => {
    const r = run()
    expect(r.confirmed).toBe(60)                 // lifetime
    expect(r.period.confirmed.value).toBe(10)    // window
    expect(r.period.confirmed.baseline).toBe(8)
    expect(r.period.confirmed.delta).toEqual({ pct: 25, direction: 'up' })
  })

  it('19 · cancellations are compared too, and are NOT netted into confirmed', () => {
    const r = run()
    expect(r.period.cancelled.value).toBe(2)
    expect(r.period.cancelled.baseline).toBe(4)
    // `computeDelta` reports a SIGNED percentage; the chip is what takes the absolute
    // value for display. Asserting the signed figure is asserting the real contract.
    expect(r.period.cancelled.delta).toEqual({ pct: -50, direction: 'down' })
    // 10 confirmed and 2 cancelled stay two facts; nothing publishes 8.
    expect(r.period.confirmed.value).toBe(10)
  })

  it('20 · a ZERO baseline yields no percentage — never +∞%', () => {
    const r = run({ baseline: { confirmed: 0, cancelled: 0, checkedIn: 0 } })
    expect(r.period.confirmed.baseline).toBe(0)
    expect(r.period.confirmed.delta?.pct).toBeNull()
    expect(JSON.stringify(r.period)).not.toMatch(/Infinity|null%/)
  })

  it('21 · zero in BOTH windows is flat, not a fabricated change', () => {
    const r = run({ period:   { confirmed: 0, cancelled: 0, checkedIn: 0 },
                    baseline: { confirmed: 0, cancelled: 0, checkedIn: 0 } })
    expect(r.period.confirmed.value).toBe(0)
    expect(r.period.confirmed.delta?.pct).toBeNull()
  })

  it('22 · a drop to zero from a real baseline is a genuine −100%', () => {
    const r = run({ period: { confirmed: 0, cancelled: 0, checkedIn: 0 } })
    expect(r.period.confirmed.delta).toEqual({ pct: -100, direction: 'down' })
  })

  it('23 · an unmeasured window reports NOT MEASURED, never zero', () => {
    const r = run({ period: { confirmed: null, cancelled: null, checkedIn: null },
                    baseline: null, registrationsByDay: null, cancellationsByDay: null })
    expect(r.period.confirmed.value).toBeNull()
    expect(r.period.confirmed.delta).toBeNull()
    expect(r.period.confirmed.unavailable).toBe('not_measured')
    expect(r.byDay).toBeNull()
    expect(r.cancelledByDay).toBeNull()
  })

  it('24 · a baseline before rollup coverage is refused and says why', () => {
    const r = run({ baseline: null, baselineOutsideCoverage: true })
    expect(r.period.confirmed.delta).toBeNull()
    expect(r.period.confirmed.unavailable).toBe('outside_coverage')
    expect(r.period.cancelled.unavailable).toBe('outside_coverage')
  })

  it('25 · the day series and the period total describe the SAME rows', () => {
    // A reader who sums the chart must get the number printed beside it.
    const r = run()
    const summed = (r.byDay ?? []).reduce((n, p) => n + p.value, 0)
    expect(summed).toBe(r.period.confirmed.value)
  })
})

// ─── K · Financial permission separation ──────────────────────────────────────

describe('RD-ANALYTICS-08 · the financial boundary is not widened', () => {
  it('26 · a payload built without `transactions` carries no money at all', () => {
    const out = normalizeEventAnalytics({
      analytics: producer(), range: RANGE,
      capabilities: caps({ financeAllowed: false }), eventId: 'draft-A',
    })
    expect('revenue' in out).toBe(false)
    expect(JSON.stringify(out)).not.toMatch(/Paise/)
    // …and the registration module still has everything it needs.
    expect(out.registrations.period.confirmed.value).toBe(10)
    expect(out.registrations.total).toBe(100)
  })

  it('27 · the module never reads a revenue field, even when one is present', () => {
    const ui = code('components/analytics/registrations/RegistrationsAnalytics.tsx')
    expect(ui).not.toContain('data.revenue')
    expect(ui).not.toContain('financialAllowed')
  })
})

// ─── L · No raw registration scan ─────────────────────────────────────────────

describe('RD-ANALYTICS-08 · the scalable path is unchanged', () => {
  it('28 · the module adds NO data access of its own', () => {
    for (const p of ['lib/analytics/registrationsModel.ts',
                     'components/analytics/registrations/RegistrationsAnalytics.tsx']) {
      const src = code(p)
      expect(src, p).not.toMatch(/adminDb|collection\(|firebase/)
      expect(src, p).not.toMatch(/\.limit\(/)
    }
  })

  it('29 · the producer still issues no registration document read', () => {
    const producerSrc = code('lib/analytics/eventAnalytics.ts')
    expect(producerSrc).not.toMatch(/collection\('registrations'\)/)
    // RE-ANCHORED (RD-ANALYTICS-09) — see the twin guard in analyticsOverview. The bounded
    // `limit(CAP + 1)` read now belongs to the payment ledger, where it exists to DETECT
    // truncation; banning the string would forbid the fix rather than the defect.
    for (const hit of producerSrc.match(/collection\('[a-zA-Z]+'\)[\s\S]{0,140}?limit\(CAP \+ 1\)/g) ?? []) {
      expect(hit).toMatch(/platformTransactions|emailLogs/)
    }
    // RE-ANCHORED AGAIN (RD-ANALYTICS-11).  now carries a bounded read too — the
    // template breakdown, which has no aggregate. Widening the collection list would only
    // weaken the guard, so the rule it always meant is asserted directly: EVERY bounded read
    // detects its own overflow and lowers the flag that gates what it publishes.
    expect(producerSrc).toContain('ledgerTruncated = true')
    expect(producerSrc).toContain('commTruncated = true')

  })

  it('30 · the cancellation series reuses the rows already read — no second query', () => {
    const producerSrc = code('lib/analytics/eventAnalytics.ts')
    expect(producerSrc).toContain('const cancellationsByDay = seriesOf(p => p.cancelled)')
    // Exactly the two readDailyStats calls RD-ANALYTICS-07 established: window + baseline.
    expect((producerSrc.match(/readDailyStats\(/g) ?? [])).toHaveLength(2)
  })
})

// ─── J · Event-type neutrality ────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · registration intelligence is universal', () => {
  it('31 · no sports-only vocabulary appears in this module', () => {
    const ui = code('components/analytics/registrations/RegistrationsAnalytics.tsx')
    for (const word of [/\bbib\b/i, /\bchip\b/i, /finish time/i, /\bpace\b/i, /race categor/i]) {
      expect(ui, String(word)).not.toMatch(word)
    }
  })

  it('32 · the module is not gated on an event type', () => {
    const ui = code('components/analytics/registrations/RegistrationsAnalytics.tsx')
    expect(ui).not.toContain("eventType === 'sports'")
  })
})

// ─── H · Empty event ──────────────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · an empty event', () => {
  it('33 · reports measured zeros, and draws no composition bar', () => {
    const r = run({
      kpis: { registrations: 0, confirmed: 0, pending: 0, cancelled: 0, rejected: 0,
              waitlisted: 0, paid: 0, free: 0, paymentPending: 0, refunded: 0,
              refundPending: 0, checkedIn: 0, conversionPct: null, capacity: null,
              capacityUsedPct: null, remaining: null },
      period: { confirmed: 0, cancelled: 0, checkedIn: 0 },
      baseline: { confirmed: 0, cancelled: 0, checkedIn: 0 },
      registrationsByDay: [], cancellationsByDay: [], passSales: [],
    })
    expect(r.total).toBe(0)
    const b = statusComposition(r, { waitlistEnabled: true })
    // Zero is a measurement, so no state is "unavailable"…
    expect(b.incomplete).toBe(false)
    // …and there is nothing to draw, which the UI renders as an empty note.
    expect(drawableSegments(b)).toEqual([])
    expect(passDistribution(r).rows).toEqual([])
  })
})

// ─── UI contract ──────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-08 · the module UI', () => {
  const UI = code('components/analytics/registrations/RegistrationsAnalytics.tsx')

  it('34 · no lifetime figure carries a period delta', () => {
    // The totals row is lifetime, so no RailMetric there may take a delta prop.
    const heads = UI.split('<RailMetric').slice(1)
      .map(s => s.slice(0, Math.max(0, s.search(/<[A-Z]|\/>/))))
    expect(heads.length).toBeGreaterThan(3)
    for (const head of heads) expect(head).not.toContain('delta=')
    // The window figure and its chip live together, in the section header.
    expect(UI).toContain('function PeriodBadge')
  })

  it('35 · an unmeasured count renders a mark, never 0', () => {
    expect(UI).toContain('=== null ? null : nf(')
    expect(UI).toContain('UNAVAILABLE_MARK')
    expect(UI).not.toMatch(/\?\?\s*0/)
  })

  it('36 · a rise in cancellations is not painted as good news', () => {
    expect(UI).toContain('invert')
    // …and only the colour flips — the arrow still reports the direction of the number.
    const chip = code('components/analytics/overview/Primitives.tsx')
    expect(chip).toContain('const good = invert ? !up : up')
    expect(chip).toContain("const word = flat ? 'no change' : up ? 'up' : 'down'")
  })

  it('37 · the chart caption names the days DRAWN, not the days requested', () => {
    expect(UI).toContain('function drawnRange')
    expect(UI).toContain('s[0].date')
  })

  it('38 · partial coverage is disclosed in the module, not only on the Overview', () => {
    expect(UI).toContain('daily analytics begin')
    expect(UI).toContain('coverage.partial')
  })
})
