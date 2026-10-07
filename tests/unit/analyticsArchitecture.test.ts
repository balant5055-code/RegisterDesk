// RD-ANALYTICS-04 — the shared Analytics architecture.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// Not features — BOUNDARIES. Each module here exists to stop a future Analytics page
// inventing its own version of something the product already decided:
//
//   dateRange    one day model, in the zone the rollups were actually written in
//   comparison   one baseline rule, on top of the tested `computeDelta`
//   modules      one capability answer, over the existing gate table
//   insights     one insight engine, not one per page
//   routes       one written-down IA decision
//
// A test here failing means two Analytics surfaces are about to disagree.

import { describe, it, expect } from 'vitest'
import {
  presetRange, customRange, normalizeRange, rangeDayKeys, rangeLengthDays, isDayKey,
  today, PRESET_DAYS, MAX_RANGE_DAYS, DEFAULT_PRESET, REPORTING_TZ_OFFSET_MINUTES,
} from '@/lib/analytics/dateRange'
import {
  previousPeriod, resolveComparison, compareMetric, COMPARISON_OFF,
} from '@/lib/analytics/comparison'
import {
  ANALYTICS_MODULES, ANALYTICS_PANELS, isAnalyticsModuleAvailable, isAnalyticsPanelAvailable,
  availableAnalyticsModules, availableAnalyticsPanels, type AnalyticsModuleContext,
} from '@/lib/analytics/modules'
import {
  buildPerformanceInsights, PERFORMANCE_NEARLY_FULL_PCT, MAX_PERFORMANCE_INSIGHTS,
  NEARLY_FULL_PCT, computeDelta,
} from '@/lib/dashboard/insights'
import {
  ANALYTICS_ROUTE_CURRENT, ANALYTICS_ROUTE_CANONICAL, REPORTS_ROUTE_CANONICAL,
  ANALYTICS_ROUTE_MIGRATION, ANALYTICS_ROUTES_MUST_RESOLVE,
} from '@/lib/analytics/routes'
import { dayKey } from '@/lib/dashboard/dailyStats'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** A fixed instant so every range assertion is deterministic. 2026-06-15T12:00Z. */
const NOW = Date.parse('2026-06-15T12:00:00Z')

