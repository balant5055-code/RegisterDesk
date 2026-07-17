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
