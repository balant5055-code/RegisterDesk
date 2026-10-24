// RD-ORGANIZER-REMAINING-ALL — organizer deletion against REAL Firestore and REAL Auth.
//
// ═══ WHY THE EMULATOR IS THE ONLY PLACE THIS CAN BE PROVED ═══════════════════
// The manifest's shape is unit-tested. What cannot be established by reading it:
//
//   · that an eligibility probe actually MATCHES the documents it is meant to find. A wrong
//     field name returns "no documents", the gate says deletable, and an organizer with a
//     published event is destroyed. That is the single worst failure available here, and it is
//     invisible to any test that does not write a real document and then read it back.
//   · that a batch of more than 500 documents is deleted at all. Firestore's limit is a hard
//     error, not a slow path.
//   · that an interrupted job resumes instead of restarting or reporting success.
//   · that Firebase Auth really is last.
//
// Every test therefore writes real documents, runs the real executor, and reads back.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000

describeEmu('RD-ORGANIZER-REMAINING-ALL · organizer deletion on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let evaluateDeletionEligibility: typeof import('@/lib/admin/organizerDeletion').evaluateDeletionEligibility
  let runOrganizerDeletion: typeof import('@/lib/admin/organizerDeletion').runOrganizerDeletion
  let buildOrganizerDeletionManifest: typeof import('@/lib/admin/organizerDeletion').buildOrganizerDeletionManifest

  const EMAIL = `orgdel-${process.pid}@rd.test`
  let uid = ''

  const user = () => adminDb.doc(`users/${uid}`)

  /** A clean, deletable organizer: a profile and nothing else. */
  async function seedCleanOrganizer() {
    await user().set({
      uid, name: 'Deletable Organizer', email: EMAIL,
      organizationName: 'Nothing Ever Happened Co',
      role: 'organizer', accountStatus: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    })
  }

  /** Remove everything this suite could have created, so each case starts clean. */
  async function wipe() {
    const cols = [
      'events', 'donationCampaigns', 'registrations', 'walletClawbacks',
      'platformTransactions', 'settlementRequests', 'eventLicenses', 'teamMembers',
      'communicationUsage', 'broadcastCampaigns', 'apiKeys', 'organizerAssets',
      'staffAccounts', 'staffUsernames', 'walletTransactions', 'adminAuditLogs',
      'payoutProfileHistory', 'globalCertificateTemplates', 'platformSettings',
    ]
    for (const c of cols) {
      // Two ownership fields are in play across these collections.
      for (const field of ['organizerUid', 'uid']) {
        const snap = await adminDb.collection(c).where(field, '==', uid).limit(400).get().catch(() => null)
        if (!snap || snap.empty) continue
        const batch = adminDb.batch()
        snap.docs.forEach(d => batch.delete(d.ref))
        await batch.commit()
      }
    }
    for (const sub of ['eventDrafts', 'campaignDrafts', 'notifications', 'emailTemplates']) {
      const snap = await user().collection(sub).limit(400).get().catch(() => null)
      if (!snap || snap.empty) continue
      const batch = adminDb.batch()
      snap.docs.forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
    for (const path of [
      `mediaSettings/${uid}`, `organizerBrandKit/${uid}`, `organizerLimits/${uid}`,
      `organizerPayoutProfiles/${uid}`, `organizerWallets/${uid}`,
      `organizerDeletionJobs/orgdel_${uid}`,
    ]) await adminDb.doc(path).delete().catch(() => null)
    await user().delete().catch(() => null)
  }

  /** Recreate the Auth user (tests delete it). */
  async function ensureAuthUser() {
    try { await adminAuth.getUser(uid) }
    catch { await adminAuth.createUser({ uid, email: EMAIL, password: 'DeletePassw0rd!' }) }
  }

  const authExists = async () => {
    try { await adminAuth.getUser(uid); return true } catch { return false }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ evaluateDeletionEligibility, runOrganizerDeletion, buildOrganizerDeletionManifest } =
      await import('@/lib/admin/organizerDeletion'))
    const created = await adminAuth.createUser({ email: EMAIL, password: 'DeletePassw0rd!' })
    uid = created.uid
  }, T)

  afterAll(async () => {
    if (!uid) return
    await wipe()
    await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  beforeEach(async () => {
    await wipe()
    await ensureAuthUser()
    await seedCleanOrganizer()
  }, T)

  // ═══ 1 · ELIGIBILITY · every blocker actually matches a real document ════════

  it('a clean organizer with only a profile IS deletable', async () => {
    const e = await evaluateDeletionEligibility(uid)
    expect(e.exists).toBe(true)
    expect(e.blockers, `unexpected blockers: ${JSON.stringify(e.blockers)}`).toEqual([])
    expect(e.deletable).toBe(true)
    expect(e.identity?.email).toBe(EMAIL)
  }, T)

  it('a non-existent organizer is never deletable', async () => {
    const e = await evaluateDeletionEligibility('no-such-organizer-uid')
    expect(e.exists).toBe(false)
    expect(e.deletable).toBe(false)
  }, T)

  // EVERY lifecycle state blocks — "zero ACTIVE events" is not the test.
  for (const lifecycleStatus of [
    'draft', 'pending_review', 'changes_requested', 'published',
    'registration_closed', 'completed', 'cancelled', 'unpublished', 'archived',
  ]) {
    it(`an event in "${lifecycleStatus}" BLOCKS deletion`, async () => {
      await adminDb.doc(`events/evt-${lifecycleStatus}-${uid}`).set({ uid, lifecycleStatus })
      const e = await evaluateDeletionEligibility(uid)
      expect(e.deletable).toBe(false)
      expect(e.blockers.map(b => b.code)).toContain('EVENTS_EXIST')
    }, T)
  }

  const BLOCKERS: [string, () => Promise<unknown>, string][] = [
    ['an unpublished event draft',
      () => user().collection('eventDrafts').doc('d1').set({ draftId: 'd1' }), 'EVENT_DRAFTS_EXIST'],
    ['an unpublished campaign draft',
      () => user().collection('campaignDrafts').doc('c1').set({ id: 'c1' }), 'CAMPAIGN_DRAFTS_EXIST'],
    ['a donation campaign',
      () => adminDb.doc(`donationCampaigns/dc-${Date.now()}`).set({ uid }), 'DONATION_CAMPAIGNS_EXIST'],
    ['a registration',
      () => adminDb.doc(`registrations/r-${Date.now()}`).set({ organizerUid: uid }), 'REGISTRATIONS_EXIST'],
    ['a non-zero wallet balance',
      () => adminDb.doc(`organizerWallets/${uid}`).set({ balancePaise: 1 }), 'WALLET_BALANCE_NONZERO'],
    ['a wallet clawback',
      () => adminDb.doc(`walletClawbacks/wc-${Date.now()}`).set({ organizerUid: uid }), 'WALLET_CLAWBACKS_EXIST'],
    ['a platform transaction',
      () => adminDb.doc(`platformTransactions/pt-${Date.now()}`).set({ organizerUid: uid }), 'PLATFORM_TRANSACTIONS_EXIST'],
    ['a pending settlement',
      () => adminDb.doc(`settlementRequests/s-${Date.now()}`).set({ organizerUid: uid, status: 'pending' }), 'SETTLEMENTS_PENDING'],
    ['an approved settlement (still owed)',
      () => adminDb.doc(`settlementRequests/s2-${Date.now()}`).set({ organizerUid: uid, status: 'approved' }), 'SETTLEMENTS_PENDING'],
    ['an event licence record',
      () => adminDb.doc(`eventLicenses/el-${Date.now()}`).set({ organizerUid: uid }), 'LICENSE_RECORDS_EXIST'],
    ['a team member',
      () => adminDb.doc(`teamMembers/tm-${Date.now()}`).set({ organizerUid: uid }), 'TEAM_MEMBERS_EXIST'],
  ]

  for (const [label, seed, code] of BLOCKERS) {
    it(`${label} BLOCKS deletion (${code})`, async () => {
      await seed()
      const e = await evaluateDeletionEligibility(uid)
      expect(e.deletable, `expected ${code} to block`).toBe(false)
      expect(e.blockers.map(b => b.code)).toContain(code)
      // The reason is a sentence an admin can act on, with no amount or id in it.
      const blocker = e.blockers.find(b => b.code === code)!
      expect(blocker.reason.length).toBeGreaterThan(10)
      expect(blocker.reason).not.toMatch(/\d{3,}/)
    }, T)
  }

  it('a TERMINAL settlement does not block — nothing is owed', async () => {
    await adminDb.doc(`settlementRequests/paid-${Date.now()}`).set({ organizerUid: uid, status: 'paid' })
    await adminDb.doc(`settlementRequests/rej-${Date.now()}`).set({ organizerUid: uid, status: 'rejected' })
    const e = await evaluateDeletionEligibility(uid)
    expect(e.blockers.map(b => b.code)).not.toContain('SETTLEMENTS_PENDING')
    expect(e.deletable).toBe(true)
  }, T)

  it('a ZERO wallet balance does not block', async () => {
    await adminDb.doc(`organizerWallets/${uid}`).set({ balancePaise: 0 })
    const e = await evaluateDeletionEligibility(uid)
    expect(e.blockers.map(b => b.code)).not.toContain('WALLET_BALANCE_NONZERO')
    expect(e.deletable).toBe(true)
  }, T)

  it('reports EVERY blocker at once, not just the first', async () => {
    await adminDb.doc(`events/multi-${uid}`).set({ uid, lifecycleStatus: 'published' })
    await adminDb.doc(`platformTransactions/pt-multi-${uid}`).set({ organizerUid: uid })
    await user().collection('eventDrafts').doc('d9').set({ draftId: 'd9' })
    const e = await evaluateDeletionEligibility(uid)
    const codes = e.blockers.map(b => b.code)
    expect(codes).toContain('EVENTS_EXIST')
    expect(codes).toContain('PLATFORM_TRANSACTIONS_EXIST')
    expect(codes).toContain('EVENT_DRAFTS_EXIST')
  }, T)

  // ═══ 2 · SUCCESSFUL DELETION ═══════════════════════════════════════════════

  it('deletes the organizer-owned records, the profile and the Auth user', async () => {
    // Organizer-owned content across every addressing mode the manifest uses.
    await user().collection('notifications').doc('n1').set({ read: false })
    await user().collection('emailTemplates').doc('welcome').set({ subject: 'hi' })
    await adminDb.doc(`communicationUsage/cu1`).set({ organizerUid: uid })
    await adminDb.doc(`broadcastCampaigns/bc1`).set({ organizerUid: uid })
    await adminDb.doc(`apiKeys/ak1`).set({ organizerUid: uid })
    await adminDb.doc(`organizerAssets/oa1`).set({ organizerUid: uid })
    await adminDb.doc(`mediaSettings/${uid}`).set({ keepOriginal: true })
    await adminDb.doc(`organizerBrandKit/${uid}`).set({ logoUrl: 'x' })
    await adminDb.doc(`organizerLimits/${uid}`).set({ maxRecipients: 10 })
    await adminDb.doc(`organizerPayoutProfiles/${uid}`).set({ isVerified: true })

    expect(await authExists()).toBe(true)

    const r = await runOrganizerDeletion(uid)
    expect(r.finished).toBe(true)
    expect(r.summary.failures, JSON.stringify(r.summary.failures)).toEqual([])
    expect(r.summary.ok).toBe(true)

    for (const path of [
      `users/${uid}`, 'communicationUsage/cu1', 'broadcastCampaigns/bc1', 'apiKeys/ak1',
      'organizerAssets/oa1', `mediaSettings/${uid}`, `organizerBrandKit/${uid}`,
      `organizerLimits/${uid}`, `organizerPayoutProfiles/${uid}`,
    ]) {
      expect((await adminDb.doc(path).get()).exists, `${path} survived`).toBe(false)
    }
    expect((await user().collection('notifications').get()).empty).toBe(true)
    expect((await user().collection('emailTemplates').get()).empty).toBe(true)

    // The irreversible step ran, and it ran last.
    expect(await authExists()).toBe(false)
  }, T)

  it('PRESERVES financial and audit records, and shared platform records', async () => {
    await adminDb.doc('walletTransactions/wt-keep').set({ organizerUid: uid, amountPaise: 500 })
    await adminDb.doc('platformTransactions/pt-keep').set({ organizerUid: 'someone-else' })
    await adminDb.doc('adminAuditLogs/al-keep').set({ organizerUid: uid, action: 'x' })
    await adminDb.doc('payoutProfileHistory/ph-keep').set({ organizerUid: uid })
    await adminDb.doc('globalCertificateTemplates/gt-keep').set({ shared: true })
    await adminDb.doc('platformSettings/ps-keep').set({ shared: true })

    const r = await runOrganizerDeletion(uid)
    expect(r.summary.ok).toBe(true)

    for (const path of [
      'walletTransactions/wt-keep', 'platformTransactions/pt-keep', 'adminAuditLogs/al-keep',
      'payoutProfileHistory/ph-keep', 'globalCertificateTemplates/gt-keep', 'platformSettings/ps-keep',
    ]) {
      expect((await adminDb.doc(path).get()).exists, `${path} was deleted`).toBe(true)
    }
  }, T)

  it('M1.3 · PRESERVES payout transfer-reference records (financial evidence) while still deleting what it always deleted', async () => {
    const ref = `payoutTransferReferences/M13ORGDEL${process.pid}`
    await adminDb.doc(ref).set({ utrNumber: `M13ORGDEL${process.pid}`, settlementId: 'sr-keep', organizerUid: uid, amountPaise: 1_000, recordedVia: 'mark_paid' })
    await adminDb.doc(`apiKeys/ak-m13-${process.pid}`).set({ organizerUid: uid })
    try {
      const r = await runOrganizerDeletion(uid)
      expect(r.summary.ok).toBe(true)
      expect((await adminDb.doc(ref).get()).data()).toMatchObject({ settlementId: 'sr-keep', organizerUid: uid, amountPaise: 1_000 })
      expect((await adminDb.doc(`apiKeys/ak-m13-${process.pid}`).get()).exists).toBe(false)   // unrelated deletion unchanged
      expect((await user().get()).exists).toBe(false)
      expect(await authExists()).toBe(false)
    } finally {
      await adminDb.doc(ref).delete().catch(() => null)
    }
  }, T)

  it('removes staff credentials: the username lock, the Auth user, then the row', async () => {
    const staffUid = `${uid}-staff-1`
    await adminAuth.createUser({ uid: staffUid, email: `gate.one.${process.pid}@staff.invalid`, password: 'StaffPassw0rd!' })
    const username = `gate.one.${process.pid}`
    await adminDb.doc(`staffAccounts/${staffUid}`).set({ staffId: staffUid, organizerUid: uid, username })
    await adminDb.doc(`staffUsernames/${username}`).set({ username, organizerUid: uid })
    await adminDb.doc(`teamMembers/tm-${staffUid}`).set({ organizerUid: uid, staffId: staffUid })

    const r = await runOrganizerDeletion(uid)
    expect(r.summary.failures, JSON.stringify(r.summary.failures)).toEqual([])

    // The global username lock is released — otherwise that username is reserved for nobody.
    expect((await adminDb.doc(`staffUsernames/${username}`).get()).exists).toBe(false)
    expect((await adminDb.doc(`staffAccounts/${staffUid}`).get()).exists).toBe(false)
    expect((await adminDb.doc(`teamMembers/tm-${staffUid}`).get()).exists).toBe(false)
    // A credential that could still authenticate into a workspace that no longer exists.
    let staffAuthAlive = true
    try { await adminAuth.getUser(staffUid) } catch { staffAuthAlive = false }
    expect(staffAuthAlive).toBe(false)
  }, T)

  // ═══ 3 · BATCHING past the Firestore 500-operation limit ═══════════════════

  it('deletes more than 500 documents in one collection', async () => {
    // 620 > 500, so a single batch would be a hard Firestore error rather than a slow path.
    const TOTAL = 620
    for (let i = 0; i < TOTAL; i += 400) {
      const batch = adminDb.batch()
      for (let j = i; j < Math.min(i + 400, TOTAL); j++) {
        batch.set(adminDb.doc(`communicationUsage/bulk-${uid}-${j}`), { organizerUid: uid, n: j })
      }
      await batch.commit()
    }
    const before = await adminDb.collection('communicationUsage').where('organizerUid', '==', uid).count().get()
    expect(before.data().count).toBe(TOTAL)

    const r = await runOrganizerDeletion(uid)
    expect(r.finished).toBe(true)
    expect(r.summary.failures, JSON.stringify(r.summary.failures)).toEqual([])

    const after = await adminDb.collection('communicationUsage').where('organizerUid', '==', uid).count().get()
    expect(after.data().count).toBe(0)
    expect(r.summary.deleted).toBeGreaterThanOrEqual(TOTAL)
  }, T)

  // ═══ 4 · AUTH IS LAST, and interruption resumes ════════════════════════════

  it('an interrupted run leaves the Auth user intact, and resuming finishes it', async () => {
    await adminDb.doc('communicationUsage/resume-1').set({ organizerUid: uid })
    await adminDb.doc(`mediaSettings/${uid}`).set({ keepOriginal: true })

    const manifest = buildOrganizerDeletionManifest(uid)
    // Stop well before the end. The Auth step is LAST, so a truncated run must not reach it.
    const partial = await runOrganizerDeletion(uid, 3)
    expect(partial.finished).toBe(false)
    // Never reported as clean.
    expect(partial.summary.ok).toBe(false)
    expect(partial.progress.step).toBeLessThan(manifest.length)

    // THE PROPERTY THAT MATTERS: the identity still exists, so the account is still
    // attributable and the job is still re-runnable.
    expect(await authExists()).toBe(true)
    expect((await user().get()).exists).toBe(true)

    // Resume from the committed progress rather than from zero.
    const resumed = await runOrganizerDeletion(uid, 400, partial.progress)
    expect(resumed.finished).toBe(true)
    expect(resumed.summary.failures, JSON.stringify(resumed.summary.failures)).toEqual([])
    expect((await user().get()).exists).toBe(false)
    expect(await authExists()).toBe(false)
  }, T)

  it('resuming from a LOST cursor still completes (a re-run from zero is safe)', async () => {
    await adminDb.doc('apiKeys/lost-cursor').set({ organizerUid: uid })
    const first = await runOrganizerDeletion(uid, 2)
    expect(first.finished).toBe(false)

    // Cursor discarded — the worst case for a resumable job. Every completed step must advance
    // immediately against data that is already gone.
    const again = await runOrganizerDeletion(uid)
    expect(again.finished).toBe(true)
    expect(again.summary.failures).toEqual([])
    expect(await authExists()).toBe(false)
  }, T)

  it('is idempotent — running it again after completion changes nothing and still succeeds', async () => {
    await adminDb.doc('apiKeys/idem').set({ organizerUid: uid })
    const first = await runOrganizerDeletion(uid)
    expect(first.summary.ok).toBe(true)
    expect(await authExists()).toBe(false)

    // Every step is a no-op: a missing document, a missing object and a missing Auth user are
    // all successes, which is what makes a retry safe after a partial failure.
    const second = await runOrganizerDeletion(uid)
    expect(second.finished).toBe(true)
    expect(second.summary.failures, JSON.stringify(second.summary.failures)).toEqual([])
    expect(second.summary.ok).toBe(true)
  }, T)

  it('never deletes ANOTHER organizer’s data', async () => {
    const other = `${uid}-bystander`
    await adminDb.doc(`users/${other}`).set({ uid: other, name: 'Bystander' })
    await adminDb.doc('communicationUsage/other-cu').set({ organizerUid: other })
    await adminDb.doc(`mediaSettings/${other}`).set({ keepOriginal: true })
    await adminDb.doc('communicationUsage/mine-cu').set({ organizerUid: uid })

    const r = await runOrganizerDeletion(uid)
    expect(r.summary.ok).toBe(true)

    expect((await adminDb.doc('communicationUsage/mine-cu').get()).exists).toBe(false)
    // The bystander is untouched, including a doc keyed by THEIR uid in a per-uid collection.
    expect((await adminDb.doc(`users/${other}`).get()).exists).toBe(true)
    expect((await adminDb.doc('communicationUsage/other-cu').get()).exists).toBe(true)
    expect((await adminDb.doc(`mediaSettings/${other}`).get()).exists).toBe(true)

    await adminDb.doc(`users/${other}`).delete().catch(() => null)
    await adminDb.doc('communicationUsage/other-cu').delete().catch(() => null)
    await adminDb.doc(`mediaSettings/${other}`).delete().catch(() => null)
  }, T)
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY · the endpoint's authorization, exercised at RUNTIME
// ═══════════════════════════════════════════════════════════════════════════════
//
// The unit suite asserts the SOURCE contract (admin verifier present, no verifyCaller, uid from
// the route). That proves the code was written correctly. These prove it BEHAVES correctly: a
// real organizer's real ID token, minted by the Auth emulator, is handed to the real handler.
//
// The distinction matters because the failure mode is silent. A route that read the body, or
// accepted any authenticated caller, would pass every source assertion while being wide open.

describeEmu('RD-ORGANIZER-REMAINING-ALL · the delete endpoint refuses everyone but an admin', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let GET: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
  let DELETE: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>

  const VICTIM_EMAIL = `orgdel-victim-${process.pid}@rd.test`
  const ADMIN_EMAIL  = `orgdel-admin-${process.pid}@rd.test`
  let victimUid = ''
  let adminUid  = ''
  let savedAdminUids: string | undefined
  const REASON = `Organizer requested account closure (test ${process.pid})`

  /** A real ID token for `u`, through the Auth emulator. */
  async function idToken(u: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(u)
    const key  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res  = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  const call = async (
    verb: 'GET' | 'DELETE',
    targetUid: string,
    authHeader?: string,
    body?: unknown,
  ) => {
    // RD-PREPROD · D3 — DELETE requires a written reason; every DELETE carries one unless a
    // test passes its own body (or `null` for none at all).
    const payload = verb === 'DELETE' && body === undefined ? { reason: REASON } : body
    const req = new Request(`http://localhost/api/admin/organizers/${targetUid}/delete`, {
      method: verb,
      headers: authHeader ? { Authorization: authHeader } : {},
      ...(payload !== undefined && payload !== null ? { body: JSON.stringify(payload) } : {}),
    })
    const handler = verb === 'GET' ? GET : DELETE
    const res = await handler(req as never, { params: Promise.resolve({ uid: targetUid }) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  const authAlive = async (u: string) => {
    try { await adminAuth.getUser(u); return true } catch { return false }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ GET, DELETE } = await import('@/app/api/admin/organizers/[uid]/delete/route') as never)

    const victim = await adminAuth.createUser({ email: VICTIM_EMAIL, password: 'VictimPassw0rd!' })
    victimUid = victim.uid
    const admin = await adminAuth.createUser({ email: ADMIN_EMAIL, password: 'AdminPassw0rd!' })
    adminUid = admin.uid
    // The claim `resolveAdminUid` accepts. Set server-side, exactly as production does.
    await adminAuth.setCustomUserClaims(adminUid, { admin: true })
    // RD-INTEG — DELETE is Super Admin only: the admin is also in ADMIN_UIDS (deployment config).
    savedAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = adminUid

    await adminDb.doc(`users/${victimUid}`).set({
      uid: victimUid, name: 'Victim', email: VICTIM_EMAIL,
      organizationName: 'Victim Co', role: 'organizer', accountStatus: 'active',
    })
  }, T)

  afterAll(async () => {
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
    for (const u of [victimUid, adminUid]) {
      if (!u) continue
      await adminDb.doc(`users/${u}`).delete().catch(() => null)
      await adminDb.doc(`organizerDeletionJobs/orgdel_${u}`).delete().catch(() => null)
      await adminAuth.deleteUser(u).catch(() => null)
    }
  }, T)

  it('refuses an unauthenticated caller on both verbs', async () => {
    expect((await call('DELETE', victimUid)).status).toBe(403)
    expect((await call('GET', victimUid)).status).toBe(403)
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
  }, T)

  // RD-SEC-01 · was "may read eligibility but NOT delete": the claim-only "plain admin" tier is
  // gone (two roles only), so it reads nothing either.
  it('a legacy-claim-only admin (not in ADMIN_UIDS) may neither read eligibility nor delete', async () => {
    const token = await idToken(adminUid)
    const saved = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = 'someone-else'
    try {
      expect((await call('GET', victimUid, `Bearer ${token}`)).status).toBe(403)
      const r = await call('DELETE', victimUid, `Bearer ${token}`)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('SUPER_ADMIN_REQUIRED')
      expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
    } finally { process.env.ADMIN_UIDS = saved }
  }, T)

  it('refuses a garbage bearer token', async () => {
    expect((await call('DELETE', victimUid, 'Bearer not-a-real-token')).status).toBe(403)
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
  }, T)

  it('refuses a real ORGANIZER token, even for their OWN account', async () => {
    // The whole reason deletion moved behind an admin: an organizer must not be able to bypass
    // the eligibility rules by deleting themselves.
    const token = await idToken(victimUid)
    expect((await call('DELETE', victimUid, `Bearer ${token}`)).status).toBe(403)
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
    expect(await authAlive(victimUid)).toBe(true)
  }, T)

  it('refuses one organizer trying to delete ANOTHER account', async () => {
    const token = await idToken(victimUid)
    expect((await call('DELETE', adminUid, `Bearer ${token}`)).status).toBe(403)
    expect(await authAlive(adminUid)).toBe(true)
  }, T)

  it('an admin can read the verdict for the ROUTE target', async () => {
    const token = await idToken(adminUid)
    const r = await call('GET', victimUid, `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(r.body.uid).toBe(victimUid)
    expect(r.body.deletable).toBe(true)
  }, T)

  it('a forged BODY cannot redirect the DELETE to another account', async () => {
    // Run against an INELIGIBLE victim so the request is refused either way — what is being
    // tested is WHOSE eligibility was evaluated, not whether a deletion happened. If the body
    // could redirect the target, the blockers would describe 'someone-else' (who has none) and
    // the call would have proceeded instead of returning the victim's own blocker.
    await adminDb.doc(`events/forge-${victimUid}`).set({ uid: victimUid, lifecycleStatus: 'published' })
    const token = await idToken(adminUid)
    const r = await call('DELETE', victimUid, `Bearer ${token}`, { uid: 'someone-else', organizerUid: 'someone-else', reason: REASON })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body.blockers)).toContain('EVENTS_EXIST')
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
    expect(await authAlive(victimUid)).toBe(true)
    await adminDb.doc(`events/forge-${victimUid}`).delete()
  }, T)

  it('an admin cannot delete their own account through this endpoint', async () => {
    const token = await idToken(adminUid)
    const r = await call('DELETE', adminUid, `Bearer ${token}`)
    expect(r.status).toBe(409)
    expect(String(r.body.error)).toMatch(/own account/i)
    expect(await authAlive(adminUid)).toBe(true)
  }, T)

  it('an admin is refused for an INELIGIBLE organizer, with the reasons, and nothing is touched', async () => {
    await adminDb.doc(`events/blocker-${victimUid}`).set({ uid: victimUid, lifecycleStatus: 'archived' })
    const token = await idToken(adminUid)
    const r = await call('DELETE', victimUid, `Bearer ${token}`)
    expect(r.status).toBe(409)
    expect(r.body.deletable).toBe(false)
    expect(JSON.stringify(r.body.blockers)).toContain('EVENTS_EXIST')
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
    expect(await authAlive(victimUid)).toBe(true)
    await adminDb.doc(`events/blocker-${victimUid}`).delete()
  }, T)

  it('D3 · a DELETE without a usable reason is refused (400) and nothing is touched', async () => {
    const token = await idToken(adminUid)
    for (const body of [null, {}, { reason: '  ' }, { reason: 'no' }, { reason: 'x'.repeat(501) }]) {
      const r = await call('DELETE', victimUid, `Bearer ${token}`, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(String(r.body.code)).toMatch(/^REASON_/)
    }
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(true)
    expect(await authAlive(victimUid)).toBe(true)
    // No job was created and no audit row was written for a refused request.
    expect((await adminDb.doc(`organizerDeletionJobs/orgdel_${victimUid}`).get()).exists).toBe(false)
    const rows = await adminDb.collection('adminAuditLogs').where('entityId', '==', victimUid).get()
    expect(rows.size).toBe(0)
  }, T)

  it('an admin CAN delete an eligible organizer, end to end', async () => {
    const token = await idToken(adminUid)
    const r = await call('DELETE', victimUid, `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    expect((await adminDb.doc(`users/${victimUid}`).get()).exists).toBe(false)
    expect(await authAlive(victimUid)).toBe(false)
  }, T)

  it('D3 · the deletion left a durable audit trail: actor, organizer, reason, time, result', async () => {
    const rows = (await adminDb.collection('adminAuditLogs').where('entityId', '==', victimUid).get())
      .docs.map(d => d.data())
    const requested = rows.find(r => r.action === 'organizer.deletion_requested')
    const result    = rows.find(r => r.action === 'organizer.deletion_result')
    for (const row of [requested, result]) {
      expect(row).toBeTruthy()
      expect(row!.adminUid).toBe(adminUid)
      expect(row!.actorRole).toBe('super_admin')
      expect(row!.entityType).toBe('organizer')
      expect(row!.reason).toBe(REASON)
      expect(row!.createdAt).toBeTruthy()
    }
    expect(result!.metadata.outcome).toBe('completed')
    expect(result!.metadata.failureCount).toBe(0)
    // Nothing sensitive about the deleted organizer is copied into the log.
    expect(JSON.stringify(rows)).not.toContain(VICTIM_EMAIL)
    expect(JSON.stringify(rows)).not.toContain('Victim Co')
  }, T)

  it('a repeated delete after completion is 404, not a second success', async () => {
    const token = await idToken(adminUid)
    expect((await call('DELETE', victimUid, `Bearer ${token}`)).status).toBe(404)
  }, T)
})
