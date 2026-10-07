// RD-ANALYTICS-10 — Operations Intelligence.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// The failure modes here are not crashes. They are a plausible screen that is wrong about
// what kind of event it is describing:
//
//   a timing panel on a sports event whose organizer never switched timing on
//   NO timing panel on a conference that did switch it on
//   the word "BIB" on a badge desk that calls them badges
//   105% attendance clamped to 100% and "0 remaining", so oversubscribed looks full
//   a capacity meter reading 0% for an event that never configured a capacity
//   a check-in trend manufactured by scanning documents

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  rate, readAttendance, readCapacity, readIdentifiers, readTiming,
  periodCheckIns, operationalPanels,
} from '@/lib/analytics/operationsModel'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import { presetRange } from '@/lib/analytics/dateRange'
import {
  ANALYTICS_PANELS, isAnalyticsPanelAvailable, type AnalyticsModuleContext,
} from '@/lib/analytics/modules'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'

/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    // Sources are MIXED CRLF/LF in this repo, so a guard matching across a line break
    // would pass or fail depending on which file it happened to read.
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const RANGE = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))

/** Every event type the product supports. The matrix runs over ALL of them. */
const EVENT_TYPES = ['sports', 'community', 'conference', 'workshop', 'exhibition',
                     'cultural', 'awards', 'fundraising', 'meetup'] as const

const caps = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
  eventType: 'conference', registrationRules: null, applications: null,
  gate: { flags: { coupons: true, broadcast: true, certificates: true, donations: true },
          has: () => true } as unknown as AnalyticsModuleContext['gate'],
  financeAllowed: false,
  ...over,
})

const producer = (over: Partial<EventAnalytics> = {}): EventAnalytics => ({
  eventId: 'e', eventName: 'E', lifecycleStatus: 'published', publishedAt: null,
  truncated: false,
  limits: { registrations: true, communications: true, reminders: true,
            certificates: true, ledger: true, passValue: true },
  financialAllowed: false,
  range: RANGE,
  period:   { confirmed: 10, cancelled: 2, checkedIn: 40 },
  baseline: { confirmed: 8,  cancelled: 4, checkedIn: 32 },
  coverageSince: '2026-01-01', coveragePartial: false, baselineOutsideCoverage: false,
  kpis: { registrations: 100, confirmed: 80, pending: 10, cancelled: 20, rejected: 5,
          waitlisted: 5, paid: 55, free: 20, paymentPending: 15, refunded: 6,
          refundPending: 4, checkedIn: 40, conversionPct: 60, capacity: 200,
          capacityUsedPct: 40, remaining: 120 },
  registrationsByDay: [{ date: '2026-06-15', label: '6/15', value: 10 }],
  cancellationsByDay: [{ date: '2026-06-15', label: '6/15', value: 2 }],
  checkInsByDay:      [{ date: '2026-06-15', label: '6/15', value: 40 }],
  paymentStatus: [], passSales: [], couponUsage: [], funnel: [],
  communication: null, reminders: null, certificates: null,
  operationalCapabilities: { identifiersEnabled: false, identifierLabel: null,
                             timingEnabled: false, timingLabel: null },
  identifierProgress: null,
  timingProgress:     null,
  dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  ...over,
})

/**
 * Mirrors the ROUTE exactly: the producer resolves the event's capabilities, and the route
 * copies them into the module context that decides which panels exist. A helper that set
 * them on only one side would pass while the real path was broken.
 */
const run = (p?: Partial<EventAnalytics>, c?: Partial<AnalyticsModuleContext>): AnalyticsResponse => {
  const analytics = producer(p)
  return normalizeEventAnalytics({
    analytics, range: RANGE, eventId: 'draft-A',
    capabilities: caps({
      identifiersEnabled: analytics.operationalCapabilities.identifiersEnabled,
      timingEnabled:      analytics.operationalCapabilities.timingEnabled,
      ...c,
    }),
  })
}

