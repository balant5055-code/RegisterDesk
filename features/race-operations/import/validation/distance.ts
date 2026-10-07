// RD-RACEOPS-RESULTS-04 · Race distance parsing.
//
// PURE. No SDK, no I/O — the single implementation of "what is a valid distance", so the
// mapper, the validator, the template and the pace/speed maths cannot disagree.
//
// ─── Why a unit is REQUIRED ───────────────────────────────────────────────────
// "10" is 10 km to a road race and 10 metres to a pool. Guessing is how a 10 km runner
// gets a pace of 4:15 min/m. Every accepted form therefore carries its unit explicitly:
//
//   21KM   21 KM   21km   21.1 KM   5.5Km        → kilometres
//   5000m  5000 M  5000 metres  5,000 m          → metres
//   13.1mi 13.1 MI 13.1 miles                    → miles
//
// Rejected: a bare number ('10', '10.5'), an unknown unit ('10 laps'), a range
// ('10-21 km'), zero or negative, and anything longer than a 1,000 km ultra.
//
// The value stored is always METRES (`distanceMeters`), rounded to the nearest metre, with
// the organizer's own text kept alongside it as `distanceRaw`.

export const METRES_PER_KM   = 1_000
export const METRES_PER_MILE = 1_609.344

/** Longest plausible course. Guards a mis-mapped column (a bib, a year) becoming a distance. */
export const MAX_DISTANCE_METRES = 1_000_000   // 1,000 km — covers multi-day ultras

export type DistanceParseFailure =
  | 'empty'
  | 'no_unit'        // a number with no unit — never guessed
  | 'unparseable'
  | 'out_of_range'

export type DistanceParseResult =
  | { ok: true;  meters: number }
  | { ok: false; reason: DistanceParseFailure }

/** number + unit, in that order, with optional space and optional thousands separators. */
const DISTANCE_RE = /^(\d{1,7}(?:,\d{3})*(?:[.]\d{1,3})?)\s*([a-z]+)$/
/** A bare number — recognised only so the failure can say WHY it was refused. */
const BARE_NUMBER_RE = /^\d{1,7}(?:,\d{3})*(?:[.]\d{1,3})?$/

const UNIT_METRES: Readonly<Record<string, number>> = {
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1, mtr: 1, mts: 1,
  km: METRES_PER_KM, kms: METRES_PER_KM, kilometer: METRES_PER_KM, kilometers: METRES_PER_KM,
  kilometre: METRES_PER_KM, kilometres: METRES_PER_KM,
  mi: METRES_PER_MILE, mile: METRES_PER_MILE, miles: METRES_PER_MILE,
}

/**
 * Parses a distance cell to whole metres.
 *
 * The unit is matched against a CLOSED table — a spelling that is not listed fails rather
 * than falling back to a default, because a silent default is indistinguishable from a
 * correct reading in the published result.
 */
export function parseRaceDistance(raw: string | null | undefined): DistanceParseResult {
  const value = (raw ?? '').trim()
  if (value === '') return { ok: false, reason: 'empty' }

  const lower = value.toLowerCase()
  if (BARE_NUMBER_RE.test(lower)) return { ok: false, reason: 'no_unit' }

  const m = DISTANCE_RE.exec(lower)
  if (!m) return { ok: false, reason: 'unparseable' }

  const factor = UNIT_METRES[m[2]]
  if (factor === undefined) return { ok: false, reason: 'unparseable' }

  const amount = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'out_of_range' }

  const meters = Math.round(amount * factor)
  if (meters <= 0 || meters > MAX_DISTANCE_METRES) return { ok: false, reason: 'out_of_range' }

  return { ok: true, meters }
}

/**
 * Display form for a stored distance: whole kilometres as "10 km", fractions as "21.1 km",
 * anything under a kilometre as metres. Used by the public result and the organizer export.
 */
export function formatDistance(meters: number | null | undefined): string {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) return ''
  if (meters < METRES_PER_KM) return `${Math.round(meters)} m`
  const km = meters / METRES_PER_KM
  // Two decimals at most, and no trailing zeros: 21.1 km, 5.5 km, 10 km.
  return `${Number(km.toFixed(2))} km`
}
