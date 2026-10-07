// RD-DASHBOARD-02 — the Attention Center's rules, and the figures beside them.
//
// The brief's hard line is "do not invent business rules" and "do not generate fake
// alerts". These tests are what enforce it: every rule must fire on real observable
// state, and must stay SILENT when the platform cannot know the answer.

import { describe, it, expect } from 'vitest'
import {
  buildAttention, buildUpcoming, computeDelta, computePace, setupIssue,
  daysUntil, fillPct,
  NEARLY_FULL_PCT, BEHIND_PACE_PCT, PACE_MIN_DAYS, PACE_MIN_DAYS_LEFT,
  type EventSignalInput,
} from '@/lib/dashboard/insights'
import type { DailyStatsPoint } from '@/lib/dashboard/dailyStats'

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

function ev(over: Partial<EventSignalInput> & { draftId: string }): EventSignalInput {
  return {
    name: `Event ${over.draftId}`,
    slug: over.draftId,
    lifecycleStatus: 'published',
    status: 'published',
    startDate: iso(NOW + 30 * DAY),
    regCloseDate: null,
    registered: 100,
    capacity: 1000,
    passCount: 3,
    reviewStatus: null,
    ...over,
  }
}

function series(days: number, perDay: number): DailyStatsPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: `d${i}`, confirmed: perDay, cancelled: 0, revenuePaise: perDay * 1000, checkedIn: 0,
  }))
}

// ─── Primitives ───────────────────────────────────────────────────────────────

describe('daysUntil / fillPct', () => {
  it('rounds days up, so "closes in 0 days" means today', () => {
    expect(daysUntil(iso(NOW + 2.2 * DAY), NOW)).toBe(3)
    expect(daysUntil(iso(NOW + 0.2 * DAY), NOW)).toBe(1)
  })

  it('returns null for an absent or unparseable date rather than 0', () => {
    // 0 would read as "today" and fire a false deadline alert.
    expect(daysUntil(null, NOW)).toBeNull()
    expect(daysUntil('not-a-date', NOW)).toBeNull()
  })

  it('is null for an unlimited-capacity event, never 0%', () => {
    expect(fillPct(500, null)).toBeNull()
    expect(fillPct(500, 0)).toBeNull()
  })

  it('clamps an oversold event to 100', () => {
    expect(fillPct(1300, 1000)).toBe(100)
  })
})

// ─── Setup completeness ───────────────────────────────────────────────────────

describe('setupIssue — only OBSERVABLE blockers', () => {
  it('flags a published event with no passes', () => {
    expect(setupIssue(ev({ draftId: 'a', passCount: 0 }), NOW)).toMatch(/no passes/i)
  })

  it('flags a published event with no public URL', () => {
    expect(setupIssue(ev({ draftId: 'a', slug: null }), NOW)).toMatch(/public page/i)
  })

  it('flags a draft whose start date is close', () => {
    expect(setupIssue(ev({ draftId: 'a', status: 'draft', lifecycleStatus: 'draft', startDate: iso(NOW + 5 * DAY) }), NOW))
      .toMatch(/still a draft/i)
  })

  it('stays SILENT on a healthy published event', () => {
    expect(setupIssue(ev({ draftId: 'a' }), NOW)).toBeNull()
  })

  it('stays silent on a far-off draft — that is not a problem yet', () => {
    expect(setupIssue(ev({ draftId: 'a', status: 'draft', lifecycleStatus: 'draft', startDate: iso(NOW + 200 * DAY) }), NOW))
      .toBeNull()
  })
})

// ─── Pace ─────────────────────────────────────────────────────────────────────