/** A payload with both capabilities configured, as the producer would report them. */
const withCapabilities = (
  identifiersEnabled: boolean, timingEnabled: boolean,
  labels: { identifier?: string; timing?: string } = {},
) => ({
  operationalCapabilities: {
    identifiersEnabled, identifierLabel: identifiersEnabled ? (labels.identifier ?? 'Bib') : null,
    timingEnabled,      timingLabel:     timingEnabled ? (labels.timing ?? 'Timing Chip') : null,
  },
  identifierProgress: identifiersEnabled
    ? { eligible: 80, withIdentifier: 60, withoutIdentifier: 18, unrecorded: 2 } : null,
  timingProgress: timingEnabled ? { attached: 55, replaced: 3, removed: 1 } : null,
})

// ─── §13 · THE EVENT-TYPE × CAPABILITY MATRIX ─────────────────────────────────

describe('RD-ANALYTICS-10 · capability gating across every event type', () => {
  const timing = ANALYTICS_PANELS.find(p => p.key === 'timing')!
  const ident  = ANALYTICS_PANELS.find(p => p.key === 'identifiers')!

  it('1 · the four capability combinations hold for EVERY event type', () => {
    // Nine event types × four combinations. The old rule — timing appears iff
    // eventType === 'sports' — fails 32 of these 36 cases.
    for (const eventType of EVENT_TYPES) {
      for (const identifiersEnabled of [true, false]) {
        for (const timingEnabled of [true, false]) {
          const c = caps({ eventType, identifiersEnabled, timingEnabled })
          expect(isAnalyticsPanelAvailable(ident, c), `${eventType} ids=${identifiersEnabled}`)
            .toBe(identifiersEnabled)
          expect(isAnalyticsPanelAvailable(timing, c), `${eventType} timing=${timingEnabled}`)
            .toBe(timingEnabled)
        }
      }
    }
  })

  it('2 · a SPORTS event with timing off gets no timing panel', () => {
    const r = run(withCapabilities(true, false), { eventType: 'sports' })
    expect(r.capabilities.panels).toContain('identifiers')
    expect(r.capabilities.panels).not.toContain('timing')
    expect(r.operations.timing).toBeUndefined()
  })

  it('3 · a CONFERENCE with timing on DOES get one', () => {
    const r = run(withCapabilities(true, true), { eventType: 'conference' })
    expect(r.capabilities.panels).toContain('timing')
    expect(r.operations.timing?.attached).toBe(55)
  })

  it('4 · an event with neither capability gets neither section', () => {
    for (const eventType of EVENT_TYPES) {
      const r = run(withCapabilities(false, false), { eventType })
      expect(r.operations.identifiers, eventType).toBeUndefined()
      expect(r.operations.timing, eventType).toBeUndefined()
      expect(r.capabilities.panels, eventType).not.toContain('identifiers')
      expect(r.capabilities.panels, eventType).not.toContain('timing')
    }
  })

  it('5 · an absent capability object means OFF — no migration required', () => {
    // Every event predating the feature has no `tagMapping` at all.
    const r = run(undefined, { eventType: 'sports' })
    expect(r.operations.timing).toBeUndefined()
    expect(r.operations.identifiers).toBeUndefined()
  })

  it('6 · nothing in the operations path reads eventType to decide a capability', () => {
    for (const p of ['lib/analytics/operationsModel.ts',
                     'lib/analytics/operationsSources.ts',
                     'components/analytics/operations/OperationsAnalytics.tsx']) {
      expect(code(p), p).not.toMatch(/eventType/)
      expect(code(p), p).not.toMatch(/'sports'/)
    }
  })
})

