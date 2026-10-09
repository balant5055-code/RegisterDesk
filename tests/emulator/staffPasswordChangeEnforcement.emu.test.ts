// RD-STAFF-PW-01 / RD-STAFF-SEC-02 — staff first-login password change is enforced SERVER-side,
// and gate-only staff cannot use the print download routes. REAL Firestore + REAL Auth-emulator
// ID tokens + the real route handlers; no identity mocks.
//
//   • with the organizer-issued TEMPORARY password, a direct call to any gate API is refused
//     (scan, event check-in context, the authorizers) — the login screen is no longer the only gate;
//   • the endpoints the change itself needs stay reachable: GET /api/staff/me and
//     POST /api/staff/password;
//   • after the change (and a fresh sign-in) check-in works; an organizer reset re-imposes it;
//   • organizers are never affected;
//   • a gate-only credential is refused by both print download routes, like every sibling route.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `stfpw-${process.pid}`
const ORG = `${P}-org`
const ORG_EMAIL = `${P}-org@registerdesk.test`
const ORG_PASSWORD = 'StfPwOrgPassw0rd!'
const DRAFT = `${P}-ev`

async function signIn(email: string, password: string): Promise<string> {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  const body = await r.json() as { idToken?: string; error?: { message?: string } }
  if (!r.ok || !body.idToken) throw new Error(`sign-in failed: ${body.error?.message}`)
  return body.idToken
}
const req = (url: string, token: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

describeEmu('RD-STAFF-PW-01 · forced password change + print downloads (real Auth + Firestore)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let svc: typeof import('@/lib/staff/service')
  let ws: typeof import('@/lib/team/workspace')
  let staffId = '', staffEmail = '', tempPassword = ''

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminAuth, adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/staff/service')
    ws = await import('@/lib/team/workspace')
    await adminAuth.deleteUser(ORG).catch(() => null)
    await adminAuth.createUser({ uid: ORG, email: ORG_EMAIL, password: ORG_PASSWORD, emailVerified: true })
    await adminDb.doc(`users/${ORG}`).set({ uid: ORG, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    const ev = { eventType: 'conference', eventDetails: { seo: { urlSlug: DRAFT }, info: { name: 'Staff PW' } }, registrationForm: { fields: [], registrationRules: {} },
      pricing: { passes: [{ id: 'p1', name: 'General', price: 0, unlimited: true, quantity: null }] } }
    await adminDb.doc(`users/${ORG}/eventDrafts/${DRAFT}`).set({ status: 'published', ...ev })
    await adminDb.doc(`events/${DRAFT}`).set({ uid: ORG, draftId: DRAFT, slug: DRAFT, lifecycleStatus: 'published', ...ev })
    const created = await svc.createStaffAccount({ organizerUid: ORG, actorUid: ORG, username: `${P}-gate`.slice(0, 32), displayName: 'Gate', role: 'checkin_lead', eventIds: [DRAFT] })
    if (!created.ok) throw new Error(created.error)
    staffId = created.data.staff.staffId
    tempPassword = created.data.temporaryPassword
    staffEmail = (await adminAuth.getUser(staffId)).email!
  }, T)

  afterAll(async () => {
    await svc.deleteStaffAccount({ organizerUid: ORG, staffId }).catch(() => null)
    for (const d of (await adminDb.collection('teamMembers').where('organizerUid', '==', ORG).get()).docs) await d.ref.delete()
    await adminDb.recursiveDelete(adminDb.doc(`users/${ORG}`)).catch(() => null)
    await adminDb.doc(`events/${DRAFT}`).delete().catch(() => null)
    await adminAuth.deleteUser(ORG).catch(() => null)
  }, T)

  it('with the TEMPORARY password every gate API refuses a direct call; /api/staff/me still answers', async () => {
    const token = await signIn(staffEmail, tempPassword)
    for (const perm of ['checkin', 'walkin'] as const) {
      const a = await ws.authorizeWorkspace(req('/x', token), perm)
      expect(a.status, perm).toBe(403)
      expect(a.error).toBe(ws.PASSWORD_CHANGE_REQUIRED_ERROR)
    }
    expect((await ws.authorizeEvent(req('/x', token), 'checkin', DRAFT)).status).toBe(403)
    const scan = await (await import('@/app/api/checkin/scan/route')).POST(req('/api/checkin/scan', token, 'POST', { ticketCode: 'RD-NOPE', source: 'manual' }))
    expect(scan.status).toBe(403)
    const ops = await (await import('@/app/api/checkin/ops/[eventId]/route')).GET(req(`/api/checkin/ops/${DRAFT}`, token), params({ eventId: DRAFT }))
    expect(ops.status).toBe(403)
    const me = await (await import('@/app/api/staff/me/route')).GET(req('/api/staff/me', token))
    expect(me.status).toBe(200)
    expect((await me.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(true)
  }, T)

  it('POST /api/staff/password stays reachable; after the change (fresh sign-in) check-in works', async () => {
    const token = await signIn(staffEmail, tempPassword)
    const pw = await (await import('@/app/api/staff/password/route')).POST(req('/api/staff/password', token, 'POST', { password: 'MyOwnGatePassw0rd!' }))
    expect(pw.status).toBe(200)
    const fresh = await signIn(staffEmail, 'MyOwnGatePassw0rd!')
    expect((await ws.authorizeWorkspace(req('/x', fresh), 'checkin')).ok).toBe(true)
    expect((await ws.authorizeEvent(req('/x', fresh), 'checkin', DRAFT)).ok).toBe(true)
    expect((await ws.authorizeWorkspace(req('/x', fresh), 'events')).status).toBe(403)         // still least privilege
  }, T)

  it('an organizer password RESET re-imposes the change', async () => {
    const reset = await svc.resetStaffPassword({ organizerUid: ORG, staffId })
    expect(reset.ok).toBe(true)
    if (!reset.ok) return
    const token = await signIn(staffEmail, reset.data.temporaryPassword)
    const a = await ws.authorizeWorkspace(req('/x', token), 'checkin')
    expect(a.status).toBe(403)
    expect(a.error).toBe(ws.PASSWORD_CHANGE_REQUIRED_ERROR)
    tempPassword = reset.data.temporaryPassword
  }, T)

  it('organizers are never affected', async () => {
    const token = await signIn(ORG_EMAIL, ORG_PASSWORD)
    for (const perm of ['checkin', 'events', 'registrations'] as const) expect((await ws.authorizeWorkspace(req('/x', token), perm)).ok, perm).toBe(true)
  }, T)

  it('gate-only staff are refused by both print download routes; the organizer passes authorization', async () => {
    // Change the password first so the refusal below is the ROLE, not the pending change.
    const t0 = await signIn(staffEmail, tempPassword)
    expect((await (await import('@/app/api/staff/password/route')).POST(req('/api/staff/password', t0, 'POST', { password: 'AnotherGatePassw0rd!' }))).status).toBe(200)
    const staff = await signIn(staffEmail, 'AnotherGatePassw0rd!')
    const org = await signIn(ORG_EMAIL, ORG_PASSWORD)
    const item = await import('@/app/api/organizer/print-jobs/[jobId]/items/[registrationId]/download/route')
    const pkg  = await import('@/app/api/organizer/print-packages/[jobId]/download/route')
    const jobP = params({ jobId: `${P}-nojob`, registrationId: 'r1' })
    expect((await item.GET(req('/x', staff), jobP)).status).toBe(403)
    expect((await pkg.GET(req('/x', staff), params({ jobId: `${P}-nojob` }))).status).toBe(403)
    // The organizer gets past authorization (the job simply does not exist).
    expect((await item.GET(req('/x', org), jobP)).status).toBe(404)
    expect((await pkg.GET(req('/x', org), params({ jobId: `${P}-nojob` }))).status).toBe(404)
  }, T)
})
