// RD-CHECKIN-2.0 — staff account lifecycle (Admin SDK).
//
// Creates, lists, updates and removes the username/password credentials an
// organizer issues to gate operators. Everything here writes THREE things that
// must agree, and the order below is the safety story:
//
//   1. staffUsernames/{username}  — a deterministic-id lock. `.create()` fails if
//      it exists, which is what makes a username globally unique. Taken FIRST, so
//      two organizers racing the same username cannot both proceed.
//   2. the Firebase Auth user        — owns the password. We never see it.
//   3. teamMembers/{id} + staffAccounts/{uid} — authorization + profile, written
//      in ONE batch so an operator can never exist with a profile but no grant.
//
// Every step compensates backwards on failure, so a partial create leaves nothing
// behind: no orphan lock, no orphan Auth user able to sign in with no workspace.
//
// ═══ AUTHORIZATION IS NOT DEFINED HERE ═══════════════════════════════════════
// The `teamMembers` row is the grant, and lib/team/access.ts re-derives permissions
// from the role matrix on every request. This file chooses WHICH role to write and
// refuses anything that is not a gate role; it cannot invent a permission.

import { randomBytes, createHash } from 'crypto'
import { FieldValue }               from 'firebase-admin/firestore'
import { adminAuth, adminDb }       from '@/lib/firebase/admin'
import {
  TEAM_COLLECTION, permissionsForRole, sanitizeEventIds, isStaffRole,
  type TeamRole, type TeamMemberDocument,
} from '@/lib/team/types'
import { logTeamAction }          from '@/lib/team/audit'
import {
  STAFF_COLLECTION, STAFF_USERNAME_COLLECTION, MAX_STAFF_ACCOUNTS,
  TEMP_PASSWORD_BYTES, formatTempPassword,
  isValidUsername, normalizeUsername, staffEmailForUsername, passwordProblem,
  type StaffAccountDocument, type StaffAccountView, type StaffStatus,
} from '@/lib/staff/types'

export type StaffResult<T = undefined> =
  | { ok: true;  data: T }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): StaffResult<never> => ({ ok: false, status, error })

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/**
 * The member-row id for a staff account.
 *
 * Namespaced by `staff:` and hashed so it can never collide with the
 * `sha256(organizerUid:email)` id the email-invite flow uses, and so one Auth
 * identity cannot hold two member rows in the same workspace.
 */
function staffMemberId(organizerUid: string, staffId: string): string {
  return createHash('sha256').update(`staff:${organizerUid}:${staffId}`).digest('hex').slice(0, 32)
}

function toView(d: StaffAccountDocument): StaffAccountView {
  return {
    staffId:     d.staffId,
    username:    d.username,
    displayName: d.displayName,
    role:        d.role,
    status:      d.status,
    eventIds:    Array.isArray(d.eventIds) ? d.eventIds.filter(e => typeof e === 'string') : [],
    createdAt:   tsToISO(d.createdAt),
    lastLoginAt: tsToISO(d.lastLoginAt),
    mustChangePassword: d.mustChangePassword === true,
  }
}

/** A temporary password, generated from the platform CSPRNG. Returned ONCE. */
export function generateTempPassword(): string {
  return formatTempPassword(new Uint8Array(randomBytes(TEMP_PASSWORD_BYTES)))
}

// ─── List ────────────────────────────────────────────────────────────────────

