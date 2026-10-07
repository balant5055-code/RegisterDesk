// RD-ANALYTICS-04 · the ONE comparison model for Analytics. PURE.
//
// ═══ WHY THIS EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO ═══════════════════
// Comparison is the feature most likely to be re-invented per page, because every chart
// wants "vs last week" and the arithmetic looks trivial. It is not trivial — the failure
// mode is a confident percentage computed against a baseline that was empty, or against a
// window of a different length. Both produce a number that reads as a fact.
//
// The arithmetic is ALREADY solved and tested: `computeDelta` in lib/dashboard/insights.ts
// returns `pct: null` when the previous period had nothing, precisely so "up from nothing"
// is never rendered as a percentage. This module does not re-implement it — it re-exports
// it and adds the one thing missing: resolving WHICH window is the baseline.
//
// No query is issued here and none is implied. Establishing the model now is what stops
// the Overview, Registrations and Revenue pages each inventing their own baseline.

import { computeDelta, type Delta } from '@/lib/dashboard/insights'
import { rangeLengthDays, isDayKey, type AnalyticsDateRange } from '@/lib/analytics/dateRange'

export { computeDelta, type Delta }

/**
 * `previous_period` — the immediately preceding window of the SAME length.
 * `event`           — another event over the same window. Groundwork only; no service
 *                     resolves a baseline event yet, and this phase adds none.
 */
export type AnalyticsComparisonMode = 'previous_period' | 'event'

/** The request. Every field beyond `enabled` is optional so an off comparison is `{ enabled: false }`. */
export interface AnalyticsComparison {
  enabled:          boolean
  mode?:            AnalyticsComparisonMode
  baselineFrom?:    string
  baselineTo?:      string
  baselineEventId?: string
}

export const COMPARISON_OFF: AnalyticsComparison = { enabled: false }

/**
 * A comparison that has been checked and can be acted on.
 *
 * `unavailable` is a first-class outcome rather than a thrown error: asking for a baseline
 * that cannot be resolved must degrade to "no comparison shown", never to a comparison
 * against a window silently substituted for the one requested.
 */
export type ResolvedComparison =
  | { ok: true;  mode: AnalyticsComparisonMode; baseline: AnalyticsDateRange; baselineEventId: string | null }
  | { ok: false; reason: 'disabled' | 'unsupported_mode' | 'invalid_baseline' | 'missing_event' }

/**
 * The window immediately before `range`, of identical length.
 *
 * Length is taken from the range itself rather than from its preset, so a custom range
 * compares against an equally-custom baseline. A 30-day window always compares against
 * 30 days — never against "last month", which is a different number of days and would
 * make the percentage a comparison of window sizes.
 */
export function previousPeriod(range: AnalyticsDateRange): AnalyticsDateRange | null {
  const len = rangeLengthDays(range.from, range.to)
  if (len === null || len <= 0) return null
  // The baseline ENDS the day before the range begins and runs the same number of days
  // back, so the two windows are adjacent with no gap and no overlap.
  const keys = daysEndingAt(dayBefore(range.from), len)
  return { from: keys[0], to: keys[keys.length - 1], preset: range.preset }
}

/**
 * Day-key arithmetic on the KEYS themselves.
 *
 * A day key is a calendar label, not an instant — it has already had the reporting offset
 * applied by `dayKey()`. Converting it back to an instant to step it would apply that
 * offset a second time, which is how an off-by-one day gets into a comparison. Parsing at
 * UTC midnight and stepping in whole days keeps the label arithmetic exact.
 */
function dayBefore(key: string): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

/** `days` keys ending at (and including) `endKey`, oldest → newest. */
function daysEndingAt(endKey: string, days: number): string[] {
  const end = Date.parse(`${endKey}T00:00:00Z`)
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10))
  return out
}

/**
 * Turn a requested comparison into one that can be executed, or say why it cannot.
 *
 * `event` mode resolves its WINDOW here but is reported as `ok` only when a baseline event
 * was actually named — the data path for it does not exist yet, and a caller must not be
 * able to mistake "the model understands this" for "a service will answer it".
 */
export function resolveComparison(
  comparison: AnalyticsComparison | null | undefined,
  range: AnalyticsDateRange,
): ResolvedComparison {
  if (!comparison?.enabled) return { ok: false, reason: 'disabled' }

  const mode = comparison.mode ?? 'previous_period'
  if (mode !== 'previous_period' && mode !== 'event') return { ok: false, reason: 'unsupported_mode' }

  if (mode === 'event') {
    if (!comparison.baselineEventId) return { ok: false, reason: 'missing_event' }
    // Same window, different event — the baseline is the range itself.
    return { ok: true, mode, baseline: range, baselineEventId: comparison.baselineEventId }
  }

  // An explicit baseline window wins over the derived one, when it is well-formed.
  if (isDayKey(comparison.baselineFrom) && isDayKey(comparison.baselineTo)) {
    const from = comparison.baselineFrom
    const to   = comparison.baselineTo
    if (rangeLengthDays(from, to) === null) return { ok: false, reason: 'invalid_baseline' }
    return { ok: true, mode, baseline: { from, to, preset: 'custom' }, baselineEventId: null }
  }

  const derived = previousPeriod(range)
  if (!derived) return { ok: false, reason: 'invalid_baseline' }
  return { ok: true, mode, baseline: derived, baselineEventId: null }
}

/**
 * RD-ANALYTICS-07 · why a comparison is not being shown.
 *
 * A delta of null is unambiguous to a type checker and useless to a reader, who wants to
 * know whether the platform has not measured the baseline, is not permitted to, or simply
 * has no history that far back. The reason travels with the metric so the UI can explain
 * itself in the one case where an explanation helps, and stay quiet otherwise.
 */
export type ComparisonUnavailable =
  | 'no_baseline'       // the previous window could not be read
  | 'outside_coverage'  // the previous window predates the analytics record
  | 'not_measured'      // the CURRENT value is itself unmeasured
  | 'disabled'          // comparison was not requested

export interface ComparedMetric {
  value:    number | null
  baseline: number | null
  delta:    Delta | null
  /** Present only when `delta` is null. Absent on a successful comparison. */
  unavailable?: ComparisonUnavailable
}

/**
 * Pair a current and baseline figure.
 *
 * Either side unmeasured ⇒ no delta, never a fabricated one. `reason` lets the caller say
 * WHY there is no baseline; it is recorded only when the comparison genuinely did not
 * happen, so a successful comparison carries no explanation to ignore.
 */
export function compareMetric(
  value: number | null,
  baseline: number | null,
  reason: ComparisonUnavailable = 'no_baseline',
): ComparedMetric {
  if (value === null) return { value, baseline, delta: null, unavailable: 'not_measured' }
  if (baseline === null) return { value, baseline, delta: null, unavailable: reason }
  return { value, baseline, delta: computeDelta(value, baseline) }
}
