// RD-WORKSPACE-OWNERSHIP-01 — which workspace a caller resolves into, against REAL Firestore.
//
// ═══ THE DEFECT THESE CASES PIN ══════════════════════════════════════════════
// `resolveWorkspaceUid` decides, for every organizer request, whose data the caller is
// acting on. When the caller held any active `teamMembers` row it asked `ownsWorkspace`
// to break the tie, and that function inferred ownership from "does this account have at
// least one event draft?".
//
// A brand-new organizer has ZERO drafts. So did a re-registered one: deleting an organizer
// removes the Firebase Auth user, the same email signs up again, and the fresh account owns
// nothing yet. Such an account was resolved into the OTHER organizer's workspace, carrying
// that membership's restricted role — the organizer sees an account that is missing features,
// with nothing in their own profile to explain why.
//
// Two halves are fixed and both are driven here:
//   • ownership is now the explicit `users/{uid}.workspaceOwner` marker, with the draft
//     inference retained ONLY for documents that predate it;
//   • organizer deletion now also sweeps the memberships the organizer HELD, so a grant
//     cannot outlive the account and re-attach to the re-registered one.
//
// Nothing is mocked. `resolveWorkspaceUid`, `ensureOrganizerProfile` and the real deletion
// executor run against the Firestore and Auth emulators.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

const STAFF_DOMAIN = 'staff.registerdesk.invalid'

