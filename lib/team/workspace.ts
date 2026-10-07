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
import { permissionsForRole, isCheckinOnlyRole, isEventInScope, type TeamRole, type TeamPermission } from '@/lib/team/types'
import { isModerated, MODERATION_DENIAL_MESSAGE } from '@/lib/admin/organizerStatus'
import { readWorkspaceOwnerMarker } from '@/lib/organizer/identity'

export interface WorkspaceContext {
  callerUid:    string
  workspaceUid: string
  role:         TeamRole
  permissions:  TeamPermission[]
  isOwner:      boolean
  /** Events this caller may act on. [] = unrestricted for a PERSON. See requireEventScope. */
  eventIds:     string[]
  /**
   * RD-CHECKIN-11 — true when the grant behind this context is a gate CREDENTIAL
   * rather than a person who was invited to a team. An empty assignment on one of
   * those DENIES instead of widening; see isEventInScope for why the cases differ.
   */
  isStaffCredential: boolean
}

/**
 * Does this caller own a workspace with something IN it?
 *
 * ═══ WHY NOT `users/{uid}.role === 'organizer'` ══════════════════════════════
 * That was the first attempt and it was wrong, in a way only live data showed. Every
 * account created through the ordinary sign-in paths gets a users doc with
 * `role: 'organizer'` — createOrganizerProfile writes it, the verify-otp self-heal writes
 * it, and firestore.rules pins it. A gate operator who was invited to a team and then
 * signed in once has that row too.
 *
 * Measured on the two live check-in staff accounts: both carry
 * `users.role === 'organizer'` and own ZERO events. Keying ownership on the profile row
 * would have resolved both of them to their own empty workspace, silently cutting them off
 * from the event they are assigned to — trading a rare exposure bug for a certain outage.
 *
 * ═══ WHAT COUNTS AS EVIDENCE ═════════════════════════════════════════════════
 * RD-WORKSPACE-OWNERSHIP-01 replaced the inference with an explicit fact. Ownership is now
 * `users/{uid}.workspaceOwner`, written by the organizer profile-creation paths and never
 * for a gate credential.
 *
 * It had to be replaced. The previous rule was "an owned workspace is one that CONTAINS
 * something", evidenced by `users/{uid}/eventDrafts`. That is evidence of a USED workspace,
 * not of owning one, and it is false for precisely one account: a brand-new or freshly
 * re-registered organizer who has not created anything yet. Such an account holding any
 * active membership fell through to `memberships[0]` and was silently resolved into the
 * OTHER organizer's workspace under that membership's restricted role — which is how it
 * gets reported: "my new organizer account is missing features it should have".
 *
 * The draft read survives as the fallback for documents that predate the marker, so no
 * existing account changes resolution and no backfill is required. Both reads happen ONLY
 * in the ambiguous branch below; a caller with no memberships pays for neither.
 *
 * ═══ FAIL CLOSED ═════════════════════════════════════════════════════════════
 * An unreadable subcollection resolves the caller to THEMSELVES, never to a membership.
 * The two outcomes are not symmetric: resolving to self can only ever show a caller their
 * own data, while resolving to a membership on bad information can show them someone
 * else's. A transient read failure must not be able to open another organizer's workspace.
 */