// ─── Terminology ──────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-10 · the event\'s own vocabulary', () => {
  it('7 · the identifier label is the EVENT\'S, never hardcoded', () => {
    for (const label of ['Bib', 'Badge', 'Token', 'Wristband', 'Volunteer number']) {
      const r = run(withCapabilities(true, false, { identifier: label }))
      expect(r.operations.identifiers?.label).toBe(label)
      expect(readIdentifiers(r.operations)?.label).toBe(label)
    }
  })

  it('8 · the timing label is the EVENT\'S too', () => {
    const r = run(withCapabilities(false, true, { timing: 'Transponder' }))
    expect(readTiming(r.operations)?.label).toBe('Transponder')
  })

  it('9 · no sports vocabulary is hardcoded anywhere in the module', () => {
    for (const p of ['lib/analytics/operationsModel.ts',
                     'components/analytics/operations/OperationsAnalytics.tsx']) {
      const src = code(p)
      for (const w of [/\bBIB\b/, /finish time/i, /\bsplits\b/i, /finisher/i, /\bpace\b/i,
                       /race categor/i, /\bmarathon\b/i]) {
        expect(src, `${p} ${w}`).not.toMatch(w)
      }
    }
  })
})

// ─── §8 · Attendance, including the over-attendance case ──────────────────────

describe('RD-ANALYTICS-10 · attendance', () => {
  it('10 · attendance is checked-in ÷ CONFIRMED', () => {
    expect(run().operations.attendance.pct).toBe(50)   // 40 / 80
  })

  it('11 · over-attendance is REPORTED, never clamped', () => {
    const r = run({ kpis: { ...producer().kpis, confirmed: 1_000, checkedIn: 1_050 } })
    const a = readAttendance(r.operations)
    expect(a.state).toBe('over')
    expect(a.pct).toBe(105)          // not 100
    expect(a.excess).toBe(50)
    expect(a.awaited).toBeNull()     // "still expected" is meaningless here
    // The raw contract field is negative rather than floored, so a consumer can tell.
    expect(r.operations.attendance.awaited).toBe(-50)
    expect(r.operations.attendance.over).toBe(true)
  })

  it('12 · a normal event reports what is still expected', () => {
    const a = readAttendance(run().operations)
    expect(a.state).toBe('normal')
    expect(a.awaited).toBe(40)       // 80 confirmed − 40 in
    expect(a.excess).toBeNull()
  })

  it('13 · an unmeasured side yields no percentage and no shortfall', () => {
    const a = readAttendance(run({ kpis: { ...producer().kpis, confirmed: null } }).operations)
    expect(a.state).toBe('unmeasured')
    expect(a.pct).toBeNull()
    expect(a.awaited).toBeNull()
    expect(a.excess).toBeNull()
  })

  it('14 · a zero denominator is unknown, not 0%', () => {
    expect(rate(0, 0)).toBeNull()
    expect(rate(5, null)).toBeNull()
    expect(rate(null, 5)).toBeNull()
    expect(rate(0, 10)).toBe(0)      // measured and genuinely none
  })
})

// ─── §9 · Capacity ────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-10 · capacity', () => {
  it('15 · capacity is ABSENT when the event configured none', () => {
    const r = run({ kpis: { ...producer().kpis, capacity: null, capacityUsedPct: null, remaining: null } })
    expect(r.operations.capacity).toBeUndefined()
    expect(readCapacity(r.operations)).toBeNull()
  })

  it('16 · the percentage is TRUE, not clamped — 104% for 1,040 of 1,000', () => {
    const r = run({ kpis: { ...producer().kpis, capacity: 1_000, confirmed: 1_040,
                            capacityUsedPct: 104, remaining: -40 } })
    const c = readCapacity(r.operations)!
    expect(c.usedPct).toBe(104)
    expect(c.over).toBe(true)
    expect(c.remaining).toBe(-40)
    // The BAR clamps; the figure does not. That is the whole distinction.
    expect(c.barPct).toBe(100)
  })

  it('17 · the producer no longer clamps the metric at its source', () => {
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).not.toContain('Math.min(100, Math.round((confirmed / capacity) * 100))')
    expect(src).not.toContain('Math.max(0, capacity - confirmed)')
  })

  it('18 · a capacity of zero is not a capacity', () => {
    const r = run({ kpis: { ...producer().kpis, capacity: 0, capacityUsedPct: 0, remaining: 0 } })
    expect(r.operations.capacity).toBeUndefined()
  })
})

