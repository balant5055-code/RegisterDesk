// RD-BCAST-DATE-01 · calendar days in an IANA timezone → absolute UTC instants.
//
// Pure and dependency-free (Intl only), the same contract as salesWindow.ts next door.
// That module answers "what is today's date in this zone" for comparison against
// date-only STRING fields. This one answers a different question — "which INSTANTS make
// up that day" — because `registeredAt` is a Firestore Timestamp and a Timestamp cannot
// be compared to 'YYYY-MM-DD'.
//
// HALF-OPEN, ALWAYS: [startUtc, endUtcExclusive). There is no 23:59:59 here and there must
// never be. That trick loses every registration in the final second, and it is wrong twice
// over on a DST day, where a local day is 23 or 25 hours long rather than 24.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface ZonedDayRange {
  /** Inclusive lower bound — the first instant of startDate in `timezone`. */
  startUtc: Date
  /** EXCLUSIVE upper bound — the first instant of the day AFTER endDate. */
  endUtcExclusive: Date
  /** The timezone actually applied. Echoed so callers can display and persist it. */
  timezone: string
}

export type ZonedDayRangeError =
  | 'invalid_date'
  | 'invalid_timezone'
  | 'start_after_end'

export type ZonedDayRangeResult =
  | { ok: true;  range: ZonedDayRange }
  | { ok: false; error: ZonedDayRangeError }

/** Whether a string is a well-formed, real calendar date ('2026-02-30' is not). */
export function isValidISODate(dateISO: string): boolean {
  if (!ISO_DATE.test(dateISO)) return false
  const [y, m, d] = dateISO.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  // Round-trip catches Feb 30, Apr 31, and non-leap Feb 29.
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true }
  catch { return false }
}

/** Shifts a 'YYYY-MM-DD' by whole days. Calendar arithmetic only — no timezone involved. */
export function shiftISODate(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * The offset (ms) that `timezone` is AHEAD of UTC at the given instant.
 * Positive east of Greenwich: Asia/Kolkata is +5:30 → 19_800_000.
 */
function offsetMsAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  // Reading the wall clock back as if it were UTC makes the difference the offset itself.
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asIfUtc - instant.getTime()
}

/**
 * The instant at which `dateISO` begins in `timezone`.
 *
 * Two passes, deliberately. The offset is itself a function of the instant, so the first
 * pass can land on the wrong side of a DST transition; re-deriving the offset at the
 * candidate instant corrects it. On a spring-forward day where local midnight does not
 * exist at all, this settles on the first instant that does — which is the only honest
 * answer and keeps the day contiguous with the previous one.
 */
function startOfDayUtc(dateISO: string, timezone: string): Date {
  const [y, m, d] = dateISO.split('-').map(Number)
  const wallClockAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0)

  let instant = wallClockAsUtc - offsetMsAt(new Date(wallClockAsUtc), timezone)
  instant = wallClockAsUtc - offsetMsAt(new Date(instant), timezone)
  return new Date(instant)
}

/**
 * Half-open UTC window covering whole calendar days in `timezone`.
 *
 * @param startDateISO first day, inclusive ('YYYY-MM-DD')
 * @param endDateISO   last day, INCLUSIVE as the organizer means it — the returned upper
 *                     bound is the start of the following day. Pass null/undefined for a
 *                     single day, which is simply the range [d, d].
 *
 * An unknown timezone is REJECTED rather than quietly falling back to UTC. salesWindow.ts
 * can afford that fallback because it compares date strings; here a silent 5½-hour shift
 * would change which registrations are in the audience, and the organizer would never know.
 * Callers resolve the zone through a validated chain, so a rejection means real config
 * corruption and deserves to surface.
 */
export function zonedDayRange(
  startDateISO: string,
  endDateISO: string | null | undefined,
  timezone: string,
): ZonedDayRangeResult {
  const endISO = endDateISO ?? startDateISO

  if (!isValidISODate(startDateISO) || !isValidISODate(endISO)) return { ok: false, error: 'invalid_date' }
  if (!isValidTimezone(timezone))                               return { ok: false, error: 'invalid_timezone' }
  if (startDateISO > endISO)                                    return { ok: false, error: 'start_after_end' }

  return {
    ok: true,
    range: {
      startUtc:        startOfDayUtc(startDateISO, timezone),
      // The day AFTER the last selected day — this is what makes the bound exclusive.
      endUtcExclusive: startOfDayUtc(shiftISODate(endISO, 1), timezone),
      timezone,
    },
  }
}
