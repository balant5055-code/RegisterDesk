// RD-RACEOPS-01 Sprint 2 — race time parsing / formatting.
//
// The single definition of "a valid finish time". Validation, preview and (later)
// ranking all depend on it, so every accepted and rejected form is pinned here.

import { describe, it, expect } from 'vitest'
import {
  parseRaceTime, formatRaceTime, MAX_RACE_DURATION_MS,
  MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND,
} from '@/features/race-operations/import/validation/time'

const ok = (raw: string) => {
  const r = parseRaceTime(raw)
  if (!r.ok) throw new Error(`expected "${raw}" to parse, got ${r.reason}`)
  return r.ms
}

describe('parseRaceTime — accepted forms', () => {
  it('hh:mm:ss', () => {
    expect(ok('01:48:32')).toBe(1 * MS_PER_HOUR + 48 * MS_PER_MINUTE + 32 * MS_PER_SECOND)
  })

  it('h:mm:ss without a leading zero', () => {
    expect(ok('1:48:32')).toBe(ok('01:48:32'))
  })

  it('mm:ss for a sub-hour result', () => {
    expect(ok('48:32')).toBe(48 * MS_PER_MINUTE + 32 * MS_PER_SECOND)
  })

  it('mm:ss where minutes exceed 59', () => {
    expect(ok('90:00')).toBe(90 * MS_PER_MINUTE)
  })

  it('a fractional second with a dot', () => {
    expect(ok('01:48:32.470')).toBe(ok('01:48:32') + 470)
  })

  it('a fractional second with a comma (European exports)', () => {
    expect(ok('01:48:32,47')).toBe(ok('01:48:32') + 470)
  })

  it('pads a one-digit fraction to hundreds of ms', () => {
    expect(ok('00:00:01.4')).toBe(1_400)
  })

  it('an Excel fraction-of-day duration', () => {
    // 0.075 of a day = 1.8h = 6,480,000 ms
    expect(ok('0.075')).toBe(6_480_000)
  })

  it('surrounding whitespace', () => {
    expect(ok('  01:48:32  ')).toBe(ok('01:48:32'))
  })

  it('an ultra-distance time beyond 24 hours', () => {
    expect(ok('30:15:00')).toBe(30 * MS_PER_HOUR + 15 * MS_PER_MINUTE)
  })
})

describe('parseRaceTime — rejected forms', () => {
  it('reports empty separately from unreadable', () => {
    expect(parseRaceTime('')).toEqual({ ok: false, reason: 'empty' })
    expect(parseRaceTime('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(parseRaceTime(null)).toEqual({ ok: false, reason: 'empty' })
    expect(parseRaceTime(undefined)).toEqual({ ok: false, reason: 'empty' })
  })

  it.each(['ABC', 'DNF', '1:2:3:4', '--', 'n/a', '12', '1:60:00', '01:48:99', '-01:00:00'])(
    'rejects %s as unreadable',
    raw => { expect(parseRaceTime(raw).ok).toBe(false) },
  )

  it('rejects zero', () => {
    expect(parseRaceTime('00:00:00')).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('rejects a duration beyond the plausible maximum', () => {
    const overMaxHours = Math.floor(MAX_RACE_DURATION_MS / MS_PER_HOUR) + 1
    expect(parseRaceTime(`${overMaxHours}:00:00`)).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('rejects a day-fraction of 1 or more (a date cell, not a duration)', () => {
    expect(parseRaceTime('1.5').ok).toBe(false)
  })
})

describe('formatRaceTime', () => {
  it('round-trips hh:mm:ss', () => {
    expect(formatRaceTime(ok('01:48:32'))).toBe('01:48:32')
  })

  it('normalises mm:ss input to hh:mm:ss output', () => {
    expect(formatRaceTime(ok('48:32'))).toBe('00:48:32')
  })

  it('shows milliseconds only when present', () => {
    expect(formatRaceTime(ok('01:48:32.470'))).toBe('01:48:32.470')
    expect(formatRaceTime(ok('01:48:32'))).toBe('01:48:32')
  })

  it('does not wrap past 24 hours', () => {
    expect(formatRaceTime(ok('30:15:00'))).toBe('30:15:00')
  })

  it('is defensive about a nonsense input', () => {
    expect(formatRaceTime(Number.NaN)).toBe('—')
    expect(formatRaceTime(-1)).toBe('—')
  })
})
