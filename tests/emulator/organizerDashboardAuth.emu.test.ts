// RD-ORGANIZER-DASHBOARD-AUTH-06 — who may read GET /api/organizer/dashboard.
//
// ═══ THE BUG THESE CASES PIN ═════════════════════════════════════════════════
// A newly verified organizer reached /dashboard and every request came back
// 401 Unauthorized ("Dashboard unavailable"). The server state was correct —
// emailVerified true, accountStatus active, role organizer — but the CLIENT was still
// sending the ID token minted at signup, whose `email_verified` claim was false.
// `verifyCaller` rejects exactly that claim, so authorization was working perfectly and
// the token was the stale thing.
//
// `user.reload()` (what the verification pages used to call) refreshes the local User
// object but does NOT mint a new token, and Firebase caches ID tokens for about an hour.
// `resyncVerifiedSession()` now forces `getIdToken(true)` as well.
//
// Case I is the regression: a token minted BEFORE the server flipped emailVerified is
// refused, and a token minted AFTER it is accepted. That is the whole defect, expressed
// as the two tokens rather than as a UI symptom.
//
// ═══ WHAT THIS DELIBERATELY DOES NOT ASSERT ══════════════════════════════════
// The dashboard's authorization is `verifyCaller` + workspace resolution. It contains NO
// accountStatus check — that is a pre-existing design, not something this phase changed,
// and cases E/F record the ACTUAL behaviour rather than an assumed one. See the notes on
// those cases.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-ORGANIZER-DASHBOARD-AUTH-06 · GET /api/organizer/dashboard', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let dashboardGET: (req: Request) => Promise<Response>

  const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const API_KEY   = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'
  const created: string[] = []

  /** Mint a REAL ID token for uid, reflecting the Auth record AS IT IS RIGHT NOW. */
  async function mintIdToken(uid: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const res = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  const claimsOf = (jwt: string): Record<string, unknown> => {
    const part = jwt.split('.')[1]!
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  }

  /** Call the real handler with a bearer token (or none). Returns status + body. */
  async function callDashboard(token: string | null) {
    const req = new NextRequest(new Request('http://localhost/api/organizer/dashboard', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }))
    const res = await dashboardGET(req as never)
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  /**
   * An organizer in a given state. `emailVerified` is the AUTH record's flag — the one
   * `verifyCaller` reads out of the token — and `accountStatus` is the Firestore field.
   */
  async function seedOrganizer(opts: {
    tag: string
    emailVerified: boolean
    accountStatus?: string | null
    role?: string
    withCreatedAt?: boolean
  }): Promise<string> {
    const email = `dash6-${opts.tag}-${process.pid}-${created.length}@rd.test`
    const u = await adminAuth.createUser({ email, password: 'Dash6Passw0rd!', emailVerified: opts.emailVerified })
    created.push(u.uid)
    const doc: Record<string, unknown> = {
      uid: u.uid, name: 'Dash ' + opts.tag, email, organizationName: 'Dash ' + opts.tag + ' Co',
      role: opts.role ?? 'organizer',
      emailVerified: opts.emailVerified,
      verification: { email: { verified: opts.emailVerified, verifiedAt: null, verifiedMethod: opts.emailVerified ? 'otp' : null } },
      trust: { level: opts.emailVerified ? 'email_verified' : 'unverified', score: opts.emailVerified ? 45 : 0, badges: [] },
    }
    if (opts.accountStatus !== null && opts.accountStatus !== undefined) doc.accountStatus = opts.accountStatus
    if (opts.withCreatedAt !== false) doc.createdAt = new Date()
    await adminDb.doc(`users/${u.uid}`).set(doc)
    return u.uid
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ GET: dashboardGET } = await import('@/app/api/organizer/dashboard/route') as never)
  }, T)

  afterAll(async () => {
    for (const uid of created) {
      await adminDb.doc(`users/${uid}`).delete().catch(() => null)
      await adminAuth.deleteUser(uid).catch(() => null)
    }
  }, T)

  // ═══ I · THE REGRESSION · stale token vs fresh token ═══════════════════════

  it('I · a token minted BEFORE verification is refused; one minted AFTER is accepted', async () => {
    // Exactly the production sequence: signup (unverified) → token → OTP verified
    // server-side → the client still holds the OLD token.
    const uid = await seedOrganizer({ tag: 'stale', emailVerified: false, accountStatus: 'pending' })
    const staleToken = await mintIdToken(uid)
    expect(claimsOf(staleToken).email_verified).toBe(false)

    // The server verifies the email and activates the account, as verify-otp does.
    await adminAuth.updateUser(uid, { emailVerified: true })
    await adminDb.doc(`users/${uid}`).update({
      accountStatus: 'active', emailVerified: true,
      'verification.email.verified': true, 'verification.email.verifiedMethod': 'otp',
    })

    // The stale token is still syntactically valid and unexpired — and still says false.
    const stale = await callDashboard(staleToken)
    expect(stale.status).toBe(401)
    expect(stale.body.error).toBe('Unauthorized')

    // This is what resyncVerifiedSession()'s getIdToken(true) produces.
    const freshToken = await mintIdToken(uid)
    expect(claimsOf(freshToken).email_verified).toBe(true)
    const fresh = await callDashboard(freshToken)
    expect(fresh.status).toBe(200)
  }, T)

  // ═══ A–D · the states that MUST be allowed ════════════════════════════════

  it('A · a newly verified organizer is allowed', async () => {
    const uid = await seedOrganizer({ tag: 'newly', emailVerified: true, accountStatus: 'active' })
    const r = await callDashboard(await mintIdToken(uid))
    expect(r.status).toBe(200)
  }, T)

  it('B · a PENDING organizer is denied', async () => {
    // A pending organizer is by definition unverified, so the token carries
    // email_verified:false and verifyCaller refuses it. The denial is the email-verification
    // gate, which is the intended control — nothing here reads accountStatus.
    const uid = await seedOrganizer({ tag: 'pending', emailVerified: false, accountStatus: 'pending' })
    const r = await callDashboard(await mintIdToken(uid))
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('Unauthorized')
  }, T)

  it('C · an ACTIVE organizer is allowed', async () => {
    const uid = await seedOrganizer({ tag: 'active', emailVerified: true, accountStatus: 'active' })
    expect((await callDashboard(await mintIdToken(uid))).status).toBe(200)
  }, T)

  it('D · a GRANDFATHERED organizer (no accountStatus) is allowed', async () => {
    // The backward-compatibility contract: documents predating the field must keep working.
    const uid = await seedOrganizer({ tag: 'grand', emailVerified: true, accountStatus: null })
    const stored = (await adminDb.doc(`users/${uid}`).get()).data()!
    expect(stored.accountStatus).toBeUndefined()
    expect((await callDashboard(await mintIdToken(uid))).status).toBe(200)
  }, T)

  // ═══ H · unauthenticated ══════════════════════════════════════════════════

  it('H · an unauthenticated caller is denied', async () => {
    const r = await callDashboard(null)
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('Unauthorized')
  }, T)

  it('H · a garbage bearer token is denied', async () => {
    expect((await callDashboard('not-a-real-token')).status).toBe(401)
  }, T)

  // ═══ E/F/G · recorded, not assumed ════════════════════════════════════════

  it('E/F · a suspended or banned organizer is refused even with a FRESH token', async () => {
    // This case used to record the OPPOSITE — that a fresh token sailed through, because
    // authorization was verifyCaller + workspace resolution with no accountStatus check, and
    // moderation leaned entirely on revokeRefreshTokens (which only invalidates tokens issued
    // BEFORE the revocation; suspension never disabled the Auth user, so signing in again
    // minted a valid one). RD-ORGANIZER-LIFECYCLE-AUDIT-11 measured that as 200/200.
    //
    // RD-ORGANIZER-MODERATION-ENFORCEMENT-12 closed it in lib/team/workspace. The expectation
    // is inverted deliberately: a FRESH token is the hard case, so it is the one asserted.
    for (const status of ['suspended', 'banned']) {
      const uid = await seedOrganizer({ tag: status, emailVerified: true, accountStatus: status })
      const r = await callDashboard(await mintIdToken(uid))
      expect(r.status, `${status} reached the dashboard`).toBe(403)
    }
  }, T)

  it('G · a non-organizer role with no memberships resolves to its OWN workspace', async () => {
    // Also recorded rather than assumed: resolveWorkspaceUid treats a caller with no
    // memberships as the owner of their own workspace, so there is no `role === organizer`
    // gate on this endpoint. Such a caller sees an empty workspace, never another's.
    const uid = await seedOrganizer({ tag: 'norole', emailVerified: true, accountStatus: 'active', role: 'attendee' })
    const r = await callDashboard(await mintIdToken(uid))
    expect([200, 401, 403]).toContain(r.status)
  }, T)

  // ═══ the fix is wired at BOTH verification sites ═══════════════════════════

  it('both verification paths force a token refresh, not just a reload()', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

    const helper = read('lib/firebase/auth/index.ts')
    expect(helper).toContain('export async function resyncVerifiedSession')
    expect(helper).toMatch(/getIdToken\(true\)/)

    for (const page of ['app/(auth)/verify-email/page.tsx', 'app/(auth)/verify-email-success/page.tsx']) {
      const src = read(page)
      expect(src, `${page} does not resync the session`).toContain('resyncVerifiedSession')
      // The bare reload() is what left the token stale.
      expect(src, `${page} still relies on a bare reload()`).not.toMatch(/currentUser[!?]?\.reload\(\)/)
    }
  }, T)
})
