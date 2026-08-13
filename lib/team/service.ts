// Team management business logic. Routes stay thin and call these functions;
// they never query teamMembers or build permissions directly.

import { randomBytes, createHash } from 'crypto'
import { FieldValue }              from 'firebase-admin/firestore'
import { adminDb }                 from '@/lib/firebase/admin'
import { APP_URL }                 from '@/lib/env'
import { notificationEngine, NotificationType } from '@/lib/notifications'
import { teamInviteTemplate }      from '@/lib/email/templates/team-invite'
import { logTeamAction }           from '@/lib/team/audit'
import {
  TEAM_COLLECTION, INVITE_TTL_MS, permissionsForRole, isAssignableRole,
  type TeamRole, type TeamMemberDocument, type TeamMemberView, type TeamStatus,
} from '@/lib/team/types'

// ─── Result type ────────────────────────────────────────────────────────────

export type ServiceResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): ServiceResult<never> => ({ ok: false, status, error })

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// Deterministic doc id per (workspace, email) so a duplicate invite cannot
// create a second row — the second write collides on the same id.
function memberId(organizerUid: string, email: string): string {
  return createHash('sha256').update(`${organizerUid}:${email}`).digest('hex').slice(0, 32)
}

function toView(doc: TeamMemberDocument): TeamMemberView {
  return {
    id:          doc.id,
    memberUid:   doc.memberUid,
    email:       doc.email,
    role:        doc.role,
    permissions: permissionsForRole(doc.role),
    status:      doc.status,
    invitedAt:   tsToISO(doc.invitedAt),
    acceptedAt:  tsToISO(doc.acceptedAt),
  }
}

const ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager',
  checkin_staff: 'Check-in Staff', finance: 'Finance',
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listTeam(organizerUid: string): Promise<{ members: TeamMemberView[]; invites: TeamMemberView[] }> {
  // Single-equality query — served by Firestore's automatic index. Splitting and
  // ordering happen in memory (team lists are small).
  const snap = await adminDb.collection(TEAM_COLLECTION)
    .where('organizerUid', '==', organizerUid)
    .get()
  const all = snap.docs.map(d => toView({ ...(d.data() as TeamMemberDocument), id: d.id }))
  all.sort((a, b) => (b.invitedAt ?? '').localeCompare(a.invitedAt ?? ''))
  return {
    members: all.filter(m => m.status === 'active' || m.status === 'suspended'),
    invites: all.filter(m => m.status === 'invited'),
  }
}

// ─── Invite ─────────────────────────────────────────────────────────────────

export async function inviteMember(args: {
  organizerUid: string; ownerUid: string; ownerEmail: string | null; email: string; role: string
}): Promise<ServiceResult<TeamMemberView>> {
  const email = normalizeEmail(args.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Enter a valid email address.')
  if (!isAssignableRole(args.role))              return fail(400, 'Invalid role.')
  if (args.ownerEmail && normalizeEmail(args.ownerEmail) === email) {
    return fail(400, 'You cannot invite yourself — you already own this workspace.')
  }

  const id    = memberId(args.organizerUid, email)
  const ref   = adminDb.collection(TEAM_COLLECTION).doc(id)
  const token = randomBytes(32).toString('hex')
  const role  = args.role as TeamRole

  // Transaction: reject if an active/invited/suspended row already exists.
  const created = await adminDb.runTransaction(async txn => {
    const existing = await txn.get(ref)
    if (existing.exists) {
      const cur = existing.data() as TeamMemberDocument
      return { conflict: cur.status as TeamStatus }
    }
    const now = FieldValue.serverTimestamp()
    txn.set(ref, {
      organizerUid: args.organizerUid,
      memberUid:    null,
      email,
      role,
      permissions:  permissionsForRole(role),
      status:       'invited',
      invitedBy:    args.ownerUid,
      invitedAt:    now,
      acceptedAt:   null,
      createdAt:    now,
      updatedAt:    now,
      inviteToken:  token,
    })
    return { conflict: null }
  })

  if (created.conflict) {
    const msg = created.conflict === 'invited'
      ? 'An invitation for this email is already pending.'
      : 'This email is already a member of your team.'
    return fail(409, msg)
  }

  // Send the invite email (best-effort — never fails the invite if email is down).
  try {
    const ownerSnap = await adminDb.doc(`users/${args.ownerUid}`).get()
    const orgName   = (ownerSnap.data()?.organizationName as string) || 'a RegisterDesk organization'
    await notificationEngine.send(NotificationType.CUSTOM_EMAIL, {
      to:      email,
      ...teamInviteTemplate({
        organizationName: orgName,
        inviterEmail:     args.ownerEmail ?? 'The organizer',
        roleLabel:        ROLE_LABELS[role],
        acceptUrl:        `${APP_URL}/team/accept?token=${encodeURIComponent(token)}`,
      }),
    })
  } catch (err) {
    console.error('[team] invite email failed:', err)
  }

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: 'team.invited', memberId: id, metadata: { email, role },
  }).catch(() => { /* audit is best-effort */ })

  const doc = (await ref.get()).data() as TeamMemberDocument
  return { ok: true, data: toView({ ...doc, id }) }
}