describe('computePace — returns NOTHING when it cannot know', () => {
  it('is null without a capacity to be behind on', () => {
    expect(computePace(ev({ draftId: 'a', capacity: null }), series(30, 5), NOW)).toBeNull()
  })

  it('is null without a start date to project to', () => {
    expect(computePace(ev({ draftId: 'a', startDate: null }), series(30, 5), NOW)).toBeNull()
  })

  it('is null with too little observed history', () => {
    // Pace on a two-day-old event is noise, not signal.
    expect(computePace(ev({ draftId: 'a' }), series(PACE_MIN_DAYS - 1, 5), NOW)).toBeNull()
  })

  it('is null when the event is about to start — the warning is no longer actionable', () => {
    expect(computePace(ev({ draftId: 'a', startDate: iso(NOW + (PACE_MIN_DAYS_LEFT - 1) * DAY) }), series(30, 5), NOW))
      .toBeNull()
  })

  it('projects from the observed rate and flags a shortfall', () => {
    // 100 registered, 1/day, 30 days left → ~130 of 1000 = 13% → behind.
    const p = computePace(ev({ draftId: 'a', registered: 100, capacity: 1000 }), series(30, 1), NOW)
    expect(p).not.toBeNull()
    expect(p!.perDay).toBe(1)
    expect(p!.daysLeft).toBe(30)
    expect(p!.projectedPct).toBeLessThan(BEHIND_PACE_PCT)
    expect(p!.behind).toBe(true)
  })

  it('does NOT flag an event tracking to fill', () => {
    // 100 registered, 30/day, 30 days left → ~1000 of 1000 → on track.
    const p = computePace(ev({ draftId: 'a', registered: 100, capacity: 1000 }), series(30, 30), NOW)
    expect(p!.behind).toBe(false)
  })
})

// ─── Attention ────────────────────────────────────────────────────────────────

describe('buildAttention', () => {
  it('produces NOTHING for a healthy workspace', () => {
    // The panel must disappear entirely when all is well — a permanent "all clear"
    // trains the organizer to ignore that region.
    expect(buildAttention({ events: [ev({ draftId: 'a' })], now: NOW })).toEqual([])
  })

  it('flags an event at or above the capacity threshold', () => {
    const s = buildAttention({ events: [ev({ draftId: 'a', registered: NEARLY_FULL_PCT * 10, capacity: 1000 })], now: NOW })
    expect(s.some(x => x.id === 'full:a')).toBe(true)
  })

  it('does not flag an event just below the threshold', () => {
    const s = buildAttention({ events: [ev({ draftId: 'a', registered: 840, capacity: 1000 })], now: NOW })
    expect(s.some(x => x.id === 'full:a')).toBe(false)
  })

  it('treats a full event as CRITICAL and a nearly-full one as a warning', () => {
    const full = buildAttention({ events: [ev({ draftId: 'a', registered: 1000, capacity: 1000 })], now: NOW })
    const near = buildAttention({ events: [ev({ draftId: 'b', registered: 900, capacity: 1000 })], now: NOW })
    expect(full.find(x => x.id === 'full:a')!.severity).toBe('critical')
    expect(near.find(x => x.id === 'full:b')!.severity).toBe('warning')
  })

  it('flags registration closing within the window', () => {
    const s = buildAttention({ events: [ev({ draftId: 'a', regCloseDate: iso(NOW + 2 * DAY) })], now: NOW })
    expect(s.some(x => x.id === 'closing:a')).toBe(true)
  })

  it('does NOT flag a close date already in the past', () => {
    const s = buildAttention({ events: [ev({ draftId: 'a', regCloseDate: iso(NOW - 2 * DAY) })], now: NOW })
    expect(s.some(x => x.id === 'closing:a')).toBe(false)
  })

  it('flags an event starting imminently and points at check-in', () => {
    const s = buildAttention({ events: [ev({ draftId: 'a', startDate: iso(NOW + 1 * DAY) })], now: NOW })
    const sig = s.find(x => x.id === 'starting:a')
    expect(sig).toBeTruthy()
    expect(sig!.actionHref).toContain('tab=attendance')
  })

  it('surfaces a review outcome as CRITICAL and suppresses lesser signals for it', () => {
    const s = buildAttention({
      events: [ev({ draftId: 'a', reviewStatus: 'rejected', registered: 1000, capacity: 1000 })],
      now: NOW,
    })
    expect(s).toHaveLength(1)
    expect(s[0].severity).toBe('critical')
    expect(s[0].id).toBe('review:a')
  })

  it('IGNORES cancelled, archived and completed events entirely', () => {
    // Alerting about a cancelled event's capacity is noise the organizer cannot act on.
    for (const st of ['cancelled', 'archived', 'completed']) {
      const s = buildAttention({
        events: [ev({ draftId: 'a', lifecycleStatus: st, registered: 1000, capacity: 1000 })],
        now: NOW,
      })
      expect(s, st).toEqual([])
    }
  })

  it('surfaces workspace payment issues with a link to the canonical module', () => {
    const s = buildAttention({ events: [], paymentIssues: 3, now: NOW })
    expect(s[0].actionHref).toBe('/dashboard/finance/payment-issues')
    expect(s[0].severity).toBe('critical')
  })

  it('orders critical before warning before info', () => {
    const s = buildAttention({
      events: [
        ev({ draftId: 'soon',  startDate: iso(NOW + 1 * DAY) }),              // info
        ev({ draftId: 'full',  registered: 900, capacity: 1000 }),            // warning
        ev({ draftId: 'setup', passCount: 0 }),                               // critical
      ],
      now: NOW,
    })
    const order = s.map(x => x.severity)
    expect(order).toEqual([...order].sort((a, b) =>
      ({ critical: 0, warning: 1, info: 2 })[a] - ({ critical: 0, warning: 1, info: 2 })[b]))
  })

  it('never fabricates a pace alert without a series', () => {
    // No rollup series supplied ⇒ pace is skipped, not estimated.
    const s = buildAttention({ events: [ev({ draftId: 'a', registered: 1, capacity: 100000 })], now: NOW })
    expect(s.some(x => x.id.startsWith('pace:'))).toBe(false)
  })
})