describeEmu('RD-WORKSPACE-OWNERSHIP-01 · workspace resolution', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let resolveWorkspaceUid: typeof import('@/lib/team/workspace').resolveWorkspaceUid
  let ensureOrganizerProfile: typeof import('@/lib/organizer/ensureProfile').ensureOrganizerProfile
  let runOrganizerDeletion: typeof import('@/lib/admin/organizerDeletion').runOrganizerDeletion

  // The workspace the memberships point AT — a separate organizer throughout, so that
  // "resolved into somebody else's workspace" is always observable as a different uid.
  const HOST = `wso-host-${process.pid}`

  beforeAll(async () => {
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ resolveWorkspaceUid } = await import('@/lib/team/workspace'))
    ;({ ensureOrganizerProfile } = await import('@/lib/organizer/ensureProfile'))
    ;({ runOrganizerDeletion } = await import('@/lib/admin/organizerDeletion'))
  }, T)

  // ─── seeding helpers ───────────────────────────────────────────────────────

  /** A users/{uid} profile. `owner` omitted ⇒ a LEGACY document with no marker at all. */
  async function profile(uid: string, owner?: boolean): Promise<void> {
    await adminDb.collection('users').doc(uid).set({
      uid, role: 'organizer', accountStatus: 'active', email: `${uid}@rd.test`,
      ...(owner === undefined ? {} : { workspaceOwner: owner }),
    })
  }

  async function draft(uid: string): Promise<void> {
    await adminDb.collection('users').doc(uid).collection('eventDrafts')
      .doc('d1').set({ status: 'draft' })
  }

  /**
   * An ACTIVE grant of `role` in HOST's workspace to `memberUid`.
   *
   * `email` decides `isStaffCredential` — lib/team/access.ts derives it from the reserved
   * address namespace — so a staff row must carry an @staff.registerdesk.invalid address
   * exactly as lib/staff/service.ts writes it.
   */
  async function membership(
    memberUid: string,
    opts: { staff: boolean; role?: string; eventIds?: string[]; organizerUid?: string } ,
  ): Promise<string> {
    const ref = adminDb.collection('teamMembers').doc()
    await ref.set({
      organizerUid: opts.organizerUid ?? HOST,
      memberUid,
      email:  opts.staff ? `gate-${memberUid}@${STAFF_DOMAIN}` : `${memberUid}@person.test`,
      role:   opts.role ?? 'checkin_staff',
      status: 'active',
      eventIds: opts.eventIds ?? [],
    })
    return ref.id
  }

  beforeEach(async () => {
    // Every case seeds its own pid-scoped uid, so only the shared teamMembers collection
    // needs clearing — and ONLY the rows this file created. Scoped by `organizerUid == HOST`
    // rather than wiping the collection: the emulator is long-lived and may be shared with
    // another suite or another session, and a blanket delete would silently destroy its data.
    const snap = await adminDb.collection('teamMembers').where('organizerUid', '==', HOST).get()
    await Promise.all(snap.docs.map(d => d.ref.delete()))
  }, T)

  // ═══ 1 · THE DEFECT ════════════════════════════════════════════════════════

  it('1 · a NEW organizer with zero drafts keeps their OWN workspace despite a membership', async () => {
    const uid = `wso-new-${process.pid}`
    await profile(uid, true)                       // marker set by signup
    // …and a PERSON membership in someone else's team. (RD-SEC-01: this used a gate-credential
    // row, i.e. "marker beats staff credential" — which is exactly how a staff login that wrote
    // itself a workspaceOwner:true profile escaped its workspace. A gate credential is now never
    // an owner — pinned in case 2b below and in securityAuthz01.)
    await membership(uid, { staff: false, role: 'manager' })
    // No drafts: this is precisely the account the draft inference got wrong.

    const ctx = await resolveWorkspaceUid(uid)

    expect(ctx.workspaceUid).toBe(uid)
    expect(ctx.isOwner).toBe(true)
    expect(ctx.role).toBe('owner')
    // The full owner grant, not a member slice. Asserted by content so a change to the
    // matrix shows up here rather than passing on a length check.
    expect(ctx.permissions).toContain('events')
    expect(ctx.permissions).toContain('wallet')
    expect(ctx.permissions).toContain('settlements')
  }, T)

  // ═══ 2 · STAFF MUST NOT BE PROMOTED ════════════════════════════════════════

  it('2 · a gate credential still resolves into the workspace it was issued for', async () => {
    const uid = `wso-gate-${process.pid}`
    await profile(uid, false)                      // explicit NON-owner (healed staff doc)
    await membership(uid, { staff: true, role: 'checkin_staff', eventIds: ['ev-1'] })

    const ctx = await resolveWorkspaceUid(uid)

    expect(ctx.workspaceUid).toBe(HOST)            // NOT their own uid
    expect(ctx.isOwner).toBe(false)
    expect(ctx.role).toBe('checkin_staff')
    expect(ctx.eventIds).toEqual(['ev-1'])
    expect(ctx.isStaffCredential).toBe(true)
    expect(ctx.permissions).not.toContain('wallet')
  }, T)

  it('2b · RD-SEC-01 · a gate credential that holds a workspaceOwner:true profile is STILL not an owner', async () => {
    const uid = `wso-gate-forged-${process.pid}`
    await profile(uid, true)                       // what client signup "recovery" could write
    await membership(uid, { staff: true, role: 'checkin_staff', eventIds: ['ev-1'] })

    const ctx = await resolveWorkspaceUid(uid)

    expect(ctx.workspaceUid).toBe(HOST)
    expect(ctx.isOwner).toBe(false)
    expect(ctx.role).toBe('checkin_staff')
    expect(ctx.isStaffCredential).toBe(true)
  }, T)

  it('3 · a LEGACY staff document resolves by its credential, not by its draft count', async () => {
    const uid = `wso-legacy-gate-${process.pid}`
    await profile(uid)                             // no marker at all
    await draft(uid)                               // and it HAS a draft — the old rule would
    await membership(uid, { staff: true })         // have called this an owner

    const ctx = await resolveWorkspaceUid(uid)

    // A gate credential is identified positively from the reserved address namespace, so
    // an incidental draft can no longer promote one out of its workspace.
    expect(ctx.workspaceUid).toBe(HOST)
    expect(ctx.isOwner).toBe(false)
    expect(ctx.role).toBe('checkin_staff')
  }, T)

  // ═══ 3 · BACKWARD COMPATIBILITY ════════════════════════════════════════════

  it('4 · a LEGACY organizer with a draft still owns their workspace', async () => {
    const uid = `wso-legacy-owner-${process.pid}`
    await profile(uid)                             // no marker
    await draft(uid)
    await membership(uid, { staff: false, role: 'manager' })

    const ctx = await resolveWorkspaceUid(uid)

    expect(ctx.workspaceUid).toBe(uid)
    expect(ctx.isOwner).toBe(true)
  }, T)

  it('5 · a LEGACY non-staff member with no drafts keeps the pre-existing resolution', async () => {
    const uid = `wso-legacy-member-${process.pid}`
    await profile(uid)                             // no marker
    await membership(uid, { staff: false, role: 'manager' })
    // Deliberately pinned rather than "fixed": this is the one shape whose answer the
    // change does NOT alter, so a future decision to alter it has to be explicit.

    const ctx = await resolveWorkspaceUid(uid)

    expect(ctx.workspaceUid).toBe(HOST)
    expect(ctx.isOwner).toBe(false)
    expect(ctx.role).toBe('manager')
  }, T)

  it('6 · a caller with no memberships is the owner, marker or not', async () => {
    const uid = `wso-solo-${process.pid}`
    // No profile document and no memberships: the short-circuit must not depend on either
    // read succeeding, because this is the common case for every organizer on every request.
    const ctx = await resolveWorkspaceUid(uid)

    expect(ctx.workspaceUid).toBe(uid)
    expect(ctx.isOwner).toBe(true)
    expect(ctx.role).toBe('owner')
  }, T)

  it('7 · an explicit false marker beats a draft that would otherwise imply ownership', async () => {
    const uid = `wso-explicit-false-${process.pid}`
    await profile(uid, false)
    await draft(uid)                               // the legacy signal says "owner"…
    await membership(uid, { staff: false, role: 'manager' })

    const ctx = await resolveWorkspaceUid(uid)

    // …and the explicit marker overrides it. Authoritative means authoritative in both
    // directions, otherwise the field cannot be used to demote anything.
    expect(ctx.workspaceUid).toBe(HOST)
    expect(ctx.isOwner).toBe(false)
  }, T)

  // ═══ 4 · WHO GETS THE MARKER WHEN A PROFILE IS HEALED ══════════════════════

  it('8 · ensureOrganizerProfile marks a healed GATE credential as a non-owner', async () => {
    const uid = `wso-heal-gate-${process.pid}`
    await adminAuth.createUser({
      uid, email: `gatehealer-${process.pid}@${STAFF_DOMAIN}`, password: 'staff-pw-123456',
    })

    await ensureOrganizerProfile(uid)

    const d = (await adminDb.collection('users').doc(uid).get()).data()
    expect(d?.workspaceOwner).toBe(false)
  }, T)

  it('9 · ensureOrganizerProfile marks a healed ORGANIZER as an owner', async () => {
    const uid = `wso-heal-org-${process.pid}`
    await adminAuth.createUser({
      uid, email: `orghealer-${process.pid}@rd.test`, password: 'org-pw-123456',
      emailVerified: true,
    })

    await ensureOrganizerProfile(uid)

    const d = (await adminDb.collection('users').doc(uid).get()).data()
    expect(d?.workspaceOwner).toBe(true)
  }, T)

  // ═══ 5 · DELETION NO LONGER LEAVES A GRANT BEHIND ══════════════════════════

  it('10 · deleting an organizer sweeps the memberships they HELD, and is retry-safe', async () => {
    const uid = `wso-del-${process.pid}`
    await profile(uid, true)
    await adminAuth.createUser({ uid, email: `${uid}@rd.test`, password: 'del-pw-123456' })
    const heldId = await membership(uid, { staff: false, role: 'manager' })

    await runOrganizerDeletion(uid)
    expect((await adminDb.collection('teamMembers').doc(heldId).get()).exists).toBe(false)

    // Retry-safe: a second full run over an already-deleted organizer must complete
    // without throwing, because the executor resumes by replaying steps.
    const second = await runOrganizerDeletion(uid)
    expect(second.finished).toBe(true)
  }, T)

  it('11 · that sweep cannot remove another person\'s membership', async () => {
    const uid      = `wso-del2-${process.pid}`
    const bystander = `wso-bystander-${process.pid}`
    await profile(uid, true)
    await adminAuth.createUser({ uid, email: `${uid}@rd.test`, password: 'del-pw-123456' })
    const mine   = await membership(uid, { staff: false, role: 'manager' })
    // Same workspace, different person — and a row where the DELETED uid is the workspace
    // owner would be legitimately removed, so the bystander is placed in HOST's workspace.
    const theirs = await membership(bystander, { staff: false, role: 'manager' })

    await runOrganizerDeletion(uid)

    expect((await adminDb.collection('teamMembers').doc(mine).get()).exists).toBe(false)
    expect((await adminDb.collection('teamMembers').doc(theirs).get()).exists).toBe(true)
  }, T)

  it('12 · a re-registered organizer resolves into their OWN workspace', async () => {
    // The whole reported journey, end to end.
    const oldUid = `wso-rr-old-${process.pid}`
    const newUid = `wso-rr-new-${process.pid}`
    const email  = `rr-${process.pid}@rd.test`

    // The organizer existed, and also held a grant in somebody else's workspace.
    await profile(oldUid, true)
    await adminAuth.createUser({ uid: oldUid, email, password: 'rr-pw-123456' })
    const stale = await membership(oldUid, { staff: false, role: 'checkin_staff' })

    // Admin deletes them; the Auth user goes with it, freeing the email.
    await runOrganizerDeletion(oldUid)
    expect((await adminDb.collection('teamMembers').doc(stale).get()).exists).toBe(false)

    // The same person registers again — a NEW uid, a fresh profile, and zero drafts.
    await adminAuth.createUser({ uid: newUid, email, password: 'rr-pw-123456' })
    await profile(newUid, true)

    const ctx = await resolveWorkspaceUid(newUid)

    expect(ctx.workspaceUid).toBe(newUid)
    expect(ctx.isOwner).toBe(true)
    expect(ctx.role).toBe('owner')
  }, T)
})
