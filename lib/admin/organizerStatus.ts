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
import { resolveAccountStatus, type AccountStatus } from '@/lib/admin/organizerTypes'

export type OrganizerStatusCode = 'ORGANIZER_SUSPENDED' | 'ORGANIZER_BANNED'

/**
 * The ONE thing a moderated organizer is told, by every enforcement point.
 *
 * RD-ORGANIZER-MODERATION-COVERAGE-14 — this used to be two different strings, one naming
 * suspension and one naming a ban, returned verbatim by 13 mutation routes. That told an
 * account which sanction it was under, while the workspace authorizers added in RD-12 were
 * deliberately refusing both identically. The lax surface decides what an attacker learns,
 * so the two are now the same sentence. `code` below still distinguishes them for server
 * logic; nothing outside this module reads it.
 */
export const MODERATION_DENIAL_MESSAGE =
  'This organizer account is restricted. Contact support if you believe this is an error.'

const MESSAGES: Record<OrganizerStatusCode, string> = {
  ORGANIZER_SUSPENDED: MODERATION_DENIAL_MESSAGE,
  ORGANIZER_BANNED:    MODERATION_DENIAL_MESSAGE,
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
  // RD-ORGANIZER-SIGNUP-02 · one resolver, so a 'pending' document reports 'pending'
  // instead of being flattened to 'active'. assertOrganizerActive below is deliberately
  // NOT widened: it blocks suspended and banned, and a pending signup is already unable
  // to reach any organizer route (verifyCaller refuses an unverified token). Adding a
  // third refusal here would be a new gate, not this phase's lifecycle change.
  return resolveAccountStatus((snap.data() as { accountStatus?: AccountStatus }).accountStatus)
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

// ═══ RD-ORGANIZER-MODERATION-COVERAGE-14 ═════════════════════════════════════
// One definition of "moderated", shared by the two enforcement points so they can
// never drift apart on what a sanction means:
//
//   • lib/team/access.verifyCaller  — the TOKEN seam. Checks the CALLER. Every
//     authenticated organizer route passes through it, so a route added tomorrow
//     inherits moderation without its author having to remember anything.
//   • lib/team/workspace            — the WORKSPACE authorizers. Also check the
//     workspace OWNER, the dimension a token cannot see, so suspending an owner
//     freezes the members they invited.
//
// Neither the set nor the predicate distinguishes suspended from banned: callers
// must treat the two identically so a denial never reveals which sanction applied.

/** The sanctions that stop an organizer from operating. */
export const MODERATED_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>(['suspended', 'banned'])

/**
 * Is this principal under moderation?
 *
 * Fail-open on a missing users/{uid} doc, exactly as getOrganizerAccountStatus
 * documents. That is what keeps this predicate safe at the token seam: a principal
 * that is not an organizer account — a staff credential, whose identity lives in
 * `staffAccounts`/`teamMembers` and which has no users/{uid} profile — reads as
 * active and is never blocked here. Same for a grandfathered organizer whose doc
 * predates accountStatus.
 */
export async function isModerated(uid: string): Promise<boolean> {
  return MODERATED_STATUSES.has(await getOrganizerAccountStatus(uid))
}
