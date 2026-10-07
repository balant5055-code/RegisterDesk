// RD-REPORT-03 · BIB reporting — the pure view model.
//
// The rule this file defends: THREE OUTCOMES, NEVER TWO.
//
//   known           we counted it, even when the count is 0
//   unknown         we could not count it
//   notApplicable   the question does not apply to this pass
//
// Collapsing either of the last two into 0 is the defect. "0 assigned" is a call to
// action; printing it for a pass that issues no numbers, or for a query that failed,
// sends an organizer to fix something that is not broken.

import { describe, it, expect } from 'vitest'
import {
  knownCell, unknownCell, notApplicableCell, fromMetric,
  calculateCoverage, buildPassRow, buildBibReport, describeEligible,
  cellText, coverageText, NO_NUMBERS_CONFIGURED,
} from '@/lib/identifiers/bibReport'
import { knownMetric, unavailableMetric } from '@/lib/identifiers/statistics'
import type { PassScopeStat, EligibilityReport } from '@/lib/identifiers/statistics'

const scope = (over: Partial<PassScopeStat> = {}): PassScopeStat => ({
  passId: 'p5', passName: '5 KM', passExists: true, poolIds: ['pool5'],
  capacityKind: 'finite', capacity: 999, assigned: 480, consumed: 0,
  occupied: 480, available: 519, utilization: 48,
  eligible: knownMetric(498),
  unassignedEligible: knownMetric(18),
  participantsWithIdentifier: knownMetric(480),
  uncountedParticipants: 0,
  ...over,
} as PassScopeStat)

const report = (over: Partial<EligibilityReport> = {}): EligibilityReport => ({
  policy: 'divergent',
  engineTerminalStatuses: ['cancelled', 'rejected'],
  rosterStatuses: ['confirmed'],
  divergentStatuses: ['waitlisted', 'pending'],
  eligible: knownMetric(1064),
  assignedEligible: knownMetric(1000),
  unassignedEligible: knownMetric(64),
  uncountedEligible: 0,
  unassignedReason: 'reason',
  ...over,
} as EligibilityReport)

// ════════════════════════════════════════════════════════════════════════════
// 1 — COVERAGE ARITHMETIC
// ════════════════════════════════════════════════════════════════════════════

