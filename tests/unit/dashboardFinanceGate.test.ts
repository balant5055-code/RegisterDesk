// RD-DASHBOARD-02 — the finance gate, and the rollup's consistency guarantee.
//
// Both are structural properties of the source, so they are asserted against the
// source. A behavioural test would need the Admin SDK (which the node-env vitest run
// cannot boot) and would in any case only prove the path it exercised; these assert
// the invariant itself, in the idiom this repo already uses for such rules
// (see checkinStaffLeastPrivilege.test.ts).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROLE_PERMISSIONS } from '@/lib/team/types'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// RD-DASH-03: the activity feed moved to lib/dashboard/activityFeed (shared with the
// paging endpoint). ROUTE spans both so a guard cannot pass merely because the code it
// checks was extracted.
const ROUTE  = strip(read('app/api/organizer/dashboard/route.ts'))
  + strip(read('lib/dashboard/activityFeed.ts'))
  + strip(read('app/api/organizer/dashboard/activity/route.ts'))
  + strip(read('lib/dashboard/activityCursor.ts'))
// RD-DASH-03: Recent Activity moved to components/dashboard/RecentActivityCard.
const PAGE   = strip(read('app/(dashboard)/dashboard/page.tsx'))
  + strip(read('components/dashboard/RecentActivityCard.tsx'))
const REGS   = strip(read('lib/firebase/firestore/registrations.ts'))
const SCAN   = strip(read('app/api/checkin/scan/route.ts'))
const RULES  = read('firestore.rules')

// ─── The finance gate ─────────────────────────────────────────────────────────

