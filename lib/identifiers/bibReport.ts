// RD-REPORT-03 — BIB reporting: the PURE view model.
//
// No I/O, no SDK, no React. The identifier read model goes in, an organizer-facing
// report comes out — so the arithmetic that decides whether a number is printed, and
// what is printed when it cannot be, is testable without a network or a browser.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THREE OUTCOMES, NEVER TWO.                                               ║
// ║                                                                           ║
// ║    known           we counted it — even when the count is 0               ║
// ║    unknown         we could not count it, or the data cannot answer yet   ║
// ║    notApplicable   the question does not apply to this pass at all        ║
// ║                                                                           ║
// ║  Collapsing `unknown` or `notApplicable` into 0 is the defect this module  ║
// ║  exists to prevent: "0 assigned" is a call to action, and printing it for  ║
// ║  a pass that issues no numbers — or for a query that failed — sends an     ║
// ║  organizer to fix something that is not broken.                           ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// This module does NOT decide who is eligible. That rule lives in ./eligibility and
// is already in force in the assignment engine; here it is only reported.

import type { IdentifierMetric, PassScopeStat, EligibilityReport } from './statistics'

// ─── Cell ───────────────────────────────────────────────────────────────────

export type BibCellState = 'known' | 'unknown' | 'notApplicable'

export interface BibCell {
  state:  BibCellState
  /** Only ever a number when `state === 'known'`. */
  value:  number | null
  /** Why it is not known. Present for `unknown`, and for `notApplicable`. */
  reason: string | null
}

export const knownCell = (value: number): BibCell => ({ state: 'known', value, reason: null })
export const unknownCell = (reason: string): BibCell => ({ state: 'unknown', value: null, reason })
export const notApplicableCell = (reason: string): BibCell =>
  ({ state: 'notApplicable', value: null, reason })

/** An `IdentifierMetric` from the read model, in this module's vocabulary. */
export function fromMetric(m: IdentifierMetric | undefined | null): BibCell {
  if (!m) return unknownCell('Not measured.')
  return m.status === 'known' && m.value !== null
    ? knownCell(m.value)
    : unknownCell(m.reason ?? 'Not measured.')
}

export const NO_NUMBERS_CONFIGURED =
  'No BIB numbers are configured for this pass, so none can be assigned.'

// ─── Coverage ───────────────────────────────────────────────────────────────

export interface BibCoverage {
  /** assigned / eligible × 100, rounded to one decimal. */
  percent: number | null
  state:   BibCellState
  reason:  string | null
  /**
   * True when more registrations hold a number than the eligible population
   * contains. That is a data-integrity signal, not a display problem — see below.
   */
  exceedsEligible: boolean
}

/**
 * Coverage, or an honest refusal to state one.
 *
 * ═══ WHY THIS IS NOT `assigned / eligible` AND A CLAMP ═══════════════════════
 *
 *   • Either side unknown        → UNKNOWN. A percentage computed from one known
 *                                  number and one guess is a guess.
 *   • eligible === 0             → NOT APPLICABLE. Nobody can hold a number, so
 *                                  there is no proportion to state. 0% would read
 *                                  as "nobody has been assigned yet", which is a
 *                                  claim about a population that does not exist.
 *   • assigned > eligible        → REPORTED, NOT CLAMPED. The value is returned as
 *                                  it computes, above 100, with `exceedsEligible`
 *                                  set. This is reachable in normal operation: the
 *                                  engine assigns to anything except cancelled and
 *                                  rejected, while the roster counts only confirmed
 *                                  — so a pending entrant who holds a number is
 *                                  assigned but not eligible. Clamping to 100%
 *                                  would hide exactly the discrepancy an organizer
 *                                  needs to see before race day.
 */