// ─── Accept ─────────────────────────────────────────────────────────────────

export async function acceptInvite(args: {
  token: string; callerUid: string; callerEmail: string | null
}): Promise<ServiceResult<{ organizerUid: string }>> {
  if (!args.token) return fail(400, 'Missing invitation token.')

  const snap = await adminDb.collection(TEAM_COLLECTION)
    .where('inviteToken', '==', args.token)
    .limit(1)
    .get()
  if (snap.empty) return fail(404, 'This invitation is invalid or has already been used.')

  const ref = snap.docs[0].ref
  const id  = snap.docs[0].id

  const result = await adminDb.runTransaction<ServiceResult<{ organizerUid: string }>>(async txn => {
    const fresh = await txn.get(ref)
    if (!fresh.exists) return fail(404, 'This invitation no longer exists.')
    const m = fresh.data() as TeamMemberDocument

    // Replay protection: a consumed/expired invite can never be re-accepted.
    if (m.status !== 'invited' || !m.inviteToken) return fail(409, 'This invitation has already been used.')

    const invitedMs = (m.invitedAt as { toMillis?: () => number })?.toMillis?.() ?? 0
    if (invitedMs && Date.now() - invitedMs > INVITE_TTL_MS) return fail(410, 'This invitation has expired.')

    // The accepting account's verified email must match the invited email.
    if (!args.callerEmail || normalizeEmail(args.callerEmail) !== m.email) {
      return fail(403, 'This invitation was sent to a different email address.')
    }
    if (args.callerUid === m.organizerUid) return fail(400, 'You already own this workspace.')

    txn.update(ref, {
      memberUid:   args.callerUid,
      status:      'active',
      acceptedAt:  FieldValue.serverTimestamp(),
      inviteToken: null,              // consume the token
      updatedAt:   FieldValue.serverTimestamp(),
    })
    return { ok: true, data: { organizerUid: m.organizerUid } }
  })

  if (result.ok) {
    void logTeamAction({
      organizerUid: result.data.organizerUid, actorUid: args.callerUid,
      action: 'team.accepted', memberId: id, metadata: { email: args.callerEmail },
    }).catch(() => { /* best-effort */ })
  }
  return result
}

// ─── Change role ──────────────────────────────────────────────────────────────

export async function changeRole(args: {
  organizerUid: string; ownerUid: string; memberId: string; role: string
}): Promise<ServiceResult<TeamMemberView>> {
  if (!isAssignableRole(args.role)) return fail(400, 'Invalid role.')
  const ref  = adminDb.collection(TEAM_COLLECTION).doc(args.memberId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Team member not found.')
  const m = snap.data() as TeamMemberDocument
  if (m.organizerUid !== args.organizerUid) return fail(404, 'Team member not found.')

  const role = args.role as TeamRole
  await ref.update({ role, permissions: permissionsForRole(role), updatedAt: FieldValue.serverTimestamp() })

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: 'team.role_changed', memberId: args.memberId, metadata: { from: m.role, to: role },
  }).catch(() => { /* best-effort */ })

  return { ok: true, data: toView({ ...m, id: args.memberId, role, permissions: permissionsForRole(role) }) }
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
  if (m.status === 'invited') return fail(409, 'Pending invitations cannot be suspended.')

  await ref.update({ status: args.status, updatedAt: FieldValue.serverTimestamp() })

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: args.status === 'suspended' ? 'team.suspended' : 'team.reactivated',
    memberId: args.memberId, metadata: { from: m.status, to: args.status },
  }).catch(() => { /* best-effort */ })

  return { ok: true, data: toView({ ...m, id: args.memberId, status: args.status }) }
}

