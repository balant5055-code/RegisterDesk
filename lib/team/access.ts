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
// A pure leaf module (no imports of its own), so this adds no cycle.
import { STAFF_COLLECTION, isStaffEmail } from '@/lib/staff/types'
// Imports only adminDb and the pure organizerTypes leaf — no cycle back to lib/team.
import { isModerated } from '@/lib/admin/organizerStatus'

export interface CallerAccess {
  role:        TeamRole
  permissions: TeamPermission[]
  isOwner:     boolean
  /**
   * Events this member may act on. EMPTY = unrestricted (every event in the
   * workspace) — the implicit behaviour of every member row created before event
   * assignment existed, and always the case for owners.
   *
   * Enforced by requireEventScope() for gate-only roles; see lib/team/types.ts.
   */
  eventIds:    string[]
}

export interface AccessResult {
  ok:          boolean
  status:      number            // suggested HTTP status when !ok
  reason:      string
  access?:     CallerAccess
}

const FORBIDDEN = (reason: string): AccessResult => ({ ok: false, status: 403, reason })

export interface VerifyCallerOptions {
  /**
   * Skip the organizer-moderation read.
   *
   * ONLY for callers that run their own, STRICTER moderation check. Today that is
   * exactly the two authorizers in lib/team/workspace — they additionally inspect the
   * workspace OWNER (which a token cannot identify) and answer with a specific 403
   * instead of this function's 401, so re-reading the caller here would be a wasted
   * Firestore read and would replace the better denial with a worse one.
   *
   * Never set this in a route handler. Doing so silently removes that route from
   * moderation coverage, and tests/emulator/organizerModerationCoverage.emu.test.ts
   * will fail the route for it.
   */
  skipModeration?: boolean
}

/**
 * Verifies a Firebase ID token from the Authorization header.
 * Returns { uid, email } or null. Centralized so routes stop re-implementing it.
 */
export async function verifyCaller(
  req: Request,
  opts: VerifyCallerOptions = {},
): Promise<{ uid: string; email: string | null } | null> {
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

    // ═══ RD-ORGANIZER-MODERATION-COVERAGE-14 · moderation lives HERE ══════════
    // checkRevoked above only stops tokens minted BEFORE the sanction. A suspended
    // organizer can sign in again and mint a fresh one, so revocation alone is not
    // enforcement — RD-13 measured 14 organizer routes answering 200 to a suspended
    // account for exactly that reason.
    //
    // This is the one seam all of them share: those routes call verifyCaller and then
    // go straight to their own logic, never through lib/team/workspace's authorizers.
    // Putting the check here means the coverage is structural — a route added next
    // month is gated because it authenticates, not because its author remembered.
    //
    // Safe for non-organizer principals: isModerated fail-opens on a missing
    // users/{uid} doc, so staff credentials (identity in staffAccounts/teamMembers)
    // and grandfathered organizers read as active. Admin routes never reach this
    // function at all — lib/admin/auth.resolveAdminUid verifies tokens itself.
    //
    // Returns null (→ each route's existing 401) rather than a distinct status: the
    // `| null` contract is shared by 41 call sites across five domains, and widening
    // it to carry a reason would be a far larger change than this defect warrants.
    // The authorizer path keeps its specific 403 via skipModeration.
    if (!opts.skipModeration && await isModerated(decoded.uid)) return null

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
    return { role: 'owner', permissions: permissionsForRole('owner'), isOwner: true, eventIds: [] }
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
  // `eventIds` is the mirror image: it can only NARROW access, so the stored value
  // is honoured as written, and a missing / malformed field degrades to [] —
  // exactly the unrestricted behaviour every row had before this field existed.
  return {
    role:        m.role,
    permissions: permissionsForRole(m.role),
    isOwner:     false,
    eventIds:    Array.isArray(m.eventIds) ? m.eventIds.filter(e => typeof e === 'string') : [],
  }
}

export function requireOwner(callerUid: string, organizerUid: string): AccessResult {
  if (callerUid !== organizerUid) return FORBIDDEN('Only the account owner can perform this action.')
  return { ok: true, status: 200, reason: 'owner', access: { role: 'owner', permissions: permissionsForRole('owner'), isOwner: true, eventIds: [] } }
}