export async function listStaffAccounts(organizerUid: string): Promise<StaffAccountView[]> {
  // Single equality — served by the automatic index, and bounded by MAX_STAFF_ACCOUNTS
  // at creation time, so this can never become an unbounded read.
  const snap = await adminDb.collection(STAFF_COLLECTION)
    .where('organizerUid', '==', organizerUid)
    .limit(MAX_STAFF_ACCOUNTS + 1)
    .get()
  return snap.docs
    .map(d => toView(d.data() as StaffAccountDocument))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateStaffInput {
  organizerUid: string
  actorUid:     string
  username:     string
  displayName:  string
  role:         string
  eventIds:     unknown
  /** Omit to have one generated and returned once. */
  password?:    string
}

export interface CreatedStaff {
  staff: StaffAccountView
  /**
   * The password, in clear, returned EXACTLY ONCE at creation so the organizer can
   * hand it over. It is never stored by this application and never readable again —
   * a later "I forgot it" is answered by issuing a new one, not by retrieving this.
   */
  temporaryPassword: string
}

export async function createStaffAccount(input: CreateStaffInput): Promise<StaffResult<CreatedStaff>> {
  const username    = normalizeUsername(input.username)
  const displayName = (input.displayName ?? '').trim()

  if (!isValidUsername(username)) {
    return fail(400, 'Username must be 3–32 characters: letters, digits, and single . _ - separators.')
  }
  if (!displayName || displayName.length > 120) {
    return fail(400, 'Enter the staff member’s name.')
  }
  if (!isStaffRole(input.role)) {
    // Deliberately not "invalid role": a staff CREDENTIAL is restricted to gate
    // roles even though the role exists, and the operator should be told which.
    return fail(400, 'Staff accounts may only be Check-in Staff or Check-in Lead.')
  }
  const eventIds = sanitizeEventIds(input.eventIds)
  if (eventIds === null) return fail(400, 'Invalid event assignment.')
  // A staff credential MUST name its events. `[]` means "unrestricted" everywhere
  // else in this codebase — the backward-compatible reading for member rows written
  // before assignment existed — and that reading is exactly wrong for an account
  // created today for one gate. Refused rather than silently granted the workspace.
  if (eventIds.length === 0) {
    return fail(400, 'Assign at least one event. A staff account cannot be workspace-wide.')
  }

  const password = input.password ?? generateTempPassword()
  const pwProblem = passwordProblem(password)
  if (pwProblem) {
    return fail(400, pwProblem === 'TOO_SHORT'
      ? 'Password must be at least 10 characters.'
      : 'Password is not valid.')
  }

  const existing = await adminDb.collection(STAFF_COLLECTION)
    .where('organizerUid', '==', input.organizerUid)
    .limit(MAX_STAFF_ACCOUNTS)
    .get()
  if (existing.size >= MAX_STAFF_ACCOUNTS) {
    return fail(409, `A workspace can hold at most ${MAX_STAFF_ACCOUNTS} staff accounts.`)
  }

  // ── 1. Claim the username ─────────────────────────────────────────────────
  // `.create()` on a deterministic id IS the uniqueness constraint — the same
  // pattern identifierLocks uses. A second writer gets ALREADY_EXISTS, not a
  // silent overwrite, so two organizers cannot both own one username.
  const lockRef = adminDb.collection(STAFF_USERNAME_COLLECTION).doc(username)
  try {
    await lockRef.create({
      username,
      organizerUid: input.organizerUid,
      createdAt:    FieldValue.serverTimestamp(),
    })
  } catch {
    return fail(409, 'That username is already taken. Choose another.')
  }

  const email = staffEmailForUsername(username)
  const role  = input.role as TeamRole

  let staffId: string
  try {
    // ── 2. The Auth user ───────────────────────────────────────────────────
    // `emailVerified: true` is set because the address is an IDENTIFIER, not a
    // mailbox: the domain is RFC-2606 reserved and can never receive mail, so
    // there is no verification to perform and none is possible. Without it,
    // verifyCaller (which requires email_verified) would reject every staff token
    // and the account could never be used. The password is handed straight to
    // Firebase and is not retained anywhere in this process.
    const user = await adminAuth.createUser({
      email, password, displayName, emailVerified: true,
    })
    staffId = user.uid
  } catch (err) {
    await lockRef.delete().catch(() => {})
    const code = (err as { code?: string }).code ?? ''
    if (code === 'auth/email-already-exists') {
      return fail(409, 'That username is already taken. Choose another.')
    }
    console.error('[staff] createUser failed:', code || err)
    return fail(500, 'Could not create the staff account. Please try again.')
  }

  // ── 3. Grant + profile, together ─────────────────────────────────────────
  const memberId = staffMemberId(input.organizerUid, staffId)
  const now      = FieldValue.serverTimestamp()

  try {
    const batch = adminDb.batch()
    batch.set(adminDb.collection(TEAM_COLLECTION).doc(memberId), {
      organizerUid: input.organizerUid,
      memberUid:    staffId,
      email,
      role,
      permissions:  permissionsForRole(role),
      eventIds,
      // Active immediately: unlike an email invite there is nothing to accept —
      // the organizer has already handed over the credential in person.
      status:       'active',
      invitedBy:    input.actorUid,
      invitedAt:    now,
      acceptedAt:   now,
      createdAt:    now,
      updatedAt:    now,
      inviteToken:  null,
    } satisfies Omit<TeamMemberDocument, 'id'>)

    batch.set(adminDb.collection(STAFF_COLLECTION).doc(staffId), {
      staffId,
      organizerUid: input.organizerUid,
      username,
      displayName,
      role,
      status:       'active' as StaffStatus,
      eventIds,
      createdBy:    input.actorUid,
      createdAt:    now,
      updatedAt:    now,
      lastLoginAt:  null,
      mustChangePassword: true,
    } satisfies StaffAccountDocument)

    await batch.commit()
  } catch (err) {
    // Compensate in reverse. An Auth user with no member row could sign in and
    // resolve to their OWN empty workspace, which is a confusing dead end rather
    // than an exposure — but it is still a credential nobody issued on purpose.
    await adminAuth.deleteUser(staffId).catch(() => {})
    await lockRef.delete().catch(() => {})
    console.error('[staff] grant write failed:', err)
    return fail(500, 'Could not create the staff account. Please try again.')
  }

  // Audit AFTER the account exists, and never the password — the record says a
  // credential was issued, never what it was.
  void logTeamAction({
    organizerUid: input.organizerUid, actorUid: input.actorUid,
    action: 'staff.created', memberId,
    metadata: { staffId, username, role, eventCount: eventIds.length },
  }).catch(() => { /* audit is best-effort */ })

  const snap = await adminDb.collection(STAFF_COLLECTION).doc(staffId).get()
  return {
    ok: true,
    data: {
      staff: toView(snap.data() as StaffAccountDocument),
      temporaryPassword: password,
    },
  }
}

// ─── Update (status / assignment / role / name) ──────────────────────────────

export interface UpdateStaffInput {
  organizerUid: string
  actorUid:     string
  staffId:      string
  displayName?: string
  role?:        string
  eventIds?:    unknown
  status?:      StaffStatus
}

export async function updateStaffAccount(input: UpdateStaffInput): Promise<StaffResult<StaffAccountView>> {
  const ref  = adminDb.collection(STAFF_COLLECTION).doc(input.staffId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Staff account not found.')
  const doc = snap.data() as StaffAccountDocument
  // Ownership: a staff account belongs to exactly one workspace, and the id alone
  // is never sufficient to act on it.
  if (doc.organizerUid !== input.organizerUid) return fail(404, 'Staff account not found.')

  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  const memberPatch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (input.displayName !== undefined) {
    const name = input.displayName.trim()
    if (!name || name.length > 120) return fail(400, 'Enter the staff member’s name.')
    patch.displayName = name
  }

  if (input.role !== undefined) {
    if (!isStaffRole(input.role)) {
      return fail(400, 'Staff accounts may only be Check-in Staff or Check-in Lead.')
    }
    patch.role              = input.role
    memberPatch.role        = input.role
    memberPatch.permissions = permissionsForRole(input.role as TeamRole)
  }

  if (input.eventIds !== undefined) {
    const ids = sanitizeEventIds(input.eventIds)
    if (ids === null) return fail(400, 'Invalid event assignment.')
    // Same rule as creation: emptying the list would WIDEN this account to the whole
    // workspace, which is the opposite of what an organizer editing an assignment
    // means. See createStaffAccount.
    if (ids.length === 0) {
      return fail(400, 'Assign at least one event. A staff account cannot be workspace-wide.')
    }
    patch.eventIds       = ids
    memberPatch.eventIds = ids
  }

  if (input.status !== undefined) {
    if (input.status !== 'active' && input.status !== 'suspended') {
      return fail(400, 'Invalid status.')
    }
    patch.status        = input.status
    // The MEMBER row is what resolveTeamAccess reads (`status === 'active'`), so
    // suspension has to land there. The staff profile mirrors it for display only.
    memberPatch.status  = input.status
  }

  const memberId = staffMemberId(input.organizerUid, input.staffId)
  const batch = adminDb.batch()
  batch.update(ref, patch)
  batch.set(adminDb.collection(TEAM_COLLECTION).doc(memberId), memberPatch, { merge: true })
  await batch.commit()

  // Suspension must take effect NOW, not when the current ID token expires.
  // verifyCaller calls verifyIdToken(token, checkRevoked = true), so revoking here
  // closes an in-progress session on the operator's next request.
  if (input.status === 'suspended') {
    await adminAuth.revokeRefreshTokens(input.staffId).catch(err =>
      console.error('[staff] revokeRefreshTokens failed:', err))
  }

  // One row per meaningful change, so an assignment edit and a suspension read as
  // separate events rather than one opaque "updated".
  const audit = (action: 'staff.updated' | 'staff.events_changed' | 'staff.suspended' | 'staff.reactivated',
                 metadata: Record<string, unknown>) =>
    void logTeamAction({
      organizerUid: input.organizerUid, actorUid: input.actorUid,
      action, memberId, metadata: { staffId: input.staffId, ...metadata },
    }).catch(() => { /* audit is best-effort */ })

  if (input.eventIds !== undefined) {
    audit('staff.events_changed', { eventCount: (patch.eventIds as string[] | undefined)?.length ?? 0 })
  }
  if (input.status === 'suspended') audit('staff.suspended', {})
  if (input.status === 'active')    audit('staff.reactivated', {})
  if (input.displayName !== undefined || input.role !== undefined) {
    audit('staff.updated', { role: input.role ?? null })
  }

  const after = await ref.get()
  return { ok: true, data: toView(after.data() as StaffAccountDocument) }
}

// ─── Password reset (organizer-initiated) ────────────────────────────────────

export async function resetStaffPassword(args: {
  organizerUid: string; staffId: string;
}): Promise<StaffResult<{ temporaryPassword: string }>> {
  const ref  = adminDb.collection(STAFF_COLLECTION).doc(args.staffId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Staff account not found.')
  const doc = snap.data() as StaffAccountDocument
  if (doc.organizerUid !== args.organizerUid) return fail(404, 'Staff account not found.')

  const temporaryPassword = generateTempPassword()
  await adminAuth.updateUser(args.staffId, { password: temporaryPassword })
  // Any device holding the old session is signed out — a reset is usually a
  // response to a lost or shared device.
  await adminAuth.revokeRefreshTokens(args.staffId).catch(() => {})
  await ref.update({ mustChangePassword: true, updatedAt: FieldValue.serverTimestamp() })

  // The FACT of a reset is auditable; the password is not, and never reaches here.
  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.organizerUid,
    action: 'staff.password_reset',
    memberId: staffMemberId(args.organizerUid, args.staffId),
    metadata: { staffId: args.staffId, username: doc.username },
  }).catch(() => { /* audit is best-effort */ })

  return { ok: true, data: { temporaryPassword } }
}

/** Staff changing their OWN password. Requires the current one, verified by the client. */
export async function setOwnStaffPassword(staffId: string, password: string): Promise<StaffResult> {
  const problem = passwordProblem(password)
  if (problem) {
    return fail(400, problem === 'TOO_SHORT'
      ? 'Password must be at least 10 characters.'
      : 'Password is not valid.')
  }
  await adminAuth.updateUser(staffId, { password })
  await adminDb.collection(STAFF_COLLECTION).doc(staffId)
    .set({ mustChangePassword: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  return { ok: true, data: undefined }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteStaffAccount(args: {
  organizerUid: string; staffId: string;
}): Promise<StaffResult> {
  const ref  = adminDb.collection(STAFF_COLLECTION).doc(args.staffId)
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'Staff account not found.')
  const doc = snap.data() as StaffAccountDocument
  if (doc.organizerUid !== args.organizerUid) return fail(404, 'Staff account not found.')

  // Order matters: revoke the grant BEFORE anything else, so a delete that fails
  // half-way leaves an account that can sign in but reach nothing, rather than one
  // that still holds a workspace grant.
  const memberId = staffMemberId(args.organizerUid, args.staffId)
  await adminDb.collection(TEAM_COLLECTION).doc(memberId).delete().catch(() => {})
  await adminAuth.deleteUser(args.staffId).catch(err =>
    console.error('[staff] deleteUser failed:', err))
  await adminDb.collection(STAFF_USERNAME_COLLECTION).doc(doc.username).delete().catch(() => {})
  await ref.delete()

  void logTeamAction({
    organizerUid: args.organizerUid, actorUid: args.organizerUid,
    action: 'staff.removed', memberId,
    metadata: { staffId: args.staffId, username: doc.username },
  }).catch(() => { /* audit is best-effort */ })

  return { ok: true, data: undefined }
}

// ─── Sign-in bookkeeping ─────────────────────────────────────────────────────

/**
 * The staff profile for an authenticated caller, or null when the uid is not a
 * staff account. Never used to AUTHORIZE — the member row does that — only to
 * decide what the staff surfaces display and to record a sign-in.
 */
export async function getStaffAccount(staffId: string): Promise<StaffAccountDocument | null> {
  const snap = await adminDb.collection(STAFF_COLLECTION).doc(staffId).get()
  return snap.exists ? snap.data() as StaffAccountDocument : null
}

export async function recordStaffLogin(staffId: string): Promise<void> {
  await adminDb.collection(STAFF_COLLECTION).doc(staffId)
    .set({ lastLoginAt: FieldValue.serverTimestamp() }, { merge: true })
}