// ─── Deltas ───────────────────────────────────────────────────────────────────

describe('computeDelta', () => {
  it('computes a percentage change', () => {
    expect(computeDelta(120, 100)).toEqual({ pct: 20, direction: 'up' })
    expect(computeDelta(80, 100)).toEqual({ pct: -20, direction: 'down' })
    expect(computeDelta(100, 100)).toEqual({ pct: 0, direction: 'flat' })
  })

  it('returns NULL rather than Infinity when the previous period was zero', () => {
    // "Up ∞%" / "up 100%" from nothing is not a statistic. The UI shows direction only.
    expect(computeDelta(50, 0)).toEqual({ pct: null, direction: 'up' })
    expect(computeDelta(0, 0)).toEqual({ pct: null, direction: 'flat' })
  })
})

// ─── Upcoming ─────────────────────────────────────────────────────────────────

describe('buildUpcoming', () => {
  it('orders by soonest start', () => {
    const list = buildUpcoming([
      ev({ draftId: 'far',  startDate: iso(NOW + 40 * DAY) }),
      ev({ draftId: 'soon', startDate: iso(NOW + 2 * DAY) }),
    ], NOW)
    expect(list.map(e => e.draftId)).toEqual(['soon', 'far'])
  })

  it('excludes events that already started and dead lifecycles', () => {
    const list = buildUpcoming([
      ev({ draftId: 'past',      startDate: iso(NOW - 5 * DAY) }),
      ev({ draftId: 'cancelled', lifecycleStatus: 'cancelled' }),
      ev({ draftId: 'ok' }),
    ], NOW)
    expect(list.map(e => e.draftId)).toEqual(['ok'])
  })

  it('keeps undated events, sorted last — undated work is still work', () => {
    const list = buildUpcoming([
      ev({ draftId: 'undated', startDate: null }),
      ev({ draftId: 'dated',   startDate: iso(NOW + 3 * DAY) }),
    ], NOW)
    expect(list.map(e => e.draftId)).toEqual(['dated', 'undated'])
  })

  it('reports null fill for an unlimited event rather than 0%', () => {
    const list = buildUpcoming([ev({ draftId: 'a', capacity: null })], NOW)
    expect(list[0].fillPct).toBeNull()
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => ev({ draftId: `e${i}`, startDate: iso(NOW + (i + 1) * DAY) }))
    expect(buildUpcoming(many, NOW, 5)).toHaveLength(5)
  })
})
