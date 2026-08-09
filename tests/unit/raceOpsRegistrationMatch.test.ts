// RD-RESULTS-FIX-01 · Cross-checking results against the start list. Pure — no Firestore.
//
// RD-RESULTS-GA-01 found the import pipeline never verified that a bib belonged to anyone.
// Three ordinary timing-day mistakes reached the public leaderboard, and from there fed
// certificates and finisher badges. These are those three.

import { describe, it, expect } from 'vitest'
import {
  hasBlockingRegistrationIssues, matchAgainstRoster, registrationIssueSeverity,
  type RosterEntry,
} from '@/features/race-operations/import/validation/registrationMatch'

const HALF = 'pass_half'
const TEN  = 'pass_10k'

const roster = new Map<string, RosterEntry>([
  ['101', { bibKey: '101', registrationId: 'r1', passId: HALF, name: 'Asha' }],
  ['102', { bibKey: '102', registrationId: 'r2', passId: HALF, name: 'Bala' }],
  ['900', { bibKey: '900', registrationId: 'r3', passId: TEN,  name: 'Chitra' }],
])

const row = (rowNumber: number, bib: string) =>
  ({ rowNumber, bibNumber: bib, bibKey: bib })

describe('matchAgainstRoster', () => {
  it('matches entrants of THIS race', () => {
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: false,
      rows: [row(1, '101'), row(2, '102')],
    })
    expect(r.matched).toBe(2)
    expect(r.issues).toHaveLength(0)
    expect(hasBlockingRegistrationIssues(r)).toBe(false)
  })

  it('flags a bib that is on NO start list — the mis-keyed bib', () => {
    // The case that used to publish a stranger as a finisher.
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: false,
      rows: [row(1, '101'), row(2, '999')],
    })
    expect(r.unknownRunner).toBe(1)
    expect(r.issues[0]).toMatchObject({ code: 'UNKNOWN_RUNNER', rowNumber: 2, bibNumber: '999' })
    expect(hasBlockingRegistrationIssues(r)).toBe(true)
  })

  it('tells WRONG RACE apart from unknown — the 10K row in the half file', () => {
    // Both would read as "not on the start list" if the roster were loaded per race, which
    // would send the organizer looking for a registration that exists.
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: false,
      rows: [row(1, '900')],
    })
    expect(r.wrongRace).toBe(1)
    expect(r.unknownRunner).toBe(0)
    expect(r.issues[0].code).toBe('WRONG_RACE')
    expect(hasBlockingRegistrationIssues(r)).toBe(true)
  })

  it('finds entrants MISSING from the file, but only for this race', () => {
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: true,
      rows: [row(1, '101')],
    })
    // 102 is a half entrant with no row; 900 is a 10K entrant and must NOT be reported.
    expect(r.missingResult).toBe(1)
    expect(r.issues.filter(i => i.code === 'MISSING_RESULT')).toHaveLength(1)
    expect(r.issues.find(i => i.code === 'MISSING_RESULT')?.bibNumber).toBe('102')
  })

  it('does NOT report missing entrants when asked not to', () => {
    // A truncated roster or a partial walk cannot answer "missing" — an entrant absent from
    // what was loaded is not evidence of an entrant absent from the file.
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: false, rows: [row(1, '101')],
    })
    expect(r.missingResult).toBe(0)
  })

  it('a MISSING entrant never blocks publishing — a DNS is not an error', () => {
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: true, rows: [row(1, '101'), row(2, '102')],
    })
    expect(hasBlockingRegistrationIssues(r)).toBe(false)
    expect(registrationIssueSeverity('MISSING_RESULT')).toBe('warning')
    expect(registrationIssueSeverity('UNKNOWN_RUNNER')).toBe('error')
    expect(registrationIssueSeverity('WRONG_RACE')).toBe('error')
  })

  it('ignores a row with no bib — engine.ts already reports that as MISSING_BIB', () => {
    // Double-reporting one mistake makes an organizer fix it twice.
    const r = matchAgainstRoster({
      passId: HALF, roster, detectMissing: false,
      rows: [{ rowNumber: 1, bibNumber: null, bibKey: '' }],
    })
    expect(r.issues).toHaveLength(0)
    expect(r.unknownRunner).toBe(0)
  })

  it('an empty roster reports every row as unknown, not as matched', () => {
    // Fail closed: an event whose registrations could not be read must not publish as clean.
    const r = matchAgainstRoster({
      passId: HALF, roster: new Map(), detectMissing: false,
      rows: [row(1, '101'), row(2, '102')],
    })
    expect(r.matched).toBe(0)
    expect(r.unknownRunner).toBe(2)
    expect(hasBlockingRegistrationIssues(r)).toBe(true)
  })
})