export function calculateCoverage(assigned: BibCell, eligible: BibCell): BibCoverage {
  if (assigned.state !== 'known' || eligible.state !== 'known') {
    return {
      percent: null,
      state: 'unknown',
      reason: assigned.reason ?? eligible.reason ?? 'Not measured.',
      exceedsEligible: false,
    }
  }
  const a = assigned.value ?? 0
  const e = eligible.value ?? 0
  if (e === 0) {
    return {
      percent: null,
      state: 'notApplicable',
      reason: 'No participants are eligible for a BIB number yet.',
      exceedsEligible: a > 0,
    }
  }
  return {
    percent: Math.round((a / e) * 1000) / 10,
    state: 'known',
    reason: null,
    exceedsEligible: a > e,
  }
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface BibReportRow {
  /** Null on the event-wide row. */
  passId:   string | null
  label:    string
  eligible: BibCell
  assigned: BibCell
  unassigned: BibCell
  coverage: BibCoverage
  /**
   * True when this pass issues no numbers at all — no pool names it. Its figures
   * are NOT APPLICABLE rather than zero, and it must never be presented as a pass
   * with missing assignments.
   */
  issuesNumbers: boolean
}

export interface BibReport {
  /** Whether the event has any BIB configuration at all. */
  configured: boolean
  /** The event-wide row. */
  overall:  BibReportRow
  /** One row per pass, in the read model's deterministic order. */
  passes:   BibReportRow[]
  /**
   * Confirmed registrations the countable field cannot answer for. Above 0 means
   * some figures are UNKNOWN, and says why in one number.
   */
  uncounted: number | null
  /** Any row where more numbers are held than the population can account for. */
  hasIntegrityWarning: boolean
  /** The eligible population, in words, so the UI never has to invent the sentence. */
  eligibleDescription: string
}

/**
 * The eligible population, stated once.
 *
 * The engine and the roster disagree on purpose (see ./eligibility): the engine
 * refuses only `cancelled` and `rejected`, while the roster an organizer actually
 * works from lists only `confirmed`. Reports follows the ROSTER, because that is the
 * population the organizer can see and act on — and because coverage against a
 * population nobody can reach is not actionable.
 */
export function describeEligible(report: EligibilityReport | null | undefined): string {
  const statuses = report?.rosterStatuses?.length ? report.rosterStatuses : ['confirmed']
  return `${statuses.join(', ')} registrations`
}

/** One pass scope → one report row. */
export function buildPassRow(scope: PassScopeStat): BibReportRow {
  // An empty `poolIds` is the read model's way of saying no pool serves this pass.
  // That is a configuration fact, not a shortfall.
  const issuesNumbers = scope.poolIds.length > 0
  const eligible = fromMetric(scope.eligible)

  if (!issuesNumbers) {
    const na = notApplicableCell(NO_NUMBERS_CONFIGURED)
    return {
      passId: scope.passId,
      label:  scope.passName ?? 'Unrestricted',
      // The participant count is still real and worth showing; what is not
      // applicable is everything about assignment.
      eligible,
      assigned:   na,
      unassigned: na,
      coverage: { percent: null, state: 'notApplicable', reason: NO_NUMBERS_CONFIGURED, exceedsEligible: false },
      issuesNumbers: false,
    }
  }

  const assigned   = fromMetric(scope.participantsWithIdentifier)
  const unassigned = fromMetric(scope.unassignedEligible)
  return {
    passId: scope.passId,
    label:  scope.passName ?? 'Unrestricted',
    eligible, assigned, unassigned,
    coverage: calculateCoverage(assigned, eligible),
    issuesNumbers: true,
  }
}

export interface BibReportInput {
  configured:  boolean
  eligibility: EligibilityReport | null | undefined
  passScopes:  PassScopeStat[] | null | undefined
}

/**
 * The whole report.
 *
 * The event-wide row is NOT a sum of the pass rows. Summing them would omit any
 * confirmed registration whose pass is missing from the configuration — the exact
 * population most likely to be missing a number. It comes from its own aggregates.
 */
export function buildBibReport(input: BibReportInput): BibReport {
  const el = input.eligibility ?? null
  const eligible   = fromMetric(el?.eligible)
  const assigned   = fromMetric(el?.assignedEligible)
  const unassigned = fromMetric(el?.unassignedEligible)

  const overall: BibReportRow = {
    passId: null,
    label:  'All participants',
    eligible, assigned, unassigned,
    coverage: calculateCoverage(assigned, eligible),
    issuesNumbers: input.configured,
  }

  const passes = (input.passScopes ?? []).map(buildPassRow)

  return {
    configured: input.configured,
    overall,
    passes,
    uncounted: el?.uncountedEligible ?? null,
    hasIntegrityWarning:
      overall.coverage.exceedsEligible || passes.some(p => p.coverage.exceedsEligible),
    eligibleDescription: describeEligible(el),
  }
}

// ─── Display ────────────────────────────────────────────────────────────────

/** A cell as text. The ONE place a non-number becomes a glyph. */
export function cellText(cell: BibCell): string {
  if (cell.state === 'known' && cell.value !== null) return cell.value.toLocaleString('en-IN')
  if (cell.state === 'notApplicable') return 'N/A'
  return '—'
}

/** Coverage as text. Never "NaN%", never "Infinity%", never a clamped 100%. */
export function coverageText(c: BibCoverage): string {
  if (c.state === 'known' && c.percent !== null) return `${c.percent.toFixed(1)}%`
  if (c.state === 'notApplicable') return 'N/A'
  return '—'
}
