// Phase C — Cashfree vendor PREPARATION state, tracked locally.
//
// ═══ THE DISTINCTION THIS FILE EXISTS TO ENFORCE ════════════════════════════
// Three different things are easy to conflate, and conflating them would let RegisterDesk
// tell an organizer their money is about to flow when it is not:
//
//   1. PROFILE SUPPLIED   — the organizer has given us bank details. Says nothing about
//                           whether anyone has checked them.
//   2. LOCALLY REVIEWED   — a RegisterDesk admin looked at those details and considers the
//                           organizer ready to be put forward to Cashfree. This is OUR
//                           opinion. Cashfree has not been contacted and does not know.
//   3. VENDOR ONBOARDED / KYC APPROVED — Cashfree's own verdict, which only Cashfree can
//                           give, through an API this codebase has not yet integrated.
//
// Everything below models 1 and 2 ONLY. Nothing here may ever set 3.

/**
 * RegisterDesk's own preparation status. These are LOCAL names for a LOCAL workflow — none
 * of them is a Cashfree status and none should ever be displayed as one.
 */
export type VendorPreparationStatus =
  /** No payout profile, or one with nothing usable in it. The default for every organizer. */
  | 'not_started'
  /** The organizer has supplied payout details. Nobody has reviewed them yet. */
  | 'profile_submitted'
  /** An admin reviewed the details and considers the organizer ready to put to Cashfree. */
  | 'locally_reviewed'
  /** An admin returned the profile for correction. The reason is stored alongside. */
  | 'changes_requested'

export const VENDOR_PREPARATION_STATUSES: readonly VendorPreparationStatus[] = [
  'not_started', 'profile_submitted', 'locally_reviewed', 'changes_requested',
] as const

/**
 * What Cashfree says about this vendor's KYC.
 *
 * ═══ WHY THIS HAS EXACTLY ONE MEMBER ════════════════════════════════════════
 * Cashfree's real KYC status values are NOT verified anywhere in this repository — no
 * vendor API contract, no documented status set. Writing a plausible-looking union here
 * ('APPROVED', 'PENDING', …) would be inventing a provider contract, and the first thing
 * built on it would be wrong in a way that looks right.
 *
 * So the only value this can hold is `unknown`, and the compiler enforces it: there is
 * literally no way to write a fabricated Cashfree status into a profile today. When the
 * official contract is confirmed, this union widens — deliberately, in a reviewed change.
 */
export type VendorKycStatus = 'unknown'

/**
 * Which LOCAL transitions an admin may perform.
 *
 * Only the two review outcomes are admin-driven. `profile_submitted` is derived from the
 * organizer supplying details, never chosen, and `not_started` is the absence of a profile
 * rather than a state anyone moves to.
 */
const ADMIN_TRANSITIONS: Record<VendorPreparationStatus, VendorPreparationStatus[]> = {
  not_started:       [],
  profile_submitted: ['locally_reviewed', 'changes_requested'],
  // A review can be revoked — details go stale, and an admin must be able to pull an
  // organizer back without deleting their profile.
  locally_reviewed:  ['changes_requested'],
  // Re-review after the organizer has resubmitted.
  changes_requested: ['locally_reviewed'],
}

/** Is this an admin transition the workflow permits? */
export function canAdminTransition(
  from: VendorPreparationStatus, to: VendorPreparationStatus,
): boolean {
  return (ADMIN_TRANSITIONS[from] ?? []).includes(to)
}

/** Every status an admin could move to from here — for rendering, never for authorization. */
export function allowedAdminTransitions(from: VendorPreparationStatus): VendorPreparationStatus[] {
  return [...(ADMIN_TRANSITIONS[from] ?? [])]
}

/**
 * Read a stored status safely.
 *
 * Absent, malformed, or an unrecognised value all read as `not_started`. That is the
 * conservative direction: an unreadable status must never present as reviewed, because
 * "reviewed" is the state that lets an organizer progress.
 */
export function readVendorPreparationStatus(value: unknown): VendorPreparationStatus {
  return typeof value === 'string' && (VENDOR_PREPARATION_STATUSES as string[]).includes(value)
    ? value as VendorPreparationStatus
    : 'not_started'
}

/** Read a stored KYC status safely. Anything we did not write reads as `unknown`. */
export function readVendorKycStatus(value: unknown): VendorKycStatus {
  return value === 'unknown' ? 'unknown' : 'unknown'
}

/**
 * A Cashfree vendor id, only when it is a real one.
 *
 * Returns null for absent, blank or non-string values. Nothing in this codebase may invent
 * or placeholder a vendor id: an id that does not correspond to a vendor at Cashfree would
 * be indistinguishable from one that does, and the split built on it would fail silently.
 */
export function readCashfreeVendorId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Has this organizer supplied enough for an admin to review?
 *
 * Derived, never stored: the profile fields are the truth, and a stored duplicate of this
 * could drift from them. Mirrors the payout profile's own requirements — a payout method
 * with its identifying fields, plus PAN.
 */
export function hasReviewablePayoutProfile(p: {
  payoutMethod?: unknown; accountNumber?: unknown; ifscCode?: unknown
  upiId?: unknown; panNumber?: unknown
} | null | undefined): boolean {
  if (!p) return false
  const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  if (!str(p.panNumber)) return false
  if (p.payoutMethod === 'upi')  return str(p.upiId)
  if (p.payoutMethod === 'bank') return str(p.accountNumber) && str(p.ifscCode)
  return false
}
