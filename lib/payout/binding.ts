// lib/payout/binding.ts
// RD-PHASE4-S4 · D5 — binding a settlement to the payout destination that was VERIFIED.
//
// PURE. No SDK, no I/O.
//
// A settlement request snapshots the verified destination's BINDING VERSION when it is
// created. Marking it paid then requires the profile to still be verified AT THAT VERSION —
// not merely "verified now". An organizer who edits their bank details resets verification
// (the payout-profile PUT is a full replace), and a later re-verification produces a NEW
// version, so money can never follow a destination that nobody verified for this request.
//
// The version is `verifiedVersion` (stamped by the admin verify transaction: the profile's
// updatedAt, in ms, of the details the admin actually reviewed). Profiles verified before this
// field existed fall back to their `verifiedAt` time, which also changes on every re-verify.
//
// The snapshot carries NO payout identifier beyond the masked label the audit history already
// stores — it can never be used to send money anywhere.

import type { OrganizerPayoutProfileDoc } from '@/lib/payout/types'

export interface SettlementPayoutDestination {
  /** The binding version of the verified destination at request time. */
  verifiedVersion: number
  verifiedBy:      string | null
  method:          string
  /** Masked, human-readable (e.g. "HDFC Bank ••••9012"); null when it could not be derived. */
  label:           string | null
}

function toMillis(ts: unknown): number | null {
  if (ts && typeof (ts as { toMillis?: () => number }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis()
  }
  if (ts instanceof Date) return ts.getTime()
  return null
}

/** The profile's binding version, or null when it is not verified (nothing to bind to). */
export function payoutBindingVersion(
  p: Pick<OrganizerPayoutProfileDoc, 'isVerified' | 'verifiedAt'> & { verifiedVersion?: unknown } | null | undefined,
): number | null {
  if (!p || p.isVerified !== true) return null
  if (typeof p.verifiedVersion === 'number' && Number.isFinite(p.verifiedVersion)) return p.verifiedVersion
  return toMillis(p.verifiedAt)
}

/** The version to compare an admin's `expectedUpdatedAt` against (stale-verification guard). */
export function profileUpdatedAtMillis(p: { updatedAt?: unknown } | null | undefined): number | null {
  return toMillis(p?.updatedAt)
}

export type BindingCheck =
  | { ok: true;  mode: 'bound' | 'legacy_unbound' }
  | { ok: false; code: 'UNVERIFIED_PROFILE' | 'DESTINATION_CHANGED' }

/**
 * Is it safe to move money for this settlement to the profile as it is NOW?
 *   • no snapshot (a request created before D5)  → the legacy rule: currently verified;
 *   • snapshot                                   → verified AND at the snapshotted version.
 */
export function checkSettlementBinding(
  snapshot: SettlementPayoutDestination | null | undefined,
  profile: Parameters<typeof payoutBindingVersion>[0],
): BindingCheck {
  const current = payoutBindingVersion(profile)
  if (current === null) return { ok: false, code: 'UNVERIFIED_PROFILE' }
  if (!snapshot || typeof snapshot.verifiedVersion !== 'number') return { ok: true, mode: 'legacy_unbound' }
  return current === snapshot.verifiedVersion ? { ok: true, mode: 'bound' } : { ok: false, code: 'DESTINATION_CHANGED' }
}

export const DESTINATION_CHANGED_MESSAGE =
  'The organizer’s payout details changed or were re-verified after this settlement was requested. ' +
  'Reject this request so the organizer can request again against the currently verified destination.'
