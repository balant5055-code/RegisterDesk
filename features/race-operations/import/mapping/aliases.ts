// RD-RACEOPS-01 Sprint 2 · Header alias table.
//
// PURE data + one comparison rule. THE single place header synonyms are declared, so
// auto-mapping never grows a second opinion.
//
// Deliberately conservative: an alias must be unambiguous across timing vendors. Where
// a heading is genuinely ambiguous (a lone "Time" — chip or gun?) it is listed under
// the field a timing export most commonly means by it, and the organizer can always
// override it in the mapping step. Auto-mapping is a convenience, never an authority.
//
// RD-RACEOPS-02C · aliases now carry a TIER. An EXACT alias names the field and nothing
// else ("Chip Time", "Net Time", "Gun Time"). A GENERIC alias is a heading a timing export
// commonly uses for the field but which could mean something else ("Finish Time", "Time",
// "Result"). Auto-mapping prefers exact over generic regardless of column order, and a
// generic hit is surfaced as "review required" rather than shown as detected. This is what
// stops `Bib No | Finish Time | Chip Time | …` mapping chip ← Finish Time (AUDIT-01 P1-1).

import type { ResultField } from '@/features/race-operations/types/results'

/**
 * Normalises a heading for comparison: lower-cased, punctuation and separators removed.
 * "Bib No." / "bib_no" / "BIB NO" / "Bib-No" all collapse to "bibno".
 */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export type AliasTier = 'exact' | 'generic'

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
    'name', 'participantname', 'participant', 'runner', 'runnername', 'athlete',
    'athletename', 'fullname', 'firstname', 'displayname', 'competitor', 'competitorname',
    // RD-RACEOPS-02E · cycling exports name the column by the discipline
    'rider', 'ridername',
  ],
  chipTime: [
    // exact — the chip / net result, unambiguous across vendors
    'chiptime', 'nettime', 'net', 'chip', 'nettimehhmmss', 'chipnettime', 'netchiptime',
    // generic — commonly the elapsed result, but a vendor may mean the gun time
    'finishtime', 'time', 'officialtime', 'racetime', 'elapsed', 'elapsedtime', 'result',
    'resulttime',
    // RD-RACEOPS-02E · a triathlon "Total" is the ranked elapsed time — but only ever a
    // review-level guess, so an explicit Chip / Net column always outranks it (02C tiers).
    'total', 'totaltime',
  ],
  gunTime: [
    'guntime', 'gun', 'grosstime', 'gross', 'clocktime', 'starttofinish', 'gunfinishtime',
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
  // RD-RACEOPS-RESULTS-04 · the RACE distance. Exact spellings only, and never a lap,
  // split, checkpoint or segment distance — those belong to one leg, not the course, and
  // `SEGMENT_DISTANCE_WORDS` below keeps them out.
  distance: [
    'distance', 'racedistance', 'coursedistance', 'eventdistance', 'totaldistance', 'distancekm',
  ],
} as const

/**
 * RD-RACEOPS-RESULTS-04 · words that make a distance heading belong to ONE LEG rather than
 * to the course. "Lap Distance" and "Split Distance" are facts, but they are the segment's
 * length and are read only by the splits sheet — mapping either onto the overall
 * `distance` field would give a 10 km runner a 5 km course and halve their pace.
 */
export const SEGMENT_DISTANCE_WORDS: readonly string[] =
  ['lap', 'split', 'checkpoint', 'segment', 'leg', 'section', 'point', 'stage', 'interval']

export function isSegmentScopedHeading(normalizedHeader: string): boolean {
  return SEGMENT_DISTANCE_WORDS.some(w => normalizedHeader.includes(w))
}

/**
 * RD-RACEOPS-RESULTS-04 · columns a timing provider prints that RegisterDesk CALCULATES.
 *
 * Every one of these is either derived from the facts (pace, speed) or a position in the
 * provider's own field (their ranks and totals) — see the note at the top of
 * types/results.ts. They are listed here so the mapper can say "RegisterDesk calculates
 * this" instead of "unrecognised column": a provider export is 20 columns wide and an
 * organizer should not be asked to reassure themselves about 12 warnings.
 *
 * Listing a heading here NEVER maps it. It is recognised in order to be ignored.
 */
export const PROVIDER_CALCULATED_ALIASES: ReadonlySet<string> = new Set([
  // ranks and totals — RegisterDesk ranks the set it publishes, from chip time
  // RD-RACEOPS-RESULTS-07B · 'pl' is how a real provider abbreviates placing in its PDF
  // header ("Pl."). A rank, so it is recognised only to be ignored — never imported.
  'rank', 'overallrank', 'overallposition', 'position', 'place', 'placing', 'pos', 'pl',
  'resultposition', 'overall', 'genderrank', 'genderposition', 'genderplace',
  'agegrouprank', 'agegroupposition', 'agerank', 'categoryrank', 'categoryposition',
  'divisionrank', 'totalparticipants', 'gendertotal', 'agegrouptotal', 'finishers',
  // derived performance
  'pace', 'avgpace', 'averagepace', 'overallpace', 'minperkm', 'minkm', 'paceminkm',
  'speed', 'avgspeed', 'averagespeed', 'overallspeed', 'kmh', 'kmph', 'speedkmh',
  'lappace', 'lapspeed', 'splitpace', 'splitspeed', 'segmentpace', 'segmentspeed',
].map(normalizeHeader))

export function isProviderCalculatedHeading(normalizedHeader: string): boolean {
  return PROVIDER_CALCULATED_ALIASES.has(normalizedHeader)
}

/**
 * The GENERIC aliases — every alias not listed here is exact. Only chip time has generic
 * spellings today: every other field's aliases name that field and nothing else.
 */
export const GENERIC_ALIASES: ReadonlySet<string> = new Set(
  ['finishtime', 'time', 'officialtime', 'racetime', 'elapsed', 'elapsedtime', 'result', 'resulttime', 'total', 'totaltime']
    .map(normalizeHeader),
)

/**
 * RD-RACEOPS-02E · words that make a heading a CLOCK reading or a non-result timing value,
 * not an elapsed result: "Start Time", "Finish Time of Day", "Race Start Time", "Lap 3",
 * "Split 2". A heading containing one of these is never guessed as a timing field. Exact
 * aliases are matched before this rule and are unaffected ("Clock Time" and
 * "Start to Finish" remain gun-time aliases by name).
 */
export const CLOCK_TIME_WORDS: readonly string[] = ['start', 'ofday', 'clock', 'date', 'lap', 'split', 'checkpoint', 'wave', 'heat']

export function isClockTimeHeading(normalizedHeader: string): boolean {
  return CLOCK_TIME_WORDS.some(w => normalizedHeader.includes(w))
}

/**
 * Headings that mean the GUN / gross time whenever a separate chip / net column exists.
 * "Finish Time" beside "Chip Time" is the start-to-finish clock; alone, it is the result.
 */
export const GUN_WHEN_CHIP_PRESENT: ReadonlySet<string> = new Set(['finishtime', 'time'].map(normalizeHeader))

export function aliasTier(normalizedAlias: string): AliasTier {
  return GENERIC_ALIASES.has(normalizedAlias) ? 'generic' : 'exact'
}

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

/** Pre-normalised preference index: normalised alias → its position in the field's list. */
export const ALIAS_RANK: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  for (const aliases of Object.values(HEADER_ALIASES)) {
    aliases.forEach((alias, i) => { const key = normalizeHeader(alias); if (!map.has(key)) map.set(key, i) })
  }
  return map
})()
