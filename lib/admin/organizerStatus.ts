// Organizer account-status enforcement. Server-only.
//
// A suspended/banned organizer must be blocked from all mutation endpoints
// (publish, settlement requests, broadcasts, certificate jobs, wallet top-ups…).
// Read-only endpoints are unaffected.
//
// Backward compatible: an organizer doc with NO accountStatus is treated as
// 'active'. A missing user doc is also treated as active (fail-open) so a data
// anomaly can never lock a legitimate organizer out of every mutation.

import { adminDb } from '@/lib/firebase/admin'
import type { AccountStatus } from '@/lib/admin/organizerTypes'

export type OrganizerStatusCode = 'ORGANIZER_SUSPENDED' | 'ORGANIZER_BANNED'

const MESSAGES: Record<OrganizerStatusCode, string> = {
  ORGANIZER_SUSPENDED: 'Your organizer account is suspended. Please contact support.',
  ORGANIZER_BANNED:    'Your organizer account has been banned. Please contact support.',
}

/** Typed error thrown by assertOrganizerActive when the account is not active. */
export class OrganizerStatusError extends Error {
  constructor(public readonly code: OrganizerStatusCode) {
    super(MESSAGES[code])
    this.name = 'OrganizerStatusError'
  }
}

/** Reads the effective account status (missing field → 'active'). */
export async function getOrganizerAccountStatus(uid: string): Promise<AccountStatus> {
  const snap = await adminDb.doc(`users/${uid}`).get()
  if (!snap.exists) return 'active'
  const status = (snap.data() as { accountStatus?: AccountStatus }).accountStatus
  return status === 'suspended' || status === 'banned' ? status : 'active'
}

/**
 * Throws OrganizerStatusError if the organizer is suspended or banned.
 * Resolves silently when active (or when the field/doc is absent).
 */
export async function assertOrganizerActive(uid: string): Promise<void> {
  const status = await getOrganizerAccountStatus(uid)
  if (status === 'suspended') throw new OrganizerStatusError('ORGANIZER_SUSPENDED')
  if (status === 'banned')    throw new OrganizerStatusError('ORGANIZER_BANNED')
}

/**
 * Route-friendly wrapper around assertOrganizerActive: returns the blocking
 * error info (for a 403) or null when active. Centralises the
 * OrganizerStatusError handling so routes don't duplicate instanceof logic.
 */
export async function organizerStatusGuard(
  uid: string,
): Promise<{ code: OrganizerStatusCode; message: string } | null> {
  try {
    await assertOrganizerActive(uid)
    return null
  } catch (err) {
    if (err instanceof OrganizerStatusError) return { code: err.code, message: err.message }
    throw err
  }
}
