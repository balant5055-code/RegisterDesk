// RD-CE-FIX M5 — the Create Event licensing routes enforce team permission and suspension.
//
// purchase, checkout/quote, coupons/validate, activation-status, capacity/activation-quote, verify and
// the organizer licence views used verifyCaller + resolveWorkspaceUid only: any workspace member —
// a check-in-only or finance member, or a member of a SUSPENDED owner — could create Razorpay orders
// and read licence amounts. They now use the same gate as capacity/* and checkout/confirm:
// authorizeWorkspace(req, 'events'). Real Firestore; only the token check (caller uid) is replaced.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

const OWNER = `la-own-${P}`, MGR = `la-mgr-${P}`, GATE = `la-gate-${P}`, FIN = `la-fin-${P}`
const SUSP_OWNER = `la-sown-${P}`, SUSP_MGR = `la-smgr-${P}`, SUSP_SELF = `la-sself-${P}`
const DRAFT = `la-draft-${P}`

const h = vi.hoisted(() => ({ caller: '' }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_la', RAZORPAY_KEY_SECRET: 'la',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders in this suite') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('no refunds') } },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.caller ? { uid: h.caller, email: `${h.caller}@rd.test` } : null),
}))
const as = (uid: string) => { h.caller = uid }
const post = (body: unknown) => new NextRequest('http://x/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body) })
const get = (url: string) => new NextRequest(url, { method: 'GET', headers: { Authorization: 'Bearer t' } })

describeEmu('RD-CE-FIX M5 · licensing team permission + suspension', () => {
  let db: import('firebase-admin/firestore').Firestore
  let quote: typeof import('@/app/api/licensing/checkout/quote/route').POST
  let status: typeof import('@/app/api/licensing/activation-status/route').GET
  let purchase: typeof import('@/app/api/licensing/purchase/route').POST
  let licenses: typeof import('@/app/api/organizer/licenses/route').GET

  beforeAll(async () => {
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ POST: quote } = await import('@/app/api/licensing/checkout/quote/route'))
    ;({ GET: status } = await import('@/app/api/licensing/activation-status/route'))
    ;({ POST: purchase } = await import('@/app/api/licensing/purchase/route'))
    ;({ GET: licenses } = await import('@/app/api/organizer/licenses/route'))
    const profile = (uid: string, owner: boolean, accountStatus = 'active') =>
      db.doc(`users/${uid}`).set({ uid, role: 'organizer', accountStatus, email: `${uid}@rd.test`, workspaceOwner: owner })
    await Promise.all([
      profile(OWNER, true), profile(MGR, false), profile(GATE, false), profile(FIN, false),
      profile(SUSP_OWNER, true, 'suspended'), profile(SUSP_MGR, false), profile(SUSP_SELF, false, 'suspended'),
    ])
    const member = (uid: string, org: string, role: string) => db.collection('teamMembers').add({ memberUid: uid, organizerUid: org, role, status: 'active', email: `${uid}@rd.test`, eventIds: [] })
    await Promise.all([member(MGR, OWNER, 'manager'), member(GATE, OWNER, 'checkin_staff'), member(FIN, OWNER, 'finance'), member(SUSP_MGR, SUSP_OWNER, 'manager'), member(SUSP_SELF, OWNER, 'manager')])
    await db.doc(`users/${OWNER}/eventDrafts/${DRAFT}`).set({ status: 'draft', lifecycleStatus: 'draft', eventDetails: {} })
  }, T)

  it('owner and an `events` member may quote and read activation status', async () => {
    for (const who of [OWNER, MGR]) {
      as(who)
      expect((await quote(post({ eventId: DRAFT, capacity: 100 }))).status, who).toBe(200)
      expect((await status(get(`http://x/api/licensing/activation-status?eventId=${DRAFT}`))).status, who).toBe(200)
    }
  }, T)

  it('a check-in-only or finance member is refused (403) on every licensing route', async () => {
    for (const who of [GATE, FIN]) {
      as(who)
      expect((await quote(post({ eventId: DRAFT, capacity: 100 }))).status, `${who} quote`).toBe(403)
      expect((await status(get(`http://x/api/licensing/activation-status?eventId=${DRAFT}`))).status, `${who} status`).toBe(403)
      expect((await purchase(post({ eventId: DRAFT, capacity: 500, agreement: {} }))).status, `${who} purchase`).toBe(403)
      expect((await licenses(get('http://x/api/organizer/licenses'))).status, `${who} licenses`).toBe(403)
    }
  }, T)

  it('a suspended member, and any member of a suspended owner, are refused; no token is 401', async () => {
    for (const who of [SUSP_SELF, SUSP_MGR]) {
      as(who)
      expect((await quote(post({ eventId: DRAFT, capacity: 100 }))).status, who).toBe(403)
      expect((await purchase(post({ eventId: DRAFT, capacity: 500, agreement: {} }))).status, who).toBe(403)
    }
    as('')
    expect((await quote(post({ capacity: 100 }))).status).toBe(401)
  }, T)
})
