// RD-PRINT-BILL-P2 — a failed audit write commits NOTHING. The licenseHistory collection path is made
// invalid so the history write throws INSIDE the route's transaction; the event's override and the
// admin audit log must both be left exactly as they were. Real Firestore + real Auth tokens.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `pb2f-${process.pid}`
const EV = `${P}-ev`
const PASSWORD = 'PrintBadgeP2FailPassw0rd!'
const EMAIL = `${P}-super@registerdesk.test`

// The ONLY change: the history collection path is invalid, so staging the audit throws mid-transaction.
vi.mock('@/lib/licensing/schema', async orig => ({ ...(await orig<typeof import('@/lib/licensing/schema')>()), LICENSE_HISTORY_COLLECTION: 'bad//path' }))

describeEmu('RD-PRINT-BILL-P2 · transaction failure leaves no partial change or audit', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let superUid = '', token = ''
  const saved = process.env.ADMIN_UIDS

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminDb = admin.adminDb; adminAuth = admin.adminAuth
    const u = await adminAuth.getUserByEmail(EMAIL).catch(() => null) ?? await adminAuth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true })
    superUid = u.uid
    process.env.ADMIN_UIDS = superUid
    const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    })
    token = ((await r.json()) as { idToken: string }).idToken
    await adminDb.doc(`events/${EV}`).set({ uid: 'org', draftId: `${P}-d`, slug: EV, printBadgeCommercial: { unitPricePaise: 30 } })
  }, T)

  afterAll(async () => {
    if (saved === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = saved
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', EV).get()).docs) await d.ref.delete()
    await adminAuth.deleteUser(superUid).catch(() => null)
  }, T)

  it('the override is unchanged and no audit row exists after the failed transaction', async () => {
    const route = await import('@/app/api/admin/events/[slug]/print-badges/route')
    const call = route.POST(new NextRequest('http://x/api/t', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ override: { complimentary: true }, reason: 'Should not commit' }),
    }), { params: Promise.resolve({ slug: EV }) })
    await expect(call).rejects.toThrow()
    expect(((await adminDb.doc(`events/${EV}`).get()).data() as Record<string, unknown>).printBadgeCommercial).toEqual({ unitPricePaise: 30 })
    expect((await adminDb.collection('adminAuditLogs').where('entityId', '==', EV).get()).size).toBe(0)
  }, T)
})