async function ownsWorkspace(
  callerUid:   string,
  memberships: readonly { isStaffCredential: boolean }[],
): Promise<boolean> {
  // ═══ 0 · A GATE CREDENTIAL IS NEVER AN OWNER (RD-SEC-01) ═══════════════════
  // Checked BEFORE the marker. A staff credential never receives a profile from the server,
  // but the users CREATE rule lets a client write its own profile with `workspaceOwner: true`
  // (the signup page's orphan-recovery does exactly that when handed a staff login), which
  // turned a gate credential into the owner of its own workspace. `isStaffCredential` comes
  // from the reserved .invalid namespace on the membership row and cannot be forged; see step 2.
  if (memberships.some(m => m.isStaffCredential)) return false

  // ═══ 1 · THE EXPLICIT MARKER WINS (RD-WORKSPACE-OWNERSHIP-01) ══════════════
  // `workspaceOwner` is the positive fact this function used to have to guess at. It is
  // written only by the organizer profile-creation paths, never for a gate credential,
  // and firestore.rules forbids a client from changing it after create. A three-state
  // read: true/false are authoritative, null means the document predates the field.
  try {
    const snap = await adminDb.collection('users').doc(callerUid).get()
    const marker = readWorkspaceOwnerMarker(snap.data())
    if (marker !== null) return marker
  } catch {
    return true   // fail closed — towards self
  }

  // ═══ 2 · LEGACY DOCUMENT · positively identify a gate CREDENTIAL first ══════
  // Costs no read: `isStaffCredential` is derived from the reserved .invalid address
  // namespace on the membership row already in hand, and cannot be forged by a request.
  // A staff credential's uid is always minted by adminAuth.createUser inside
  // lib/staff/service.ts, so it can never coincide with an organizer's own uid — which
  // makes this a sound negative answer, and one that no longer depends on the account
  // happening to own zero drafts.
  if (memberships.some(m => m.isStaffCredential)) return false

  // ═══ 3 · LEGACY DOCUMENT · the original draft inference, retained verbatim ══
  // Deliberately unchanged, including its "no drafts ⇒ not an owner" outcome. Every
  // account created from now on carries the marker and never reaches this branch, so
  // widening it here would change the resolution of existing accounts for no gain —
  // and the fix for a legacy organizer is the marker (backfilled on their next email
  // verification), not a looser guess.
  try {
    const drafts = await adminDb.collection('users').doc(callerUid)
      .collection('eventDrafts').limit(1).get()
    return !drafts.empty
  } catch {
    return true   // fail closed — towards self
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
      permissions: permissionsForRole('owner'), isOwner: true, eventIds: [], isStaffCredential: false,
    }
  }

  // Ambiguous: the caller holds at least one membership. Ownership still wins. The profile
  // read happens ONLY here — a caller with no memberships never pays for it.
  //
  // `memberships` is passed in so ownership can be decided partly FROM them (a gate
  // credential identifies itself, see step 2 of ownsWorkspace) without a second query.
  if (await ownsWorkspace(callerUid, memberships)) {
    return {
      callerUid, workspaceUid: callerUid, role: 'owner',
      permissions: permissionsForRole('owner'), isOwner: true, eventIds: [], isStaffCredential: false,
    }
  }

  const m = memberships[0]
  return {
    callerUid, workspaceUid: m.organizerUid, role: m.role,
    permissions: permissionsForRole(m.role), isOwner: false, eventIds: m.eventIds,
    isStaffCredential: m.isStaffCredential,
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

// A denial carries no identity. `isStaffCredential: true` is the safe value for the
// placeholder: should a caller ever read scope off a denied context, an empty
// assignment must not read as unrestricted.
const denied = (status: number, error: string): WorkspaceAuthz => ({
  ok: false, status, error, callerUid: '', workspaceUid: '', role: 'owner', permissions: [], isOwner: false,
  eventIds: [], isStaffCredential: true,
})

// ═══ RD-ORGANIZER-MODERATION-ENFORCEMENT-12 · moderation is enforced HERE ══════
//
// Before this, suspending or banning an organizer did not stop them using the organizer
// APIs. The only mechanism was `setOrganizerAccountStatus` calling `revokeRefreshTokens`,
// which invalidates tokens issued BEFORE the revocation — but suspension does not disable
// the Auth user, so signing in again minted a perfectly valid token and every organizer
// endpoint answered 200. RD-ORGANIZER-LIFECYCLE-AUDIT-11 measured it: suspended and banned
// both returned 200 from /api/organizer/dashboard and /api/organizer/events.
//
// The check lives in the two top-level authorizers rather than in a route, because
// `authorizeEvent` and `authorizeWorkspaceDownload` both delegate to `authorizeWorkspace`
// — so one seam covers every organizer API instead of ~189 individual call sites.
//
// WHOSE status: the WORKSPACE OWNER's, and the CALLER's when they differ. Suspending an
// organizer freezes their workspace for their whole team, not just for them; and a
// suspended person must not keep acting inside somebody else's workspace either. The two
// reads are issued together, and for the common case (an owner acting on their own
// workspace) they collapse to one.
//
// WHICH statuses: suspended and banned only. `pending` is already refused upstream by
// `verifyCaller`, which rejects any token whose email is unverified — adding a second
// denial for it here would duplicate a working control. A MISSING accountStatus stays
// allowed: that is the grandfathering contract every pre-field organizer depends on, and
// `resolveAccountStatus` is the one place that decides it.
// RD-ORGANIZER-MODERATION-COVERAGE-14 — the set and the predicate now come from
// lib/admin/organizerStatus so this authorizer and the token seam in lib/team/access
// cannot disagree about what a sanction means.

/** The message is deliberately identical for suspended and banned: an account under
 *  moderation learns that it is restricted and who to talk to, never which sanction.
 *  Shared with the 13 mutation routes that guard via organizerStatusGuard, so the whole
 *  platform refuses a moderated organizer in the same words. */
const MODERATION_ERROR = MODERATION_DENIAL_MESSAGE

async function moderationBlocked(ctx: WorkspaceContext): Promise<boolean> {
  // BOTH subjects, still checked here rather than deferred to verifyCaller:
  //   • workspaceUid — suspending an owner must freeze the whole workspace, including
  //     members they invited. A token identifies the caller, never the workspace, so
  //     this dimension can only be enforced after resolveWorkspaceUid.
  //   • callerUid    — checked here too because these authorizers pass
  //     skipModeration to verifyCaller, trading its 401 for the specific 403 below.
  const uids = ctx.callerUid && ctx.callerUid !== ctx.workspaceUid
    ? [ctx.workspaceUid, ctx.callerUid]
    : [ctx.workspaceUid]

  return (await Promise.all(uids.map(isModerated))).some(Boolean)
}

/**
 * One-call route guard for workspace-scoped routes (lists, creates, subcollection
 * and `where`-based queries). Verifies the token, resolves the workspace, and
 * checks the permission. On success, use `authz.workspaceUid` as the owner uid.
 */
export async function authorizeWorkspace(req: Request, permission: TeamPermission): Promise<WorkspaceAuthz> {
  // skipModeration: moderationBlocked below is STRICTER (it also checks the workspace
  // owner) and answers 403 with a reason instead of a bare 401 — so the read there is
  // the one worth paying for. Route handlers must never pass this.
  const caller = await verifyCaller(req, { skipModeration: true })
  if (!caller) return denied(401, 'Unauthorized')
  const ctx = await resolveWorkspaceUid(caller.uid)
  if (await moderationBlocked(ctx)) {
    return { ...ctx, ok: false, status: 403, error: MODERATION_ERROR }
  }
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
  // skipModeration: moderationBlocked below is STRICTER (it also checks the workspace
  // owner) and answers 403 with a reason instead of a bare 401 — so the read there is
  // the one worth paying for. Route handlers must never pass this.
  const caller = await verifyCaller(req, { skipModeration: true })
  if (!caller) return denied(401, 'Unauthorized')
  const ctx = await resolveWorkspaceUid(caller.uid)
  if (await moderationBlocked(ctx)) {
    return { ...ctx, ok: false, status: 403, error: MODERATION_ERROR }
  }
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
