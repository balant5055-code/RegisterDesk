// RD-STAFF-SEC-01 — staff credential lifecycle on REAL Firestore + REAL Auth-emulator ID tokens,
// through the real staff service and the real route handlers. No identity mocks.
//
//   1. an ACTIVE gate credential is refused by owner-only routes (api-keys) — the old
//      `requireOwner(caller.uid, caller.uid)` passed for every caller;
//   2. SUSPEND disables the sign-in (the operator cannot simply log in again);
//   3. defence in depth: a staff credential whose sign-in is enabled but whose membership is
//      suspended (e.g. a failed disable) resolves to NO permissions — never to the owner of
//      its own workspace (it used to get every organizer permission, events included);
//   4. REACTIVATE re-enables the sign-in and restores check-in access only;
//   5. a failed Auth delete keeps the profile (retryable), disables the sign-in, and reports
//      failure instead of success; the retry then completes.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `stfsec-${process.pid}`
const ORG = `${P}-org`
const ORG_PASSWORD = 'StfSecOrgPassw0rd!'

async function signIn(email: string, password: string): Promise<{ ok: boolean; idToken?: string; error?: string }> {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  const body = await r.json() as { idToken?: string; error?: { message?: string } }
  return r.ok ? { ok: true, idToken: body.idToken } : { ok: false, error: body.error?.message }
}
const get = (url: string, token: string) => new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${token}` } })

describeEmu('RD-STAFF-SEC-01 · staff suspension, owner-only routes and removal (real Auth + Firestore)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let svc: typeof import('@/lib/staff/service')
  let staffId = '', staffEmail = '', staffPassword = ''

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminAuth, adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/staff/service')
    await adminAuth.deleteUser(ORG).catch(() => null)
    await adminAuth.createUser({ uid: ORG, email: `${P}-org@registerdesk.test`, password: ORG_PASSWORD, emailVerified: true })
    await adminDb.doc(`users/${ORG}`).set({ uid: ORG, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    await adminDb.doc(`users/${ORG}/eventDrafts/${P}-draft`).set({ status: 'published', eventDetails: { info: { name: 'Staff Sec' } } })

    const created = await svc.createStaffAccount({
      organizerUid: ORG, actorUid: ORG, username: `${P}-gate`.slice(0, 32), displayName: 'Gate', role: 'checkin_staff', eventIds: [`${P}-draft`],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    staffId = created.data.staff.staffId
    staffPassword = created.data.temporaryPassword
    staffEmail = (await adminAuth.getUser(staffId)).email!
  }, T)

  afterAll(async () => {
    for (const d of (await adminDb.collection('staffAccounts').where('organizerUid', '==', ORG).get()).docs) {
      await adminAuth.deleteUser(d.id).catch(() => null)
      await adminDb.doc(`staffUsernames/${(d.data() as { username: string }).username}`).delete().catch(() => null)
      await d.ref.delete()
    }
    for (const d of (await adminDb.collection('teamMembers').where('organizerUid', '==', ORG).get()).docs) await d.ref.delete()
    await adminDb.recursiveDelete(adminDb.doc(`users/${ORG}`)).catch(() => null)
    await adminAuth.deleteUser(ORG).catch(() => null)
    vi.restoreAllMocks()
  }, T)

  it('1 · an ACTIVE gate credential is refused by owner-only routes; the organizer is not', async () => {
    const staff = await signIn(staffEmail, staffPassword)
    expect(staff.ok).toBe(true)
    const keys = await import('@/app/api/organizer/api-keys/route')
    expect((await keys.GET(get('/api/organizer/api-keys', staff.idToken!))).status).toBe(403)
    const org = await signIn(`${P}-org@registerdesk.test`, ORG_PASSWORD)
    expect((await keys.GET(get('/api/organizer/api-keys', org.idToken!))).status).toBe(200)
  }, T)

  it('2 + 3 · SUSPEND disables the sign-in; a still-enabled suspended credential gets NO permissions (never owner)', async () => {
    // A session already OPEN when the organizer suspends: its token must stop working at once.
    const open = await signIn(staffEmail, staffPassword)
    expect(open.ok).toBe(true)
    expect((await svc.updateStaffAccount({ organizerUid: ORG, actorUid: ORG, staffId, status: 'suspended' })).ok).toBe(true)
    const { authorizeWorkspace: authz } = await import('@/lib/team/workspace')
    expect((await authz(get('/x', open.idToken!), 'checkin')).status).toBe(401)        // revoked → no caller
    expect((await adminAuth.getUser(staffId)).disabled).toBe(true)
    const refused = await signIn(staffEmail, staffPassword)
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/USER_DISABLED/)

    // Simulate a disable that did not land: sign-in works again, membership still suspended.
    await adminAuth.updateUser(staffId, { disabled: false })
    const again = await signIn(staffEmail, staffPassword)
    expect(again.ok).toBe(true)
    const { resolveWorkspaceUid, authorizeWorkspace, authorizeAnyWorkspace } = await import('@/lib/team/workspace')
    const ctx = await resolveWorkspaceUid(staffId, staffEmail)
    expect(ctx).toMatchObject({ isOwner: false, permissions: [], isStaffCredential: true })
    for (const perm of ['events', 'registrations', 'wallet', 'broadcasts', 'checkin'] as const) {
      expect((await authorizeWorkspace(get('/x', again.idToken!), perm)).status, perm).toBe(403)
    }
    expect((await authorizeAnyWorkspace(get('/x', again.idToken!))).ok).toBe(false)
    // The staff sign-in screen's own check: GET /api/staff/me must REFUSE the revoked login
    // (the client signs out on !ok). It used to rely on ctx.isOwner, which the no-permission
    // context above no longer sets — a 200 sent the operator to an empty /ops, signed in.
    const me = await (await import('@/app/api/staff/me/route')).GET(get('/api/staff/me', again.idToken!))
    expect(me.status).toBe(403)
    expect(((await me.json()) as { error?: string }).error).toBe('This account is not active. Ask your organizer to re-enable it.')
    const ws = await import('@/app/api/organizer/workspace/route')
    const wsRes = await ws.GET(get('/api/organizer/workspace', again.idToken!))
    const wsBody = wsRes.status === 200 ? await wsRes.json() as { isOwner?: boolean } : { isOwner: false }
    expect(wsBody.isOwner).not.toBe(true)
    // The organizer is unaffected by the staff rule.
    expect(await resolveWorkspaceUid(ORG, `${P}-org@registerdesk.test`)).toMatchObject({ isOwner: true })
  }, T)

  it('4 · REACTIVATE re-enables the sign-in and restores check-in access only', async () => {
    expect((await svc.updateStaffAccount({ organizerUid: ORG, actorUid: ORG, staffId, status: 'active' })).ok).toBe(true)
    expect((await adminAuth.getUser(staffId)).disabled).toBe(false)
    const back = await signIn(staffEmail, staffPassword)
    expect(back.ok).toBe(true)
    const { authorizeWorkspace, PASSWORD_CHANGE_REQUIRED_ERROR } = await import('@/lib/team/workspace')
    // Still on the organizer-issued temporary password ⇒ the server requires the change first.
    const pending = await authorizeWorkspace(get('/x', back.idToken!), 'checkin')
    expect(pending.status).toBe(403)
    expect(pending.error).toBe(PASSWORD_CHANGE_REQUIRED_ERROR)
    expect((await svc.setOwnStaffPassword(staffId, 'ReactivatedGatePassw0rd!')).ok).toBe(true)
    const fresh = await signIn(staffEmail, 'ReactivatedGatePassw0rd!')
    expect(fresh.ok).toBe(true)
    staffPassword = 'ReactivatedGatePassw0rd!'
    expect((await authorizeWorkspace(get('/x', fresh.idToken!), 'checkin')).ok).toBe(true)
    expect((await authorizeWorkspace(get('/x', fresh.idToken!), 'events')).status).toBe(403)
  }, T)

  it('5 · a failed Auth delete keeps the account (retryable), disables the sign-in, and reports failure; the retry completes', async () => {
    const spy = vi.spyOn(adminAuth, 'deleteUser').mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'auth/internal-error' }))
    const first = await svc.deleteStaffAccount({ organizerUid: ORG, staffId })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.status).toBe(500)
    expect((await adminDb.doc(`staffAccounts/${staffId}`).get()).exists).toBe(true)     // still visible → retryable
    expect((await adminAuth.getUser(staffId)).disabled).toBe(true)                     // and unusable meanwhile
    spy.mockRestore()

    const retry = await svc.deleteStaffAccount({ organizerUid: ORG, staffId })
    expect(retry.ok).toBe(true)
    expect((await adminDb.doc(`staffAccounts/${staffId}`).get()).exists).toBe(false)
    await expect(adminAuth.getUser(staffId)).rejects.toMatchObject({ code: 'auth/user-not-found' })
  }, T)
})
