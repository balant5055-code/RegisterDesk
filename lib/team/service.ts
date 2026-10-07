// Team management business logic. Routes stay thin and call these functions;
// they never query teamMembers or build permissions directly.
//
// ═══ THE INVITATION PATH IS GONE (RD-TEAM-IMPL-01) ═══════════════════════════
// `inviteMember` and `acceptInvite` lived here and were the only way a row entered
// `teamMembers` by email. RegisterDesk now issues gate credentials directly
// (lib/staff/service.ts), so there is no invitation, no token, no acceptance and no
// mail. Nothing in this file can create a member row any more.
//
// What remains is deliberate: `teamMembers` is still the authorization substrate —
// the staff path writes it, every organizer route reads it — and rows created by the
// old flow are still live grants. `listTeam`, `changeRole`, `setMemberStatus` and
// `removeMember` therefore stay, so an organizer can still see and retire the people
// they invited before this change. They operate on EXISTING rows only.

import { FieldValue }   from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'
import { logTeamAction } from '@/lib/team/audit'
import { isStaffEmail } from '@/lib/staff/types'
import {
  TEAM_COLLECTION, permissionsForRole, isAssignableRole, sanitizeEventIds,
  type TeamRole, type TeamMemberDocument, type TeamMemberView,
} from '@/lib/team/types'

// ─── Result type ────────────────────────────────────────────────────────────

export type ServiceResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): ServiceResult<never> => ({ ok: false, status, error })

// ─── Helpers ────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function toView(doc: TeamMemberDocument): TeamMemberView {
  return {
    id:          doc.id,
    memberUid:   doc.memberUid,
    email:       doc.email,
    role:        doc.role,
    permissions: permissionsForRole(doc.role),
    // [] = every event in the workspace. Normalised here rather than at every call
    // site so a row written before event assignment existed reads as unrestricted.
    eventIds:    Array.isArray(doc.eventIds) ? doc.eventIds.filter(e => typeof e === 'string') : [],
    status:      doc.status,
    invitedAt:   tsToISO(doc.invitedAt),
    acceptedAt:  tsToISO(doc.acceptedAt),
  }
}

/**
 * RD-CHECKIN-2.0 — a member row created by the STAFF ACCOUNT flow, not by an email
 * invite.
 *
 * Staff rows live in the same collection on purpose (one authorization model, one
 * matrix, one scope check), but they are owned by lib/staff/service.ts, which also
 * owns a Firebase Auth user, a username lock and a profile document. Editing or
 * deleting one through the email-invite routes would update the grant and orphan
 * the other three — a credential that still signs in with no workspace behind it.
 *
 * Derived from the reserved address namespace rather than a stored flag, so it
 * cannot be forged by a request and cannot drift out of sync with reality.
 */
const isStaffRow = (email: string): boolean => isStaffEmail(email)

const STAFF_ROW_REFUSAL = 'This is a staff account. Manage it from Staff Accounts.'

// ─── List ───────────────────────────────────────────────────────────────────

/**
 * The LEGACY members of a workspace — people invited by email before
 * RD-TEAM-IMPL-01 removed that flow.
 *
 * Bounded: a single equality served by the automatic index, capped at
 * MAX_LEGACY_MEMBERS. This list can only ever shrink now (nothing creates a row
 * here any more), so the cap is a safety rail rather than pagination.
 *
 * Two exclusions, for different reasons:
 *   • STAFF rows — they own a credential and a username lock as well as a grant, so
 *     they are presented and revoked on the staff surface. Removing one from here
 *     would delete half an account. See isStaffRow.
 *   • `status: 'invited'` rows — an unaccepted invitation has `memberUid: null` and
 *     grants nothing (resolveTeamAccess requires 'active'). With no acceptance route
 *     left they can never become active, so showing them would offer the organizer
 *     an action that cannot complete. The documents are left untouched in Firestore.
 */
export const MAX_LEGACY_MEMBERS = 200

