// RD-ORGANIZER-MODERATION-ENFORCEMENT-12 — suspending an organizer actually stops them.
//
// ═══ THE GAP THIS CLOSES ═════════════════════════════════════════════════════
// Moderation used to be advisory at the API boundary. `setOrganizerAccountStatus` calls
// `revokeRefreshTokens`, which invalidates tokens issued BEFORE the revocation — but it
// never disables the Firebase Auth user, so a suspended organizer could simply sign in
// again, mint a fresh token, and every organizer endpoint answered 200.
// RD-ORGANIZER-LIFECYCLE-AUDIT-11 measured exactly that: suspended and banned both got 200
// from /api/organizer/dashboard and /api/organizer/events.
//
// The gate now lives in lib/team/workspace, in the two top-level authorizers. Because
// `authorizeEvent` and `authorizeWorkspaceDownload` delegate to `authorizeWorkspace`, one
// seam covers every organizer API rather than ~189 route files.
//
// ═══ WHAT THESE CASES DELIBERATELY PIN ═══════════════════════════════════════
// Every token here is minted AFTER the status change. That is the case the old mechanism
// could not handle, and testing with a stale token would let a broken gate pass.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-ORGANIZER-MODERATION-ENFORCEMENT-12 · moderation at the API boundary', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let dashboardGET: (req: Request) => Promise<Response>
  let authorizeWorkspace: typeof import('@/lib/team/workspace').authorizeWorkspace
  let authorizeAnyWorkspace: typeof import('@/lib/team/workspace').authorizeAnyWorkspace

  const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const API_KEY   = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'
  const created: string[] = []

  /** A token minted from the Auth record AS IT IS NOW — never a stale one. */
  async function freshToken(uid: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const res = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const b = await res.json() as { idToken?: string }
    if (!b.idToken) throw new Error('no idToken')
    return b.idToken
  }

  const bearer = (token: string | null) =>
    new NextRequest(new Request('http://localhost/api/organizer/dashboard', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }))

  async function callDashboard(token: string | null) {
    const res = await dashboardGET(bearer(token) as never)
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  async function seed(tag: string, accountStatus: string | null, emailVerified = true): Promise<string> {
    const email = `mod12-${tag}-${process.pid}-${created.length}@rd.test`
    const u = await adminAuth.createUser({ email, password: 'Mod12Passw0rd!', emailVerified })
    created.push(u.uid)
    const doc: Record<string, unknown> = {
      uid: u.uid, name: 'Mod ' + tag, email, organizationName: 'Mod ' + tag + ' Co',
      role: 'organizer', emailVerified,
      verification: { email: { verified: emailVerified, verifiedAt: null, verifiedMethod: 'otp' } },
      trust: { level: 'email_verified', score: 45, badges: [] },
      createdAt: new Date(),
    }
    if (accountStatus !== null) doc.accountStatus = accountStatus
    await adminDb.doc(`users/${u.uid}`).set(doc)
    return u.uid
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ GET: dashboardGET } = await import('@/app/api/organizer/dashboard/route') as never)
    ;({ authorizeWorkspace, authorizeAnyWorkspace } = await import('@/lib/team/workspace'))
  }, T)

  afterAll(async () => {
    for (const uid of created) {
      for (const d of (await adminDb.collection('teamMembers').where('organizerUid', '==', uid).get()).docs) await d.ref.delete()
      await adminDb.doc(`users/${uid}`).delete().catch(() => null)
      await adminAuth.deleteUser(uid).catch(() => null)
    }
  }, T)

  // ═══ the states that must now be refused ══════════════════════════════════

  for (const status of ['suspended', 'banned']) {
    it(`a ${status} organizer is refused with 403, on a token minted after the change`, async () => {
      const uid = await seed(status, status)
      const r = await callDashboard(await freshToken(uid))
      expect(r.status).toBe(403)
      // The message must not reveal WHICH sanction was applied.
      expect(String(r.body.error)).toMatch(/restricted/i)
      expect(String(r.body.error)).not.toMatch(/suspend|ban/i)
    }, T)
  }

  it('suspended and banned are refused identically — neither is laxer', async () => {
    const s = await callDashboard(await freshToken(await seed('s-parity', 'suspended')))
    const b = await callDashboard(await freshToken(await seed('b-parity', 'banned')))
    expect(s.status).toBe(b.status)
    expect(s.body.error).toBe(b.body.error)
  }, T)

  // ═══ the states that must still pass ══════════════════════════════════════

  it('an ACTIVE organizer is unaffected', async () => {
    expect((await callDashboard(await freshToken(await seed('active', 'active')))).status).toBe(200)
  }, T)

  it('a GRANDFATHERED organizer (no accountStatus) is still allowed', async () => {
    // The backward-compatibility contract. The gate must read through
    // resolveAccountStatus, which maps a missing field to 'active' — not treat
    // "not active" as "moderated".
    const uid = await seed('grand', null)
    expect((await adminDb.doc(`users/${uid}`).get()).data()!.accountStatus).toBeUndefined()
    expect((await callDashboard(await freshToken(uid))).status).toBe(200)
  }, T)

  it('a PENDING organizer is still refused by the EMAIL gate, not this one', async () => {
    // 401 (verifyCaller rejects the unverified token) rather than 403 — proof the new
    // check did not quietly take over a denial that already worked upstream.
    const uid = await seed('pending', 'pending', false)
    const r = await callDashboard(await freshToken(uid))
    expect(r.status).toBe(401)
    expect(String(r.body.error)).toBe('Unauthorized')
  }, T)

  it('an unauthenticated caller is still 401', async () => {
    expect((await callDashboard(null)).status).toBe(401)
  }, T)

  // ═══ both authorizers, not just the dashboard ═════════════════════════════

  it('the PERMISSION-scoped authorizer refuses too, so every organizer API is covered', async () => {
    // authorizeWorkspace backs the permission-gated routes, and authorizeEvent /
    // authorizeWorkspaceDownload delegate to it — so this one assertion stands in for the
    // whole surface that does not go through authorizeAnyWorkspace.
    const uid = await seed('perm', 'suspended')
    const token = await freshToken(uid)
    const authz = await authorizeWorkspace(
      new Request('http://localhost/api/organizer/events', { headers: { authorization: `Bearer ${token}` } }),
      'events',
    )
    expect(authz.ok).toBe(false)
    expect(authz.status).toBe(403)
    expect(authz.error).toMatch(/restricted/i)
  }, T)

  it('and the permissionless authorizer refuses', async () => {
    const uid = await seed('any', 'banned')
    const token = await freshToken(uid)
    const authz = await authorizeAnyWorkspace(
      new Request('http://localhost/x', { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(authz.ok).toBe(false)
    expect(authz.status).toBe(403)
  }, T)

  // ═══ the workspace dimension ══════════════════════════════════════════════

  it('a TEAM MEMBER of a suspended workspace is frozen out with the owner', async () => {
    // Suspending an organizer must freeze the workspace, not just the one login. Otherwise
    // a suspended organiser keeps operating through any member they invited.
    const owner  = await seed('ws-owner', 'suspended')
    const member = await seed('ws-member', 'active')
    await adminDb.collection('teamMembers').add({
      organizerUid: owner, memberUid: member, uid: member,
      role: 'manager', status: 'active', eventIds: [], createdAt: new Date(),
    })
    const r = await callDashboard(await freshToken(member))
    expect(r.status).toBe(403)
  }, T)

  it('a healthy workspace is NOT frozen by an unrelated suspended member', async () => {
    // The mirror of the previous case: the gate must not punish a clean workspace because
    // somebody attached to it is restricted elsewhere — the OWNER is what freezes it.
    const owner = await seed('ws-ok-owner', 'active')
    expect((await callDashboard(await freshToken(owner))).status).toBe(200)
  }, T)

  // ═══ reversibility ════════════════════════════════════════════════════════

  it('reactivating restores access immediately', async () => {
    const uid = await seed('restore', 'active')
    await adminDb.doc(`users/${uid}`).update({ accountStatus: 'suspended' })
    expect((await callDashboard(await freshToken(uid))).status).toBe(403)

    const { setOrganizerAccountStatus } = await import('@/lib/admin/organizerService')
    const res = await setOrganizerAccountStatus(uid, 'reactivate', 'mod12-admin', '')
    expect(res.ok).toBe(true)
    expect((await callDashboard(await freshToken(uid))).status).toBe(200)
  }, T)

  it('the real moderation service produces a state this gate refuses', async () => {
    // End to end through the service an admin actually calls, rather than a hand-written
    // status field — so the two cannot drift apart.
    const uid = await seed('svc', 'active')
    const { setOrganizerAccountStatus } = await import('@/lib/admin/organizerService')
    await setOrganizerAccountStatus(uid, 'suspend', 'mod12-admin', 'testing enforcement')
    expect((await callDashboard(await freshToken(uid))).status).toBe(403)
  }, T)
})
