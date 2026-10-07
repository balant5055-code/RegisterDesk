// RD-REPORT-04 · Timing Chip reporting — the pure view model.
//
// Two rules, both of which have a specific way of going wrong:
//
//   1. APPLICABILITY IS CONFIGURATION. A conference that never switched the device
//      on must produce NO figures — not "0 assigned, 0% coverage", which reads as a
//      race-day emergency on an event that has no chips at all.
//
//   2. THE NUMBER COMES FIRST. The eligible population for a device is the people
//      who already hold an identifier, because the engine refuses everyone else.
//      Counting all confirmed participants would report a shortfall the organizer
//      cannot act on until numbers are assigned.

import { describe, it, expect } from 'vitest'
import {
  buildTimingReport, describeTimingEligible, cellText, coverageText,
  TIMING_DISABLED_REASON, fromCount,
} from '@/lib/identifiers/timingReport'

const base = {
  enabled: true as boolean,
  mode: 'mapped' as 'mapped' | 'identifier',
  label: 'Timing Chip',
  identifierLabel: 'BIB',
  counts: { eligible: 1094, identified: 1064, mapped: 1000 },
  rosterCounts: { mapped: 1000, mappedWithIdentifier: 1000, mappedWithoutIdentifier: 0 },
  passes: [
    { passId: 'p5',  passName: '5 KM',  total: 528, withIdentifier: 498, withTag: 480 },
    { passId: 'p10', passName: '10 KM', total: 566, withIdentifier: 566, withTag: 520 },
  ],
}
const build = (over: Partial<typeof base> = {}) => buildTimingReport({ ...base, ...over })
const ready = (over: Partial<typeof base> = {}) => {
  const r = build(over)
  if (!r.applicable) throw new Error('expected an applicable report')
  return r
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — APPLICABILITY
// ════════════════════════════════════════════════════════════════════════════

describe('1 — an event that does not use a device', () => {
  it('produces no figures at all', () => {
    const r = build({ enabled: false })
    expect(r.applicable).toBe(false)
    expect(r).not.toHaveProperty('overall')
  })

  it('says why', () => {
    const r = build({ enabled: false })
    expect(r.applicable === false && r.reason).toBe(TIMING_DISABLED_REASON)
  })

  it('stays inapplicable even when chips and counts exist in the data', () => {
    // Applicability is the stored configuration, never inferred from a lock, a
    // registration field, or a non-zero count that happens to be present.
    const r = build({
      enabled: false,
      counts: { eligible: 500, identified: 500, mapped: 480 },
      rosterCounts: { mapped: 480, mappedWithIdentifier: 480, mappedWithoutIdentifier: 0 },
    })
    expect(r.applicable).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — ELIGIBILITY IS BIB HOLDERS
// ════════════════════════════════════════════════════════════════════════════

describe('2 — the eligible population', () => {
  it('is identifier holders, not everyone confirmed', () => {
    const r = ready()
    expect(cellText(r.overall.eligible)).toBe('1,064')   // identified
    expect(cellText(r.overall.eligible)).not.toBe('1,094') // confirmed
  })

  it('names itself using the event\'s own identifier label', () => {
    expect(describeTimingEligible('BIB')).toBe('confirmed registrations holding a BIB')
    // The article follows the configured noun rather than being hardcoded.
    expect(describeTimingEligible('Entry Number')).toBe('confirmed registrations holding an Entry Number')
  })

  it('reports those blocked for want of a number SEPARATELY', () => {
    const r = ready()
    // 1094 confirmed − 1064 holding a number. Not an assignment shortfall.
    expect(cellText(r.blockedWithoutIdentifier)).toBe('30')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — CORE METRICS (§24)
// ════════════════════════════════════════════════════════════════════════════

describe('3 — the regression shape', () => {
  it('reports the event totals, never a page', () => {
    const r = ready()
    expect(cellText(r.overall.eligible)).toBe('1,064')
    expect(cellText(r.overall.assigned)).toBe('1,000')
    expect(cellText(r.overall.unassigned)).toBe('64')
    expect(coverageText(r.overall.coverage)).toBe('94.0%')
  })

  it('counts assigned on the ROSTER, not from the lock collection', () => {
    // Locks say 1,200 — devices out, including any held by people the roster
    // excludes. The eligible-population figure must not use it.
    const r = ready({ counts: { eligible: 1094, identified: 1064, mapped: 1200 } })
    expect(cellText(r.overall.assigned)).toBe('1,000')
    expect(cellText(r.heldOutsideRoster)).toBe('200')
    expect(r.hasIntegrityWarning).toBe(true)
  })

  it('per-pass figures are exact', () => {
    const r = ready()
    const p5 = r.passes.find(p => p.passId === 'p5')!
    const p10 = r.passes.find(p => p.passId === 'p10')!
    expect([cellText(p5.eligible), cellText(p5.assigned), cellText(p5.unassigned)]).toEqual(['498', '480', '18'])
    expect(coverageText(p5.coverage)).toBe('96.4%')
    expect([cellText(p10.eligible), cellText(p10.assigned), cellText(p10.unassigned)]).toEqual(['566', '520', '46'])
    expect(coverageText(p10.coverage)).toBe('91.9%')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — EDGE STATES
// ════════════════════════════════════════════════════════════════════════════

describe('4 — zero, all, none, unknown', () => {
  it('zero eligible is N/A coverage, not 0%', () => {
    const r = ready({
      counts: { eligible: 0, identified: 0, mapped: 0 },
      rosterCounts: { mapped: 0, mappedWithIdentifier: 0, mappedWithoutIdentifier: 0 },
      passes: [],
    })
    expect(cellText(r.overall.eligible)).toBe('0')
    expect(coverageText(r.overall.coverage)).toBe('N/A')
  })

  it('none assigned with a real population IS 0%', () => {
    const r = ready({
      counts: { eligible: 500, identified: 500, mapped: 0 },
      rosterCounts: { mapped: 0, mappedWithIdentifier: 0, mappedWithoutIdentifier: 0 },
      passes: [],
    })
    expect(coverageText(r.overall.coverage)).toBe('0.0%')
    expect(cellText(r.overall.unassigned)).toBe('500')
  })

  it('all assigned is exactly 100%', () => {
    const r = ready({
      counts: { eligible: 500, identified: 500, mapped: 500 },
      rosterCounts: { mapped: 500, mappedWithIdentifier: 500, mappedWithoutIdentifier: 0 },
      passes: [],
    })
    expect(coverageText(r.overall.coverage)).toBe('100.0%')
    expect(cellText(r.overall.unassigned)).toBe('0')
  })

  it('an unreadable aggregate is "—", never 0', () => {
    const r = ready({
      counts: { eligible: 500, identified: null, mapped: null },
      rosterCounts: { mapped: null, mappedWithIdentifier: null, mappedWithoutIdentifier: null },
      passes: [],
    })
    expect(cellText(r.overall.eligible)).toBe('—')
    expect(cellText(r.overall.assigned)).toBe('—')
    expect(coverageText(r.overall.coverage)).toBe('—')
  })

  it('a null count is unknown while a zero count is a measurement', () => {
    expect(fromCount(null).state).toBe('unknown')
    expect(fromCount(undefined).state).toBe('unknown')
    expect(cellText(fromCount(0))).toBe('0')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — INTEGRITY (§4 · the BIB dependency)
// ════════════════════════════════════════════════════════════════════════════

describe('5 — a device without a number is an anomaly', () => {
  it('is counted and flagged, never absorbed into "assigned"', () => {
    const r = ready({
      rosterCounts: { mapped: 1000, mappedWithIdentifier: 997, mappedWithoutIdentifier: 3 },
    })
    expect(cellText(r.anomalyWithoutIdentifier)).toBe('3')
    expect(r.hasIntegrityWarning).toBe(true)
  })

  it('a healthy event raises no warning', () => {
    expect(ready().hasIntegrityWarning).toBe(false)
  })

  it('coverage above 100% is reported, not clamped', () => {
    const r = ready({
      counts: { eligible: 1094, identified: 400, mapped: 500 },
      rosterCounts: { mapped: 500, mappedWithIdentifier: 500, mappedWithoutIdentifier: 0 },
      passes: [],
    })
    expect(r.overall.coverage.exceedsEligible).toBe(true)
    expect(r.overall.coverage.percent).toBeGreaterThan(100)
    // …and the impossible subtraction refuses to print a negative.
    expect(cellText(r.overall.unassigned)).toBe('—')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — MODE
// ════════════════════════════════════════════════════════════════════════════

describe('6 — identifier mode', () => {
  it('is applicable but has nothing to map', () => {
    const r = ready({ mode: 'identifier' })
    expect(r.mode).toBe('identifier')
    expect(r.applicable).toBe(true)
  })

  it('keeps the configured device label verbatim', () => {
    // Never lower-cased, never substituted — an event calling them Transponders
    // must see that word.
    expect(ready({ label: 'Transponder' }).label).toBe('Transponder')
    expect(ready({ label: 'RFID Band' }).label).toBe('RFID Band')
  })
})