export async function listTeam(organizerUid: string): Promise<{ members: TeamMemberView[] }> {
  const snap = await adminDb.collection(TEAM_COLLECTION)
    .where('organizerUid', '==', organizerUid)
    .limit(MAX_LEGACY_MEMBERS + 1)
    .get()
  const all = snap.docs
    .map(d => toView({ ...(d.data() as TeamMemberDocument), id: d.id }))
    .filter(m => !isStaffRow(m.email))
  all.sort((a, b) => (b.invitedAt ?? '').localeCompare(a.invitedAt ?? ''))
  return {
    members: all.filter(m => m.status === 'active' || m.status === 'suspended'),
  }
}

// ─── Change role ──────────────────────────────────────────────────────────────

export async function changeRole(args: {
  organizerUid: string; ownerUid: string; memberId: string; role: string
  /** RD-CHECKIN-STAFF-01 — when provided, replaces the event assignment. Omit to leave it as-is. */
  eventIds?: unknown
}): Promise<ServiceResult<TeamMemberView>> {
  if (!isAssignableRole(args.role)) return fail(400, 'Invalid role.')
  const ref  = adminDb.collection(TEAM_COLLECTION).doc(args.memberId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Team member not found.')
  const m = snap.data() as TeamMemberDocument
  if (m.organizerUid !== args.organizerUid) return fail(404, 'Team member not found.')
  if (isStaffRow(m.email)) return fail(409, STAFF_ROW_REFUSAL)

  // Absent means "don't touch the assignment"; [] means "all events". These are
  // deliberately different, so an unrelated role change cannot silently widen a
  // gate operator's scope from one event to the whole workspace.
  const nextEventIds = args.eventIds === undefined ? undefined : sanitizeEventIds(args.eventIds)
  if (nextEventIds === null) return fail(400, 'Invalid event assignment.')

  const role = args.role as TeamRole
  await ref.update({
    role,
    permissions: permissionsForRole(role),
    ...(nextEventIds !== undefined ? { eventIds: nextEventIds } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  })

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: 'team.role_changed', memberId: args.memberId, metadata: { from: m.role, to: role },
  }).catch(() => { /* best-effort */ })

  return {
    ok: true,
    data: toView({
      ...m, id: args.memberId, role, permissions: permissionsForRole(role),
      eventIds: nextEventIds ?? m.eventIds,
    }),
  }
}

// ─── Suspend / reactivate ──────────────────────────────────────────────────────

export async function setMemberStatus(args: {
  organizerUid: string; ownerUid: string; memberId: string; status: 'active' | 'suspended'
}): Promise<ServiceResult<TeamMemberView>> {
  const ref  = adminDb.collection(TEAM_COLLECTION).doc(args.memberId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Team member not found.')
  const m = snap.data() as TeamMemberDocument
  if (m.organizerUid !== args.organizerUid) return fail(404, 'Team member not found.')
  if (isStaffRow(m.email)) return fail(409, STAFF_ROW_REFUSAL)
  if (m.status === 'invited') return fail(409, 'Pending invitations cannot be suspended.')

  await ref.update({ status: args.status, updatedAt: FieldValue.serverTimestamp() })

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: args.status === 'suspended' ? 'team.suspended' : 'team.reactivated',
    memberId: args.memberId, metadata: { from: m.status, to: args.status },
  }).catch(() => { /* best-effort */ })

  return { ok: true, data: toView({ ...m, id: args.memberId, status: args.status }) }
}

// ─── Remove ─────────────────────────────────────────────────────────────────

export async function removeMember(args: {
  organizerUid: string; ownerUid: string; callerUid: string; memberId: string
}): Promise<ServiceResult> {
  const ref  = adminDb.collection(TEAM_COLLECTION).doc(args.memberId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Team member not found.')
  const m = snap.data() as TeamMemberDocument
  if (m.organizerUid !== args.organizerUid) return fail(404, 'Team member not found.')
  if (isStaffRow(m.email)) return fail(409, STAFF_ROW_REFUSAL)
  // Owner can never remove themselves (defensive — the owner has no member row).
  if (m.memberUid && m.memberUid === args.callerUid) return fail(400, 'You cannot remove yourself.')

  await ref.delete()

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: 'team.removed', memberId: args.memberId, metadata: { email: m.email, role: m.role },
  }).catch(() => { /* best-effort */ })

  return { ok: true, data: undefined }
}
