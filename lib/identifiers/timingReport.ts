// RD-REPORT-04 — Timing Chip reporting: the PURE view model.
//
// No I/O, no SDK, no React. Reuses the cell vocabulary RD-REPORT-03 established for
// BIB reporting (`known` / `unknown` / `notApplicable`) so both sections answer with
// one grammar and one set of glyphs.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  TWO RULES THIS MODULE EXISTS TO HOLD                                     ║
// ║                                                                           ║
// ║  1. APPLICABILITY IS CONFIGURATION. An event that has not switched the     ║
// ║     device credential on has no timing figures — not zeroes. Nothing here  ║
// ║     infers enablement from the presence of a chip, a lock or a field.      ║
// ║                                                                           ║
// ║  2. THE NUMBER COMES FIRST. A device is only meaningful on a participant   ║
// ║     who already holds an identifier, so the eligible population for a      ║
// ║     device is the population that HAS one — not everyone confirmed.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import {
  knownCell, unknownCell, notApplicableCell, calculateCoverage,
  cellText, coverageText,
  type BibCell, type BibCoverage,
} from './bibReport'

export { cellText, coverageText }
export type { BibCell as TimingCell, BibCoverage as TimingCoverage }

/** A `number | null` straight off the wire. Null is UNKNOWN, never 0. */
export function fromCount(n: number | null | undefined, reason = 'This figure could not be read.'): BibCell {
  return typeof n === 'number' ? knownCell(n) : unknownCell(reason)
}

export const TIMING_DISABLED_REASON =
  'This event does not use a timing device, so there is nothing to assign.'

export const NO_DEVICE_FOR_PASS =
  'This pass is not part of device mapping.'

// ─── Inputs, exactly as the tags route serves them ──────────────────────────

export interface TimingReportInput {
  /** `identifierConfigs/{slug}.tagMapping` — the ONLY source of applicability. */
  enabled: boolean
  /** 'mapped' ⇒ devices are mapped to numbers. 'identifier' ⇒ the number IS the tag. */
  mode:    'mapped' | 'identifier'
  /** What this event calls the device. Printed verbatim; never lower-cased. */
  label:   string
  /** What the identifier is called on this event ("BIB", "Number", …). */
  identifierLabel: string
  counts: {
    /** Confirmed registrations. */
    eligible:   number | null
    /** Confirmed AND holding an identifier — the population a device can reach. */
    identified: number | null
    /** Devices out, counted from the LOCK collection. */
    mapped:     number | null
  } | null
  /** RD-REPORT-04 · the same question asked of the ROSTER instead of the locks. */
  rosterCounts?: {
    mapped:                  number | null
    mappedWithIdentifier:    number | null
    mappedWithoutIdentifier: number | null
  } | null
  passes?: { passId: string; passName: string; total: number | null; withIdentifier: number | null; withTag: number | null }[] | null
}

export interface TimingReportRow {
  passId:   string | null
  label:    string
  eligible: BibCell
  assigned: BibCell
  unassigned: BibCell
  coverage: BibCoverage
}

export type TimingReport =
  /** The event does not use a device. There are no figures, and that is the answer. */
  | { applicable: false; reason: string }
  | {
      applicable: true
      /** The configured device noun, verbatim. */
      label: string
      mode: 'mapped' | 'identifier'
      overall: TimingReportRow
      passes: TimingReportRow[]
      /** Confirmed participants who cannot yet receive a device: no identifier. */
      blockedWithoutIdentifier: BibCell
      /** Devices held by someone with NO identifier — must be 0. */
      anomalyWithoutIdentifier: BibCell
      /** Locks assigned beyond the eligible roster (e.g. a cancelled holder). */
      heldOutsideRoster: BibCell
      hasIntegrityWarning: boolean
      eligibleDescription: string
    }

/**
 * Timing eligibility, stated once.
 *
 * NOT the same as BIB eligibility, and this is the whole point of the section. The
 * tag engine throws `REGISTRATION_HAS_NO_IDENTIFIER` before it writes anything, so a
 * confirmed participant with no number cannot receive a device — counting them as
 * "unassigned" would report a shortfall the organizer cannot act on until the number
 * exists. They are reported separately, as blocked.
 */
export function describeTimingEligible(identifierLabel: string): string {
  return `confirmed registrations holding ${article(identifierLabel)} ${identifierLabel}`
}

/** "a"/"an" for the configured noun. Kept local so this module stays pure. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun.trim()) ? 'an' : 'a'
}

/** Subtraction, but only when BOTH sides are known and the result is sane. */
function difference(a: BibCell, b: BibCell): BibCell {
  if (a.state !== 'known' || b.state !== 'known') {
    return unknownCell(a.reason ?? b.reason ?? 'Not measured.')
  }
  const d = (a.value ?? 0) - (b.value ?? 0)
  // A negative difference is not a number to print — it means the two figures
  // describe different populations, which the integrity flags report separately.
  return d < 0 ? unknownCell('More devices are assigned than the population contains.') : knownCell(d)
}

export function buildTimingReport(input: TimingReportInput): TimingReport {
  if (!input.enabled) {
    return { applicable: false, reason: TIMING_DISABLED_REASON }
  }

  const label = input.label?.trim() || 'Timing Chip'
  const c  = input.counts ?? null
  const rc = input.rosterCounts ?? null

  const confirmed  = fromCount(c?.eligible)
  // THE eligible population for a device: confirmed AND holding an identifier.
  const eligible   = fromCount(c?.identified)
  // Assigned is counted on the ROSTER, in that same population — not from the lock
  // collection, which contains devices held by people the roster excludes.
  const assigned   = fromCount(rc?.mapped)
  const unassigned = difference(eligible, assigned)

  const anomalyWithoutIdentifier = fromCount(rc?.mappedWithoutIdentifier)
  const blockedWithoutIdentifier = difference(confirmed, eligible)
  // Locks out, minus devices on eligible participants. Above 0 means devices are
  // attached to registrations the roster does not contain — a cancelled holder whose
  // detach did not complete, most often.
  const heldOutsideRoster = difference(fromCount(c?.mapped), assigned)

  const coverage = calculateCoverage(assigned, eligible)

  const passes: TimingReportRow[] = (input.passes ?? []).map(p => {
    // Per pass the eligible population is the same rule: holders of an identifier.
    const pe = fromCount(p.withIdentifier)
    const pa = fromCount(p.withTag)
    return {
      passId: p.passId,
      label:  p.passName,
      eligible: pe,
      assigned: pa,
      unassigned: difference(pe, pa),
      coverage: calculateCoverage(pa, pe),
    }
  })

  const hasIntegrityWarning =
    coverage.exceedsEligible ||
    (anomalyWithoutIdentifier.state === 'known' && (anomalyWithoutIdentifier.value ?? 0) > 0) ||
    (heldOutsideRoster.state === 'known' && (heldOutsideRoster.value ?? 0) > 0) ||
    passes.some(p => p.coverage.exceedsEligible)

  return {
    applicable: true,
    label,
    mode: input.mode,
    overall: { passId: null, label: 'All participants', eligible, assigned, unassigned, coverage },
    passes,
    blockedWithoutIdentifier,
    anomalyWithoutIdentifier,
    heldOutsideRoster,
    hasIntegrityWarning,
    eligibleDescription: describeTimingEligible(input.identifierLabel || 'BIB'),
  }
}

export { notApplicableCell, knownCell, unknownCell }
