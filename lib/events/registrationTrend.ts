// RD-EVENT-07 · Registration trend — the bucket arithmetic, as pure functions.
//
// ═══ WHY THE OLD CHART WAS WRONG ═════════════════════════════════════════════
// The previous trend was computed in the browser from `registrations` — ONE PAGE of
// 51 documents. Three consequences, all silent:
//
//   • A busy event whose 51 most recent sign-ups all landed this morning drew six
//     empty days and one tall bar. A quiet event whose 51 spanned a year drew almost
//     nothing. The chart was systematically wrong for any event past 51 registrations.
//   • Buckets were keyed on `toISOString().slice(0, 10)` — a UTC date — while the bar
//     LABEL came from `toLocaleDateString`, the viewer's local weekday. A registration
//     at 20:00 UTC is already tomorrow in IST, so it was counted under one day and
//     labelled with another.
//   • An empty bucket was indistinguishable from a bucket outside the loaded page.
//
// Buckets are now day boundaries in the EVENT's timezone, counted server-side over the
// whole dataset with `count()` aggregates. This module owns only the arithmetic.

/** One day of the trend. `count` is authoritative; `null` means the bucket was not read. */
export interface TrendBucket {
  /** Local calendar date in the event's timezone, `YYYY-MM-DD`. */
  date:  string
  count: number | null
}

export const TREND_MIN_DAYS = 1
export const TREND_MAX_DAYS = 31
export const TREND_DEFAULT_DAYS = 14

/** Clamp a caller-supplied day count into a bounded, sane window. */
export function parseTrendDays(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.min(TREND_MAX_DAYS, Math.max(TREND_MIN_DAYS, Math.floor(n)))
}

/**
 * The UTC instant of local midnight, `dayOffset` days before the local day containing
 * `at`, in `timeZone`.
 *
 * `Intl.DateTimeFormat` is the only reliable way to do this without a tz database of our
 * own: it tells us what the local wall-clock reads at a given instant, from which the
 * zone's offset at that instant follows. That matters across a DST transition, where a
 * fixed offset would silently shift a whole day's bucket.
 */
export function localDayStartUtc(at: Date, timeZone: string, dayOffset = 0): Date {
  const parts = zonedParts(at, timeZone)
  // Midnight of the local day, expressed as if it were UTC, then corrected by the
  // zone's offset AT THAT INSTANT (recomputed, so a DST boundary lands correctly).
  const localMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day - dayOffset, 0, 0, 0, 0)
  const guess = new Date(localMidnightAsUtc)
  const offset = zoneOffsetMs(guess, timeZone)
  const corrected = new Date(localMidnightAsUtc - offset)
  // One refinement pass: if the correction crossed a DST change, the offset at the
  // corrected instant is the authoritative one.
  const offset2 = zoneOffsetMs(corrected, timeZone)
  return offset2 === offset ? corrected : new Date(localMidnightAsUtc - offset2)
}

function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const [year, month, day] = fmt.format(at).split('-').map(Number)
  return { year, month, day }
}

/** How far `timeZone` is ahead of UTC at this instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  )
  return asUtc - at.getTime()
}

/** The local calendar date (`YYYY-MM-DD`) of an instant, in `timeZone`. */
export function localDateKey(at: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(at, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The half-open ranges `[start, end)` for the last `days` local days, oldest first.
 * The final range ends at local midnight TOMORROW, so today is complete and open.
 */
export function trendRanges(
  now: Date, timeZone: string, days: number,
): { date: string; start: Date; end: Date }[] {
  const out: { date: string; start: Date; end: Date }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const start = localDayStartUtc(now, timeZone, i)
    const end   = localDayStartUtc(now, timeZone, i - 1)
    out.push({ date: localDateKey(start, timeZone), start, end })
  }
  return out
}

// ─── Presentation ─────────────────────────────────────────────────────────────

export interface TrendView {
  buckets: TrendBucket[]
  /** Highest count across read buckets; 0 when every bucket is 0, null when none read. */
  peak:    number | null
  total:   number | null
  /** True when at least one bucket could not be read — the chart must say so. */
  partial: boolean
  /** True when every bucket was read and every one is zero. */
  allZero: boolean
}

export function trendView(buckets: TrendBucket[]): TrendView {
  const read = buckets.filter(b => b.count !== null).map(b => b.count as number)
  if (read.length === 0) {
    return { buckets, peak: null, total: null, partial: buckets.length > 0, allZero: false }
  }
  const total = read.reduce((s, v) => s + v, 0)
  return {
    buckets,
    peak:  Math.max(...read),
    total,
    partial: read.length !== buckets.length,
    allZero: total === 0,
  }
}

/**
 * Bar height as a percentage of the tallest bucket.
 *
 * An UNREAD bucket returns null — the bar must render as a gap with an explanation,
 * never as a zero-height bar, which would read as "nobody registered that day".
 */
export function barPercent(bucket: TrendBucket, peak: number | null): number | null {
  if (bucket.count === null) return null
  if (peak === null || peak <= 0) return 0
  return Math.round((bucket.count / peak) * 100)
}

/** Short weekday + day-of-month label, rendered in the event's timezone. */
export function bucketLabel(date: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  // Noon UTC keeps the calendar date stable in every zone from UTC-11 to UTC+13.
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-IN', { timeZone, weekday: 'short' }).format(at)
}

export function bucketFullLabel(date: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  const at = new Date(Date.UTC(y, m - 1, d, 12))
  return new Intl.DateTimeFormat('en-IN', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short',
  }).format(at)
}