// Wording covers every call site: issuing a staff credential and inviting a team
// member are both "managing who can get into this workspace".
export const STAFF_CREDENTIAL_REFUSAL =
  'A staff account cannot manage workspace access.'

/**
 * Is this authenticated identity a GATE CREDENTIAL rather than a person with a
 * workspace?
 *
 * Settled two ways, because neither alone is enough:
 *   • the reserved `.invalid` address namespace — free, needs no read, and is the
 *     same rule lib/team/service.ts already uses to keep staff rows off the team
 *     surface;
 *   • the `staffAccounts/{uid}` profile — authoritative, written only by
 *     lib/staff/service.ts through the Admin SDK and denied to the client SDK, so it
 *     still holds if a token's email were ever changed out of the namespace.
 *
 * The address is checked first so the common organizer case costs nothing.
 */
export async function isStaffCredential(caller: { uid: string; email: string | null }): Promise<boolean> {
  if (isStaffEmail(caller.email)) return true
  const snap = await adminDb.collection(STAFF_COLLECTION).doc(caller.uid).get()
  return snap.exists
}

/**
 * May this caller perform an OWNER action on their own workspace?
 *
 * ═══ WHY THIS EXISTS (RD-CHECKIN-07 Defect 1, RD-CHECKIN-09) ═════════════════
 * The surfaces that grant workspace access — issuing a staff credential, inviting a
 * team member — deliberately never take the workspace from the request; it is always
 * `caller.uid`, which is what kept both defects from being cross-tenant. But the
 * ownership check they paired with that was `requireOwner(caller.uid, caller.uid)`,
 * whose two arguments are the same value, so it is true for EVERY authenticated
 * identity and authorized nothing at all.
 *
 * The rule that was missing is not "which workspace" but "is this caller entitled to
 * grant access at all". A staff account is a way INTO a workspace, not a person who
 * owns one, so it is refused here; every other authenticated identity manages its own
 * workspace exactly as before.
 *
 * ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
 * Not a licence check and not a role matrix. It answers one question — is the caller
 * a credential — and leaves entitlement, rate limiting and business rules to the
 * gates that already own them. In particular it must not be confused with the plan
 * gate on the invite route: a 402 means "authorized but unpaid", which is a different
 * statement from "not allowed", and only one of them is authorization.
 */
export async function requireWorkspaceOwner(
  caller: { uid: string; email: string | null },
): Promise<AccessResult> {
  if (await isStaffCredential(caller)) return FORBIDDEN(STAFF_CREDENTIAL_REFUSAL)
  return requireOwner(caller.uid, caller.uid)
}

/**
 * Staff-account management (RD-CHECKIN-08 Defect 1). Named for its call site; the
 * rule is `requireWorkspaceOwner`, kept in one place so the two access-granting
 * surfaces cannot drift apart.
 */
export async function requireStaffManager(
  caller: { uid: string; email: string | null },
): Promise<AccessResult> {
  return requireWorkspaceOwner(caller)
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
export async function activeMemberships(
  callerUid: string,
): Promise<Array<{ organizerUid: string; role: TeamRole; eventIds: string[]; isStaffCredential: boolean }>> {
  const snap = await adminDb.collection(TEAM_COLLECTION)
    .where('memberUid', '==', callerUid)
    .where('status', '==', 'active')
    .get()
  return snap.docs.map(d => {
    const m = d.data() as TeamMemberDocument
    return {
      organizerUid: m.organizerUid,
      role:         m.role,
      eventIds:     Array.isArray(m.eventIds) ? m.eventIds.filter(e => typeof e === 'string') : [],
      // RD-CHECKIN-11 — is this grant a GATE CREDENTIAL rather than a person?
      // Derived from the reserved address namespace, which is the same rule
      // lib/team/service.ts already uses to keep staff rows off the team surface:
      // it costs no extra read (the document is in hand) and cannot be forged by a
      // request. It decides one thing only — whether an EMPTY assignment may be
      // read as "unrestricted". See isEventInScope.
      isStaffCredential: isStaffEmail(m.email),
    }
  })
}
