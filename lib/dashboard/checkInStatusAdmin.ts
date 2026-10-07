// RD-DASH-11A · the Firestore side of Check-in progress. READ-ONLY.
//
// ═══ ONE FOLD PER SLUG, OWNED BY THE CALLER ══════════════════════════════════
// RD-DASH-11B · this module no longer reads Firestore. The route holds the base counters
// it already fetched and folds each slug's attendance shards EXACTLY ONCE, then hands the
// two halves here. That is what lets the Check-in card and `eventStatus.checkedIn` share
// one authoritative number without folding the selected event's shards twice.
//
// The fold itself is still the platform's own — `foldAttendanceShards`, the same function
// `getRegistrationCounter` composes. Nothing here counts check-ins a second way: no
// registration scan, no `checkedInAt` aggregate, no new counter. The RD-DASH-11 audit found
// the base document's `checkedInCount` reading 0 against 288 real check-ins precisely
// because a caller read around that fold.
//
// ═══ READ COST ═══════════════════════════════════════════════════════════════
// ZERO, here. The route pays ONE `attendanceShards` subcollection read per slug that needs
// one, and both consumers read the same result.
//
// ═══ WHY THIS IS EVENT-SCOPED, AND STAYS THAT WAY ════════════════════════════
// Check-in is a gate operation: one event, one day, one door. A workspace-wide rate would
// blend a finished race at 288/2,295 with an upcoming event at 0/50 and produce a number
// nobody can act on — and it would cost one subcollection read per event to produce it.
// Technically possible is not the same as meaningful, so all-events mode reads NOTHING and
// the card asks for an event instead.

import {
  foldAttendanceShards,
  type AttendanceShardSums,
} from '@/lib/firebase/firestore/registrationCounters'
import type { RegistrationCounter } from '@/lib/registrations/types'
import { resolveCheckInStatus, EMPTY_CHECK_IN, type CheckInStatus } from './checkInStatus'

/**
 * Lifecycle states in which an event can take check-ins.
 *
 * Mirrors lib/eventSetup/registry, which gates its check-in module on the event being
 * published-like ("Publish the event to enable check-in"). That is the authoritative rule;
 * this is not a second one. Pinned to the registry by test.
 */
export const CHECK_IN_LIFECYCLES: readonly string[] =
  ['published', 'registration_closed', 'completed']

export interface CheckInScope {
  /** True when the dashboard is scoped to one event. */
  scoped:    boolean
  /** The selected event's slug. Null for an unpublished event — see below. */
  slug:      string | null
  /** The selected event's lifecycle, for the capability rule. */
  lifecycle: string | null
  /** passId → configured name, in the organizer's order. Empty when the event has no passes. */
  passNames: Record<string, string>
}

/**
 * SYNCHRONOUS. Check-in progress for the SELECTED event, from counters the caller holds.
 *
 * All-events mode resolves to `not_supported`: the card then asks the organizer to pick an
 * event rather than blending events that share no gate.
 *
 * An event selected while still unpublished has no slug, and no slug means no counter and
 * no shards — so it is refused before anything is read. Falling through with a null slug is
 * how a workspace figure ends up under one event's name; because this function performs no
 * query at all, that failure mode is now structurally impossible here.
 *
 * `shards` is null ONLY when the caller's fold failed. Unread is never zero.
 */
export function resolveCheckInFromCounters(
  scope: CheckInScope,
  /** passId → confirmed, from the counter the dashboard already loaded. */
  passConfirmed: Record<string, number>,
  /** The BASE counter document. Its own `checkedInCount` is never read alone. */
  base: RegistrationCounter | null,
  /** This slug's attendance-shard sums, folded once by the caller. null ⇒ unread. */
  shards: AttendanceShardSums | null,
): CheckInStatus {
  const { scoped, slug, lifecycle, passNames } = scope

  if (!scoped || !slug) return { ...EMPTY_CHECK_IN, state: 'not_supported' }
  if (!lifecycle || !CHECK_IN_LIFECYCLES.includes(lifecycle)) {
    return { ...EMPTY_CHECK_IN, state: 'not_supported' }
  }
  // The shard read failed. Falling back to the base document would reinstate the exact
  // defect this phase exists to remove — 0 against 288.
  if (shards === null) return { ...EMPTY_CHECK_IN, state: 'unavailable' }

  // THE fold — the same function `getRegistrationCounter` composes, applied to counters the
  // route already has. `checkedInCount` and `passCheckedInCounts` below therefore include
  // every attendance shard; the base document's own values are never read alone.
  const counter = foldAttendanceShards((base ?? {}) as RegistrationCounter, shards)

  return resolveCheckInStatus({
    // No counter document at all ⇒ nothing has ever been registered for this event, so both
    // figures are genuinely zero rather than unread.
    checkedIn:     counter.checkedInCount ?? 0,
    // `totalCount` holds CONFIRMED — the same field every other dashboard surface uses for
    // that figure. Introducing a different confirmed count here would give the card its own
    // denominator.
    confirmed:     counter.totalCount ?? 0,
    passCheckedIn: counter.passCheckedInCounts ?? {},
    passConfirmed,
    passNames,
    supported:     true,
  })
}
