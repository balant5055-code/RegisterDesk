// Shared workspace resolution — the bridge that lets team members operate an
// owner's resources. Every organizer route resolves identity through here.
//
// The model: a caller acts inside exactly ONE workspace.
//   • Owner (no active memberships) → workspaceUid = callerUid.
//   • Team member                   → workspaceUid = the owner's organizerUid.
//
// Routes then use workspaceUid wherever they used to use the raw uid for
// ownership (subcollection paths, `where('organizerUid','==',…)`, resource
// `organizerUid` comparisons). For owners nothing changes; for members it
// transparently scopes to the owner's data — gated by the permission check.

import { verifyCaller, requirePermission, activeMemberships, type AccessResult } from '@/lib/team/access'
import { adminDb } from '@/lib/firebase/admin'
import { isOrganizer } from '@/lib/organizer/identity'
import { permissionsForRole, isCheckinOnlyRole, isEventInScope, type TeamRole, type TeamPermission } from '@/lib/team/types'

export interface WorkspaceContext {
  callerUid:    string
  workspaceUid: string
  role:         TeamRole
  permissions:  TeamPermission[]
  isOwner:      boolean
  /** Events this caller may act on. [] = unrestricted. See requireEventScope. */
  eventIds:     string[]
}

/**
 * Does this caller own a workspace of their own?
 *
 * `users/{uid}.role === 'organizer'` is the ONE canonical definition of an organizer
 * account (lib/organizer/identity.ts) — written by createOrganizerProfile, self-healed by
 * verify-otp, and pinned by firestore.rules. Reused here rather than re-derived, so this
 * cannot drift from the admin counts and listings that already depend on it.
 *
 * Read ONLY in the ambiguous case below, so the common paths pay nothing for it.
 */
async function ownsWorkspace(callerUid: string): Promise<boolean> {
  try {
    const snap = await adminDb.collection('users').doc(callerUid).get()
    return snap.exists && isOrganizer(snap.data())
  } catch {
    // FAIL CLOSED TOWARDS SELF. An unreadable profile must not be read as "not an owner",
    // because that is precisely the branch that would hand this caller someone else's
    // workspace. Treating it as ownership resolves them to their own data — which is, at
    // worst, empty.
    return true
  }
}

/**
 * Resolves which workspace the caller is acting in.
 *
 *   • Owner (no memberships)            → their own workspace
 *   • Team member                       → the owner's workspace
 *   • Owner who ALSO holds a membership → their OWN workspace
 *
 * ═══ THE DEFECT THIS FIXES ═══════════════════════════════════════════════════
 * This used to take `memberships[0]` whenever any membership existed, on the stated
 * assumption that "owners have no member row". That was an assumption, not an enforced
 * invariant: nothing stops an organizer being invited into someone else's team. When it
 * happened, an owner's every request silently resolved to the OTHER organizer's workspace —
 * and because `workspaceUid` is what routes feed into `where('organizerUid','==',…)`, they
 * read that organizer's data under their own login.
 *
 * Harmless-looking on a settings page. Not harmless on a surface that reconciles captured
 * payments, which is why it is fixed before that surface exists rather than after.
 *
 * ═══ WHY OWNERSHIP WINS, AND WHY THAT DIRECTION IS THE SAFE ONE ══════════════
 * Resolving to SELF can only ever show a caller their own data. Resolving to a membership
 * can show them someone else's. When the two are ambiguous the tie must break towards self,
 * because the failure modes are not symmetric: the cost of being wrong here is an owner
 * seeing their own (possibly empty) workspace instead of one they were invited to — a
 * functionality gap a workspace switcher closes later — versus cross-organizer exposure,
 * which no later feature can undo.
 *
 * The single-active-workspace model is otherwise unchanged; no permission, role or matrix
 * behaviour is touched.
 */
export async function resolveWorkspaceUid(callerUid: string): Promise<WorkspaceContext> {
  const memberships = await activeMemberships(callerUid)
  if (memberships.length === 0) {
    return {
      callerUid, workspaceUid: callerUid, role: 'owner',
      permissions: permissionsForRole('owner'), isOwner: true, eventIds: [],
    }
  }

  // Ambiguous: the caller holds at least one membership. Ownership still wins. The profile
  // read happens ONLY here — a caller with no memberships never pays for it.
  if (await ownsWorkspace(callerUid)) {
    return {
      callerUid, workspaceUid: callerUid, role: 'owner',
      permissions: permissionsForRole('owner'), isOwner: true, eventIds: [],
    }
  }

  const m = memberships[0]
  return {
    callerUid, workspaceUid: m.organizerUid, role: m.role,
    permissions: permissionsForRole(m.role), isOwner: false, eventIds: m.eventIds,
  }
}

/**
 * Resource-level authorization: the caller may act on a resource owned by
 * `resourceOrganizerUid` only if they are that workspace's owner or an active
 * member with the permission. Delegates entirely to requirePermission so the
 * matrix stays the single source of truth.
 */
