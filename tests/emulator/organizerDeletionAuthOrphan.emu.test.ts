// RD-ORGDEL-AUTH-01 — a failed Firebase Auth deletion must stay RESUMABLE.
//
// ═══ THE DEFECT THESE CASES PIN ══════════════════════════════════════════════
// The Auth delete is the last manifest step and it is irreversible. Everything before it
// has already run, including `users/{uid}`. If that final step fails, three things used to
// conspire to make the failure permanent and invisible:
//
//   1. `driveOrganizerDeletion` committed `finished: true` as soon as the manifest ended,
//      regardless of `progress.failures`. The kernel turns `finished` into status
//      'completed' (lib/jobs/kernel.ts), and `leaseJob` refuses to lease a completed job —
//      so the job could never be resumed.
//   2. A failing step ADVANCED the cursor (correct for bulk steps: one unreachable
//      collection must not wedge the rest), so even a resumable job would restart past the
//      Auth step, find nothing to do, and report a clean deletion.
//   3. The route's `!eligibility.exists → 404` gate reads `users/{uid}` — which the
//      manifest deletes immediately BEFORE the Auth step — so a retry 404'd before
//      reaching the job at all.
//
// The observable result was a Firebase Auth orphan: the organizer's data was gone, the
// email stayed unusable (EMAIL_EXISTS on the next signup), and the retry reported success.
//
// These cases drive the REAL kernel and the REAL executor. The Auth failure is injected by
// stubbing exactly one method on the Admin Auth instance, so everything else — the lease,
// the fencing, the cursor, the manifest — is production code.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-ORGDEL-AUTH-01 · a failed Auth deletion stays resumable', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let driveOrganizerDeletion: typeof import('@/lib/admin/organizerDeletion').driveOrganizerDeletion
  let evaluateDeletionEligibility: typeof import('@/lib/admin/organizerDeletion').evaluateDeletionEligibility
  let ORGANIZER_DELETION_JOBS: string
  let getJob: typeof import('@/lib/jobs/kernel').getJob

  const EMAIL = `orgdel-auth-${process.pid}@rd.test`
  const ADMIN_UID = 'orgdel-auth-admin'
  let uid = ''

  /** Replace adminAuth.deleteUser for the duration of one call. Returns a restore fn. */
  function stubAuthDelete(impl: (u: string) => Promise<void>): () => void {
    const target = adminAuth as unknown as { deleteUser: (u: string) => Promise<void> }
    const original = target.deleteUser.bind(adminAuth)
    target.deleteUser = impl
    return () => { target.deleteUser = original }
  }

  const authAlive = async () => {
    try { await adminAuth.getUser(uid); return true } catch { return false }
  }
  const profileAlive = async () => (await adminDb.doc(`users/${uid}`).get()).exists
  const jobDoc = async () => getJob(ORGANIZER_DELETION_JOBS, `orgdel_${uid}`)

  /** An eligible organizer: a real Auth user + the canonical profile, nothing blocking. */
  async function seedOrganizer() {
    const existing = await adminAuth.getUserByEmail(EMAIL).catch(() => null)
    if (existing) await adminAuth.deleteUser(existing.uid).catch(() => null)
    const u = await adminAuth.createUser({ email: EMAIL, password: 'OrgDelPassw0rd!', emailVerified: true })
    uid = u.uid
    await adminDb.doc(`users/${uid}`).set({
      uid, name: 'OrgDel Auth', email: EMAIL, organizationName: 'OrgDel Co',
      role: 'organizer', accountStatus: 'active', emailVerified: true,
      verification: { email: { verified: true, verifiedAt: null, verifiedMethod: 'otp' } },
      trust: { level: 'email_verified', score: 45, badges: [] },
      createdAt: new Date(), updatedAt: new Date(),
    })
    await adminDb.doc(`organizerDeletionJobs/orgdel_${uid}`).delete().catch(() => null)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ driveOrganizerDeletion, evaluateDeletionEligibility } = await import('@/lib/admin/organizerDeletion'))
    ;({ ORGANIZER_DELETION_JOBS } = await import('@/lib/admin/organizerDeletionManifest'))
    ;({ getJob } = await import('@/lib/jobs/kernel'))
  }, T)

  beforeEach(async () => { await seedOrganizer() }, T)

  afterAll(async () => {
    if (!uid) return
    await adminDb.doc(`users/${uid}`).delete().catch(() => null)
    await adminDb.doc(`organizerDeletionJobs/orgdel_${uid}`).delete().catch(() => null)
    await adminAuth.deleteUser(uid).catch(() => null)
    const stray = await adminAuth.getUserByEmail(EMAIL).catch(() => null)
    if (stray) await adminAuth.deleteUser(stray.uid).catch(() => null)
  }, T)

  // ─── 1 · the happy path still removes the Auth user ─────────────────────────

  it('1 · a successful deletion removes the Firebase Auth user', async () => {
    const r = await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID })
    expect(r.outcome).toBe('completed')
    expect(r.failures).toEqual([])
    expect(await profileAlive()).toBe(false)
    expect(await authAlive()).toBe(false)
  }, T)

  // ─── 2 · a failed Auth delete must not look complete ────────────────────────

  it('2 · an Auth failure does NOT report completion, and does not close the job', async () => {
    const restore = stubAuthDelete(async () => { throw new Error('simulated transient Auth outage') })
    let r: Awaited<ReturnType<typeof driveOrganizerDeletion>>
    try { r = await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID }) } finally { restore() }

    expect(r!.outcome).not.toBe('completed')
    expect(r!.failures.join(' ')).toMatch(/authUser/)

    // The Firestore side did its job — that is what makes the next assertion matter.
    expect(await profileAlive()).toBe(false)
    // The Auth user is still there, so the deletion is genuinely incomplete …
    expect(await authAlive()).toBe(true)
    // … and the job MUST NOT be terminal, or it can never be resumed.
    const job = await jobDoc()
    expect(job?.status, 'the job was closed with a failed step — the orphan is now permanent').not.toBe('completed')
  }, T)

  // ─── 3 · retry after a transient failure succeeds ───────────────────────────

  it('3 · retrying after a transient Auth failure completes the deletion', async () => {
    const restore = stubAuthDelete(async () => { throw new Error('simulated transient Auth outage') })
    try { await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID }) } finally { restore() }
    expect(await authAlive()).toBe(true)

    // Auth recovers; the same job is driven again and must finish the one remaining step.
    const again = await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID })
    expect(again.outcome).toBe('completed')
    expect(again.failures).toEqual([])
    expect(await authAlive()).toBe(false)
    expect((await jobDoc())?.status).toBe('completed')
  }, T)

  // ─── 4 · retry when the Auth user is already gone is idempotent ─────────────

  it('4 · retrying when the Auth user is already absent is idempotent', async () => {
    // Delete the Auth user out from under the job, then run: user-not-found is a terminal
    // success, not an error — the account is gone, which is the goal.
    await adminAuth.deleteUser(uid)
    const r = await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID })
    expect(r.outcome).toBe('completed')
    expect(r.failures).toEqual([])
    expect(await authAlive()).toBe(false)

    // And a third run over a completed job is still not an error.
    const third = await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID })
    expect(third.outcome).toBe('already_completed')
  }, T)

  // ─── 5 · the orphan is discoverable after users/{uid} is gone ───────────────

  it('5 · an interrupted deletion is still recognisable once users/{uid} is gone', async () => {
    const restore = stubAuthDelete(async () => { throw new Error('simulated transient Auth outage') })
    try { await driveOrganizerDeletion({ uid, adminUid: ADMIN_UID }) } finally { restore() }

    // This is the state that used to be a dead end: the eligibility probe reads users/{uid},
    // which is already deleted, so the route answered 404 "nothing left to delete" while an
    // Auth orphan survived. The job document is what makes the truth recoverable.
    const elig = await evaluateDeletionEligibility(uid)
    expect(elig.exists).toBe(false)

    const job = await jobDoc()
    expect(job, 'no job document — an interrupted deletion would be unrecoverable').toBeTruthy()
    expect(job?.status).not.toBe('completed')
    expect(await authAlive()).toBe(true)
  }, T)

  // ─── 7 · the ROUTE can resume, instead of answering 404 ─────────────────────

  it('7 · the admin route RESUMES an interrupted deletion instead of 404-ing', async () => {
    const { DELETE } = await import('@/app/api/admin/organizers/[uid]/delete/route') as unknown as {
      DELETE: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
    }

    const admin = await adminAuth.createUser({
      email: `orgdel-auth-adm-${process.pid}-${Date.now()}@rd.test`,
      password: 'OrgDelAdm1n!', emailVerified: true,
    })
    await adminAuth.setCustomUserClaims(admin.uid, { admin: true })
    // RD-INTEG — DELETE is Super Admin only (ADMIN_UIDS); restored in the finally below.
    const savedAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = admin.uid
    const custom = await adminAuth.createCustomToken(admin.uid)
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const key  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'
    const signIn = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    const token = (await signIn.json() as { idToken: string }).idToken

    const call = async () => {
      const res = await DELETE(
        new Request(`http://localhost/api/admin/organizers/${uid}/delete`, {
          method: 'DELETE', headers: { authorization: `Bearer ${token}` },
          // RD-PREPROD · D3 — DELETE requires a written reason.
          body: JSON.stringify({ reason: 'Interrupted deletion — resume test' }),
        }) as never,
        { params: Promise.resolve({ uid }) },
      )
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }

    try {
      // First request: everything deletes except Auth.
      const restore = stubAuthDelete(async () => { throw new Error('simulated transient Auth outage') })
      let first
      try { first = await call() } finally { restore() }

      // Partial work must NOT be reported as success.
      expect(first.status).not.toBe(200)
      expect(first.body.success).not.toBe(true)
      expect(await profileAlive()).toBe(false)
      expect(await authAlive()).toBe(true)

      // Second request: users/{uid} is gone, so the eligibility probe says "does not exist".
      // The route used to answer 404 here and strand the Auth orphan for ever.
      const second = await call()
      expect(second.status).toBe(200)
      expect(second.body.success).toBe(true)
      expect(second.body.resumed).toBe(true)
      expect(await authAlive()).toBe(false)

      // Third request: now genuinely nothing left — 404 is the honest answer again, and it
      // must NOT be a second success.
      const third = await call()
      expect(third.status).toBe(404)
      expect(third.body.success).not.toBe(true)
    } finally {
      if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
      await adminAuth.deleteUser(admin.uid).catch(() => null)
    }
  }, T)

  // ─── 6 · financial / audit retention is unchanged ───────────────────────────

  it('6 · retained financial collections are still never in the plan', async () => {
    const { buildOrganizerDeletionManifest, ORGANIZER_RETAINED_COLLECTIONS } =
      await import('@/lib/admin/organizerDeletionManifest')
    const plan = buildOrganizerDeletionManifest(uid)
    const touched = new Set(plan.map(s => ('collection' in s ? s.collection : s.label)))
    for (const retained of ORGANIZER_RETAINED_COLLECTIONS) {
      expect(touched.has(retained), `${retained} must never be deleted`).toBe(false)
    }
    // And the irreversible step is still last.
    expect(plan[plan.length - 1]!.kind).toBe('auth')
    expect(plan[plan.length - 2]!.label).toBe('userProfile')
  }, T)
})
