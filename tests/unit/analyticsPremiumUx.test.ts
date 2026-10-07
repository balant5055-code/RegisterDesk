// RD-ANALYTICS-12-33 · Premium Analytics UX — presentation only.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// Three states that used to collapse into one (empty denominator, unknown event, attendance
// not started) now have their own words; the Overview names its module and captions its
// lifetime figures; one event selector; the module strip hides what the payload does not
// offer; the loading state reserves space; targets are ≥ 40px; the Communications window
// table has no minimum width. Every assertion is against source or the pure presentation
// model — nothing here reads data, and no contract, rule, permission or query changed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { intelligenceRows, moneyUnavailableNote } from '@/lib/analytics/revenueModel'
import { readAttendance } from '@/lib/analytics/operationsModel'
import type { RevenueAnalytics, OperationsAnalytics } from '@/lib/analytics/contract'

const raw  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const code = (p: string) => raw(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const CHROME   = code('components/analytics/ModuleChrome.tsx')
const NAV      = code('components/analytics/AnalyticsModuleNav.tsx')
const HOOK     = code('components/analytics/useAnalyticsScope.ts')
const PROVIDER = code('components/analytics/AnalyticsScopeProvider.tsx')
const OVERVIEW = code('components/analytics/overview/AnalyticsOverview.tsx')
const REVENUE  = code('components/analytics/revenue/RevenueAnalytics.tsx')
const OPS      = code('components/analytics/operations/OperationsAnalytics.tsx')
const COMMS    = code('components/analytics/communications/CommunicationsAnalytics.tsx')
const INSIGHTS = code('components/analytics/insights/InsightsAnalytics.tsx')
const MODULES  = ['overview', 'registrations', 'revenue', 'operations', 'communications', 'participants', 'insights']

const money = (paise: number) => ({ ok: true as const, paise })
const gone  = (reason: 'query_failed' | 'out_of_budget') => ({ ok: false as const, reason })
const revenue = (aov: RevenueAnalytics['intelligence']['averageOrderValue']): RevenueAnalytics => ({
  confirmedRevenue: money(0), netRevenue: money(0), grossCollected: money(0), platformFee: money(0), gst: money(0),
  gatewayFee: money(0), netSettlement: money(0), refunds: money(0), refundCount: 0, communicationCost: money(0),
  profitEstimate: money(0), byDay: [], byPass: [], byPassBasis: 'lifetime_confirmed',
  intelligence: {
    velocity: { perDayPaise: money(0), windowDays: 30, basis: 'period_rollup_revenue_per_day' },
    averageOrderValue: aov,
    refundRate: { pct: null, basis: 'completed_refunds_over_confirmed_revenue' },
    refundsInPeriod: { amount: money(0), count: 0, comparison: { value: 0, baseline: null, delta: null, unavailable: 'no_baseline' }, basis: 'refund_ledger_by_refund_date' },
    beforeDiscount: { paise: money(0), discount: money(0), basis: 'confirmed_revenue_plus_discount_given' },
  },
})

// ─── A · empty denominator ≠ read failure ───────────────────────────────────

describe('RD-ANALYTICS-12-33 · A · average order value with no paid registrations', () => {
  it('1 · a zero denominator carries its own note and never the read-failure wording', () => {
    const row = intelligenceRows(revenue({ paise: gone('query_failed'), denominator: 0, basis: 'confirmed_revenue_per_paid_registration' }), 'last 30 days')
      .find(r => r.key === 'aov')!
    expect(row.emptyDenominatorNote).toBe('No paid registrations yet')
    expect(row.money).toEqual(gone('query_failed'))               // the payload is untouched
    expect(row.definition).not.toMatch(/could not be read/)
    expect(REVENUE).toContain('{row.emptyDenominatorNote ?? moneyUnavailableNote(row.money)}')
  })

  it('2 · a genuinely failed read (denominator unknown) keeps "could not be read"', () => {
    const row = intelligenceRows(revenue({ paise: gone('query_failed'), denominator: null, basis: 'confirmed_revenue_per_paid_registration' }), 'last 30 days')
      .find(r => r.key === 'aov')!
    expect(row.emptyDenominatorNote).toBeUndefined()
    expect(moneyUnavailableNote(row.money)).toBe('could not be read')
  })

  it('3 · a measured average is still a rupee figure with its divisor named', () => {
    const row = intelligenceRows(revenue({ paise: money(125_000), denominator: 80, basis: 'confirmed_revenue_per_paid_registration' }), 'last 30 days')
      .find(r => r.key === 'aov')!
    expect(row.emptyDenominatorNote).toBeUndefined()
    expect(row.money).toEqual(money(125_000))
    expect(row.definition).toContain('÷ 80 paid registrations, all time')
  })

  it('4 · the empty-denominator state is never rendered as ₹0', () => {
    expect(REVENUE).not.toMatch(/emptyDenominatorNote[^\n]*₹0|₹0[^\n]*emptyDenominatorNote/)
  })
})

// ─── B · unknown / unauthorized event ───────────────────────────────────────

describe('RD-ANALYTICS-12-33 · B · an event the workspace cannot see', () => {
  it('5 · the hook exposes the context\'s own urlEventMissing — no new resolution logic', () => {
    expect(HOOK).toContain('urlEventMissing')
    expect(HOOK).toMatch(/const \{ selectedEventId, selectedEvent, isAllEvents, loading: eventsLoading, urlEventMissing \} = useEventContext\(\)/)
    expect(HOOK).not.toMatch(/fetch\([^)]*events/)
  })

  it('6 · the chrome renders a distinct, non-leaky state before the "select an event" placeholder', () => {
    const missing = CHROME.indexOf('if (urlEventMissing)')
    const select  = CHROME.indexOf('Select a single event')
    expect(missing).toBeGreaterThan(0)
    expect(missing).toBeLessThan(select)
    expect(CHROME).toContain('This event is not available in your workspace.')
    // One sentence for not-found / unpublished / not-yours — nothing says which.
    expect(CHROME).not.toMatch(/another workspace|belongs to|owned by|not found\b/i)
  })

  it('7 · a server refusal still renders the server\'s own generic message as an alert', () => {
    expect(CHROME).toContain('<Placeholder role="alert">{load.message}</Placeholder>')
  })
})

// ─── C · attendance not started ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-33 · C · attendance before the first scan', () => {
  const ops = (attendance: OperationsAnalytics['attendance']): OperationsAnalytics =>
    ({ checkedIn: attendance.checkedIn, attendancePct: attendance.pct, byDay: [], attendance })

  it('8 · zero scans render "Not started", not "0%"; the model is untouched', () => {
    const a = readAttendance(ops({ confirmed: 200, checkedIn: 0, pct: 0, awaited: 200, over: false }))
    expect(a.pct).toBe(0)                                           // arithmetic preserved
    expect(OPS).toMatch(/attendance\.pct !== null && attendance\.checkedIn === 0 \? \(/)
    expect(OPS).toContain('value="Not started"')
    expect(OPS).toContain('No check-ins yet')
  })

  it('9 · a measured rate with scans still prints the percentage', () => {
    const a = readAttendance(ops({ confirmed: 200, checkedIn: 40, pct: 20, awaited: 160, over: false }))
    expect(a.pct).toBe(20)
    expect(OPS).toContain("value={attendance.pct === null ? null : `${attendance.pct}%`}")
  })

  it('10 · an unmeasured side stays the unavailable mark, with different wording from not-started', () => {
    const a = readAttendance(ops({ confirmed: null, checkedIn: 0, pct: null, awaited: null, over: false }))
    expect(a.state).toBe('unmeasured')
    expect(OPS).toContain('unavailableNote="needs both figures"')
    for (const src of [OPS, OVERVIEW, INSIGHTS]) expect(src).not.toMatch(/no[- ]?show/i)
  })

  it('11 · the Overview rail says "no check-ins yet" for the same case', () => {
    expect(OVERVIEW).toContain("'All time · no check-ins yet'")
  })
})