export async function requireResourcePermission(
  callerUid: string, resourceOrganizerUid: string, permission: TeamPermission,
): Promise<AccessResult> {
  return requirePermission(callerUid, resourceOrganizerUid, permission)
}

// ─── Route-level convenience wrappers ────────────────────────────────────────

export interface WorkspaceAuthz extends WorkspaceContext {
  ok:     boolean
  status: number
  error:  string            // '' when ok; a message when !ok (always a string for route typing)
}

const denied = (status: number, error: string): WorkspaceAuthz => ({
  ok: false, status, error, callerUid: '', workspaceUid: '', role: 'owner', permissions: [], isOwner: false, eventIds: [],
})

/**
 * One-call route guard for workspace-scoped routes (lists, creates, subcollection
 * and `where`-based queries). Verifies the token, resolves the workspace, and
 * checks the permission. On success, use `authz.workspaceUid` as the owner uid.
 */
export async function authorizeWorkspace(req: Request, permission: TeamPermission): Promise<WorkspaceAuthz> {
  const caller = await verifyCaller(req)
  if (!caller) return denied(401, 'Unauthorized')
  const ctx = await resolveWorkspaceUid(caller.uid)
  if (!ctx.permissions.includes(permission)) {
    return { ...ctx, ok: false, status: 403, error: `Missing required permission: ${permission}.` }
  }
  return { ...ctx, ok: true, status: 200, error: '' }
}

/**
 * Like authorizeWorkspace but for routes that need workspace context WITHOUT a
 * specific permission (e.g. the dashboard aggregate). Any active member of the
 * workspace — or the owner — passes.
 *
 * RD-CHECKIN-STAFF-01: "any member" deliberately EXCLUDES gate-only roles. A
 * permissionless surface is still an organizer surface, and a role whose entire
 * grant is `checkin` has no business reading workspace aggregates. Roles that hold
 * any other permission are unaffected.
 */
export async function authorizeAnyWorkspace(req: Request): Promise<WorkspaceAuthz> {
  const caller = await verifyCaller(req)
  if (!caller) return denied(401, 'Unauthorized')
  const ctx = await resolveWorkspaceUid(caller.uid)
  if (!ctx.isOwner && isCheckinOnlyRole(ctx.role)) {
    return { ...ctx, ok: false, status: 403, error: 'This account is limited to event check-in.' }
  }
  return { ...ctx, ok: true, status: 200, error: '' }
}

/**
 * Event-scoped authorization for gate operations.
 *
 * Runs the ordinary workspace + permission check, then confirms the caller may act
 * on THIS event. `eventId` must come from the route path (a server-controlled
 * value), never from a request body the operator can edit.
 *
 * Scope is enforced only for gate-only roles: broader roles already hold
 * workspace-wide permissions and can reach the same event through the organizer
 * surfaces, so narrowing them here would be a false promise rather than a control.
 *
 * An empty `eventIds` means unrestricted — the implicit state of every member row
 * written before event assignment existed, so this is backward-compatible.
 */
export async function authorizeEvent(
  req: Request, permission: TeamPermission, eventId: string,
): Promise<WorkspaceAuthz> {
  const authz = await authorizeWorkspace(req, permission)
  if (!authz.ok) return authz
  if (!requireEventScope(authz, eventId)) {
    // Deliberately the same message and status as an unassigned event would give,
    // so a probing operator cannot use the response to enumerate which events exist.
    return { ...authz, ok: false, status: 403, error: 'You are not assigned to this event.' }
  }
  return authz
}

/**
 * Scope predicate for a resolved workspace context.
 *
 * A thin adapter over the pure rule in lib/team/types.ts — the rule itself lives
 * there because this module imports the Admin SDK transitively, which would make
 * the rule untestable in the repo's node-environment vitest run.
 */
export function requireEventScope(ctx: WorkspaceContext, eventId: string): boolean {
  return isEventInScope(ctx, eventId)
}

/**
 * Download-friendly variant of authorizeWorkspace. Identical guarantees (same
 * verifyCaller email-verification gate, same workspace + permission resolution),
 * but the Firebase ID token may arrive in a `?token=` query param instead of the
 * Authorization header — required for `<a download>` / new-tab navigations that
 * cannot set request headers. Prefers the header when both are present. Reuses
 * authorizeWorkspace so the authorization flow stays single-sourced.
 */
export async function authorizeWorkspaceDownload(req: Request, permission: TeamPermission): Promise<WorkspaceAuthz> {
  const headerToken = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const queryToken  = new URL(req.url).searchParams.get('token') ?? ''
  const token = headerToken || queryToken
  const authedReq = token
    ? new Request(req.url, { headers: { Authorization: `Bearer ${token}` } })
    : req
  return authorizeWorkspace(authedReq, permission)
}
