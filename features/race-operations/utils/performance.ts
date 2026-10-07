// RD-RACEOPS-RESULTS-04 · Pace and speed — THE only implementation.
//
// PURE. No SDK, no React. Server, client and test safe.
//
// ─── Why these are computed and never imported ───────────────────────────────
// Pace and speed are functions of (elapsed time, distance). Every timing provider prints
// them, and every one rounds differently — so importing them means a stored "4:15 min/km"
// sitting beside a time and distance that say 4:14. One of the two is then wrong on the
// participant's own result page, and nothing can say which. RegisterDesk therefore stores
// the facts and derives the rest, here, once.
//
// ─── Every impossible case returns null ──────────────────────────────────────
// Missing distance, missing time, zero distance, zero time: `null`, never NaN, never
// Infinity, never 0. The UI renders an unavailable state from `null` — it never formats a
// number it was not given.

export const MS_PER_SECOND = 1_000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND
export const METRES_PER_KM = 1_000

/** Guards absurd outputs from a mis-mapped column: faster than a car, slower than walking backwards. */
const MAX_SPEED_KMH = 200
const MIN_SPEED_KMH = 0.1

function usableLeg(timeMs: number | null | undefined, meters: number | null | undefined): { ms: number; m: number } | null {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs <= 0) return null
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) return null
  return { ms: timeMs, m: meters }
}

/**
 * Pace in milliseconds per kilometre, or null when it cannot be known.
 *
 * Kept as a duration (not a formatted string) so a caller can compare paces — the split
 * table highlights nothing today, but a stored number would have been the wrong shape for
 * the first caller that wants to.
 */
export function paceMsPerKm(timeMs: number | null | undefined, meters: number | null | undefined): number | null {
  const leg = usableLeg(timeMs, meters)
  if (!leg) return null
  const pace = leg.ms / (leg.m / METRES_PER_KM)
  return Number.isFinite(pace) && pace > 0 ? Math.round(pace) : null
}

/**
 * Speed in km/h, or null. One decimal — the precision a race result publishes.
 *
 * TRUNCATED, not rounded, for the same reason as the pace below: a timing system never
 * rounds a runner up. Provider A's 21 km in 1:29:32 is 14.07 km/h and their result sheet
 * says 14.0; rounding would print 14.1 beside a time that does not support it.
 */
export function speedKmh(timeMs: number | null | undefined, meters: number | null | undefined): number | null {
  const leg = usableLeg(timeMs, meters)
  if (!leg) return null
  const hours = leg.ms / (60 * MS_PER_MINUTE)
  if (hours <= 0) return null
  const kmh = (leg.m / METRES_PER_KM) / hours
  if (!Number.isFinite(kmh) || kmh < MIN_SPEED_KMH || kmh > MAX_SPEED_KMH) return null
  return Math.floor(kmh * 10) / 10
}

/**
 * "4:15" — minutes and seconds per kilometre. Empty string when there is no pace.
 *
 * TRUNCATED to the second, which is the convention every timing provider publishes and the
 * same one that makes a 1:29:32.9 crossing a 1:29:32 finish. Provider A's 21 km in 1:29:32
 * is 4:15.8 min/km and their sheet says 4:15; Provider B's 10 km in 32:35 is 3:15.5 and
 * their sheet says 3:15. Rounding would disagree with both, on the participant's own page,
 * against a time the same page prints.
 */
export function formatPace(paceMs: number | null | undefined): string {
  if (typeof paceMs !== 'number' || !Number.isFinite(paceMs) || paceMs <= 0) return ''
  const totalSeconds = Math.floor(paceMs / MS_PER_SECOND)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** "4:15 min/km", or '' — the unit belongs with the number so a caller cannot mislabel it. */
export function formatPaceWithUnit(paceMs: number | null | undefined): string {
  const p = formatPace(paceMs)
  return p === '' ? '' : `${p} min/km`
}

/** "14.0 km/h", or ''. One decimal, always — "14 km/h" reads as an estimate. */
export function formatSpeed(kmh: number | null | undefined): string {
  if (typeof kmh !== 'number' || !Number.isFinite(kmh) || kmh <= 0) return ''
  return `${kmh.toFixed(1)} km/h`
}

/** Both derived numbers for one leg, in one call — what every consumer actually wants. */
export interface LegPerformance {
  paceMsPerKm: number | null
  speedKmh:    number | null
}

export function legPerformance(
  timeMs: number | null | undefined, meters: number | null | undefined,
): LegPerformance {
  return { paceMsPerKm: paceMsPerKm(timeMs, meters), speedKmh: speedKmh(timeMs, meters) }
}
