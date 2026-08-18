// RD-DASHBOARD-03 — organizer-wide registration analytics.
//
// These are the numbers an organizer trusts to answer "how many people are coming", and they
// had NO test coverage before this file. The properties pinned here are the ones that make
// the two cards believable:
//
//   • RECONCILIATION — Σ confirmed-by-pass === confirmed total, Σ cancelled-by-pass ===
//     cancelled total. A chart that disagrees with the status card beside it is worse than
//     no chart at all.
//   • NOTHING IS INVENTED — unreadable data sets a flag, never a zero.
//   • NOTHING IS DISCARDED — the tail becomes a real "Other", not a `.slice()`.
//   • "free" IS REAL — a pass genuinely named "free" displays as "free"; only an
//     unresolvable passId becomes "Unassigned".

import { describe, it, expect } from 'vitest'
import {
  buildDashboardAnalytics, DISPLAY_LIMIT,
  type EventAnalyticsInput,
} from '@/lib/analytics/dashboardAnalytics'
import type { RegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'

const status = (o: Partial<RegistrationStatusCounts> = {}): RegistrationStatusCounts => ({
  total: 0, confirmed: 0, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0, ...o,
})

const ev = (o: Partial<EventAnalyticsInput> = {}): EventAnalyticsInput => ({
  slug: 'e1', eventName: 'Event One', status: status(),
  passConfirmed: {}, passCancelled: {}, passNames: {}, ...o,
})

const row = (a: ReturnType<typeof buildDashboardAnalytics>, label: string) =>
  a.passDistribution.find(p => p.label === label)

// ─── 1 · The "free = 2" question ──────────────────────────────────────────────

describe('a pass genuinely named "free" is displayed, not treated as a fallback', () => {
  it('renders the CONFIGURED name, whatever it is', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 2, confirmed: 2 }),
      passConfirmed: { p_free: 2 },
      passNames:     { p_free: 'free' },
    })])
    expect(row(a, 'free')?.count).toBe(2)
    expect(row(a, 'Unassigned')).toBeUndefined()
  })

  it('an UNRESOLVABLE passId becomes Unassigned — never a made-up name', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 3, confirmed: 3 }),
      passConfirmed: { deleted_pass: 3 },
      passNames:     {},                       // the pass no longer exists on the event
    })])
    expect(row(a, 'Unassigned')?.count).toBe(3)
  })

  it('an empty configured name is Unassigned, not a blank label', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 1, confirmed: 1 }),
      passConfirmed: { p1: 1 },
      passNames:     { p1: '   ' },
    })])
    expect(row(a, 'Unassigned')?.count).toBe(1)
  })
})

// ─── 2 · Event scope consistency ──────────────────────────────────────────────

describe('all three cards describe the SAME events', () => {
  it('Event Performance is built from the same list and the same confirmed figure', () => {
    const a = buildDashboardAnalytics([
      ev({ slug: 'a', eventName: 'Marathon', status: status({ total: 88, confirmed: 88 }) }),
      ev({ slug: 'b', eventName: 'Lorem',    status: status({ total: 1,  confirmed: 1  }) }),
      // The event that used to be invisible: still published-at, no longer in a visible
      // lifecycle state. Its registrations counted toward the totals while its row was
      // missing, which is exactly why the cards could not be reconciled by eye.
      ev({ slug: 'c', eventName: 'Archived', status: status({ total: 2, confirmed: 2 }) }),
    ])
    expect(a.totals.confirmed).toBe(91)
    expect(a.eventPerformance.reduce((s, e) => s + e.count, 0)).toBe(91)
    expect(a.eventPerformance.map(e => e.label)).toContain('Archived')
  })
})

// ─── 3 · Reconciliation ───────────────────────────────────────────────────────

