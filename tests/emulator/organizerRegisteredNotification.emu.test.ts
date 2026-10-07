// RD-ORGANIZER-NOTIFY-03 — WHEN the admin notice is sent, against real Firestore.
//
// The unit suite proves what the email says and where the dispatch sits in the source.
// What it cannot prove is the thing that actually matters operationally: that the notice
// follows a COMMITTED activation and nothing else. That is behaviour — it depends on the
// transaction outcome, on the stored lifecycle state, and on the route's control flow —
// so it is exercised here through the real handler with a real OTP document.
//
// The notification engine is stubbed at the module boundary (vi.mock) purely to OBSERVE
// dispatches; every other layer — Auth, Firestore, the transaction, the route — is real.
// Stubbing the transport is what makes "was it sent, and how many times" answerable at
// all; stubbing anything below it would make the answer meaningless.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

/** Every notification the route dispatched during a test. */
const sent: { type: string; payload: Record<string, unknown> }[] = []
let engineAvailable = true
let sendBehaviour: 'ok' | 'reject' = 'ok'

vi.mock('@/lib/notifications', async (orig) => {
  const actual = await orig() as Record<string, unknown>
  return {
    ...actual,
    notificationEngine: {
      isAvailable: () => engineAvailable,
      send: async (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload })
        if (sendBehaviour === 'reject') throw new Error('provider down')
        return { success: true }
      },
    },
  }
})

