// RD-EVENT-19D — Participant Identity Platform: reuse eligibility.
//
// PURE, and extracted from ./config for exactly one reason: `config.ts` imports the
// Firebase Admin SDK, so anything importing `canReuse` from there pulled a
// server-only dependency with it. The RD-EVENT-19C decision model is consumed by
// the browser, and it must be able to ask "may this released value be reissued?"
// without shipping firebase-admin to the client.
//
// The RULE ITSELF IS UNCHANGED — this is a move, not a rewrite. `lib/identifiers/config`
// re-exports both symbols, so every existing import keeps working.

import type { IdentifierLockDoc, ReusePolicy } from './types'

export type LifecyclePhase = 'pre_event' | 'in_event' | 'completed' | 'unknown'

/**
 * Whether a RELEASED lock may be re-issued right now. Pure + deterministic given
 * the current event phase. A consumed/everCheckedIn identifier is NEVER reusable.
 */
export function canReuse(
  lock:   Pick<IdentifierLockDoc, 'state' | 'everCheckedIn'>,
  policy: ReusePolicy,
  phase:  LifecyclePhase,
): boolean {
  if (lock.everCheckedIn) return false          // permanent rule
  if (lock.state !== 'released') return false    // only released values can be reused

  switch (policy) {
    case 'never':                       return false
    case 'manual_only':                 return false   // explicit manual reassignment only
    case 'after_cancel_before_checkin': return true    // released && !everCheckedIn
    case 'before_event_start':          return phase === 'pre_event'
    case 'after_event_completed':       return phase === 'completed'
    default:                            return false
  }
}