describe('the breakdowns reconcile with the status totals', () => {
  const a = buildDashboardAnalytics([
    ev({
      slug: 'a', eventName: 'Marathon',
      status:        status({ total: 119, confirmed: 91, cancelled: 28 }),
      passConfirmed: { m5: 44, w5: 41, m10: 3, free: 2, test: 1 },
      passCancelled: { m5: 8,  w5: 5,  m10: 15 },
      passNames:     { m5: '5 KM Marathon', w5: '5 KM Walkathon', m10: '10 KM Marathon', free: 'free', test: 'Test' },
    }),
  ])

  it('Σ confirmed-by-pass === Registration Status confirmed', () => {
    expect(a.passDistribution.reduce((s, p) => s + p.count, 0)).toBe(a.totals.confirmed)
    expect(a.totals.confirmed).toBe(91)
  })

  it('Σ cancelled-by-pass === Registration Status cancelled', () => {
    expect(a.passDistribution.reduce((s, p) => s + p.cancelled, 0)).toBe(a.totals.cancelled)
    expect(a.totals.cancelled).toBe(28)
  })

  it('each row totals its own parts', () => {
    for (const p of a.passDistribution) expect(p.total).toBe(p.count + p.cancelled)
    expect(row(a, '5 KM Marathon')).toMatchObject({ count: 44, cancelled: 8, total: 52 })
    expect(row(a, '5 KM Walkathon')).toMatchObject({ count: 41, cancelled: 5, total: 46 })
  })

  it('nothing is double counted across the two dimensions', () => {
    const grand = a.passDistribution.reduce((s, p) => s + p.total, 0)
    expect(grand).toBe(a.totals.confirmed + a.totals.cancelled)
  })
})

// ─── 4 · Unattributed vs Unassigned ───────────────────────────────────────────

describe('lost attribution is reported, never invented and never hidden', () => {
  it('empty passCounts with confirmed > 0 is Unattributed (the dotted-key defect)', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 50, confirmed: 50 }),
      passConfirmed: {},                       // permanently lost
    })])
    expect(row(a, 'Unattributed')?.count).toBe(50)
    expect(a.passDistribution.reduce((s, p) => s + p.count, 0)).toBe(50)
  })

  it('a counter that drifted BELOW the authoritative total surfaces the remainder', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 10, confirmed: 10 }),
      passConfirmed: { p1: 7 },                // 3 unaccounted for
      passNames:     { p1: 'Standard' },
    })])
    expect(row(a, 'Standard')?.count).toBe(7)
    expect(row(a, 'Unattributed')?.count).toBe(3)
    expect(a.passDistribution.reduce((s, p) => s + p.count, 0)).toBe(10)
  })

  it('cancelled that cannot be attributed to a pass is Unattributed too', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 12, confirmed: 10, cancelled: 2 }),
      passConfirmed: { p1: 10 },
      passCancelled: {},                       // cancellations exist but map to no live pass
      passNames:     { p1: 'Standard' },
    })])
    expect(row(a, 'Unattributed')?.cancelled).toBe(2)
    expect(a.passDistribution.reduce((s, p) => s + p.cancelled, 0)).toBe(2)
  })
})

// ─── 5 · Missing data is never zero ───────────────────────────────────────────

describe('unavailable data raises a flag instead of reporting zero', () => {
  it('an unreadable event flags statusUnavailable and contributes nothing', () => {
    const a = buildDashboardAnalytics([
      ev({ slug: 'a', status: status({ total: 5, confirmed: 5 }) }),
      ev({ slug: 'b', status: null }),
    ])
    expect(a.statusUnavailable).toBe(true)
    expect(a.totals.confirmed).toBe(5)      // never 5 + 0-as-if-known
  })

  it('an incomplete cancelled split flags passCancelledUnavailable', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 10, confirmed: 8, cancelled: 2 }),
      passConfirmed: { p1: 8 },
      passCancelled: null,                     // budget spent / read failed
      passNames:     { p1: 'Standard' },
    })])
    expect(a.passCancelledUnavailable).toBe(true)
    // and no zero was written into the row
    expect(row(a, 'Standard')?.cancelled).toBe(0)
  })

  it('an event with no cancellations does NOT raise the flag', () => {
    const a = buildDashboardAnalytics([ev({
      status:        status({ total: 8, confirmed: 8 }),
      passConfirmed: { p1: 8 },
      passCancelled: null,
      passNames:     { p1: 'Standard' },
    })])
    expect(a.passCancelledUnavailable).toBe(false)
  })

  it('no events at all yields zeroed totals and empty rows, not a crash', () => {
    const a = buildDashboardAnalytics([])
    expect(a.totals).toEqual({ total: 0, confirmed: 0, pending: 0, waitlisted: 0, cancelled: 0, rejected: 0 })
    expect(a.passDistribution).toEqual([])
    expect(a.registrationStatus).toEqual([])
    expect(a.statusUnavailable).toBe(false)
  })
})

