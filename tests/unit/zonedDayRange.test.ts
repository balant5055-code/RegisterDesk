// RD-BCAST-DATE-01 · the date maths the broadcast audience filter stands on.
//
// Every assertion here is about a boundary, because boundaries are where a date filter
// silently loses people. A registration at 00:00:00.000 must be IN; one at the next
// midnight must be OUT; and both facts must survive a timezone that is not UTC.

import { describe, it, expect } from 'vitest'
import { zonedDayRange, shiftISODate, isValidISODate, isValidTimezone } from '@/lib/registrations/zonedDayRange'

const IST = 'Asia/Kolkata'
const ok = (r: ReturnType<typeof zonedDayRange>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.range
}

describe('IANA conversion', () => {
  it('Asia/Kolkata midnight is 18:30 UTC the previous day', () => {
    // +5:30 — the offset most likely to expose an off-by-one-day error.
    expect(ok(zonedDayRange('2026-08-20', null, IST)).startUtc.toISOString())
      .toBe('2026-08-19T18:30:00.000Z')
  })

  it('the exclusive end is the NEXT day\'s midnight, not 23:59:59', () => {
    const r = ok(zonedDayRange('2026-08-20', null, IST))
    expect(r.endUtcExclusive.toISOString()).toBe('2026-08-20T18:30:00.000Z')
    // Exactly 24h for a non-DST zone, and never 86_399_999.
    expect(r.endUtcExclusive.getTime() - r.startUtc.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('UTC is handled as the degenerate case', () => {
    const r = ok(zonedDayRange('2026-08-20', null, 'UTC'))
    expect(r.startUtc.toISOString()).toBe('2026-08-20T00:00:00.000Z')
    expect(r.endUtcExclusive.toISOString()).toBe('2026-08-21T00:00:00.000Z')
  })

  it('a negative-offset zone resolves the other way', () => {
    expect(ok(zonedDayRange('2026-08-20', null, 'America/New_York')).startUtc.toISOString())
      .toBe('2026-08-20T04:00:00.000Z')   // EDT, UTC-4
  })
})

describe('DST awareness', () => {
  it('a spring-forward day is 23 hours long', () => {
    // America/New_York, 8 Mar 2026: clocks jump 02:00 → 03:00.
    const r = ok(zonedDayRange('2026-03-08', null, 'America/New_York'))
    expect(r.endUtcExclusive.getTime() - r.startUtc.getTime()).toBe(23 * 60 * 60 * 1000)
  })

  it('a fall-back day is 25 hours long', () => {
    // America/New_York, 1 Nov 2026: clocks fall 02:00 → 01:00.
    const r = ok(zonedDayRange('2026-11-01', null, 'America/New_York'))
    expect(r.endUtcExclusive.getTime() - r.startUtc.getTime()).toBe(25 * 60 * 60 * 1000)
  })

  it('the offset is re-derived per day, so a range spanning a transition stays exact', () => {
    const r = ok(zonedDayRange('2026-03-07', '2026-03-09', 'America/New_York'))
    expect(r.startUtc.toISOString()).toBe('2026-03-07T05:00:00.000Z')   // EST, UTC-5
    expect(r.endUtcExclusive.toISOString()).toBe('2026-03-10T04:00:00.000Z') // EDT, UTC-4
  })
})

describe('boundaries are half-open', () => {
  const r = ok(zonedDayRange('2026-08-20', null, IST))
  const at = (iso: string) => new Date(iso).getTime()

  it('exactly midnight is INCLUDED', () => {
    expect(at('2026-08-19T18:30:00.000Z')).toBeGreaterThanOrEqual(r.startUtc.getTime())
  })

  it('one millisecond before midnight is EXCLUDED', () => {
    expect(at('2026-08-19T18:29:59.999Z')).toBeLessThan(r.startUtc.getTime())
  })

  it('the last millisecond of the day is INCLUDED — the 23:59:59 hack would lose it', () => {
    expect(at('2026-08-20T18:29:59.999Z')).toBeLessThan(r.endUtcExclusive.getTime())
  })

  it('the next midnight is EXCLUDED', () => {
    expect(at('2026-08-20T18:30:00.000Z')).toBeGreaterThanOrEqual(r.endUtcExclusive.getTime())
  })
})

describe('ranges', () => {
  it('a single date is the range [d, d]', () => {
    expect(zonedDayRange('2026-08-20', '2026-08-20', IST)).toEqual(zonedDayRange('2026-08-20', null, IST))
  })

  it('spans a multi-day range inclusively at both ends', () => {
    const r = ok(zonedDayRange('2026-08-01', '2026-08-20', IST))
    expect(r.startUtc.toISOString()).toBe('2026-07-31T18:30:00.000Z')
    expect(r.endUtcExclusive.toISOString()).toBe('2026-08-20T18:30:00.000Z')  // 21 Aug 00:00 IST
  })

  it('crosses a month boundary', () => {
    expect(ok(zonedDayRange('2026-08-31', '2026-09-01', IST)).endUtcExclusive.toISOString())
      .toBe('2026-09-01T18:30:00.000Z')
  })

  it('crosses a leap day', () => {
    const r = ok(zonedDayRange('2028-02-28', '2028-02-29', 'UTC'))
    expect(r.endUtcExclusive.toISOString()).toBe('2028-03-01T00:00:00.000Z')
  })
})

describe('rejections', () => {
  it('rejects a malformed date', () => {
    for (const bad of ['20-08-2026', '2026/08/20', '2026-8-20', 'today', '']) {
      expect(zonedDayRange(bad, null, IST), bad).toEqual({ ok: false, error: 'invalid_date' })
    }
  })

  it('rejects a date that does not exist', () => {
    expect(zonedDayRange('2026-02-30', null, IST).ok).toBe(false)
    expect(zonedDayRange('2026-02-29', null, IST).ok).toBe(false)   // 2026 is not a leap year
    expect(zonedDayRange('2026-13-01', null, IST).ok).toBe(false)
  })

  it('rejects an invalid end date', () => {
    expect(zonedDayRange('2026-08-01', 'rubbish', IST)).toEqual({ ok: false, error: 'invalid_date' })
  })

  it('REJECTS an unknown timezone instead of falling back to UTC', () => {
    // A silent UTC fallback would shift an IST audience by 5½ hours — a different set of
    // people, with nothing on screen to say so.
    expect(zonedDayRange('2026-08-20', null, 'Mars/Olympus')).toEqual({ ok: false, error: 'invalid_timezone' })
    expect(zonedDayRange('2026-08-20', null, '')).toEqual({ ok: false, error: 'invalid_timezone' })
  })

  it('rejects start after end', () => {
    expect(zonedDayRange('2026-08-20', '2026-08-01', IST)).toEqual({ ok: false, error: 'start_after_end' })
  })

  it('accepts start == end', () => {
    expect(zonedDayRange('2026-08-20', '2026-08-20', IST).ok).toBe(true)
  })
})

describe('helpers', () => {
  it('shiftISODate moves whole days and rolls over months and years', () => {
    expect(shiftISODate('2026-08-20', 1)).toBe('2026-08-21')
    expect(shiftISODate('2026-08-20', -1)).toBe('2026-08-19')
    expect(shiftISODate('2026-08-31', 1)).toBe('2026-09-01')
    expect(shiftISODate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftISODate('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('validators agree with the range function', () => {
    expect(isValidISODate('2026-08-20')).toBe(true)
    expect(isValidISODate('2026-02-30')).toBe(false)
    expect(isValidTimezone(IST)).toBe(true)
    expect(isValidTimezone('Nowhere/Nothing')).toBe(false)
  })
})
