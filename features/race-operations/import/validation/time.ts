// RD-RACEOPS-01 Sprint 2 · Race time parsing.
//
// PURE. No SDK, no I/O. The single implementation of "what is a valid finish time" —
// validation, preview and (later) ranking all call this, so no surface can disagree.
//
// Accepted forms, as emitted by real timing exports:
//   hh:mm:ss        01:48:32       h:mm:ss    1:48:32
//   mm:ss           48:32                        (under an hour)
//   with fraction   01:48:32.470   01:48:32,47  (comma decimal — European exports)
//   Excel duration  0.075370...    (fraction of a 24-hour day)
//
// Rejected: 'ABC', '1:2:3:4', negative values, '25:00:00' as mm:ss (minutes ≥ 60 is
// only legal in the mm:ss form when no hours part exists... see MAX_* below).

export const MS_PER_SECOND = 1_000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND
export const MS_PER_HOUR   = 60 * MS_PER_MINUTE

/** Longest plausible race duration. Guards against a mis-mapped column (e.g. a date
 *  cell) being accepted as a 900-hour finish time. Covers multi-day ultras. */
export const MAX_RACE_DURATION_MS = 240 * MS_PER_HOUR   // 10 days

export type TimeParseFailure =
  | 'empty'
  | 'unparseable'
  | 'out_of_range'

export type TimeParseResult =
  | { ok: true;  ms: number }
  | { ok: false; reason: TimeParseFailure }

// hh:mm:ss(.fff) or mm:ss(.fff) — the fraction may use '.' or ','.
const CLOCK_RE = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?(?:[.,](\d{1,3}))?$/
// A bare decimal number: Excel fraction-of-day.
const DECIMAL_RE = /^\d*\.\d+$/

function fractionToMs(fraction: string | undefined): number {
  if (!fraction) return 0
  // '4' → 400ms, '47' → 470ms, '470' → 470ms.
  return Number(fraction.padEnd(3, '0'))
}

/**
 * Parses a raw time cell to whole milliseconds.
 *
 * `hh:mm:ss` is preferred when three parts are present. With two parts the value is
 * read as mm:ss, which is how timing systems write sub-hour results.
 */
export function parseRaceTime(raw: string | null | undefined): TimeParseResult {
  const value = (raw ?? '').trim()
  if (value === '') return { ok: false, reason: 'empty' }

  const clock = CLOCK_RE.exec(value)
  if (clock) {
    const [, a, b, c, frac] = clock
    const ms = c === undefined
      // Two parts ⇒ mm:ss. `a` is minutes and may exceed 59 (e.g. '90:00' = 1h30m).
      ? Number(a) * MS_PER_MINUTE + Number(b) * MS_PER_SECOND + fractionToMs(frac)
      // Three parts ⇒ hh:mm:ss.
      : Number(a) * MS_PER_HOUR + Number(b) * MS_PER_MINUTE + Number(c) * MS_PER_SECOND + fractionToMs(frac)

    if (ms <= 0) return { ok: false, reason: 'out_of_range' }
    if (ms > MAX_RACE_DURATION_MS) return { ok: false, reason: 'out_of_range' }
    return { ok: true, ms }
  }

  if (DECIMAL_RE.test(value)) {
    const dayFraction = Number(value)
    if (!Number.isFinite(dayFraction) || dayFraction <= 0 || dayFraction >= 1) {
      return { ok: false, reason: 'out_of_range' }
    }
    const ms = Math.round(dayFraction * 24 * MS_PER_HOUR)
    if (ms <= 0) return { ok: false, reason: 'out_of_range' }
    return { ok: true, ms }
  }

  return { ok: false, reason: 'unparseable' }
}

/**
 * Formats milliseconds back to `hh:mm:ss` (or `hh:mm:ss.fff` when sub-second precision
 * is present). Used by the preview so a normalised value can be shown beside the
 * organizer's raw one.
 */
export function formatRaceTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total   = Math.round(ms)
  const hours   = Math.floor(total / MS_PER_HOUR)
  const minutes = Math.floor((total % MS_PER_HOUR) / MS_PER_MINUTE)
  const seconds = Math.floor((total % MS_PER_MINUTE) / MS_PER_SECOND)
  const millis  = total % MS_PER_SECOND

  const base = [hours, minutes, seconds]
    .map(n => String(n).padStart(2, '0'))
    .join(':')

  return millis > 0 ? `${base}.${String(millis).padStart(3, '0')}` : base
}
