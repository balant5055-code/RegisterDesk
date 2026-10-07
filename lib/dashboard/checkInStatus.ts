// RD-DASH-11A · Check-in progress. PURE — no Firestore, no clock, no React.
//
// ═══ THE DEFECT THIS EXISTS TO AVOID ═════════════════════════════════════════
// The dashboard already carried a per-event `checkedIn`, sourced from
// `registrationCounters/{slug}.checkedInCount`. On the audited event that field reads 0
// while 288 people actually checked in — because check-in writes go to distributed
// ATTENDANCE SHARDS (10 documents, 22–35 each) to avoid contention on one hot counter, and
// the dashboard route reads the base document without folding them.
//
// It survived because nothing rendered it. A card built on that field would have reported
// 0 of 2,295 checked in, at 0%, for an event whose gate processed 288 people.
//
// The authoritative read path is `getRegistrationCounter()`, which folds the shards. This
// module never touches the base field.
//
// ═══ WHAT "CHECKED IN" MEANS ═════════════════════════════════════════════════
// A registration carrying `checkedInAt`. Check-in sets it; undo removes it. It is a state
// of a REGISTRATION, not a count of scans — a participant scanned five times is one
// checked-in registration, which is exactly what the shard counter records.
//
// ═══ WHY THE RATIO CAN EXCEED 100%, AND WHY IT IS NOT CLAMPED ════════════════
// `checkInBlockReason` refuses a cancelled registration at every entry point, so nobody can
// check IN a cancelled participant. But the reverse is unguarded: `cancelRegistration`
// decrements `totalCount` (the confirmed figure) and leaves `checkedInAt` and the attendance
// shard untouched. A participant who checks in at the gate and is cancelled afterwards
// therefore stays in the numerator and leaves the denominator.
//
// That makes `checkedIn > confirmed` STRUCTURALLY POSSIBLE, not merely theoretical. It is
// 0 on the audited event today; the mechanism is live.
//
// So nothing here clamps. `Math.min(rate, 100)` would turn a data-integrity signal into a
// plausible-looking number, and the organizer would never learn that their gate count and
// their confirmed count disagree. The true ratio is reported and the condition is flagged.

/** A measured count, or `null` when it could not be read. Never a fallback 0. */
export type CheckInCount = number | null

/**
 * What the card can be in. Four states, and collapsing any two of them is how a dashboard
 * starts lying — see the RD-DASH-06/07/08 precedent.
 *
 *   ready         — measured, with a denominator to measure against
 *   no_confirmed  — measured, but nobody is confirmed yet; a rate would divide by zero
 *   not_supported — the event cannot take check-ins at all (it is not published-like)
 *   unavailable   — the read failed; never rendered as zero
 */
export type CheckInState = 'ready' | 'no_confirmed' | 'not_supported' | 'unavailable'

export interface CheckInPassRow {
  passId: string
  label:  string
  checkedIn: number
  /** Confirmed on this pass. null when unknown — then no per-pass rate is claimed. */
  confirmed: number | null
  /** 0–100, unclamped, or null without a usable denominator. */
  percentage: number | null
}

export interface CheckInStatus {
  state:     CheckInState
  checkedIn: CheckInCount
  confirmed: CheckInCount
  /**
   * Confirmed minus checked in — resolved HERE, not in the component.
   *
   * Null when either side is unread, and null when `exceedsConfirmed`: a negative
   * "remaining" is not a quantity, and forcing it to 0 would hide the very disagreement
   * that made it negative.
   */
  remaining: CheckInCount
  /** The TRUE ratio, unclamped. Null when there is no denominator to divide by. */
  percentage: number | null
  /**
   * `checkedIn > confirmed`. Surfaced rather than corrected — see the header.
   * Its most likely cause is a participant cancelled after being checked in.
   */
  exceedsConfirmed: boolean
  /** Everyone confirmed has been checked in. Distinct from a rate that rounds to 100. */
  complete: boolean
  /** In the ORGANIZER'S configured pass order. Empty when unavailable or not applicable. */
  byPass: CheckInPassRow[]
}

export const EMPTY_CHECK_IN: CheckInStatus = {
  state: 'unavailable', checkedIn: null, confirmed: null, remaining: null,
  percentage: null, exceedsConfirmed: false, complete: false, byPass: [],
}

export interface CheckInInput {
  /** Folded across the attendance shards. null ⇒ the read failed. */
  checkedIn: CheckInCount
  /** `registrationCounters.totalCount`, which holds CONFIRMED. null ⇒ the read failed. */
  confirmed: CheckInCount
  /** passId → checked in, from the shards' `passCheckedInCounts`. */
  passCheckedIn: Record<string, number>
  /** passId → confirmed, from `passCounts`. */
  passConfirmed: Record<string, number>
  /**
   * passId → configured name, in the organizer's own order.
   *
   * Key ORDER is the display order — `passNames` is built by walking
   * `draft.pricing.passes`, so it already carries the arrangement the organizer chose.
   * The component must not sort; see RD-DASH-04, where iterating a Firestore map decided
   * the order by accident.
   */
  passNames: Record<string, string>
  /**
   * False ⇒ the event cannot take check-ins.
   *
   * The authoritative rule, not one invented here: lib/eventSetup/registry gates the
   * check-in module on the event being published-like ("Publish the event to enable
   * check-in"). The caller applies that same rule.
   */
  supported: boolean
}

/** 0–100, unclamped. Null when the denominator is missing or zero. */
function rate(part: number, whole: number | null): number | null {
  if (whole === null || whole <= 0) return null
  return (part / whole) * 100
}

/**
 * PURE. Every figure the card renders, resolved once.
 *
 * The component receives `checkedIn`, `confirmed`, `remaining` and `percentage` already
 * computed — it performs no arithmetic of its own, so the card and any other consumer can
 * never derive two different answers from the same payload.
 */
export function resolveCheckInStatus(input: CheckInInput): CheckInStatus {
  const { checkedIn, confirmed, supported } = input

  // An event that cannot take check-ins has no check-in progress — which is a different
  // statement from "nobody has checked in yet".
  if (!supported) return { ...EMPTY_CHECK_IN, state: 'not_supported' }

  // A failed read. Zero here would claim an empty gate.
  if (checkedIn === null || confirmed === null) return { ...EMPTY_CHECK_IN, state: 'unavailable' }

  const exceedsConfirmed = checkedIn > confirmed
  const percentage = rate(checkedIn, confirmed)

  const byPass: CheckInPassRow[] = Object.keys(input.passNames).map(passId => {
    const ci = input.passCheckedIn[passId] ?? 0
    const cf = input.passConfirmed[passId]
    const known = typeof cf === 'number' && cf > 0 ? cf : null
    return {
      passId,
      label: input.passNames[passId]?.trim() || 'Unassigned',
      checkedIn: ci,
      confirmed: known,
      percentage: rate(ci, known),
    }
  // A pass nobody has checked into AND nobody confirmed is not a row worth a line.
  }).filter(r => r.checkedIn > 0 || (r.confirmed ?? 0) > 0)

  return {
    // Measured, but there is nothing to be a share OF. A rate would divide by zero and a
    // "0%" would read as poor turnout rather than as an empty roll.
    state: confirmed <= 0 ? 'no_confirmed' : 'ready',
    checkedIn,
    confirmed,
    remaining: exceedsConfirmed ? null : confirmed - checkedIn,
    percentage,
    exceedsConfirmed,
    complete: confirmed > 0 && checkedIn === confirmed,
    byPass,
  }
}