// ─── 6 · Every status survives ────────────────────────────────────────────────

describe('pending, waitlisted and rejected are never silently lost', () => {
  const a = buildDashboardAnalytics([ev({
    status: status({ total: 100, confirmed: 60, pending: 12, waitlisted: 9, cancelled: 15, rejected: 4 }),
    passConfirmed: { p1: 60 }, passNames: { p1: 'Standard' },
  })])

  it('carries all five statuses through to the totals', () => {
    expect(a.totals).toMatchObject({ confirmed: 60, pending: 12, waitlisted: 9, cancelled: 15, rejected: 4 })
  })

  it('lists them all, rejected kept distinct from cancelled', () => {
    expect(a.registrationStatus.map(s => s.label))
      .toEqual(['Confirmed', 'Pending', 'Waitlisted', 'Cancelled', 'Rejected'])
  })

  it('the parts sum to the reported total', () => {
    const { confirmed, pending, waitlisted, cancelled, rejected } = a.totals
    expect(confirmed + pending + waitlisted + cancelled + rejected).toBe(a.totals.total)
  })

  it('omits only genuinely-zero statuses from the chart series', () => {
    const b = buildDashboardAnalytics([ev({ status: status({ total: 5, confirmed: 5 }) })])
    expect(b.registrationStatus.map(s => s.label)).toEqual(['Confirmed'])
  })
})

// ─── 7 · Top-N + a REAL Other ─────────────────────────────────────────────────

describe('the tail is aggregated, never discarded', () => {
  const many = Array.from({ length: DISPLAY_LIMIT + 4 }, (_, i) => [`p${i}`, DISPLAY_LIMIT + 4 - i] as const)
  const a = buildDashboardAnalytics([ev({
    status:        status({ total: 100, confirmed: many.reduce((s, [, n]) => s + n, 0) }),
    passConfirmed: Object.fromEntries(many),
    passNames:     Object.fromEntries(many.map(([id]) => [id, `Pass ${id}`])),
  })])

  it('caps the visible rows but keeps the total whole', () => {
    expect(a.passDistribution.length).toBe(DISPLAY_LIMIT + 1)   // head + Other
    expect(a.passDistribution.reduce((s, p) => s + p.count, 0)).toBe(a.totals.confirmed)
  })

  it('"Other" is a real sum of the remainder', () => {
    const other = row(a, 'Other')!
    const tail  = many.slice(DISPLAY_LIMIT).reduce((s, [, n]) => s + n, 0)
    expect(other.count).toBe(tail)
    expect(other.count).toBeGreaterThan(0)
  })

  it('Event Performance gets the same treatment', () => {
    const evs = Array.from({ length: DISPLAY_LIMIT + 3 }, (_, i) =>
      ev({ slug: `s${i}`, eventName: `E${i}`, status: status({ total: 10, confirmed: 10 }) }))
    const b = buildDashboardAnalytics(evs)
    expect(b.eventPerformance.length).toBe(DISPLAY_LIMIT + 1)
    expect(b.eventPerformance.reduce((s, e) => s + e.count, 0)).toBe(b.totals.confirmed)
  })
})

// ─── 8 · Cross-event merging ──────────────────────────────────────────────────

describe('the same pass name across events merges, because the card is organizer-wide', () => {
  it('adds both events into one row', () => {
    const a = buildDashboardAnalytics([
      ev({ slug: 'a', status: status({ total: 5, confirmed: 5 }), passConfirmed: { x: 5 }, passNames: { x: '5 KM' } }),
      ev({ slug: 'b', status: status({ total: 3, confirmed: 3 }), passConfirmed: { y: 3 }, passNames: { y: '5 KM' } }),
    ])
    expect(row(a, '5 KM')?.count).toBe(8)
    expect(a.passDistribution.reduce((s, p) => s + p.count, 0)).toBe(8)
  })
})
