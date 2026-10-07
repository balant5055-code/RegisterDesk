// Server-only. Verifies that a decoded token belongs to a platform admin.
//
// RD-SEC-01 · There are exactly two roles: Organizer and Super Admin. Super Admin identity is
// ADMIN_UIDS (deployment configuration, comma-separated Firebase UIDs) and NOTHING else. The legacy
// `admin: true` custom claim, `isAdmin`, `role` and every profile field grant no admin access —
// a claim-only caller is refused like any organizer (legacyAdminClaimOnly only picks its message).

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

  return isAdminUid(decoded.uid) ? decoded.uid : null
}

/**
 * RD-SEC-01 · Diagnostics only — NEVER an authorization input. True when the caller holds the
 * legacy `admin: true` claim but is not in ADMIN_UIDS, so a refusal can say "Super Admin required"
 * instead of a bare Forbidden. Grants nothing.
 */
export async function legacyAdminClaimOnly(authHeader: string | null): Promise<boolean> {
  const token = (authHeader ?? '').replace('Bearer ', '').trim()
  if (!token) return false
  try {
    const decoded = await adminAuth.verifyIdToken(token, true)
    return decoded.admin === true && !isAdminUid(decoded.uid)
  } catch { return false }
}

/**
 * MC-09 · Super Admin (ADMIN_UIDS). Since RD-SEC-01 `resolveAdminUid` is ADMIN_UIDS-only too, so
 * the two are equivalent; the explicit re-check stays so that a future widening of
 * `resolveAdminUid` can never silently widen the financial routes with it.
 */
export async function resolveSuperAdminUid(
  authHeader: string | null,
): Promise<string | null> {
  const uid = await resolveAdminUid(authHeader)
  // Re-checked against the env var, not inferred from how the token passed above.
  return uid && isAdminUid(uid) ? uid : null
}
