// RD-RACEOPS-01 Sprint 2 · Header alias table.
//
// PURE data + one comparison rule. THE single place header synonyms are declared, so
// auto-mapping never grows a second opinion.
//
// Deliberately conservative: an alias must be unambiguous across timing vendors. Where
// a heading is genuinely ambiguous (a lone "Time" — chip or gun?) it is listed under
// the field a timing export most commonly means by it, and the organizer can always
// override it in the mapping step. Auto-mapping is a convenience, never an authority.

import type { ResultField } from '@/features/race-operations/types/results'

/**
 * Normalises a heading for comparison: lower-cased, punctuation and separators removed.
 * "Bib No." / "bib_no" / "BIB NO" / "Bib-No" all collapse to "bibno".
 */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Aliases per canonical field, in preference order. Compared post-normalisation, so
 * only one spelling of each distinct word-sequence is needed.
 */
export const HEADER_ALIASES: Readonly<Record<ResultField, readonly string[]>> = {
  bibNumber: [
    'bib', 'bibno', 'bibnumber', 'bibnum', 'race number', 'racenumber', 'raceno',
    'runnerid', 'runnerno', 'runnernumber', 'participantid', 'participantnumber',
    'chipid', 'startnumber', 'startno', 'no',
  ],
  participantName: [
    'name', 'runner', 'runnername', 'participant', 'participantname', 'athlete',
    'athletename', 'fullname', 'firstname', 'displayname',
  ],
  chipTime: [
    'chiptime', 'nettime', 'net', 'chip', 'finishtime', 'time', 'officialtime',
    'racetime', 'elapsed', 'elapsedtime', 'result', 'resulttime', 'nettimehhmmss',
  ],
  gunTime: [
    'guntime', 'gun', 'grosstime', 'gross', 'clocktime', 'starttofinish',
  ],
  status: [
    'status', 'resultstatus', 'finishstatus', 'remarks', 'remark', 'dnf', 'flag',
  ],
  gender: [
    'gender', 'sex', 'mf', 'genderm f',
  ],
  category: [
    'category', 'cat', 'racecategory', 'division', 'div', 'class',
  ],
  ageGroup: [
    'agegroup', 'age group', 'agecategory', 'agecat', 'agebracket', 'ageband', 'agediv',
  ],
} as const

/** Pre-normalised lookup: normalised alias → field. Built once. */
export const ALIAS_TO_FIELD: ReadonlyMap<string, ResultField> = (() => {
  const map = new Map<string, ResultField>()
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [ResultField, readonly string[]][]) {
    for (const alias of aliases) {
      const key = normalizeHeader(alias)
      // First declaration wins, so a word claimed by an earlier field is never stolen
      // by a later one (e.g. 'chip' stays with chipTime).
      if (!map.has(key)) map.set(key, field)
    }
  }
  return map
})()
