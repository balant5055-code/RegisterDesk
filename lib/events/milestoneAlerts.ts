// Booking Milestone Alerts — the ONE place a milestone is decided.
// PURE: no Firestore, no network, no React, no browser API. Server and test import it directly.
//
// ═══ WHAT THIS IS ════════════════════════════════════════════════════════════
// An organizer may attach informational notices to a pass, each keyed to a booking count
// ("at 2,000 bookings, tell people the t-shirt benefit applies"). This resolves which — if
// any — of those notices is currently showing.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// It is NOT a capacity system and must never become one. Nothing here may gate registration,
// hide a pass, alter a price, or influence checkout. It answers one question — "is there a
// message to display?" — and every caller uses the answer for rendering only. Keeping it pure
// is what makes that guarantee checkable: a function with no I/O cannot block a payment.
//
// ═══ THE COUNT IS THE PLATFORM'S EXISTING ONE ════════════════════════════════
// Callers pass `registrationCounters/{eventSlug}.passCounts[passId]` — the SAME number that
// enforces per-pass capacity. Reusing it means the notice and the seat count can never
// disagree, and it introduces no second definition of "a booking". Consequences inherited
// from that number, deliberately and not worked around here:
//
//   • It is a LIVE NET count. Cancelling a confirmed registration decrements it, so a
//     crossed milestone can UN-cross. There is no latching and no persisted `crossedAt` —
//     latching would require a write path, which is exactly the risk this feature avoids.
//   • Pending (manual-approval) registrations are not counted until approved.
//   • A refund keeps `status: 'confirmed'`, so refunded bookings still count.
//   • Events predating the historical dotted-key counter defect have an empty `passCounts`
//     and therefore read 0 — they will never fire a milestone. That attribution is
//     permanently unrecoverable upstream; it is not something this file can repair.

/** One organizer-configured notice. Stored on the pass, so `passId` is implicit. */
export interface MilestoneAlert {
  /** Bookings for THIS pass at which the notice starts showing. Must be a positive integer. */
  threshold:        number
  /** Organizer copy. Rendered as PLAIN TEXT by every caller — never as HTML. */
  message:          string
  /** Reuses the existing Banner tone scale rather than inventing a parallel severity axis. */
  tone?:            'info' | 'success' | 'warning'
  /** Also show a dismissible dialog when the attendee selects this pass. */
  showOnSelection?: boolean
}

/** A resolved, ready-to-render notice. Always fully populated — no optional fields to re-check. */
export interface ResolvedMilestoneAlert {
  threshold:       number
  message:         string
  tone:            'info' | 'success' | 'warning'
  showOnSelection: boolean
}

/** The platform maximum a threshold may take. Mirrors the largest event this system targets. */
export const MILESTONE_THRESHOLD_MAX = 1_000_000

/** The longest organizer message a notice may carry, matching the platform's short-copy limits. */
export const MILESTONE_MESSAGE_MAX = 300

/**
 * True when a configured entry is usable at all.
 *
 * A positive INTEGER threshold and a non-blank message are the whole contract. Anything else
 * — 0, negative, fractional, NaN, Infinity, a blank or whitespace-only message, a non-object —
 * is treated as "not configured" and silently ignored rather than throwing: a malformed draft
 * must never be able to surface an error on a public registration page.
 */
function isUsable(a: unknown): a is MilestoneAlert {
  if (!a || typeof a !== 'object') return false
  const { threshold, message } = a as { threshold?: unknown; message?: unknown }
  return (
    typeof threshold === 'number' &&
    Number.isInteger(threshold) &&
    threshold >= 1 &&
    threshold <= MILESTONE_THRESHOLD_MAX &&
    typeof message === 'string' &&
    message.trim().length > 0
  )
}

/**
 * The notice to display for a pass right now, or `null` for none.
 *
 * ═══ HIGHEST CROSSED WINS ════════════════════════════════════════════════════
 * With 1,000 / 2,000 / 3,000 configured and a count of 2,500, only the 2,000 notice shows.
 * Stacking every crossed milestone would grow the pass card without bound as an event fills
 * and would bury the most recent — and most relevant — message under stale ones. On a tie
 * (two entries with the same threshold) the FIRST in the organizer's order wins, so the
 * result is stable and depends only on the stored order, never on sort implementation.
 *
 * ═══ TOTAL, NEVER THROWING ═══════════════════════════════════════════════════
 * Every argument is defensive: a null/undefined config, a non-array, a missing count, or a
 * negative/NaN count all resolve to `null`. This function is on the render path of a LIVE
 * registration page, so "no alert" is the only acceptable failure mode.
 *
 * Does not mutate `alerts` — no sort in place, no element rewriting.
 *
 * @param alerts     The pass's configured notices (absent/empty ⇒ no alert, i.e. today's behaviour).
 * @param passCount  `counter.passCounts[passId] ?? 0`. No other count source is valid.
 */
export function resolveMilestoneAlert(
  alerts:    readonly MilestoneAlert[] | null | undefined,
  passCount: number | null | undefined,
): ResolvedMilestoneAlert | null {
  if (!Array.isArray(alerts) || alerts.length === 0) return null

  // A counter that could not be read arrives as null/undefined ⇒ 0 ⇒ nothing crossed.
  const count =
    typeof passCount === 'number' && Number.isFinite(passCount) && passCount > 0
      ? passCount
      : 0
  if (count === 0) return null

  let best: MilestoneAlert | null = null
  for (const a of alerts) {
    if (!isUsable(a)) continue
    if (a.threshold > count) continue
    // Strictly greater keeps the FIRST entry on a tie.
    if (best === null || a.threshold > best.threshold) best = a
  }
  if (best === null) return null

  return {
    threshold:       best.threshold,
    // Trimmed for display; the stored value is never rewritten.
    message:         best.message.trim().slice(0, MILESTONE_MESSAGE_MAX),
    tone:            best.tone === 'success' || best.tone === 'warning' ? best.tone : 'info',
    showOnSelection: best.showOnSelection === true,
  }
}

/**
 * Resolve for many passes at once — the shape the public projection actually needs.
 *
 * Returns a plain `passId → alert` record containing ONLY passes that currently have one, so
 * a template can ask `alerts[pass.id]` without first checking whether the feature is in use.
 * Passes are independent: one pass's configuration can never affect another's result.
 *
 * `counts` is the counter's `passCounts` map exactly as stored; a missing pass reads 0.
 */
export function resolveMilestoneAlertsByPass(
  passes: readonly { id: string; milestoneAlerts?: readonly MilestoneAlert[] | null }[],
  counts: Readonly<Record<string, number>> | null | undefined,
): Record<string, ResolvedMilestoneAlert> {
  const out: Record<string, ResolvedMilestoneAlert> = {}
  if (!Array.isArray(passes)) return out

  for (const p of passes) {
    if (!p || typeof p.id !== 'string' || !p.id) continue
    const resolved = resolveMilestoneAlert(p.milestoneAlerts, counts?.[p.id])
    if (resolved) out[p.id] = resolved
  }
  return out
}