// ─── Date range ───────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-04 · one date model', () => {
  it('1 · a preset covers exactly its number of days, inclusive of today', () => {
    for (const [preset, days] of Object.entries(PRESET_DAYS) as ['7d' | '30d' | '90d', number][]) {
      const r = presetRange(preset, NOW)
      expect(rangeLengthDays(r.from, r.to), preset).toBe(days)
      expect(r.preset, preset).toBe(preset)
    }
  })

  it('2 · a range ENDS today in the reporting zone, not in UTC or the host zone', () => {
    // The whole point of the module: the last bucket must be the same day the rollups
    // would have written today's row into.
    expect(presetRange('7d', NOW).to).toBe(dayKey(NOW))
    expect(today(NOW)).toBe(dayKey(NOW))
    expect(REPORTING_TZ_OFFSET_MINUTES).toBe(330)
  })

  it('3 · the reporting zone genuinely shifts the day near the UTC boundary', () => {
    // 2026-06-15T19:00Z is 2026-06-16 00:30 IST. A UTC-based model would call this the
    // 15th — which is precisely the divergence RD-ANALYTICS-03 removed from the trend.
    const lateUtc = Date.parse('2026-06-15T19:00:00Z')
    expect(today(lateUtc)).toBe('2026-06-16')
    expect(new Date(lateUtc).toISOString().slice(0, 10)).toBe('2026-06-15')
  })

  it('4 · rangeDayKeys produces the exact document ids readDailyStats expects', () => {
    const r = presetRange('7d', NOW)
    const keys = rangeDayKeys(r)
    expect(keys).toHaveLength(7)
    expect(keys[0]).toBe(r.from)
    expect(keys[keys.length - 1]).toBe(r.to)
    // Strictly ascending, one day apart, no gaps.
    for (let i = 1; i < keys.length; i++) {
      expect(Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`)).toBe(86_400_000)
    }
  })

  it('5 · a custom range is accepted, and reversed bounds are swapped not rejected', () => {
    expect(customRange('2026-06-01', '2026-06-10')).toEqual({ from: '2026-06-01', to: '2026-06-10', preset: 'custom' })
    expect(customRange('2026-06-10', '2026-06-01')).toEqual({ from: '2026-06-01', to: '2026-06-10', preset: 'custom' })
  })

  it('6 · an over-long custom range is clamped from the OLD end, keeping the recent one', () => {
    const r = customRange('2025-01-01', '2026-06-15')!
    expect(r.to).toBe('2026-06-15')
    expect(rangeLengthDays(r.from, r.to)).toBe(MAX_RANGE_DAYS)
  })

  it('7 · the cap matches what the data layer can actually fill', () => {
    // 90 is the dashboard route's rollup window. A longer range would render a chart whose
    // left half is indistinguishable from a quiet period.
    expect(MAX_RANGE_DAYS).toBe(90)
    expect(PRESET_DAYS['90d']).toBe(MAX_RANGE_DAYS)
  })

  it('8 · malformed input falls back to the default preset instead of throwing', () => {
    for (const bad of [null, undefined, {}, { preset: 'yesterday' }, { preset: 'custom' },
                       { preset: 'custom', from: 'nope', to: '2026-06-01' }]) {
      const r = normalizeRange(bad as never, NOW)
      expect(r.preset).toBe(DEFAULT_PRESET)
      expect(rangeLengthDays(r.from, r.to)).toBe(PRESET_DAYS[DEFAULT_PRESET])
    }
  })

  it('9 · a well-formed custom request survives normalization', () => {
    expect(normalizeRange({ preset: 'custom', from: '2026-06-01', to: '2026-06-10' }, NOW))
      .toEqual({ from: '2026-06-01', to: '2026-06-10', preset: 'custom' })
  })

  it('10 · isDayKey rejects anything that is not a business-day key', () => {
    expect(isDayKey('2026-06-15')).toBe(true)
    for (const bad of ['2026-6-15', '2026-06-15T00:00:00Z', '', 'today', 20260615, null]) {
      expect(isDayKey(bad), String(bad)).toBe(false)
    }
  })
})

// ─── Comparison ───────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-04 · one comparison model', () => {
  it('11 · the previous period is the SAME length and immediately adjacent', () => {
    const r = presetRange('30d', NOW)
    const p = previousPeriod(r)!
    expect(rangeLengthDays(p.from, p.to)).toBe(rangeLengthDays(r.from, r.to))
    // Adjacent: the baseline's last day is the day before the range's first.
    const gap = Date.parse(`${r.from}T00:00:00Z`) - Date.parse(`${p.to}T00:00:00Z`)
    expect(gap).toBe(86_400_000)
  })

  it('12 · a custom range compares against an equally custom baseline, not "last month"', () => {
    const r = customRange('2026-06-01', '2026-06-10')!   // 10 days
    const p = previousPeriod(r)!
    expect(rangeLengthDays(p.from, p.to)).toBe(10)
    expect(p.to).toBe('2026-05-31')
    expect(p.from).toBe('2026-05-22')
  })

  it('13 · comparison is off by default and resolves to a reason, never a silent baseline', () => {
    const r = presetRange('7d', NOW)
    expect(resolveComparison(COMPARISON_OFF, r)).toEqual({ ok: false, reason: 'disabled' })
    expect(resolveComparison(undefined, r)).toEqual({ ok: false, reason: 'disabled' })
  })

  it('14 · previous_period is the default mode when enabled without one', () => {
    const r = resolveComparison({ enabled: true }, presetRange('7d', NOW))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.mode).toBe('previous_period')
      expect(rangeLengthDays(r.baseline.from, r.baseline.to)).toBe(7)
    }
  })

  it('15 · event mode without a baseline event is refused, not silently downgraded', () => {
    // Downgrading to previous_period would answer a question nobody asked.
    expect(resolveComparison({ enabled: true, mode: 'event' }, presetRange('7d', NOW)))
      .toEqual({ ok: false, reason: 'missing_event' })
  })

  it('16 · event mode compares the SAME window across two events', () => {
    const range = presetRange('30d', NOW)
    const r = resolveComparison({ enabled: true, mode: 'event', baselineEventId: 'evt-b' }, range)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.baseline).toEqual(range)
      expect(r.baselineEventId).toBe('evt-b')
    }
  })

  it('17 · an explicit baseline window is honoured over the derived one', () => {
    const r = resolveComparison(
      { enabled: true, baselineFrom: '2026-01-01', baselineTo: '2026-01-31' },
      presetRange('7d', NOW),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.baseline).toEqual({ from: '2026-01-01', to: '2026-01-31', preset: 'custom' })
  })

  it('18 · an unmeasured side yields NO delta — never a fabricated percentage', () => {
    // RE-ANCHORED (RD-ANALYTICS-07). The refusal is unchanged; what is new is that the
    // metric now says WHICH side was missing, so the UI can print "not measured" for a
    // failed read and "no earlier period on record" for a genuinely absent baseline
    // instead of showing the same blank for two different facts.
    expect(compareMetric(null, 10)).toEqual({
      value: null, baseline: 10, delta: null, unavailable: 'not_measured' })
    expect(compareMetric(10, null)).toEqual({
      value: 10, baseline: null, delta: null, unavailable: 'no_baseline' })
    expect(compareMetric(null, null).delta).toBeNull()
  })

  it('18b · the caller names the reason a baseline is missing; the default never lies', () => {
    // A window that predates recorded history is NOT the same fact as "this event has no
    // earlier period", and the two must not collapse into one message.
    expect(compareMetric(10, null, 'outside_coverage').unavailable).toBe('outside_coverage')
    expect(compareMetric(10, null, 'disabled').unavailable).toBe('disabled')
    // An unmeasured VALUE outranks whatever the caller says about the baseline — the
    // figure itself could not be read, so no reason about the comparison applies.
    expect(compareMetric(null, null, 'outside_coverage').unavailable).toBe('not_measured')
  })

  it('19 · a measured pair delegates to the tested computeDelta', () => {
    expect(compareMetric(120, 100)).toEqual({ value: 120, baseline: 100, delta: computeDelta(120, 100) })
    // …including its refusal to divide by an empty baseline.
    expect(compareMetric(50, 0).delta).toEqual({ pct: null, direction: 'up' })
  })
})

// ─── Capability-driven modules ────────────────────────────────────────────────

const ctx = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
  eventType: 'conference',
  registrationRules: null,
  applications: null,
  gate: { flags: {
    coupons: true, broadcast: true, certificates: true, donations: true,
  }, has: () => true } as unknown as AnalyticsModuleContext['gate'],
  financeAllowed: true,
  ...over,
})

describe('RD-ANALYTICS-04 · modules are capability-driven', () => {
  it('20 · Revenue is ABSENT without the finance permission', () => {
    const revenue = ANALYTICS_MODULES.find(m => m.key === 'revenue')!
    expect(isAnalyticsModuleAvailable(revenue, ctx({ financeAllowed: true }))).toBe(true)
    expect(isAnalyticsModuleAvailable(revenue, ctx({ financeAllowed: false }))).toBe(false)
    expect(availableAnalyticsModules(ctx({ financeAllowed: false })).map(m => m.key))
      .not.toContain('revenue')
  })

  it('21 · a module with no capability signal is available — hidden only when something says so', () => {
    // The rule isEventTabAvailable already states: absent signal ⇒ present.
    const overview = ANALYTICS_MODULES.find(m => m.key === 'overview')!
    expect(overview.gateKey).toBeUndefined()
    expect(isAnalyticsModuleAvailable(overview, ctx())).toBe(true)
  })

  it('22 · a module whose gate refuses is absent', () => {
    const deny = ctx({ gate: { flags: {}, has: () => false } as unknown as AnalyticsModuleContext['gate'] })
    const registrations = ANALYTICS_MODULES.find(m => m.key === 'registrations')!
    expect(isAnalyticsModuleAvailable(registrations, deny)).toBe(false)
  })

  it('23 · Participants requires an explicit data signal — it is never assumed', () => {
    const participants = ANALYTICS_MODULES.find(m => m.key === 'participants')!
    expect(isAnalyticsModuleAvailable(participants, ctx())).toBe(false)
    expect(isAnalyticsModuleAvailable(participants, ctx({ hasParticipantData: true }))).toBe(true)
  })

  it('24 · timing follows the EVENT\'S CONFIGURATION, never its event type', () => {
    // ═══ RE-ANCHORED (RD-ANALYTICS-10), AND THE OLD RULE WAS THE DEFECT ════════
    // This required timing to appear for `sports` and for nothing else. That inference is
    // wrong in both directions: a sports event whose organizer never switched timing on was
    // offered the panel, and any other event that DID switch it on — the feature is a
    // per-event switch available to all of them — could never see it. The capability lives
    // in `identifierConfigs/{slug}.tagMapping.enabled`, and that is now what decides.
    const timing = ANALYTICS_PANELS.find(p => p.key === 'timing')!
    const TYPES = ['sports', 'community', 'conference', 'workshop', 'exhibition',
                   'cultural', 'awards', 'fundraising', 'meetup']

    for (const t of TYPES) {
      expect(isAnalyticsPanelAvailable(timing, ctx({ eventType: t, timingEnabled: true })), `${t} on`)
        .toBe(true)
      expect(isAnalyticsPanelAvailable(timing, ctx({ eventType: t, timingEnabled: false })), `${t} off`)
        .toBe(false)
      // Absent is OFF — every event predating the feature, with no migration.
      expect(isAnalyticsPanelAvailable(timing, ctx({ eventType: t })), `${t} absent`)
        .toBe(false)
    }
  })

  it('24b · identifiers follow their own switch, independently of timing', () => {
    // All four combinations are real events: bibs without chips (most road races), chips
    // without platform-issued numbers (pre-printed bibs), both, and neither.
    const ids    = ANALYTICS_PANELS.find(p => p.key === 'identifiers')!
    const timing = ANALYTICS_PANELS.find(p => p.key === 'timing')!
    const cases: [boolean, boolean][] = [[true, true], [true, false], [false, true], [false, false]]
    for (const [identifiersEnabled, timingEnabled] of cases) {
      const c = ctx({ eventType: 'sports', identifiersEnabled, timingEnabled })
      expect(isAnalyticsPanelAvailable(ids, c), `ids ${identifiersEnabled}`).toBe(identifiersEnabled)
      expect(isAnalyticsPanelAvailable(timing, c), `timing ${timingEnabled}`).toBe(timingEnabled)
    }
  })

  it('24c · no panel infers a capability from the event type any more', () => {
    // The `eventTypes` mechanism still exists for genuinely type-exclusive panels; the
    // guard is that the two identifier panels no longer use it.
    for (const key of ['timing', 'identifiers'] as const) {
      expect(ANALYTICS_PANELS.find(p => p.key === key)!.eventTypes, key).toBeUndefined()
    }
  })

  it('25 · no module or panel names a gate the product does not define', () => {
    const gates = readFileSync(resolve(process.cwd(), 'lib/eventSetup/readiness.ts'), 'utf8')
    for (const m of ANALYTICS_MODULES) {
      if (m.gateKey) expect(gates, m.key).toMatch(new RegExp(`\\b${m.gateKey}:\\s*\\{`))
    }
    for (const p of ANALYTICS_PANELS) {
      if (p.gateKey) expect(gates, p.key).toMatch(new RegExp(`\\b${p.gateKey}:\\s*\\{`))
    }
  })

  it('26 · a panel under a financial module inherits that permission', () => {
    const coupons = ANALYTICS_PANELS.find(p => p.key === 'coupons')!
    expect(coupons.module).toBe('revenue')
    expect(isAnalyticsPanelAvailable(coupons, ctx({ financeAllowed: false }))).toBe(false)
  })

  it('27 · the waitlist panel consults the organizer\'s own switch, not just a gate', () => {
    // A disabled waitlist is not an empty one — a panel of zeros would claim nobody queued.
    expect(availableAnalyticsPanels('registrations', ctx({ registrationRules: null })).map(p => p.key))
      .not.toContain('waitlist')
  })

  it('28 · every panel belongs to a module that exists', () => {
    const keys = new Set(ANALYTICS_MODULES.map(m => m.key))
    for (const p of ANALYTICS_PANELS) expect(keys, p.key).toContain(p.module)
  })
})

// ─── Insight consolidation ────────────────────────────────────────────────────

const ev = (over: Partial<Parameters<typeof buildPerformanceInsights>[0]['events'][0]> = {}) => ({
  name: 'Event', lifecycleStatus: 'published', registered: 10, capacity: 100, fillPct: 10, ...over,
})

describe('RD-ANALYTICS-04 · one insight engine', () => {
  it('29 · the leading event is named with its real count', () => {
    const out = buildPerformanceInsights({
      events: [ev({ name: 'Small', registered: 5 }), ev({ name: 'Big', registered: 900 })],
      week: null, trendUnavailable: false,
    })
    expect(out[0].kind).toBe('top_event')
    expect(out[0].text).toContain('"Big"')
    expect(out[0].text).toContain('900')
  })

  it('30 · velocity is suppressed entirely when the rollups are unreadable', () => {
    const out = buildPerformanceInsights({
      events: [ev()], week: { total: 50, delta: { pct: 20, direction: 'up' } },
      trendUnavailable: true,
    })
    expect(out.map(i => i.kind)).not.toContain('velocity_up')
  })

  it('31 · a decline is reported with an ABSOLUTE number and the word "fewer"', () => {
    // `delta.pct` is negative on a decline; "-14% fewer" would read as a rise.
    const out = buildPerformanceInsights({
      events: [], week: { total: 40, delta: { pct: -14, direction: 'down' } }, trendUnavailable: false,
    })
    const v = out.find(i => i.kind === 'velocity_down')!
    expect(v.text).toContain('14% fewer')
    expect(v.text).not.toContain('-14')
    expect(v.tone).toBe('warning')
  })

  it('32 · a null pct makes no percentage claim, but still reports the raw total', () => {
    const out = buildPerformanceInsights({
      events: [], week: { total: 12, delta: { pct: null, direction: 'up' } }, trendUnavailable: false,
    })
    const v = out.find(i => i.kind === 'velocity_total')!
    expect(v.text).toContain('12 new registrations')
    expect(v.text).not.toContain('%')
  })

  it('33 · an event with no capacity is never called nearly full', () => {
    // There is nothing for a percentage to be OF.
    const out = buildPerformanceInsights({
      events: [ev({ capacity: null, fillPct: 99 })], week: null, trendUnavailable: false,
    })
    expect(out.map(i => i.kind)).not.toContain('nearly_full')
  })

  it('34 · the nearly-full threshold is 80 and is DELIBERATELY not the attention rule\'s 85', () => {
    // The attention signal is a warning that should fire late; this is narration that
    // should fire early. Unifying them would silently change one of the two surfaces.
    expect(PERFORMANCE_NEARLY_FULL_PCT).toBe(80)
    expect(NEARLY_FULL_PCT).toBe(85)
    const at80 = buildPerformanceInsights({
      events: [ev({ fillPct: 80 })], week: null, trendUnavailable: false,
    })
    expect(at80.map(i => i.kind)).toContain('nearly_full')
  })

  it('35 · the output is capped, preserving the panel\'s existing limit', () => {
    const out = buildPerformanceInsights({
      events: [ev({ name: 'A', registered: 100, fillPct: 95 }), ev({ name: 'B', registered: 0 })],
      week: { total: 10, delta: { pct: 5, direction: 'up' } }, trendUnavailable: false,
    })
    expect(out.length).toBeLessThanOrEqual(MAX_PERFORMANCE_INSIGHTS)
    expect(MAX_PERFORMANCE_INSIGHTS).toBe(4)
  })

  it('36 · the rules are pure — no icon, no React, no colour leaves the engine', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/dashboard/insights.ts'), 'utf8')
    expect(src).not.toMatch(/from 'react'/)
    expect(src).not.toMatch(/lucide-react/)
    const out = buildPerformanceInsights({ events: [ev()], week: null, trendUnavailable: false })
    for (const i of out) expect(Object.keys(i).sort()).toEqual(['kind', 'text', 'tone'])
  })

  it('37 · the Reports page no longer carries its own copy of the rules', () => {
    const page = readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/reports/page.tsx'), 'utf8')
    expect(page).toContain('buildPerformanceInsights')
    // The tell-tales of the inline engine that used to live here.
    expect(page).not.toContain('const result: InsightEntry[] = []')
    expect(page).not.toContain('% more registrations in the last 7 days')
    expect(page).not.toContain('consider opening a waitlist')
  })
})

// ─── Route decision ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-04 · the IA decision is recorded, not folklore', () => {
  it('38 · the three routes are distinct and none is deleted', () => {
    const all = [...ANALYTICS_ROUTES_MUST_RESOLVE]
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain(ANALYTICS_ROUTE_CURRENT)
    expect(all).toContain(ANALYTICS_ROUTE_CANONICAL)
    expect(all).toContain(REPORTS_ROUTE_CANONICAL)
  })

  it('39 · every route that must resolve still has a page in the tree', () => {
    for (const r of ANALYTICS_ROUTES_MUST_RESOLVE) {
      const p = resolve(process.cwd(), `app/(dashboard)${r}/page.tsx`)
      expect(existsSync(p), r).toBe(true)
    }
  })

  it('40 · the migration is ordered and every step states its precondition', () => {
    expect(ANALYTICS_ROUTE_MIGRATION.map(s => s.step)).toEqual([1, 2, 3, 4])
    for (const s of ANALYTICS_ROUTE_MIGRATION) {
      expect(s.precondition.length, `step ${s.step}`).toBeGreaterThan(20)
    }
  })

  /**
   * UPDATED BY RD-ANALYTICS-12-13 — deliberately, not to make a build pass.
   *
   * RD-ANALYTICS-04 corrected this row's LABEL while its destination stayed at
   * `/dashboard/reports`, and this case pinned that exact string. 12-13 corrected the
   * DESTINATION: the row now points at the canonical Analytics workspace, so asserting the
   * old string would pin the product backwards. What the case is really defending — that the
   * sidebar does not call the analytics dashboard "Reports", and that no bookmark broke — is
   * unchanged and is what it now asserts.
   */
  it('41 · the sidebar Analytics row points at the canonical workspace, and the old route survives', () => {
    const nav = readFileSync(resolve(process.cwd(), 'config/workspaceNav.ts'), 'utf8')
    expect(nav).toContain(`label: 'Analytics', icon: BarChart3, href: '${ANALYTICS_ROUTE_CANONICAL}'`)
    // No nav row may label the compatibility route "Analytics" any more…
    expect(nav).not.toContain(`label: 'Analytics', icon: BarChart3, href: '${ANALYTICS_ROUTE_CURRENT}'`)
    // …and nothing in the navigation points at it at all, while the route itself remains.
    expect(nav).not.toContain(`href: '${ANALYTICS_ROUTE_CURRENT}'`)
    expect(existsSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/reports/page.tsx'))).toBe(true)
  })

  it('42 · the breadcrumb agrees with the sidebar', () => {
    const crumbs = readFileSync(resolve(process.cwd(), 'lib/navigation/breadcrumbs.ts'), 'utf8')
    // The compatibility route still names itself, and now does so WITHOUT a nav owner —
    // 12-13 made the no-owner branch honour a known leaf, which is what renders this.
    expect(crumbs).toMatch(/'\/dashboard\/reports':\s*'Analytics'/)
  })

  it('43 · Reports stays the report REGISTRY, and no second engine was added', () => {
    const registry = readFileSync(resolve(process.cwd(), 'lib/reports/registry.ts'), 'utf8')
    expect(registry).toContain('ORGANIZER_REPORTS')
    // This phase adds no builder, no kind and no export path.
    expect(REPORTS_ROUTE_CANONICAL).toBe('/dashboard/finance/reports')
  })
})
