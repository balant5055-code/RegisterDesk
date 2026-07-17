// Server-only payout-profile verification gate (P9.1).
//
// A payout (settlement) must never proceed without an admin-verified payout
// profile. Used as a pre-check by the settlement request + admin-approve paths;
// the mark-paid path re-reads the profile INSIDE its transaction for strictness.

import { adminDb } from '@/lib/firebase/admin'
import type { OrganizerPayoutProfileDoc } from '@/lib/payout/types'

/** True only when the organizer has a payout profile with isVerified === true. */
export async function isPayoutProfileVerified(organizerUid: string): Promise<boolean> {
  const snap = await adminDb.doc(`organizerPayoutProfiles/${organizerUid}`).get()
  if (!snap.exists) return false
  return (snap.data() as OrganizerPayoutProfileDoc).isVerified === true
}

export const PAYOUT_PROFILE_UNVERIFIED_MESSAGE =
  'A verified payout profile is required. Add your bank/UPI details and wait for verification before requesting a settlement.'