// ─── §5/§7 · Trend and comparison ─────────────────────────────────────────────

describe('RD-ANALYTICS-10 · trend and comparison', () => {
  it('19 · the check-in trend comes from the rollups, and matches its period total', () => {
    const r = run()
    expect(r.operations.byDay).toEqual([{ date: '2026-06-15', value: 40 }])
    const summed = (r.operations.byDay ?? []).reduce((n, p) => n + p.value, 0)
    expect(summed).toBe(periodCheckIns(r).value)
  })

  it('20 · the comparison is the SHARED overview metric, not a second one', () => {
    const r = run()
    expect(periodCheckIns(r)).toBe(r.overview.checkedIn)
    expect(r.overview.checkedIn.delta).toEqual({ pct: 25, direction: 'up' })
    const src = code('lib/analytics/operationsModel.ts')
    expect(src).not.toContain('computeDelta')
    expect(src).not.toContain('previousPeriod')
  })

  it('21 · a zero baseline yields no percentage; a drop to zero is a real −100%', () => {
    const flat = run({ period: { confirmed: 0, cancelled: 0, checkedIn: 0 },
                       baseline: { confirmed: 0, cancelled: 0, checkedIn: 0 } })
    expect(flat.overview.checkedIn.delta?.pct).toBeNull()
    const dropped = run({ period: { confirmed: 0, cancelled: 0, checkedIn: 0 } })
    expect(dropped.overview.checkedIn.delta).toEqual({ pct: -100, direction: 'down' })
    expect(JSON.stringify(dropped.overview)).not.toMatch(/Infinity|NaN/)
  })

  it('22 · an unreadable trend is null and a pre-coverage baseline says why', () => {
    const none = run({ checkInsByDay: null, period: { confirmed: null, cancelled: null, checkedIn: null } })
    expect(none.operations.byDay).toBeNull()
    expect(none.overview.checkedIn.unavailable).toBe('not_measured')
    const outside = run({ baseline: null, baselineOutsideCoverage: true })
    expect(outside.overview.checkedIn.unavailable).toBe('outside_coverage')
  })
})

// ─── §10 · Credential progress ────────────────────────────────────────────────

describe('RD-ANALYTICS-10 · credential progress', () => {
  it('23 · identifier progress is assigned against the CONFIRMED roster', () => {
    const i = readIdentifiers(run(withCapabilities(true, false)).operations)!
    expect(i.assigned).toBe(60)
    expect(i.eligible).toBe(80)
    expect(i.pct).toBe(75)
  })

  it('24 · "not tracked" is a THIRD state, never folded into unassigned', () => {
    const i = readIdentifiers(run(withCapabilities(true, false)).operations)!
    expect(i.unassigned).toBe(18)
    expect(i.unrecorded).toBe(2)
    // 60 + 18 + 2 = 80. Folding the residue in would claim 20 are waiting.
    expect((i.assigned ?? 0) + (i.unassigned ?? 0) + (i.unrecorded ?? 0)).toBe(i.eligible)
  })

  it('25 · timing attachment is measured against the confirmed field', () => {
    const t = readTiming(run(withCapabilities(false, true)).operations)!
    expect(t.attached).toBe(55)
    expect(t.pct).toBe(69)          // 55 / 80
    // Replaced and removed are reported but never summed into "attached".
    expect(t.replaced).toBe(3)
    expect(t.removed).toBe(1)
  })

  it('26 · panels are read from the resolved capabilities, not from payload shape', () => {
    const r = run(withCapabilities(true, true))
    expect(operationalPanels(r)).toMatchObject({ identifiers: true, timing: true })
    const src = code('lib/analytics/operationsModel.ts')
    expect(src).toContain('data.capabilities.panels')
  })
})

// ─── §11/§15/§18 · Boundaries ─────────────────────────────────────────────────

