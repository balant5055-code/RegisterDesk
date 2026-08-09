// RD-RESULTS-FIX-01 · Cross-checking imported results against the real start list.
//
// PURE. No SDK, no Firestore, no I/O — the roster arrives as an argument.
//
// ═══ WHY THIS IS A SEPARATE FILE ═════════════════════════════════════════════
// `validation/engine.ts` is documented as checking the uploaded data "against itself and
// against the canonical model", with **no Firestore query of any kind**, so a future vendor
// parser needs no change to it. Cross-checking against registrations needs data that engine
// is forbidden to fetch. Putting it there would break that contract; putting the query in a
// service and the RULE here keeps both honest and keeps this unit-testable.
//
// ═══ WHAT THIS CATCHES ═══════════════════════════════════════════════════════
// RD-RESULTS-GA-01 found the import pipeline never verified that a bib belonged to anyone.
// A mis-keyed bib published as a real finisher; a runner who registered and started but was
// missing from the timing file was undetectable; and a row from the 10K file loaded into the
// half-marathon race was accepted silently. All three are ordinary timing-day mistakes, and
// all three reached the public leaderboard — and from there into issued certificates.

/** One confirmed entrant, as the matcher needs to see them. */
export interface RosterEntry {
  /** Normalised bib — the join key. */
  bibKey:         string
  registrationId: string
  /** The race this person is actually entered in. */
  passId:         string
  name:           string | null
}

export type RegistrationIssueCode =
  /** The bib is not on the start list at all. */
  | 'UNKNOWN_RUNNER'
  /** The bib exists but is entered in a DIFFERENT race than the one being imported. */
  | 'WRONG_RACE'
  /** Registered and confirmed, but absent from the timing file. */
  | 'MISSING_RESULT'

export interface RegistrationIssue {
  code:      RegistrationIssueCode
  /** Row number in the uploaded file. Null for MISSING_RESULT — there is no row. */
  rowNumber: number | null
  bibNumber: string
  detail:    string
}

/**
 * Severity, decided in ONE place.
 *
 * `UNKNOWN_RUNNER` and `WRONG_RACE` are ERRORS: publishing either puts a result on the
 * public leaderboard for somebody who did not run that race, and the organizer cannot
 * discover it afterwards because published results feed certificates and badges.
 *
 * `MISSING_RESULT` is a WARNING: a confirmed entrant with no row is usually a DNS the timing
 * file simply omitted rather than an error in the file. Blocking on it would make publishing
 * impossible for every race where anyone failed to start, which is every race.
 */
export function registrationIssueSeverity(code: RegistrationIssueCode): 'error' | 'warning' {
  return code === 'MISSING_RESULT' ? 'warning' : 'error'
}

export interface RegistrationMatchInput {
  /** The race being imported. */
  passId: string
  /** Imported rows — only what the check needs. */
  rows: readonly { rowNumber: number; bibNumber: string | null; bibKey: string }[]
  /** Confirmed entrants for the EVENT (all races), keyed by normalised bib. */
  roster: ReadonlyMap<string, RosterEntry>
  /**
   * When false, `MISSING_RESULT` is not reported.
   *
   * A chunked verification pass sees only part of the file, so it cannot know whether an
   * entrant is missing overall — it must only be asked on a complete set.
   */
  detectMissing: boolean
}

export interface RegistrationMatchResult {
  issues:        RegistrationIssue[]
  /** Rows whose bib is on the start list for THIS race. */
  matched:       number
  unknownRunner: number
  wrongRace:     number
  missingResult: number
}

/**
 * Cross-checks a set of imported rows against the start list.
 *
 * Deliberately total: it reports rather than throws, so a caller decides how loudly to fail
 * and the organizer sees every problem at once instead of the first one.
 */
export function matchAgainstRoster(input: RegistrationMatchInput): RegistrationMatchResult {
  const issues: RegistrationIssue[] = []
  let matched = 0, unknownRunner = 0, wrongRace = 0

  const seen = new Set<string>()

  for (const row of input.rows) {
    // A row with no bib is already an error from `engine.ts` (MISSING_BIB); reporting it
    // again here would double-count one mistake.
    if (!row.bibNumber || !row.bibKey) continue
    seen.add(row.bibKey)

    const entrant = input.roster.get(row.bibKey)
    if (!entrant) {
      unknownRunner++
      issues.push({
        code: 'UNKNOWN_RUNNER', rowNumber: row.rowNumber, bibNumber: row.bibNumber,
        detail: 'This bib is not on the start list for this event.',
      })
      continue
    }

    if (entrant.passId !== input.passId) {
      wrongRace++
      issues.push({
        code: 'WRONG_RACE', rowNumber: row.rowNumber, bibNumber: row.bibNumber,
        detail: 'This bib is entered in a different race at this event.',
      })
      continue
    }

    matched++
  }

  // ── Entrants with no row ───────────────────────────────────────────────────
  let missingResult = 0
  if (input.detectMissing) {
    for (const entrant of input.roster.values()) {
      if (entrant.passId !== input.passId) continue      // another race — not expected here
      if (seen.has(entrant.bibKey)) continue
      missingResult++
      issues.push({
        code: 'MISSING_RESULT', rowNumber: null, bibNumber: entrant.bibKey,
        detail: 'Registered for this race but absent from the results file.',
      })
    }
  }

  return { issues, matched, unknownRunner, wrongRace, missingResult }
}

/** True when the counts contain something that must block publishing. */
export function hasBlockingRegistrationIssues(
  r: Pick<RegistrationMatchResult, 'unknownRunner' | 'wrongRace'>,
): boolean {
  return r.unknownRunner > 0 || r.wrongRace > 0
}
