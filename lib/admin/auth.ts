// Server-only. Verifies that a decoded token belongs to a platform admin.
//
// Admin identity is resolved via two mechanisms (either is sufficient):
//   1. Firebase custom claim:  { admin: true }
//      Set with: adminAuth.setCustomUserClaims(uid, { admin: true })
//   2. ADMIN_UIDS env var: comma-separated list of Firebase UIDs in .env.local
//      e.g. ADMIN_UIDS=uid1,uid2
//
// To bootstrap without custom claims, add the admin UID to ADMIN_UIDS.

import { adminAuth }        from '@/lib/firebase/admin'
import type { DecodedIdToken } from 'firebase-admin/auth'

function isAdminUid(uid: string): boolean {
  const raw = process.env.ADMIN_UIDS ?? ''
  return raw.split(',').map(u => u.trim()).filter(Boolean).includes(uid)
}

export async function resolveAdminUid(
  authHeader: string | null,
): Promise<string | null> {
  const token = (authHeader ?? '').replace('Bearer ', '').trim()
  if (!token) return null

  let decoded: DecodedIdToken
  // checkRevoked:true rejects a revoked/disabled admin session within the token
  // window (reuses Firebase Admin SDK; same posture as the organizer path).
  try { decoded = await adminAuth.verifyIdToken(token, true) }
  catch { return null }

  if (decoded.admin === true) return decoded.uid
  if (isAdminUid(decoded.uid)) return decoded.uid

  return null
}

/**
 * MC-09 · The narrower of the two admin mechanisms, for actions that CREATE value.
 *
 * `resolveAdminUid` accepts either the `admin: true` claim or `ADMIN_UIDS`. This accepts
 * only the second. That is a real distinction rather than a label: the claim is data in
 * Firebase and can be set by anything holding admin credentials, whereas `ADMIN_UIDS` is
 * deployment configuration and changing it requires a deploy. Minting credits out of nothing
 * is the one Media Credits operation with no counterparty — no payment, no refund request —
 * so it is gated on the mechanism that a compromised admin session cannot widen.
 *
 * Deliberately NOT a new role, claim or permission matrix: it composes the two checks that
 * already exist. Every other admin route keeps using `resolveAdminUid` unchanged.
 */
export async function resolveSuperAdminUid(
  authHeader: string | null,
): Promise<string | null> {
  const uid = await resolveAdminUid(authHeader)
  // Re-checked against the env var, not inferred from how the token passed above.
  return uid && isAdminUid(uid) ? uid : null
}
