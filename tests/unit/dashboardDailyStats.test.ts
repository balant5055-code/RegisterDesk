// RD-DASHBOARD-02 — the daily-rollup rules.
//
// These cover the decisions that make the trend TRUE rather than merely present:
// which calendar day a registration lands in, what a cancellation does to the day it
// came from, and whether an uncovered day can ever be mistaken for a measured zero.

import { describe, it, expect } from 'vitest'
import {
  dayKey, dayKeyRange, dailyStatsDocId, deltaFor, isNoOpDelta,
  buildSeries, sumSeries, resolveCoverage, REPORTING_TZ_OFFSET_MINUTES, ALL_EVENTS,
  type DailyStatsPoint,
} from '@/lib/dashboard/dailyStats'

// ─── Day bucketing ────────────────────────────────────────────────────────────

describe('dayKey', () => {
  it('buckets by the INDIA reporting day, not the host timezone', () => {
    // The defect this prevents: a Vercel function running in UTC put every
    // registration after 18:30 IST into "tomorrow", so the dashboard disagreed with
    // the organizer's own calendar every evening.
    // 2026-08-23T19:00:00Z is 2026-08-24 00:30 IST → the 24th.
    expect(dayKey(Date.parse('2026-08-23T19:00:00Z'))).toBe('2026-08-24')
    // 2026-08-23T18:00:00Z is 2026-08-23 23:30 IST → still the 23rd.
    expect(dayKey(Date.parse('2026-08-23T18:00:00Z'))).toBe('2026-08-23')
  })

  it('uses a fixed offset so every host agrees', () => {
    expect(REPORTING_TZ_OFFSET_MINUTES).toBe(330)
  })

  it('pads month and day to a sortable YYYY-MM-DD', () => {
    // String comparison is used for month filtering and coverage, so the shape matters.
    expect(dayKey(Date.parse('2026-01-05T06:00:00Z'))).toBe('2026-01-05')
  })

  it('accepts a Date as well as millis', () => {
    const d = new Date('2026-03-15T10:00:00Z')
    expect(dayKey(d)).toBe(dayKey(d.getTime()))
  })
})