describe('RD-ANALYTICS-10 · boundaries', () => {
  it('27 · no staff analytics, and no read of the append-only check-in log', () => {
    for (const p of ['lib/analytics/operationsSources.ts',
                     'lib/analytics/operationsModel.ts',
                     'components/analytics/operations/OperationsAnalytics.tsx']) {
      expect(code(p), p).not.toMatch(/checkinHistory/i)
      expect(code(p), p).not.toMatch(/staff/i)
    }
  })

  it('28 · Operations exposes no financial field of any kind', () => {
    const r = run(withCapabilities(true, true))
    expect(JSON.stringify(r.operations)).not.toMatch(/Paise|revenue|refund|settlement|fee/i)
    for (const p of ['lib/analytics/operationsModel.ts',
                     'components/analytics/operations/OperationsAnalytics.tsx']) {
      expect(code(p), p).not.toMatch(/Paise|₹|revenue/i)
    }
  })

  it('29 · the sources module reads only aggregates and one configuration document', () => {
    const src = code('lib/analytics/operationsSources.ts')
    // count() only — no document pages, no limits, no scans.
    expect(src).not.toMatch(/\.limit\(/)
    expect(src).not.toMatch(/\.get\(\)\s*\.then\(s => s\.docs/)
    expect((src.match(/\.count\(\)/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect(src).toContain('resolveIdentifierConfig')
  })

  it('30 · the UI and model add no data access of their own', () => {
    for (const p of ['lib/analytics/operationsModel.ts',
                     'components/analytics/operations/OperationsAnalytics.tsx']) {
      expect(code(p), p).not.toMatch(/adminDb|collection\(|firebase|fetch\(/)
    }
  })

  it('31 · the conditional reads are SKIPPED when the capability is off', () => {
    // An event without identifiers must not pay for three aggregates asking about them.
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toMatch(/capabilities\.identifiersEnabled\s*\?\s*readIdentifierProgress/)
    expect(src).toMatch(/capabilities\.timingEnabled\s*\?\s*readTimingProgress/)
  })

  it('32 · a failed capability read yields NO panels rather than empty ones', () => {
    const src = code('lib/analytics/operationsSources.ts')
    expect(src).toContain('return NO_OPERATIONAL_CAPABILITIES')
    expect(src).toContain('if (!isStored) return NO_OPERATIONAL_CAPABILITIES')
  })
})

// ─── UI contract ──────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-10 · the module UI', () => {
  const UI = code('components/analytics/operations/OperationsAnalytics.tsx')

  it('33 · no snapshot figure carries a comparison chip', () => {
    const snapshot = UI.slice(UI.indexOf('aria-label="Operational snapshot"'),
                              UI.indexOf('Check-in trend'))
    expect(snapshot).not.toContain('DeltaChip')
    expect(UI).toContain('<DeltaChip delta={period.delta} />')
  })

  it('34 · an unmeasured figure renders a mark, never 0', () => {
    expect(UI).toContain('UNAVAILABLE_MARK')
    expect(UI).toContain('=== null ? null : nf(')
    // Every displayed COUNT branches on null first. A `?? 0` survives only where it is a
    // bar width or an aria value — a drawing constraint, never a claim about the data.
    for (const hit of UI.match(/.{0,70}\?\?\s*0.{0,25}/g) ?? []) {
      expect(hit, hit).toMatch(/Math\.min|aria-valuenow|aria-label|width/)
    }
  })

  it('35 · over-attendance changes what the fourth cell says', () => {
    expect(UI).toContain("attendance.state === 'over'")
    expect(UI).toContain('Above confirmed')
    expect(UI).toContain('Still expected')
    expect(UI).toContain('function OverAttendanceNote')
  })

  it('36 · the capacity bar clamps its WIDTH while the figure stays true', () => {
    expect(UI).toContain('capacity.barPct')
    const model = code('lib/analytics/operationsModel.ts')
    expect(model).toContain('Math.min(100, Math.max(0, c.usedPct))')
  })

  it('37 · panel titles are built from the event\'s label', () => {
    expect(UI).toContain('${identifiers.label} assignment')
    expect(UI).toContain('${timing.label} assignment')
  })
})
