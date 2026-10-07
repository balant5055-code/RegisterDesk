// RD-ANALYTICS-04 · the ONE date-range model for Analytics. PURE — no Firestore, no React.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Before this module there were four ways to say "a day" in the product, and three of
// them disagreed:
//
//   lib/dashboard/dailyStats.ts        IST fixed offset (+05:30) — the ROLLUP's own
//                                      bucketing, written at registration time
//   lib/analytics/eventAnalytics.ts    UTC `toISOString().slice(0,10)` (RETIRED in
//                                      RD-ANALYTICS-03 when the series moved onto rollups)
//   lib/events/registrationTrend.ts    the EVENT's timezone, via Intl, DST-correct
//   the Reports page                   a bare `'7d' | '30d' | '90d'` union with the
//                                      labels formatted in the BROWSER's locale
//
// A range is not a formatting concern. Two Analytics pages asking "the last 30 days" must
// mean the same 30 days, or a figure moved between tabs is a bug nobody can see.
//
// ═══ THE CANONICAL DAY, AND WHY IT IS NOT NEGOTIABLE HERE ════════════════════
// Analytics day buckets are IST business days, because that is what
// `organizerDailyStats` PHYSICALLY CONTAINS. The rollup rows were written with
// `dayKey()`; a range expressed in any other zone would slice rows whose boundaries do
// not match it and silently mis-attribute the edges. This module therefore delegates to
// `dayKey`/`dayKeyRange` rather than re-deriving a calendar — see the timezone boundary
// note at the foot of this file for what would have to happen to change it.

import { dayKey, dayKeyRange, REPORTING_TZ_OFFSET_MINUTES } from '@/lib/dashboard/dailyStats'

/** Re-exported so a consumer never reaches for its own offset constant. */
export { REPORTING_TZ_OFFSET_MINUTES }

export type AnalyticsRangePreset = '7d' | '30d' | '90d' | 'custom'

/**
 * A resolved analytics window.
 *
 * `from` and `to` are INCLUSIVE `YYYY-MM-DD` IST business days — the same string space as
 * a rollup document's `day` field, so a range can be turned into document ids without any
 * further conversion. Deliberately not Date objects: a Date carries a time and a zone,
 * and both would be lies here.
 */
export interface AnalyticsDateRange {
  from:   string
  to:     string
  preset: AnalyticsRangePreset
}

/** Days each preset covers, inclusive of today. */
export const PRESET_DAYS: Record<Exclude<AnalyticsRangePreset, 'custom'>, number> = {
  '7d': 7, '30d': 30, '90d': 90,
}

/**
 * The longest window Analytics may request.
 *
 * 90 is not a product preference — it is how much history the dashboard route materialises
 * from `organizerDailyStats`. Allowing 180 here would produce a range the data layer
 * cannot fill and a chart whose left half is indistinguishable from a quiet period.
 */
export const MAX_RANGE_DAYS = 90

/**
 * Typed as a NON-custom preset on purpose: the default has to be resolvable without a
 * `from`/`to` pair, and typing it as the wider union would let `'custom'` be assigned here
 * and fail at the one call site that can never supply bounds.
 */
export const DEFAULT_PRESET: Exclude<AnalyticsRangePreset, 'custom'> = '30d'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Is this a well-formed IST business-day key? */
export function isDayKey(v: unknown): v is string {
  return typeof v === 'string' && DAY_RE.test(v)
}

/** Whole days from `from` to `to`, inclusive. Null when either bound is malformed. */
export function rangeLengthDays(from: string, to: string): number | null {
  if (!isDayKey(from) || !isDayKey(to)) return null
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.round(ms / 86_400_000) + 1
}

/** The window a preset names, ending today in the reporting zone. */
export function presetRange(
  preset: Exclude<AnalyticsRangePreset, 'custom'>,
  now: Date | number = Date.now(),
): AnalyticsDateRange {
  const days = PRESET_DAYS[preset]
  const keys = dayKeyRange(now, days)
  return { from: keys[0], to: keys[keys.length - 1], preset }
}

/**
 * A custom window, clamped rather than rejected.
 *
 * Reversed bounds are swapped and an over-long window is truncated from the FROM end —
 * the recent end is the one an organizer is looking at, so it is the one kept. Returns
 * null only when a bound is not a day key at all, because that is a caller bug rather
 * than a user choice.
 */
export function customRange(from: string, to: string): AnalyticsDateRange | null {
  if (!isDayKey(from) || !isDayKey(to)) return null
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const len = rangeLengthDays(lo, hi)
  if (len === null) return null
  if (len <= MAX_RANGE_DAYS) return { from: lo, to: hi, preset: 'custom' }
  const clamped = dayKeyRange(Date.parse(`${hi}T00:00:00Z`) - REPORTING_TZ_OFFSET_MINUTES * 60_000, MAX_RANGE_DAYS)
  return { from: clamped[0], to: hi, preset: 'custom' }
}

/**
 * Read a range off untrusted input (a query string, stored state, a page prop).
 *
 * Anything unrecognised falls back to the default preset rather than throwing: a bad
 * `?range=` in a bookmark should show the organizer their dashboard, not an error page.
 */
export function normalizeRange(
  input: { preset?: unknown; from?: unknown; to?: unknown } | null | undefined,
  now: Date | number = Date.now(),
): AnalyticsDateRange {
  const preset = input?.preset
  if (preset === 'custom' && isDayKey(input?.from) && isDayKey(input?.to)) {
    return customRange(input.from, input.to) ?? presetRange(DEFAULT_PRESET, now)
  }
  if (preset === '7d' || preset === '30d' || preset === '90d') return presetRange(preset, now)
  return presetRange(DEFAULT_PRESET, now)
}

/**
 * The range as rollup document day keys, oldest → newest.
 *
 * This is the bridge to `readDailyStats`, which takes exactly this array. Returns an
 * empty array for a malformed range rather than a partially-built one.
 */
export function rangeDayKeys(range: AnalyticsDateRange): string[] {
  const len = rangeLengthDays(range.from, range.to)
  if (len === null || len <= 0) return []
  // `to` at IST midnight, expressed as the instant dayKeyRange expects.
  const toInstant = Date.parse(`${range.to}T00:00:00Z`) - REPORTING_TZ_OFFSET_MINUTES * 60_000
  return dayKeyRange(toInstant, len)
}

/** Today in the reporting zone — the anchor every preset is measured from. */
export function today(now: Date | number = Date.now()): string {
  return dayKey(now)
}

// ═══ TIMEZONE BOUNDARY — deliberately NOT crossed in RD-ANALYTICS-04 ══════════
//
// Analytics days are IST because `organizerDailyStats` rows were WRITTEN that way, in the
// same transaction as `registrationCounters`. The event's own timezone is stored
// (`eventDetails.schedule.timezone`) and `lib/events/registrationTrend.ts` already uses it
// correctly for its own surface — so "use the event's timezone" is a reasonable future
// product decision, not a missing capability.
//
// It is not made here because it is a DATA decision, not a formatting one. Every existing
// rollup row would have to be rebuilt against a per-event zone; until that happens, an
// event-timezone range would slice IST-bucketed rows at the wrong boundary and move
// registrations between days. That rebuild is out of scope for an architecture phase and
// is recorded as the open decision it is.