describe('dayKeyRange', () => {
  it('returns the range oldest → newest, inclusive of today', () => {
    const r = dayKeyRange(Date.parse('2026-08-23T06:00:00Z'), 3)
    expect(r).toEqual(['2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('produces exactly the requested number of days', () => {
    expect(dayKeyRange(Date.now(), 90)).toHaveLength(90)
  })
})

describe('dailyStatsDocId', () => {
  it('is deterministic, so the read needs no query and the write is idempotent', () => {
    expect(dailyStatsDocId('uid1', ALL_EVENTS, '2026-08-23')).toBe('uid1____all____2026-08-23')
    expect(dailyStatsDocId('uid1', ALL_EVENTS, '2026-08-23'))
      .toBe(dailyStatsDocId('uid1', ALL_EVENTS, '2026-08-23'))
  })

  // RD-DASHBOARD-05 — the event dimension. Without it an event-scoped trend could only
  // be drawn from the workspace series, which is the "workspace data under an event
  // heading" defect the scope work exists to remove.
  it('separates the workspace row from each event row', () => {
    const ws = dailyStatsDocId('uid1', ALL_EVENTS, '2026-08-23')
    const a  = dailyStatsDocId('uid1', 'city-marathon', '2026-08-23')
    const b  = dailyStatsDocId('uid1', 'trail-run',     '2026-08-23')
    expect(new Set([ws, a, b]).size).toBe(3)
  })

  it('cannot be made ambiguous by an underscore inside a uid or a slug', () => {
    // Single-underscore separators would let ('a_b','c') and ('a','b_c') collide. The
    // double underscore is what makes the id parseable and unique.
    expect(dailyStatsDocId('a_b', 'c', '2026-08-23'))
      .not.toBe(dailyStatsDocId('a', 'b_c', '2026-08-23'))
  })

  it('cannot collide with the coverage marker', () => {
    // The marker is `{uid}__meta`; a day is always YYYY-MM-DD, so the two never clash.
    expect(dailyStatsDocId('uid1', ALL_EVENTS, '2026-08-23')).not.toBe('uid1__meta')
    expect(dailyStatsDocId('uid1', 'meta', '2026-08-23')).not.toBe('uid1__meta')
  })
})

// ─── Attribution ──────────────────────────────────────────────────────────────

describe('deltaFor', () => {
  it('counts a new confirmed registration and its revenue', () => {
    expect(deltaFor({ action: 'confirm', amountPaise: 80000 }))
      .toEqual({ confirmed: 1, cancelled: 0, revenuePaise: 80000, checkedIn: 0 })
  })

  it('counts a free registration without inventing revenue', () => {
    expect(deltaFor({ action: 'confirm', amountPaise: 0 }).revenuePaise).toBe(0)
  })

  // ═══ The rule that keeps the trend honest ══════════════════════════════════
  it('reverse_confirm removes the registration AND its revenue', () => {
    // Applied to the ORIGINAL day. Without this, a January registration cancelled in
    // March would leave January permanently claiming revenue it no longer has, and
    // the trend would drift from registrationCounters forever.
    expect(deltaFor({ action: 'reverse_confirm', amountPaise: 80000 }))
      .toEqual({ confirmed: -1, cancelled: 0, revenuePaise: -80000, checkedIn: 0 })
  })

  it('record_cancel touches only the cancellation count, never revenue', () => {
    // Applied to TODAY. Revenue was already reversed on the original day; doing it
    // again here would double-subtract.
    expect(deltaFor({ action: 'record_cancel', amountPaise: 80000 }))
      .toEqual({ confirmed: 0, cancelled: 1, revenuePaise: 0, checkedIn: 0 })
  })

  it('cancel then restore is a perfect round trip', () => {
    const amount = 120000
    const parts = [
      deltaFor({ action: 'confirm',         amountPaise: amount }),
      deltaFor({ action: 'reverse_confirm', amountPaise: amount }),
      deltaFor({ action: 'record_cancel',   amountPaise: amount }),
      deltaFor({ action: 'restore',         amountPaise: amount }),
      deltaFor({ action: 'unrecord_cancel', amountPaise: amount }),
    ]
    const net = parts.reduce((a, d) => ({
      confirmed: a.confirmed + d.confirmed,
      cancelled: a.cancelled + d.cancelled,
      revenuePaise: a.revenuePaise + d.revenuePaise,
      checkedIn: a.checkedIn + d.checkedIn,
    }))
    // Back to exactly one confirmed registration and its revenue — no residue.
    expect(net).toEqual({ confirmed: 1, cancelled: 0, revenuePaise: amount, checkedIn: 0 })
  })

  it('check-in and its undo cancel out', () => {
    const a = deltaFor({ action: 'checkin' })
    const b = deltaFor({ action: 'undo_checkin' })
    expect(a.checkedIn + b.checkedIn).toBe(0)
    expect(a.revenuePaise).toBe(0)
  })

  it('treats a non-finite amount as zero rather than writing NaN into a counter', () => {
    expect(deltaFor({ action: 'confirm', amountPaise: Number.NaN }).revenuePaise).toBe(0)
  })
})

describe('isNoOpDelta', () => {
  it('lets a caller skip a write that would change nothing', () => {
    expect(isNoOpDelta({ confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0 })).toBe(true)
    expect(isNoOpDelta({ confirmed: 0, cancelled: 0, revenuePaise: -1, checkedIn: 0 })).toBe(false)
  })
})

// ─── Series ───────────────────────────────────────────────────────────────────

describe('buildSeries', () => {
  const days = ['2026-08-21', '2026-08-22', '2026-08-23']

  it('zero-fills days with no document', () => {
    // Inside coverage, a missing document genuinely means no activity — the write
    // path only creates one when something happened.
    const s = buildSeries(days, new Map())
    expect(s).toHaveLength(3)
    expect(s.every(p => p.confirmed === 0 && p.revenuePaise === 0)).toBe(true)
  })

  it('preserves the requested order and dates', () => {
    const s = buildSeries(days, new Map())
    expect(s.map(p => p.date)).toEqual(days)
  })

  it('uses stored values where present', () => {
    const byDay = new Map<string, DailyStatsPoint>([
      ['2026-08-22', { date: '2026-08-22', confirmed: 7, cancelled: 1, revenuePaise: 5000, checkedIn: 2 }],
    ])
    expect(buildSeries(days, byDay)[1].confirmed).toBe(7)
  })
})

describe('sumSeries', () => {
  it('totals the range', () => {
    const s: DailyStatsPoint[] = [
      { date: 'a', confirmed: 2, cancelled: 0, revenuePaise: 100, checkedIn: 1 },
      { date: 'b', confirmed: 3, cancelled: 1, revenuePaise: 250, checkedIn: 4 },
    ]
    expect(sumSeries(s)).toEqual({ confirmed: 5, revenuePaise: 350, checkedIn: 5 })
  })
})

// ─── Coverage ─────────────────────────────────────────────────────────────────

describe('resolveCoverage', () => {
  const days = ['2026-06-01', '2026-06-02', '2026-06-03']

  it('flags a range that reaches before coverage as PARTIAL', () => {
    // This is what stops uncovered days rendering as measured zeros — the exact lie
    // the old capped scan told.
    expect(resolveCoverage(days, '2026-06-02')).toEqual({ since: '2026-06-02', partial: true })
  })

  it('is complete when coverage starts at or before the range', () => {
    expect(resolveCoverage(days, '2026-06-01').partial).toBe(false)
    expect(resolveCoverage(days, '2026-01-01').partial).toBe(false)
  })

  it('treats absent coverage as partial, never as complete', () => {
    // Fail towards disclosure: claiming full history we cannot prove is the one
    // outcome that must not happen.
    expect(resolveCoverage(days, null)).toEqual({ since: null, partial: true })
  })

  it('is not partial when nothing was requested', () => {
    expect(resolveCoverage([], null).partial).toBe(false)
  })
})