describeEmu('RD-ORGANIZER-NOTIFY-03 · admin notice follows a committed activation', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let POST: (req: Request) => Promise<Response>
  let hashCode: (code: string, salt: string) => string
  let generateSalt: () => string

  const EMAIL = `notify-03-${process.pid}@rd.test`
  const CODE  = '654321'
  let uid = ''

  async function idToken(): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
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

  async function seedOtp(opts: { expired?: boolean } = {}) {
    const salt = generateSalt()
    const ref  = adminDb.collection('otpRequests').doc()
    await ref.set({
      uid, channel: 'email', recipient: EMAIL,
      codeHash: hashCode(CODE, salt), salt,
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 600_000)),
      attempts: 0, verified: false, verifiedAt: null, createdAt: new Date(), ip: 'test',
    })
    return ref.id
  }

  async function seedProfile(accountStatus: string | null) {
    const doc: Record<string, unknown> = {
      uid, name: 'Asha Menon', email: EMAIL, organizationName: 'Puliyampatti Runners',
      role: 'organizer', emailVerified: false,
      verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } },
      trust: { level: 'unverified', score: 0, badges: [] },
      createdAt: new Date(), updatedAt: new Date(),
    }
    if (accountStatus !== null) doc.accountStatus = accountStatus
    await adminDb.doc(`users/${uid}`).set(doc)
  }

  async function call(otpId: string, code = CODE) {
    const token = await idToken()
    const res = await POST(new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ otpId, code }),
    }) as never)
    const body = await res.json() as Record<string, unknown>
    // The dispatch is fire-and-forget; give the microtask queue a turn to run it.
    await new Promise(r => setTimeout(r, 120))
    return { status: res.status, body }
  }

  const adminNotices = () => sent.filter(s => s.type === 'ORGANIZER_REGISTERED')
  const welcomes     = () => sent.filter(s => s.type === 'ACCOUNT_WELCOME')
  const status = async () => (await adminDb.doc(`users/${uid}`).get()).data()?.accountStatus

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ POST } = await import('@/app/api/auth/verify-otp/route') as never)
    ;({ hashCode, generateSalt } = await import('@/lib/otp'))
    const user = await adminAuth.createUser({ email: EMAIL, password: 'NotifyPassw0rd!', emailVerified: false })
    uid = user.uid
  }, T)

  afterAll(async () => {
    if (!uid) return
    for (const d of (await adminDb.collection('otpRequests').where('uid', '==', uid).get()).docs) await d.ref.delete()
    await adminDb.doc(`users/${uid}`).delete().catch(() => null)
    await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  beforeEach(async () => {
    sent.length = 0
    engineAvailable = true
    sendBehaviour = 'ok'
    await adminAuth.updateUser(uid, { emailVerified: false })
    await seedProfile('pending')
  })

  it('A · a successful verification activates the account and notifies the platform exactly once', async () => {
    const otpId = await seedOtp()
    const { status: http, body } = await call(otpId)
    expect(http).toBe(200)
    expect(body.verified).toBe(true)
    expect(await status()).toBe('active')

    expect(adminNotices()).toHaveLength(1)
    const payload = adminNotices()[0].payload
    expect(payload.organizationName).toBe('Puliyampatti Runners')
    expect(payload.organizerName).toBe('Asha Menon')
    expect(payload.organizerEmail).toBe(EMAIL)
    expect(payload.uid).toBe(uid)
    expect(typeof payload.registeredAt).toBe('string')
    // the recipient came from the branding config, not from anything the caller sent
    expect(typeof payload.to).toBe('string')
    expect(payload.to).not.toBe(EMAIL)
    // …and the organizer's own welcome still went out, once
    expect(welcomes()).toHaveLength(1)
  }, T)

  it('B · a wrong code notifies nobody and leaves the account pending', async () => {
    const otpId = await seedOtp()
    const { status: http, body } = await call(otpId, '000000')
    expect(http).toBe(400)
    expect(body.error).toBe('INVALID_CODE')
    expect(await status()).toBe('pending')
    expect(sent).toHaveLength(0)
  }, T)

  it('C · an expired code notifies nobody', async () => {
    const otpId = await seedOtp({ expired: true })
    expect((await call(otpId)).body.error).toBe('EXPIRED')
    expect(await status()).toBe('pending')
    expect(sent).toHaveLength(0)
  }, T)

  it('D · a replayed OTP cannot announce the same organizer twice', async () => {
    const otpId = await seedOtp()
    expect((await call(otpId)).status).toBe(200)
    expect(adminNotices()).toHaveLength(1)

    sent.length = 0
    await seedProfile('pending')                 // even if the row were pending again…
    const replay = await call(otpId)             // …the consumed OTP stops at the guard
    expect(replay.body.error).toBe('ALREADY_VERIFIED')
    expect(adminNotices()).toHaveLength(0)
    expect(await status()).toBe('pending')
  }, T)

  it('E · an OTP belonging to another uid notifies nobody', async () => {
    const otpId = await seedOtp()
    await adminDb.doc(`otpRequests/${otpId}`).update({ uid: 'someone-else' })
    expect((await call(otpId)).status).toBe(403)
    expect(sent).toHaveLength(0)
    expect(await status()).toBe('pending')
  }, T)

  it('F · an account that was already active is NOT announced as a new registration', async () => {
    // A grandfathered organizer (no accountStatus, ALREADY verified) re-verifying its email
    // is not a new signup — the transaction reports no activation, so the platform is not
    // told twice. RD-PHASE4 signup transition: "already verified" is what makes it
    // grandfathered; either stored flag is enough.
    for (const verified of [
      { emailVerified: true },
      { 'verification.email.verified': true },
    ]) {
      sent.length = 0
      await seedProfile(null)
      await adminDb.doc(`users/${uid}`).update(verified)
      const otpId = await seedOtp()
      expect((await call(otpId)).status, JSON.stringify(verified)).toBe(200)
      expect(adminNotices(), JSON.stringify(verified)).toHaveLength(0)
      expect(await status(), JSON.stringify(verified)).toBeUndefined()   // not back-filled
      expect(welcomes()).toHaveLength(1)           // the organizer's own email still sends
    }
  }, T)

  it('F2 · a signup from an OLDER app bundle (no accountStatus, never verified) is activated and announced ONCE', async () => {
    // RD-PHASE4 signup transition — the transitional create rule accepts a profile without
    // accountStatus; verify-otp must treat it exactly like a pending signup.
    await seedProfile(null)
    const otpId = await seedOtp()
    expect((await call(otpId)).status).toBe(200)
    expect(await status()).toBe('active')
    expect(adminNotices()).toHaveLength(1)
    expect(adminNotices()[0].payload).toMatchObject({ uid, organizationName: 'Puliyampatti Runners' })

    // a replay of the consumed OTP announces nothing
    sent.length = 0
    expect((await call(otpId)).body.error).toBe('ALREADY_VERIFIED')
    expect(adminNotices()).toHaveLength(0)
    // and a later, fresh verification of the now-active account is not a new registration
    const again = await seedOtp()
    expect((await call(again)).status).toBe(200)
    expect(adminNotices()).toHaveLength(0)
    expect(await status()).toBe('active')
  }, T)

  it('F · a suspended account verifying its email is not announced either', async () => {
    await seedProfile('suspended')
    const otpId = await seedOtp()
    expect((await call(otpId)).status).toBe(200)
    expect(await status()).toBe('suspended')     // moderation intact (RD-ORGANIZER-SIGNUP-02)
    expect(adminNotices()).toHaveLength(0)
  }, T)

  it('G · a failing notification provider does not fail the registration', async () => {
    sendBehaviour = 'reject'
    const otpId = await seedOtp()
    const { status: http, body } = await call(otpId)

    // The request still succeeds, and the account is still active.
    expect(http).toBe(200)
    expect(body.verified).toBe(true)
    expect(await status()).toBe('active')
    // The attempt was made and rejected — the rejection was swallowed, not propagated.
    expect(adminNotices()).toHaveLength(1)
  }, T)

  it('G · no email channel at all still completes the registration', async () => {
    engineAvailable = false
    const otpId = await seedOtp()
    const { status: http } = await call(otpId)
    expect(http).toBe(200)
    expect(await status()).toBe('active')
    expect(sent).toHaveLength(0)
  }, T)
})
