// Organizer visibility — proved over real Firestore + Auth emulators and the real route
// handlers:
//   A  pending signups are in the default admin list, badged; filters partition it;
//      legacy profiles (no createdAt / no accountStatus) are listed, nothing written
//   B  a social sign-in gets its organizer profile at sign-in, idempotently, never for
//      staff or team members, never overwriting an existing profile
//   C  the 360 mobile reads users.mobile.e164 with the legacy `phone` fallback; signup date
//   D  verification / trust / onboarding are read-only and honest about missing fields
//   +  signup → email OTP → the same row reads active, no longer badged

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000

type Row = {
  uid: string; accountStatus: string; pendingVerification: boolean; statusRecorded: boolean
  emailVerification: string; createdAt: string | null
}

describeEmu('Organizer visibility', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let listOrganizers: (req: Request) => Promise<Response>
  let organizerDetail: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
  let organizer360: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
  let socialProfile: (req: Request) => Promise<Response>
  let verifyOtp: (req: Request) => Promise<Response>
  let hashCode: (code: string, salt: string) => string
  let generateSalt: () => string
  let staffEmailForUsername: (u: string) => string

  // every organizer seeded here carries MARK in its email, so ?search= isolates them
  const MARK = `orgvis${process.pid}`
  const authUids: string[] = []
  const docUids: string[] = []
  let adminUid = ''
  let prevAdminUids: string | undefined

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

  const adminGet = (url: string, token: string) =>
    new NextRequest(new Request(url, { headers: { authorization: `Bearer ${token}` } }))

  /** Every row of the list for this suite's MARK, following the cursor to the end. */
  async function listAll(token: string, status = ''): Promise<Row[]> {
    const out: Row[] = []
    let cursor = ''
    for (let i = 0; i < 500; i++) {
      const qs = new URLSearchParams({ pageSize: '100', search: MARK })
      if (status) qs.set('status', status)
      if (cursor) qs.set('cursor', cursor)
      const res = await listOrganizers(adminGet(`http://localhost/api/admin/organizers?${qs}`, token) as never)
      expect(res.status).toBe(200)
      const body = await res.json() as { items: Row[]; nextCursor: string | null }
      out.push(...body.items)
      if (!body.nextCursor) return out
      cursor = body.nextCursor
    }
    throw new Error('list did not terminate')
  }

  async function seedUser(key: string, data: Record<string, unknown>): Promise<string> {
    const uid = `${MARK}-${key}`
    await adminDb.doc(`users/${uid}`).set({ uid, email: `${key}-${MARK}@rd.test`, name: `Vis ${key}`, ...data })
    docUids.push(uid)
    return uid
  }

  async function get360(token: string, uid: string) {
    const res = await organizer360(
      adminGet(`http://localhost/api/admin/organizers/${uid}/360`, token) as never,
      { params: Promise.resolve({ uid }) },
    )
    expect(res.status).toBe(200)
    return (await res.json() as { overview: Record<string, any> }).overview   // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /** An Auth user with a linked social provider (as a Google / Microsoft / Facebook sign-in leaves). */
  async function socialUser(key: string, opts: { verified: boolean; providerId?: string; email?: string }) {
    const uid = `${MARK}-soc-${key}`
    const email = opts.email ?? `soc-${key}-${MARK}@rd.test`
    const r = await adminAuth.importUsers([{
      uid, email, emailVerified: opts.verified, displayName: `Social ${key}`,
      providerData: [{ uid: `p-${uid}`, providerId: opts.providerId ?? 'google.com', email, displayName: `Social ${key}` }],
    }])
    if (r.failureCount) throw new Error(`importUsers failed: ${JSON.stringify(r.errors)}`)
    authUids.push(uid); docUids.push(uid)
    return uid
  }

  async function callSocial(token: string | null) {
    const res = await socialProfile(new Request('http://localhost/api/auth/social-profile', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
    }) as never)
    return { status: res.status, body: await res.json() as { created?: boolean; reason?: string; error?: string } }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ GET: listOrganizers } = await import('@/app/api/admin/organizers/route') as never)
    ;({ GET: organizerDetail } = await import('@/app/api/admin/organizers/[uid]/route') as never)
    ;({ GET: organizer360 } = await import('@/app/api/admin/organizers/[uid]/360/route') as never)
    ;({ POST: socialProfile } = await import('@/app/api/auth/social-profile/route') as never)
    ;({ POST: verifyOtp } = await import('@/app/api/auth/verify-otp/route') as never)
    ;({ hashCode, generateSalt } = await import('@/lib/otp'))
    ;({ staffEmailForUsername } = await import('@/lib/staff/types'))

    const adm = await adminAuth.createUser({ email: `adm-${MARK}@rd.test`, password: 'VisAdminPassw0rd!', emailVerified: true })
    adminUid = adm.uid
    authUids.push(adminUid)
    prevAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [prevAdminUids, adminUid].filter(Boolean).join(',')
  }, T)

  afterAll(async () => {
    if (prevAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdminUids
    for (const u of docUids) {
      await adminDb.doc(`users/${u}`).delete().catch(() => null)
      await adminDb.doc(`staffAccounts/${u}`).delete().catch(() => null)
      for (const d of (await adminDb.collection('teamMembers').where('memberUid', '==', u).get()).docs) await d.ref.delete()
      for (const d of (await adminDb.collection('otpRequests').where('uid', '==', u).get()).docs) await d.ref.delete()
    }
    for (const u of authUids) await adminAuth.deleteUser(u).catch(() => null)
  }, T)

  // ─── A · list ─────────────────────────────────────────────────────────────────

  describe('A · the default list is every organizer, badged', () => {
    const ids: Record<string, string> = {}

    beforeAll(async () => {
      const now = new Date()
      ids.pending   = await seedUser('pending', { role: 'organizer', accountStatus: 'pending', emailVerified: false,
        verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } }, createdAt: now })
      ids.active    = await seedUser('active', { role: 'organizer', accountStatus: 'active', emailVerified: true,
        verification: { email: { verified: true, verifiedAt: now, verifiedMethod: 'otp' } }, createdAt: now })
      ids.unverAct  = await seedUser('unveract', { role: 'organizer', accountStatus: 'active', emailVerified: false, createdAt: now })
      ids.suspended = await seedUser('suspended', { role: 'organizer', accountStatus: 'suspended', statusReason: 'x', emailVerified: true, createdAt: now })
      ids.banned    = await seedUser('banned', { role: 'organizer', accountStatus: 'banned', emailVerified: true, createdAt: now })
      ids.legacyNoStatus = await seedUser('legacynostatus', { role: 'organizer', createdAt: now })
      // no createdAt AND no accountStatus — invisible to orderBy('createdAt') before
      ids.legacyNoDate = await seedUser('legacynodate', { role: 'organizer' })
      ids.attendee  = await seedUser('attendee', { role: 'attendee', createdAt: now })
    }, T)

    it('All includes pending and legacy rows; never a non-organizer', async () => {
      const rows = await listAll(await idToken(adminUid))
      const by = new Map(rows.map(r => [r.uid, r]))
      for (const k of ['pending', 'active', 'unverAct', 'suspended', 'banned', 'legacyNoStatus', 'legacyNoDate']) {
        expect(by.has(ids[k]), `${k} missing from All`).toBe(true)
      }
      expect(by.has(ids.attendee)).toBe(false)
      expect(new Set(rows.map(r => r.uid)).size, 'a row was listed twice').toBe(rows.length)
    }, T)

    it('badge: pending and explicitly-unverified rows only', async () => {
      const by = new Map((await listAll(await idToken(adminUid))).map(r => [r.uid, r]))
      expect(by.get(ids.pending)).toMatchObject({ accountStatus: 'pending', pendingVerification: true, emailVerification: 'unverified' })
      expect(by.get(ids.unverAct)).toMatchObject({ accountStatus: 'active', pendingVerification: true })
      expect(by.get(ids.active)).toMatchObject({ accountStatus: 'active', pendingVerification: false, emailVerification: 'verified' })
      expect(by.get(ids.suspended)).toMatchObject({ accountStatus: 'suspended', pendingVerification: false })
      // legacy: effective active, not recorded, not badged (nothing recorded is not "unverified")
      expect(by.get(ids.legacyNoStatus)).toMatchObject({ accountStatus: 'active', statusRecorded: false, pendingVerification: false, emailVerification: 'unknown' })
      expect(by.get(ids.legacyNoDate)).toMatchObject({ accountStatus: 'active', statusRecorded: false, createdAt: null })
    }, T)

    it('filters partition All exactly (counts consistent)', async () => {
      const token = await idToken(adminUid)
      const all = new Set((await listAll(token)).map(r => r.uid))
      const parts: Record<string, Row[]> = {}
      for (const s of ['active', 'pending', 'suspended', 'banned']) parts[s] = await listAll(token, s)
      for (const [s, rows] of Object.entries(parts)) for (const r of rows) expect(r.accountStatus).toBe(s)
      const union = Object.values(parts).flat().map(r => r.uid)
      expect(new Set(union).size).toBe(union.length)
      expect(new Set(union)).toEqual(all)
      expect(parts.pending.map(r => r.uid)).toContain(ids.pending)
      expect(parts.active.map(r => r.uid)).toEqual(expect.arrayContaining([ids.active, ids.unverAct, ids.legacyNoStatus, ids.legacyNoDate]))
    }, T)

    it('the list writes nothing to legacy profiles', async () => {
      await listAll(await idToken(adminUid))
      const d = (await adminDb.doc(`users/${ids.legacyNoDate}`).get()).data()!
      expect(d).not.toHaveProperty('createdAt')
      expect(d).not.toHaveProperty('accountStatus')
    }, T)

    it('the detail popup endpoint carries the same badge and a safe missing date', async () => {
      const token = await idToken(adminUid)
      for (const [k, expectBadge] of [['pending', true], ['legacyNoDate', false]] as const) {
        const res = await organizerDetail(
          adminGet(`http://localhost/api/admin/organizers/${ids[k]}`, token) as never,
          { params: Promise.resolve({ uid: ids[k] }) },
        )
        expect(res.status).toBe(200)
        const body = await res.json() as { profile: Row }
        expect(body.profile.pendingVerification).toBe(expectBadge)
        if (k === 'legacyNoDate') expect(body.profile.createdAt).toBeNull()
      }
    }, T)

    it('a non-admin is refused (authorization unchanged)', async () => {
      const res = await listOrganizers(adminGet('http://localhost/api/admin/organizers', await idToken(ids.active)) as never)
      expect(res.status).toBe(403)
    }, T)
  })

  // ─── C/D · 360 ────────────────────────────────────────────────────────────────

  describe('C/D · Organizer 360 reads mobile, dates, verification, trust and onboarding', () => {
    it('mobile.e164 wins; verification + trust + signup date as recorded', async () => {
      const at = new Date('2026-09-01T10:00:00.000Z')
      const uid = await seedUser('o360full', {
        role: 'organizer', accountStatus: 'active', emailVerified: true,
        mobile: { e164: '+919000000101', countryCode: '+91', verified: false, verifiedAt: null },
        phone: '+919999999999',
        verification: { email: { verified: true, verifiedAt: at, verifiedMethod: 'otp' } },
        trust: { level: 'email_verified', score: 45, badges: ['email'] },
        organizationName: 'Vis Co',
        organizationProfile: { supportEmail: 'help@vis.test' },
        branding: { logoUrl: 'https://x.test/logo.png' },
        createdAt: at,
      })
      const o = await get360(await idToken(adminUid), uid)
      expect(o.profile).toMatchObject({ phone: '+919000000101', phoneSource: 'mobile', mobileVerification: 'unverified', createdAt: at.toISOString() })
      expect(o.verification.email).toEqual({ state: 'verified', method: 'otp', verifiedAt: at.toISOString() })
      expect(o.trust).toEqual({ level: 'email_verified', score: 45 })
      expect(o.account).toMatchObject({ status: 'active', statusRecorded: true, pendingVerification: false })
      const done = Object.fromEntries((o.onboarding.checks as { id: string; done: boolean }[]).map(c => [c.id, c.done]))
      expect(done).toMatchObject({ org_name: true, support_email: true, logo: true, cert_signature: false, published_event: false })
      expect(o.onboarding.total).toBe(o.onboarding.checks.length)
      expect(o.onboarding.done).toBe(Object.values(done).filter(Boolean).length)
      expect(o.onboarding.payout).toBe('missing')
    }, T)

    it('legacy phone fallback; missing fields read as not recorded, nothing invented', async () => {
      const uid = await seedUser('o360legacy', { role: 'organizer', phone: '+918888888888' })
      const o = await get360(await idToken(adminUid), uid)
      expect(o.profile).toMatchObject({ phone: '+918888888888', phoneSource: 'legacy_phone', mobileVerification: 'unverified', createdAt: null })
      expect(o.verification.email).toEqual({ state: 'unknown', method: null, verifiedAt: null })
      expect(o.trust).toBeNull()
      expect(o.account).toMatchObject({ status: 'active', statusRecorded: false, pendingVerification: false })
      // only the confirmation-email check passes: it is ON by default when nothing is
      // stored (the dashboard's own rule); every setup step the organizer must do is open
      const done = Object.fromEntries((o.onboarding.checks as { id: string; done: boolean }[]).map(c => [c.id, c.done]))
      expect(done).toEqual({ org_name: false, support_email: false, send_confirmation: true, logo: false, cert_signature: false, published_event: false })
      expect(o.onboarding.done).toBe(1)
      expect(o.onboarding.payout).toBe('missing')
      // the read wrote nothing
      const d = (await adminDb.doc(`users/${uid}`).get()).data()!
      expect(Object.keys(d).sort()).toEqual(['email', 'name', 'phone', 'role', 'uid'])
    }, T)

    it('no phone at all reads missing; a pending signup reads pending verification', async () => {
      const uid = await seedUser('o360pending', { role: 'organizer', accountStatus: 'pending', emailVerified: false, createdAt: new Date() })
      const o = await get360(await idToken(adminUid), uid)
      expect(o.profile).toMatchObject({ phone: null, phoneSource: null, mobileVerification: 'missing' })
      expect(o.account).toMatchObject({ status: 'pending', pendingVerification: true })
      expect(o.verification.email.state).toBe('unverified')
      const health = (o.health as { key: string; level: string; detail: string }[]).find(h => h.key === 'account')!
      expect(health).toMatchObject({ level: 'yellow', detail: 'pending verification' })
    }, T)
  })

  // ─── B · social sign-in ───────────────────────────────────────────────────────

  describe('B · social sign-in creates the organizer profile at sign-in', () => {
    it('a verified Google sign-in gets an active organizer profile; nothing invented', async () => {
      const uid = await socialUser('google', { verified: true })
      const r = await callSocial(await idToken(uid))
      expect(r).toEqual({ status: 200, body: { created: true, reason: 'created' } })
      const d = (await adminDb.doc(`users/${uid}`).get()).data()!
      expect(d).toMatchObject({ role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true, organizationName: '' })
      expect(d).not.toHaveProperty('branding')
      expect(d).not.toHaveProperty('organizationProfile')
      expect(d).not.toHaveProperty('mobile')
      // visible to the admin list straight away
      const row = (await listAll(await idToken(adminUid))).find(x => x.uid === uid)
      expect(row).toMatchObject({ accountStatus: 'active', pendingVerification: false })
    }, T)

    it('repeated calls never overwrite (idempotent)', async () => {
      const uid = `${MARK}-soc-google`
      const before = (await adminDb.doc(`users/${uid}`).get()).data()!
      await adminDb.doc(`users/${uid}`).update({ organizationName: 'Set Later' })
      for (let i = 0; i < 2; i++) {
        expect((await callSocial(await idToken(uid))).body).toEqual({ created: false, reason: 'exists' })
      }
      const after = (await adminDb.doc(`users/${uid}`).get()).data()!
      expect(after.organizationName).toBe('Set Later')
      expect(after.createdAt.toMillis()).toBe(before.createdAt.toMillis())
    }, T)

    it('an unverified Microsoft / Facebook sign-in is pending, and badged', async () => {
      for (const providerId of ['microsoft.com', 'facebook.com']) {
        const uid = await socialUser(providerId.split('.')[0], { verified: false, providerId })
        expect((await callSocial(await idToken(uid))).body.reason).toBe('created')
        const d = (await adminDb.doc(`users/${uid}`).get()).data()!
        expect(d).toMatchObject({ accountStatus: 'pending', emailVerified: false })
        const row = (await listAll(await idToken(adminUid), 'pending')).find(x => x.uid === uid)
        expect(row).toMatchObject({ pendingVerification: true })
      }
    }, T)

    it('an existing profile is never downgraded or re-roled', async () => {
      const uid = await socialUser('existing', { verified: false })
      await adminDb.doc(`users/${uid}`).set({ uid, role: 'attendee', accountStatus: 'active', note: 'keep' })
      expect((await callSocial(await idToken(uid))).body.reason).toBe('exists')
      expect((await adminDb.doc(`users/${uid}`).get()).data()).toEqual({ uid, role: 'attendee', accountStatus: 'active', note: 'keep' })
    }, T)

    it('gate staff (by address or by staff record) and team members get no organizer profile', async () => {
      const byEmail = await socialUser('staffmail', { verified: true, email: staffEmailForUsername(`g${process.pid}`) })
      expect((await callSocial(await idToken(byEmail))).body.reason).toBe('staff')

      const byRecord = await socialUser('staffrec', { verified: true })
      await adminDb.doc(`staffAccounts/${byRecord}`).set({ staffId: byRecord, organizerUid: 'someone', status: 'active' })
      expect((await callSocial(await idToken(byRecord))).body.reason).toBe('staff')

      const member = await socialUser('member', { verified: true })
      await adminDb.collection('teamMembers').doc(`someone_${member}`).set({ organizerUid: 'someone', memberUid: member, status: 'active' })
      expect((await callSocial(await idToken(member))).body.reason).toBe('team_member')

      for (const u of [byEmail, byRecord, member]) expect((await adminDb.doc(`users/${u}`).get()).exists).toBe(false)
    }, T)

    it('a password-only account is not this route’s business; no token is 401', async () => {
      const pw = await adminAuth.createUser({ email: `pw-${MARK}@rd.test`, password: 'VisPassw0rd!!', emailVerified: true })
      authUids.push(pw.uid); docUids.push(pw.uid)
      expect((await callSocial(await idToken(pw.uid))).body.reason).toBe('not_social')
      expect((await adminDb.doc(`users/${pw.uid}`).get()).exists).toBe(false)
      expect((await callSocial(null)).status).toBe(401)
      expect((await callSocial('not-a-token')).status).toBe(401)
    }, T)
  })

  // ─── signup → email code → visible as active ──────────────────────────────────

  it('signup (pending, badged) → email OTP → the same row reads active, unbadged', async () => {
    const email = `signup-${MARK}@rd.test`
    const u = await adminAuth.createUser({ email, password: 'VisSignupPassw0rd!', emailVerified: false })
    authUids.push(u.uid); docUids.push(u.uid)
    // the exact shape createOrganizerProfile writes at signup
    await adminDb.doc(`users/${u.uid}`).set({
      uid: u.uid, name: 'Signup Vis', email, organizationName: 'Signup Co',
      mobile: { e164: '+919000000202', countryCode: '+91', verified: false, verifiedAt: null },
      role: 'organizer', accountStatus: 'pending', emailVerified: false, workspaceOwner: true,
      verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } },
      trust: { level: 'unverified', score: 0, badges: [] },
      createdAt: new Date(), updatedAt: new Date(),
    })
    const adminToken = await idToken(adminUid)
    expect((await listAll(adminToken)).find(r => r.uid === u.uid)).toMatchObject({ accountStatus: 'pending', pendingVerification: true })

    const CODE = '123456'
    const salt = generateSalt()
    const otp = adminDb.collection('otpRequests').doc()
    await otp.set({
      uid: u.uid, channel: 'email', recipient: email, codeHash: hashCode(CODE, salt), salt,
      expiresAt: new Date(Date.now() + 10 * 60_000), attempts: 0, verified: false, verifiedAt: null,
      createdAt: new Date(), ip: 'test',
    })
    const res = await verifyOtp(new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await idToken(u.uid)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ otpId: otp.id, code: CODE }),
    }) as never)
    expect(res.status).toBe(200)

    expect((await listAll(adminToken)).find(r => r.uid === u.uid)).toMatchObject({ accountStatus: 'active', pendingVerification: false, emailVerification: 'verified' })
    const o = await get360(adminToken, u.uid)
    expect(o.profile.phone).toBe('+919000000202')
    expect(o.verification.email.state).toBe('verified')
    expect(o.verification.email.method).toBe('otp')
  }, T)
})
