// Team access enforcement — the SINGLE place permission logic lives.
//
// Organizer routes must NOT hard-code role/ownership checks. They resolve the
// caller's effective access against a workspace (an organizerUid) through the
// helpers here:
//
//   requireOwner(caller, organizerUid)            — only the account owner
//   requireAdmin(caller, organizerUid)            — owner or admin
//   requirePermission(caller, organizerUid, perm) — owner or member with perm
//
// The account owner is the organizer whose uid IS the workspace id; team members
// are rows in `teamMembers`. Permissions are always re-derived from the member's
// role (the matrix is the source of truth) — a stale stored permission array can
// never grant more than the role allows.

import { adminAuth, adminDb } from '@/lib/firebase/admin'
import {
  TEAM_COLLECTION, permissionsForRole,
  type TeamRole, type TeamPermission, type TeamMemberDocument,
} from '@/lib/team/types'

export interface CallerAccess {
  role:        TeamRole
  permissions: TeamPermission[]
  isOwner:     boolean
}

export interface AccessResult {
  ok:          boolean
  status:      number            // suggested HTTP status when !ok
  reason:      string
  access?:     CallerAccess
}

const FORBIDDEN = (reason: string): AccessResult => ({ ok: false, status: 403, reason })

/**
 * Verifies a Firebase ID token from the Authorization header.
 * Returns { uid, email } or null. Centralized so routes stop re-implementing it.
 */
export async function verifyCaller(req: Request): Promise<{ uid: string; email: string | null } | null> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null
  try {
    // checkRevoked:true so a suspended/banned/deleted organizer (whose refresh
    // tokens were revoked via revokeRefreshTokens in setOrganizerAccountStatus) —
    // or a disabled Auth account — is rejected within the token window instead of
    // retaining access until the ~1h ID-token expiry. Throws on revoked/disabled.
    const decoded = await adminAuth.verifyIdToken(token, true)
    // Server-side email-verification gate. The dashboard redirects unverified
    // organizers to /verify-email, but that is UI, not a security control — every
    // organizer API authorizes through here, so an unverified token (e.g. a freshly
    // signed-up account that never completed OTP) must be rejected before it can
    // publish an event or collect payments. `emailVerified` is flipped to true by
    // POST /api/auth/verify-otp (adminAuth.updateUser), and the OTP routes verify
    // tokens directly (not via verifyCaller), so verification is never deadlocked.
    if (decoded.email_verified !== true) return null
    return { uid: decoded.uid, email: decoded.email ?? null }
  } catch {
    return null
  }
}

/**
 * Resolves the caller's effective access within a workspace.
 *   • caller === organizerUid → implicit owner, full access.
 *   • active team member       → role + matrix permissions.
 *   • suspended / invited / absent → null (no access).
 */
export async function resolveTeamAccess(callerUid: string, organizerUid: string): Promise<CallerAccess | null> {
  if (callerUid === organizerUid) {
    return { role: 'owner', permissions: permissionsForRole('owner'), isOwner: true }
  }
  const snap = await adminDb.collection(TEAM_COLLECTION)
    .where('organizerUid', '==', organizerUid)
    .where('memberUid', '==', callerUid)
    .where('status', '==', 'active')
    .limit(1)
    .get()
  if (snap.empty) return null
  const m = snap.docs[0].data() as TeamMemberDocument
  // Re-derive from role — never trust a stored permissions array to widen scope.
  return { role: m.role, permissions: permissionsForRole(m.role), isOwner: false }
}

export function requireOwner(callerUid: string, organizerUid: string): AccessResult {
  if (callerUid !== organizerUid) return FORBIDDEN('Only the account owner can perform this action.')
  return { ok: true, status: 200, reason: 'owner', access: { role: 'owner', permissions: permissionsForRole('owner'), isOwner: true } }
}

export async function requireAdmin(callerUid: string, organizerUid: string): Promise<AccessResult> {
  const access = await resolveTeamAccess(callerUid, organizerUid)
  if (!access) return FORBIDDEN('You do not have access to this workspace.')
  if (access.isOwner || access.role === 'admin') return { ok: true, status: 200, reason: 'admin', access }
  return FORBIDDEN('Administrator access is required.')
}

export async function requirePermission(
  callerUid: string, organizerUid: string, permission: TeamPermission,
): Promise<AccessResult> {
  const access = await resolveTeamAccess(callerUid, organizerUid)
  if (!access) return FORBIDDEN('You do not have access to this workspace.')
  if (access.permissions.includes(permission)) return { ok: true, status: 200, reason: permission, access }
  return FORBIDDEN(`Missing required permission: ${permission}.`)
}

/**
 * All workspaces the caller actively belongs to (excludes their own). Lets
 * resource routes discover which owner's data a team member may act upon.
 */
export async function activeMemberships(callerUid: string): Promise<Array<{ organizerUid: string; role: TeamRole }>> {
  const snap = await adminDb.collection(TEAM_COLLECTION)
    .where('memberUid', '==', callerUid)
    .where('status', '==', 'active')
    .get()
  return snap.docs.map(d => {
    const m = d.data() as TeamMemberDocument
    return { organizerUid: m.organizerUid, role: m.role }
  })
}