// ─── Resend a pending invitation ──────────────────────────────────────────────

/**
 * Re-sends the invitation email for an ALREADY PENDING invite.
 *
 * ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
 * A pending invite was previously a dead end. `inviteMember` correctly refuses a second
 * invite for the same email with 409, so an owner whose invitee never received the mail had
 * only one route back: revoke and re-invite. That destroys the row, mints a new token, and
 * silently breaks any accept link already sitting in the invitee's inbox.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═════════════════════════════════════════
 * · It does NOT create a document — the row must already exist, and only `invitedAt` /
 *   `updatedAt` are written. The 409 duplicate protection in `inviteMember` is untouched
 *   and is still the only thing that decides whether a NEW invite may be created.
 * · It does NOT mint a token. The stored `inviteToken` is reused verbatim, so a link the
 *   invitee already has keeps working — replacing it would invalidate the very email we
 *   are trying to deliver.
 * · It does NOT touch status, role, permissions, memberUid or acceptedAt.
 *
 * ═══ WHY `invitedAt` IS REFRESHED ═════════════════════════════════════════════
 * `invitedAt` is not decorative: `acceptInvitation` derives expiry from it
 * (`Date.now() - invitedMs > INVITE_TTL_MS`). It IS the TTL clock. Leaving it alone would
 * mean a resend on day 6 hands the invitee a link that dies tomorrow — the opposite of what
 * "resend" promises. `createdAt` is never written after creation, so the original invite
 * date survives in the document; no new field is needed to keep that history.
 */
export async function resendInvitation(args: {
  organizerUid: string; ownerUid: string; ownerEmail: string | null; memberId: string
}): Promise<ServiceResult<TeamMemberView>> {
  const ref  = adminDb.collection(TEAM_COLLECTION).doc(args.memberId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Team member not found.')
  const m = snap.data() as TeamMemberDocument
  // Same 404 (not 403) the other mutations use for a foreign row: a distinct status here
  // would turn this endpoint into a probe for other workspaces' member ids.
  if (m.organizerUid !== args.organizerUid) return fail(404, 'Team member not found.')

  if (m.status !== 'invited') return fail(409, 'Only pending invitations can be resent.')
  // Accepting an invite consumes the token (`inviteToken: null`). Without one there is no
  // link to send, and minting a replacement here would be issuing a fresh invitation
  // through an endpoint that is not allowed to create one.
  if (!m.inviteToken) return fail(409, 'This invitation can no longer be resent.')

  await ref.update({
    invitedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  // Same composition and the same best-effort posture as `inviteMember`: a provider outage
  // must not fail the request, because the row has already been refreshed and the owner can
  // simply try again.
  try {
    const ownerSnap = await adminDb.doc(`users/${args.ownerUid}`).get()
    const orgName   = (ownerSnap.data()?.organizationName as string) || 'a RegisterDesk organization'
    await notificationEngine.send(NotificationType.CUSTOM_EMAIL, {
      to:      m.email,
      ...teamInviteTemplate({
        organizationName: orgName,
        inviterEmail:     args.ownerEmail ?? 'The organizer',
        roleLabel:        ROLE_LABELS[m.role],
        acceptUrl:        `${APP_URL}/team/accept?token=${encodeURIComponent(m.inviteToken)}`,
      }),
    })
  } catch (err) {
    console.error('[team] invite resend email failed:', err)
  }

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: 'team.invite_resent', memberId: args.memberId, metadata: { email: m.email, role: m.role },
  }).catch(() => { /* audit is best-effort */ })

  // Re-read so the returned view carries the resolved server timestamp rather than the
  // sentinel, matching what the next GET /api/organizer/team will show.
  const fresh = (await ref.get()).data() as TeamMemberDocument
  return { ok: true, data: toView({ ...fresh, id: args.memberId }) }
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
  // Owner can never remove themselves (defensive — the owner has no member row).
  if (m.memberUid && m.memberUid === args.callerUid) return fail(400, 'You cannot remove yourself.')

  await ref.delete()

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.ownerUid,
    action: 'team.removed', memberId: args.memberId, metadata: { email: m.email, role: m.role },
  }).catch(() => { /* best-effort */ })

  return { ok: true, data: undefined }
}