describe('finance permission gating', () => {
  it('is decided SERVER-side from the caller’s own permissions', () => {
    expect(ROUTE).toContain("authz.permissions.includes('transactions')")
  })

  it('uses the SAME permission /api/organizer/finance requires', () => {
    // If these ever diverge, one endpoint would disclose what the other refuses —
    // the exact inconsistency this change removed.
    const finance = strip(read('app/api/organizer/finance/route.ts'))
    expect(finance).toContain("authorizeWorkspace(req, 'transactions')")
  })

  it('OMITS money rather than zeroing it', () => {
    // `₹0` is a lie that looks like a measurement. Absence is honest and lets the UI
    // say "not available to your role".
    expect(ROUTE).toContain('...(financeAllowed ? {')
    expect(ROUTE).toMatch(/financeAllowed \? \{[\s\S]*?settlement:/)
    expect(ROUTE).toMatch(/financeAllowed \? \{[\s\S]*?walletBalancePaise/)
    expect(ROUTE).toMatch(/financeAllowed \? \{[\s\S]*?totalRevenuePaise/)
  })

  it('never emits a zero fallback for a gated money field', () => {
    for (const bad of [
      'totalRevenuePaise: financeAllowed ? totalRevPaise : 0',
      'walletBalancePaise: financeAllowed ? walletBalancePaise : 0',
    ]) {
      expect(ROUTE).not.toContain(bad)
    }
  })

  it('the client renders a restricted state, not a zero', () => {
    expect(PAGE).toContain('restricted={!finance.allowed}')
    expect(PAGE).toContain('finance.allowed ?')
  })

  it('roles without the permission genuinely exist — the gate is not theoretical', () => {
    // admin and manager are real roles that hold `events`/`registrations` but NOT
    // `transactions`, so the gate changes what they see.
    expect(ROLE_PERMISSIONS.admin).not.toContain('transactions')
    expect(ROLE_PERMISSIONS.manager).not.toContain('transactions')
    expect(ROLE_PERMISSIONS.finance).toContain('transactions')
    expect(ROLE_PERMISSIONS.owner).toContain('transactions')
  })
})

// ─── The rollup ───────────────────────────────────────────────────────────────

describe('organizerDailyStats consistency', () => {
  it('the 5,000-row trend scan is GONE, not merely raised', () => {
    expect(ROUTE).not.toContain('RECENT_WINDOW_CAP')
    expect(ROUTE).not.toContain('limit(5000)')
    // And the replacement is bounded by DAYS, not by registration volume.
    expect(ROUTE).toContain('const TREND_DAYS = 90')
    // RD-DASHBOARD-05 — the read now carries an event dimension. Asserted by BEHAVIOUR
    // (the day range is still the bound) rather than by source literal, so a rename of
    // the scope expression cannot fail a test about the 5,000-row scan.
    expect(ROUTE).toMatch(/readDailyStats\(uid,[^)]*trendKeys\)/)
  })

  it('the activity feed is the only remaining registration query, and it is small', () => {
    // RD-DASH-03: still bounded, and now smaller — one page of ten per stream.
    expect(ROUTE).toContain('export const ACTIVITY_PAGE_SIZE = 10')
    expect(ROUTE).toContain('.limit(fetchLimit)')
  })

  it('every rollup write is staged INSIDE the caller’s transaction', () => {
    // This is the entire consistency story: the rollup and registrationCounters either
    // both land or neither does, so the trend cannot drift from the counting SSOT.
    expect(REGS).toContain('stageDailyStatsIncrement(txn,')
    expect(REGS).not.toMatch(/applyDailyStatsIncrement\(/)
    expect(SCAN).toContain('stageDailyStatsIncrement(txn,')
  })

  it('covers every registration lifecycle transition', () => {
    for (const action of ['confirm', 'reverse_confirm', 'record_cancel', 'restore', 'unrecord_cancel', 'approve', 'checkin', 'undo_checkin']) {
      expect(REGS + SCAN, action).toContain(`action: '${action}'`)
    }
  })

  it('a cancellation reverses the ORIGINAL day, not today', () => {
    // Otherwise a January registration cancelled in March leaves January permanently
    // claiming revenue it no longer has.
    expect(REGS).toMatch(/originalDay[\s\S]{0,200}action: 'reverse_confirm'/)
  })

  it('the collection is server-only in the rules', () => {
    expect(RULES).toContain('match /organizerDailyStats/{docId} { allow read, write: if false; }')
  })
})

// ─── Trend honesty ────────────────────────────────────────────────────────────

describe('trend integrity is surfaced, not swallowed', () => {
  it('the API reports unavailability and coverage', () => {
    expect(ROUTE).toContain('trendUnavailable')
    expect(ROUTE).toContain('historySince')
    expect(ROUTE).toContain('historyPartial')
  })

  it('a failed rollup read resolves to null, never to an empty series', () => {
    expect(ROUTE).toMatch(/readDailyStats\(uid,[^)]*trendKeys\)\.catch\(\(\) => null\)/)
    expect(ROUTE).toContain('const trendUnavailable = dailySeriesResult === null')
  })

  it('the client forwards all three to the trend panel', () => {
    expect(PAGE).toContain('unavailable={data.trendUnavailable}')
    expect(PAGE).toContain('historySince={data.historySince}')
    expect(PAGE).toContain('historyPartial={data.historyPartial}')
  })

  // ═══ The bug the audit found ═══════════════════════════════════════════════
  it('analyticsUnavailable is now actually CONSUMED by the client', () => {
    // The API always produced this flag and its doc comment demanded the client honour
    // it — but the page never forwarded it, so failed counter reads rendered as
    // authoritative zeros for two charts.
    expect(PAGE).toContain('analyticsUnavailable={data.analyticsUnavailable}')
    const charts = strip(read('components/dashboard/DashboardCharts.tsx'))
    expect(charts).toContain('analyticsUnavailable?: boolean')
    expect(charts).toContain('unavailable={analyticsUnavailable}')
  })
})

// ─── Scope ────────────────────────────────────────────────────────────────────

// RD-DASHBOARD-05 REVERSED THIS. The dashboard previously asserted it stayed GLOBAL and
// deliberately ignored the Event Selector. It now FOLLOWS the selector, at the product
// owner's direction — see tests/unit/dashboardEventScope.test.ts for the full contract.
//
// What survives here is the part that did not change: the scope must be STATED on
// screen, never left implied, whichever mode the page is in.
describe('/dashboard states its scope', () => {
  it('follows the header event selector, and says which event it is showing', () => {
    expect(PAGE).toContain('useEventContext')
    expect(PAGE).toContain('selectedEventId')
    // The badge names the applied scope in BOTH modes — the event's own name when
    // scoped, "All events" otherwise. A selector with no visible consequence is how a
    // number ends up read under the wrong heading.
    // The scope now lives in the header's own subtitle + identity line rather than
    // PageHeader's badge slot (RD-DASHBOARD-08). Same rule, different element.
    expect(PAGE).toMatch(/All events/)
    expect(PAGE).toMatch(/\{scopeName\}/)
    expect(PAGE).toMatch(/happening for this event today/)
  })

  it('event links enter the canonical Event Overview', () => {
    const upcoming = strip(read('components/dashboard/UpcomingEvents.tsx'))
    expect(upcoming).toContain('/dashboard/events/${encodeURIComponent(e.draftId)}')
  })
})