// ─── Overview provenance and terminology ────────────────────────────────────

describe('RD-ANALYTICS-12-33 · Overview', () => {
  it('12 · the H1 names the module, through the shared chrome', () => {
    expect(OVERVIEW).toContain('title="Overview"')
    expect(OVERVIEW).toContain('<ModuleHeader')
    expect(OVERVIEW).not.toMatch(/<h1/)
  })

  it('13 · every lifetime rail figure is captioned "All time"; the windowed line keeps the window', () => {
    expect((OVERVIEW.match(/All time/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(OVERVIEW).toContain('in the ${windowLabel}')
    expect(OVERVIEW).toContain('baselineLabel={baselineLabel}')
  })

  it('14 · no section shares the Insights module\'s name', () => {
    expect(OVERVIEW).not.toContain('title="Insights"')
    expect(OVERVIEW).toContain('title="Highlights"')
  })
})

// ─── Selector, chrome, targets, skeleton ────────────────────────────────────

describe('RD-ANALYTICS-12-33 · shell', () => {
  it('15 · one event selector: no module renders its own', () => {
    for (const src of [CHROME, OVERVIEW, REVENUE, OPS, COMMS, INSIGHTS]) expect(src).not.toMatch(/<EventSelector/)
  })

  it('16 · the compact header keeps eyebrow, module, window and controls', () => {
    expect(CHROME).toMatch(/gap-y-2 sm:gap-y-3/)
    expect(CHROME).toContain("'text-[length:var(--fs-xl)] sm:text-[length:var(--fs-2xl)]'")
    expect(CHROME).toContain('aria-label="Date range"')
  })

  it('17 · presets and refresh are ≥ 36/40px tall and stay real buttons with focus rings', () => {
    expect(CHROME).toMatch(/inline-flex min-h-9 items-center rounded-md px-3 text-fs-xs/)
    expect(CHROME).toMatch(/inline-flex min-h-10 items-center gap-1\.5 rounded-lg/)
    expect((CHROME.match(/type="button"/g) ?? []).length).toBe(2)
    expect((CHROME.match(/focus-visible:ring-2/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(CHROME).not.toMatch(/onClick=\{[^}]*\}\s*className[^>]*>\s*<div/)   // no div-as-button
  })

  it('18 · Insights card links and strip links carry ≥ 40px hit areas', () => {
    expect((INSIGHTS.match(/inline-flex min-h-10 items-center/g) ?? []).length).toBe(2)
    expect(NAV).toContain('min-h-10')
  })

  it('19 · loading reserves the rail and two sections, and stills for reduced motion', () => {
    expect(CHROME).toContain('return <ModuleSkeleton />')
    expect(CHROME).toContain('aria-busy="true"')
    expect(CHROME).toContain('animate-pulse motion-reduce:animate-none')
    expect(CHROME).not.toContain('Loading analytics…')
    expect(CHROME).toMatch(/lg:grid-cols-4/)
  })
})

// ─── Capability-gated strip and the shared payload ──────────────────────────

describe('RD-ANALYTICS-12-33 · module strip', () => {
  it('20 · hides modules absent from capabilities.modules; Overview and Insights always listed', () => {
    expect(NAV).toContain('scope?.data?.capabilities.modules ?? null')
    expect(NAV).toMatch(/ANALYTICS_MODULES\.filter\(m => ALWAYS\.has\(m\.key\) \|\| \(offered as string\[\]\)\.includes\(m\.key\)\)/)
    expect(NAV).toContain("new Set(['insights', 'overview'])")
    expect(NAV).not.toMatch(/fetch\(|availableAnalyticsModules/)   // reads the payload, computes nothing
  })

  it('21 · the strip reads the page\'s ONE payload through the provider — no second fetch', () => {
    expect(NAV).toContain("import { AnalyticsScopeContext } from './useAnalyticsScope'")
    expect(HOOK).toContain('export const AnalyticsScopeContext = createContext<AnalyticsScopeState | null>(null)')
    expect(HOOK).toMatch(/if \(!enabled \|\| !scoped \|\| !slug\) return/)
    expect(PROVIDER).toContain('useStandaloneAnalyticsScope(initialPreset, true)')
    for (const m of MODULES) {
      const page = raw(`app/(dashboard)/dashboard/analytics/${m}/page.tsx`)
      expect(page, m).toContain('<AnalyticsScopeProvider>')
      expect(page, m).toContain('<AnalyticsModuleNav />')
    }
  })

  it('22 · a page with a provider fetches once; a consumer without one still works standalone', () => {
    expect(HOOK).toMatch(/const shared = useContext\(AnalyticsScopeContext\)\s*const standalone = useStandaloneAnalyticsScope\(initialPreset, shared === null\)\s*return shared \?\? standalone/)
  })
})

// ─── Communications table ───────────────────────────────────────────────────

describe('RD-ANALYTICS-12-33 · Communications window table', () => {
  it('23 · no minimum width; compact cells below sm; every column kept', () => {
    expect(COMMS).not.toContain('min-w-[32rem]')
    expect(COMMS).toContain('<table className="w-full text-fs-xs">')
    for (const h of ['Channel', 'Attempted', 'Delivered', 'Not delivered', 'Queued', 'Skipped']) expect(COMMS).toContain(`>${h}</th>`)
    expect(COMMS).toContain("last ? 'px-3 lg:px-5' : 'px-2 lg:px-3'")
    expect(COMMS).toContain('border-t border-border sm:hidden')   // the phone-width list
    expect(COMMS).toContain('hidden overflow-x-auto border-t border-border sm:block')
  })
})

// ─── Nothing below the presentation moved ───────────────────────────────────

describe('RD-ANALYTICS-12-33 · data safety', () => {
  it('24 · no contract, rule, query, permission or route file changed shape', () => {
    const contract = code('lib/analytics/contract.ts')
    expect(contract).not.toMatch(/emptyDenominator|notStarted|urlEventMissing/)
    expect(code('lib/analytics/insightsRules.ts')).not.toMatch(/emptyDenominator|Not started/)
    expect(code('lib/analytics/revenueIntelligence.ts')).toContain("gone('query_failed')")   // AOV reason untouched
    expect(code('lib/analytics/operationsModel.ts')).not.toMatch(/notStarted|'not_started'/)
  })
})
