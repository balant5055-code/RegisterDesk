// RD-ORGANIZER-SIGNUP-02 — pending → active against REAL Firestore.
//
// The unit suite pins the source contract; this one pins the BEHAVIOUR, because the
// thing that matters most about the activation is that it rides inside the OTP
// verification transaction. A transaction either commits both halves or neither, and
// that property cannot be observed by reading the file — only by verifying a real code
// against a real document and reading back what actually landed.
//
// What each case proves:
//   G  a correct code promotes the pending row AND records the verification, together
//   H  a wrong code leaves the row pending, and consumes exactly one attempt
//   I  an expired code leaves the row pending
//   J  a replay of an already-verified OTP cannot activate anything a second time
//   +  a suspended document survives a verification untouched (moderation is not undone)
//
// Everything is driven through the real route handler, so the guards, the attempt
// accounting and the transaction are the production ones.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-ORGANIZER-SIGNUP-02 · pending → active', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let POST: (req: Request) => Promise<Response>
  let hashCode: (code: string, salt: string) => string
  let generateSalt: () => string

  const EMAIL = `signup-lifecycle-${process.pid}@rd.test`
  let uid = ''
  const CODE = '123456'
  let salt = ''

  /** A real ID token for `uid`, minted through the Auth emulator. */
  async function idToken(): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  /** Writes a fresh OTP document and returns its id. */
  async function seedOtp(opts: { expired?: boolean; verified?: boolean; attempts?: number } = {}) {
    salt = generateSalt()
    const ref = adminDb.collection('otpRequests').doc()
    await ref.set({
      uid, channel: 'email', recipient: EMAIL,
      codeHash: hashCode(CODE, salt), salt,
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 10 * 60_000)),
      attempts: opts.attempts ?? 0,
      verified: opts.verified ?? false,
      verifiedAt: null, createdAt: new Date(), ip: 'test',
    })
    return ref.id
  }

  /** Puts users/{uid} back into the state a fresh signup leaves behind. */
  async function seedPendingProfile(overrides: Record<string, unknown> = {}) {
    await adminDb.doc(`users/${uid}`).set({
      uid, name: 'Lifecycle Tester', email: EMAIL, organizationName: 'Lifecycle Co',
      role: 'organizer',
      accountStatus: 'pending',
      emailVerified: false,
      verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } },
      trust: { level: 'unverified', score: 0, badges: [] },
      createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    })
  }

  const verify = async (otpId: string) => {
    const token = await idToken()
    const req = new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ otpId, code: CODE }),
    })
    const res = await POST(req as never)
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const wrongCode = async (otpId: string) => {
    const token = await idToken()
    const req = new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ otpId, code: '000000' }),
    })
    const res = await POST(req as never)
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const profile = async () => (await adminDb.doc(`users/${uid}`).get()).data()!

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ POST } = await import('@/app/api/auth/verify-otp/route') as never)
    ;({ hashCode, generateSalt } = await import('@/lib/otp'))

    const user = await adminAuth.createUser({ email: EMAIL, password: 'LifecyclePassw0rd!', emailVerified: false })
    uid = user.uid
  }, T)

  afterAll(async () => {
    if (!uid) return
    for (const d of (await adminDb.collection('otpRequests').where('uid', '==', uid).get()).docs) await d.ref.delete()
    await adminDb.doc(`users/${uid}`).delete().catch(() => null)
    await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  beforeEach(async () => {
    await adminAuth.updateUser(uid, { emailVerified: false })
    await seedPendingProfile()
  })

  it('G · a correct code activates the row and records the verification in one commit', async () => {
    const otpId = await seedOtp()
    const before = await profile()
    expect(before.accountStatus).toBe('pending')

    const { status, body } = await verify(otpId)
    expect(status).toBe(200)
    expect(body.verified).toBe(true)

    const after = await profile()
    expect(after.accountStatus).toBe('active')
    // …and the verification landed in the SAME commit — both halves or neither.
    expect(after.emailVerified).toBe(true)
    expect((after.verification as { email: { verified: boolean } }).email.verified).toBe(true)
    expect((after.trust as { level: string }).level).toBe('email_verified')
  }, T)

  it('H · a wrong code leaves the row pending and consumes exactly one attempt', async () => {
    const otpId = await seedOtp()
    const { status, body } = await wrongCode(otpId)
    expect(status).toBe(400)
    expect(body.error).toBe('INVALID_CODE')

    const after = await profile()
    expect(after.accountStatus).toBe('pending')
    expect(after.emailVerified).toBe(false)
    const otp = (await adminDb.doc(`otpRequests/${otpId}`).get()).data()!
    expect(otp.attempts).toBe(1)
    expect(otp.verified).toBe(false)
  }, T)

  it('I · an expired code leaves the row pending', async () => {
    const otpId = await seedOtp({ expired: true })
    const { status, body } = await verify(otpId)
    expect(status).toBe(400)
    expect(body.error).toBe('EXPIRED')

    const after = await profile()
    expect(after.accountStatus).toBe('pending')
    expect(after.emailVerified).toBe(false)
  }, T)

  it('J · replaying an already-verified OTP cannot activate a second time', async () => {
    const otpId = await seedOtp()
    expect((await verify(otpId)).status).toBe(200)
    expect((await profile()).accountStatus).toBe('active')

    // Put the row back to pending and replay the SAME, now-consumed OTP.
    await seedPendingProfile()
    const replay = await verify(otpId)
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe('ALREADY_VERIFIED')
    expect((await profile()).accountStatus).toBe('pending')
  }, T)

  it('an OTP issued to another uid cannot activate this account', async () => {
    const otpId = await seedOtp()
    await adminDb.doc(`otpRequests/${otpId}`).update({ uid: 'someone-else' })
    const { status, body } = await verify(otpId)
    expect(status).toBe(403)
    expect(body.error).toBe('FORBIDDEN')
    expect((await profile()).accountStatus).toBe('pending')
  }, T)

  it('a suspended document is NOT reactivated by a successful verification', async () => {
    // Moderation must survive an OTP: the promotion is conditional on the stored value
    // being 'pending', so a suspended account verifies its email and stays suspended.
    await seedPendingProfile({ accountStatus: 'suspended', statusReason: 'test' })
    const otpId = await seedOtp()
    expect((await verify(otpId)).status).toBe(200)

    const after = await profile()
    expect(after.accountStatus).toBe('suspended')
    expect(after.emailVerified).toBe(true)          // the verification itself still applies
  }, T)

  it('D · a pre-existing (already verified) organizer with NO accountStatus is left without one', async () => {
    // Backward compatibility: these documents predate the field, read as active through
    // the resolver, and this phase must not back-fill them. RD-PHASE4 signup transition:
    // "pre-existing" means ALREADY VERIFIED — a never-verified one is a new signup (D2).
    await seedPendingProfile({ emailVerified: true })
    const { FieldValue } = await import('firebase-admin/firestore')
    await adminDb.doc(`users/${uid}`).update({ accountStatus: FieldValue.delete() })
    expect((await profile()).accountStatus).toBeUndefined()

    const otpId = await seedOtp()
    expect((await verify(otpId)).status).toBe(200)

    const after = await profile()
    expect(after.accountStatus).toBeUndefined()     // still absent — nothing was invented
    expect(after.emailVerified).toBe(true)
    const { resolveAccountStatus } = await import('@/lib/admin/organizerTypes')
    expect(resolveAccountStatus(after.accountStatus)).toBe('active')
  }, T)

  it('D2 · a NEVER-verified profile with no accountStatus (older app bundle) is activated by the OTP', async () => {
    // RD-PHASE4 signup transition: the transitional create rule accepts this shape.
    await seedPendingProfile()
    const { FieldValue } = await import('firebase-admin/firestore')
    await adminDb.doc(`users/${uid}`).update({ accountStatus: FieldValue.delete() })
    const bad = await seedOtp({ expired: true })
    expect((await verify(bad)).status).toBe(400)                       // a failed attempt activates nothing
    expect((await profile()).accountStatus).toBeUndefined()
    const otpId = await seedOtp()
    expect((await verify(otpId)).status).toBe(200)
    const after = await profile()
    expect(after.accountStatus).toBe('active')
    expect(after.emailVerified).toBe(true)
    expect(after.verification).toMatchObject({ email: { verified: true, verifiedMethod: 'otp' } })
  }, T)

  it('D2 · the orphan-profile flow is unchanged: no profile ⇒ a complete, active profile', async () => {
    await adminDb.doc(`users/${uid}`).delete()
    const otpId = await seedOtp()
    expect((await verify(otpId)).status).toBe(200)
    const after = await profile()
    expect(after).toMatchObject({ accountStatus: 'active', emailVerified: true, role: 'organizer' })
  }, T)

  // ═══ RD-ORGANIZER-SIGNUP-FIX-02 · D3 ══════════════════════════════════════
  //
  // Moderation used to accept `reactivate` from ANY status, pending included. That wrote
  // accountStatus: 'active' onto an account whose email was still unverified — and since
  // nothing anywhere writes 'pending' back, it was unrecoverable. The unit suite pins the
  // guard's source; these pin that the real service actually refuses, and that suspend
  // still works on the same document (the guard names reactivate only, on purpose).

  it('D3 · reactivate is REFUSED for a pending signup, and changes nothing', async () => {
    const { setOrganizerAccountStatus } = await import('@/lib/admin/organizerService')
    const before = await profile()
    expect(before.accountStatus).toBe('pending')

    const res = await setOrganizerAccountStatus(uid, 'reactivate', 'admin-test-uid', '')
    expect(res.ok).toBe(false)
    expect(res.invalidTransition).toBe(true)
    expect(res.accountStatus).toBe('pending')

    // The write must not have happened at all — not the status, and not the audit stamp
    // a successful moderation leaves behind.
    const after = await profile()
    expect(after.accountStatus).toBe('pending')
    expect(after.statusUpdatedBy).toBeUndefined()
    expect((await adminAuth.getUser(uid)).emailVerified).toBe(false)
  }, T)

  it('D3 · suspend is still allowed for a pending signup', async () => {
    // An abusive signup has to be stoppable before it verifies. If the guard were widened
    // to every action, this is the capability it would silently remove.
    const { setOrganizerAccountStatus } = await import('@/lib/admin/organizerService')
    const res = await setOrganizerAccountStatus(uid, 'suspend', 'admin-test-uid', 'audit test')
    expect(res.ok).toBe(true)
    expect((await profile()).accountStatus).toBe('suspended')
  }, T)

  it('D3 · and a genuinely suspended organizer CAN still be reactivated', async () => {
    // The fix must not cost the feature its actual purpose.
    const { setOrganizerAccountStatus } = await import('@/lib/admin/organizerService')
    await seedPendingProfile({ accountStatus: 'suspended', statusReason: 'audit test' })
    const res = await setOrganizerAccountStatus(uid, 'reactivate', 'admin-test-uid', '')
    expect(res.ok).toBe(true)
    expect((await profile()).accountStatus).toBe('active')
  }, T)

  it('D3 · the OTP is still the one route out of pending', async () => {
    // With reactivate closed, verification is the ONLY path — so it had better work.
    expect((await profile()).accountStatus).toBe('pending')
    const otpId = await seedOtp()
    expect((await verify(otpId)).status).toBe(200)
    expect((await profile()).accountStatus).toBe('active')
  }, T)
})