describe('1 — coverage', () => {
  it('is assigned / eligible, to one decimal', () => {
    expect(calculateCoverage(knownCell(480), knownCell(498)).percent).toBe(96.4)
    expect(calculateCoverage(knownCell(1000), knownCell(1064)).percent).toBe(94)
    expect(calculateCoverage(knownCell(520), knownCell(554)).percent).toBe(93.9)
  })

  it('is 100 when everyone is assigned, and 0 when nobody is', () => {
    expect(calculateCoverage(knownCell(498), knownCell(498)).percent).toBe(100)
    // A real, counted zero — this one IS printable.
    const none = calculateCoverage(knownCell(0), knownCell(498))
    expect(none.percent).toBe(0)
    expect(none.state).toBe('known')
  })

  it('refuses to divide by an eligible population of zero', () => {
    const c = calculateCoverage(knownCell(0), knownCell(0))
    expect(c.state).toBe('notApplicable')
    expect(c.percent).toBeNull()
    // Never NaN, never Infinity, never a bare 0%.
    expect(coverageText(c)).toBe('N/A')
  })

  it('is UNKNOWN when either side is unknown — never a half-guessed percentage', () => {
    expect(calculateCoverage(unknownCell('x'), knownCell(498)).state).toBe('unknown')
    expect(calculateCoverage(knownCell(480), unknownCell('x')).state).toBe('unknown')
    expect(coverageText(calculateCoverage(unknownCell('x'), knownCell(1))).toString()).toBe('—')
  })

  it('REPORTS above 100% rather than clamping it', () => {
    // Reachable in normal operation: the engine assigns to anything except cancelled
    // and rejected, while the roster counts only confirmed. A pending entrant holding
    // a number is assigned but not eligible.
    const c = calculateCoverage(knownCell(510), knownCell(498))
    expect(c.percent).toBeGreaterThan(100)
    expect(c.exceedsEligible).toBe(true)
    expect(coverageText(c)).toBe('102.4%')
  })

  it('flags an impossible assignment even when there is no denominator', () => {
    const c = calculateCoverage(knownCell(3), knownCell(0))
    expect(c.state).toBe('notApplicable')
    expect(c.exceedsEligible).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — NOT APPLICABLE IS NOT ZERO
// ════════════════════════════════════════════════════════════════════════════

describe('2 — a pass that issues no numbers', () => {
  const noPool = scope({
    poolIds: [], passId: 'phalf', passName: 'Half Marathon',
    eligible: knownMetric(120),
    participantsWithIdentifier: knownMetric(0),
    unassignedEligible: knownMetric(120),
  })

  it('is NOT APPLICABLE, not 0 assigned', () => {
    const row = buildPassRow(noPool)
    expect(row.issuesNumbers).toBe(false)
    expect(row.assigned.state).toBe('notApplicable')
    expect(row.unassigned.state).toBe('notApplicable')
    expect(cellText(row.assigned)).toBe('N/A')
    expect(cellText(row.unassigned)).toBe('N/A')
  })

  it('says why, in words', () => {
    expect(buildPassRow(noPool).assigned.reason).toBe(NO_NUMBERS_CONFIGURED)
  })

  it('has no coverage — 0% would read as a shortfall', () => {
    const row = buildPassRow(noPool)
    expect(row.coverage.state).toBe('notApplicable')
    expect(coverageText(row.coverage)).toBe('N/A')
  })

  it('still reports its real participant count', () => {
    // The people exist; it is the assignment question that does not apply.
    expect(cellText(buildPassRow(noPool).eligible)).toBe('120')
  })

  it('a pass WITH a pool and nobody assigned is a real 0, not N/A', () => {
    const row = buildPassRow(scope({
      participantsWithIdentifier: knownMetric(0),
      unassignedEligible: knownMetric(498),
    }))
    expect(row.assigned.state).toBe('known')
    expect(cellText(row.assigned)).toBe('0')
    expect(row.coverage.percent).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — UNKNOWN SURVIVES
// ════════════════════════════════════════════════════════════════════════════

describe('3 — an unmeasured figure stays unmeasured', () => {
  it('an unavailable metric becomes an unknown cell, not 0', () => {
    const c = fromMetric(unavailableMetric('could not read'))
    expect(c.state).toBe('unknown')
    expect(c.value).toBeNull()
    expect(cellText(c)).toBe('—')
  })

  it('a missing metric is unknown too', () => {
    expect(fromMetric(undefined).state).toBe('unknown')
    expect(fromMetric(null).state).toBe('unknown')
  })

  it('a known ZERO is preserved as a number', () => {
    const c = fromMetric(knownMetric(0))
    expect(c.state).toBe('known')
    expect(cellText(c)).toBe('0')
  })

  it('an incompletely covered roster leaves unassigned UNKNOWN', () => {
    const r = buildBibReport({
      configured: true,
      eligibility: report({ unassignedEligible: unavailableMetric('legacy rows'), uncountedEligible: 12 }),
      passScopes: [],
    })
    expect(r.overall.unassigned.state).toBe('unknown')
    expect(r.uncounted).toBe(12)
    // …while the two figures that WERE counted stay exact.
    expect(cellText(r.overall.eligible)).toBe('1,064')
    expect(cellText(r.overall.assigned)).toBe('1,000')
    expect(r.overall.coverage.percent).toBe(94)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — THE WHOLE REPORT
// ════════════════════════════════════════════════════════════════════════════

describe('4 — report assembly', () => {
  it('the event row is NOT a sum of the pass rows', () => {
    // The passes here total 498; the event row says 1,064. Summing pass rows would
    // omit every confirmed registration whose pass is not in the configuration —
    // precisely the population most likely to be missing a number.
    const r = buildBibReport({
      configured: true,
      eligibility: report(),
      passScopes: [scope()],
    })
    expect(cellText(r.overall.eligible)).toBe('1,064')
    expect(cellText(r.passes[0].eligible)).toBe('498')
  })

  it('names the eligible population from the roster rule', () => {
    expect(describeEligible(report())).toBe('confirmed registrations')
    // Never invented when the report is missing.
    expect(describeEligible(null)).toBe('confirmed registrations')
  })

  it('raises one integrity flag when any row exceeds its population', () => {
    const clean = buildBibReport({ configured: true, eligibility: report(), passScopes: [scope()] })
    expect(clean.hasIntegrityWarning).toBe(false)

    const bad = buildBibReport({
      configured: true, eligibility: report(),
      passScopes: [scope({ participantsWithIdentifier: knownMetric(510) })],
    })
    expect(bad.hasIntegrityWarning).toBe(true)
  })

  it('an event with nothing configured reports it rather than showing zeros', () => {
    const r = buildBibReport({ configured: false, eligibility: null, passScopes: null })
    expect(r.configured).toBe(false)
    expect(r.overall.eligible.state).toBe('unknown')
    expect(r.overall.assigned.state).toBe('unknown')
  })

  it('an event with zero eligible participants is not a coverage failure', () => {
    const r = buildBibReport({
      configured: true,
      eligibility: report({ eligible: knownMetric(0), assignedEligible: knownMetric(0), unassignedEligible: knownMetric(0) }),
      passScopes: [],
    })
    expect(cellText(r.overall.eligible)).toBe('0')
    expect(r.overall.coverage.state).toBe('notApplicable')
    expect(r.hasIntegrityWarning).toBe(false)
  })

  it('every participant assigned reads as 100%, not as a rounding artefact', () => {
    const r = buildBibReport({
      configured: true,
      eligibility: report({ eligible: knownMetric(777), assignedEligible: knownMetric(777), unassignedEligible: knownMetric(0) }),
      passScopes: [],
    })
    expect(coverageText(r.overall.coverage)).toBe('100.0%')
    expect(cellText(r.overall.unassigned)).toBe('0')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — DISPLAY
// ════════════════════════════════════════════════════════════════════════════

describe('5 — text rendering', () => {
  it('groups digits in the Indian convention', () => {
    expect(cellText(knownCell(1064))).toBe('1,064')
    expect(cellText(knownCell(120000))).toBe('1,20,000')
  })

  it('uses one glyph per state', () => {
    expect(cellText(unknownCell('x'))).toBe('—')
    expect(cellText(notApplicableCell('x'))).toBe('N/A')
    expect(cellText(knownCell(0))).toBe('0')
  })
})
