// RD-RACEOPS-01 · Race Operations — event eligibility.
//
// PURE. No SDK, no I/O, no React. Unit-testable in isolation.
//
// Decides whether an event can receive published results, and — when it cannot —
// gives the honest reason. An ineligible event is still LISTED (so the organizer
// never wonders where it went); it is rendered disabled with this reason attached.

import { RACE_OPS_ELIGIBLE_LIFECYCLE } from '@/features/race-operations/types'
import { isRaceOperationsAvailable } from '@/lib/events/eventCapabilities'

/** RD-RACEOPS-02B · the reason shown when the event's TYPE does not admit results. */
export const RACE_OPS_TYPE_REASON = 'Race results are only available for sports events.'

export interface RaceOpsEligibility {
  eligible: boolean
  /** Present only when `eligible` is false. Shown verbatim to the organizer. */
  reason?:  string
}

/**
 * `lifecycleStatus` values come from the existing EventLifecycleStatus union and
 * are produced by the existing `deriveLifecycleStatus` resolver — Race Operations
 * derives no lifecycle state of its own.
 *
 * RD-RACEOPS-02B · `eventType` is checked FIRST, through the platform's own event
 * capability rule (`isRaceOperationsAvailable`): a conference is ineligible whatever its
 * lifecycle, and a sports event of any subtype passes on to the lifecycle and pass checks.
 */
export function resolveRaceOpsEligibility(
  lifecycleStatus: string,
  raceCount:       number,
  eventType:       string | null,
): RaceOpsEligibility {
  if (!isRaceOperationsAvailable(eventType)) {
    return { eligible: false, reason: RACE_OPS_TYPE_REASON }
  }
  if (!RACE_OPS_ELIGIBLE_LIFECYCLE.includes(lifecycleStatus)) {
    switch (lifecycleStatus) {
      case 'draft':
      case 'pending_review':
      case 'changes_requested':
        return { eligible: false, reason: 'Publish this event before recording results.' }
      case 'cancelled':
        return { eligible: false, reason: 'This event was cancelled.' }
      case 'archived':
        return { eligible: false, reason: 'This event is archived.' }
      case 'unpublished':
        return { eligible: false, reason: 'This event is currently offline.' }
      default:
        return { eligible: false, reason: 'Results are not available for this event.' }
    }
  }
  if (raceCount === 0) {
    // Distance = pass (Phase 0 · D2). No passes ⇒ nothing to record results against.
    return { eligible: false, reason: 'This event has no races or passes configured.' }
  }
  return { eligible: true }
}
