// RD-EVENT-COMMERCE-01 — regression suite for the defects fixed in Phase C part 1.
//
// Every case below FAILED on the code before this change (reproduced in the Phase A audit,
// docs/RD-EVENT-COMMERCE-01-AUDIT.md §2–§3) and runs the REAL handlers against REAL Firestore.
// Razorpay is an in-memory stub — `.env.local` holds LIVE keys, so no request leaves the process.
//
//   D1  capacity routes resolve the dashboard's DRAFT id to the live event's SLUG
//   D2  the dashboard receives the ENFORCED capacity, not the draft-derived estimate
//   D3  the licence detail route no longer throws on every request
//   D4  a stored totalCapacity survives getEventBySlug's legacy backfill (gate agrees with txn)
//   D5  admin tier actions never overwrite a PURCHASED capacity
//   X1  a new licence can no longer be bought by TIER (the unlimited-capacity bypass)
//   M1  a capacity licence is not capped by the free tier's media limit

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
// RD-EVENT-COMMERCE-05F — requests carry the Publish Agreement, as the wizard's always do.
import { withPublishAgreement } from '../helpers/publishAgreement'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const SECRET = 'rd_event_commerce_01_secret'

const UID   = `ec01-org-${process.pid}`
const DRAFT = `EcDraftId${process.pid}`
const SLUG  = `tech-summit-ec01-${process.pid}`
const ADMIN = `ec01-admin-${process.pid}`

const rzp = vi.hoisted(() => ({
  seq: 0,
  orders:   [] as Array<{ id: string; amount: number }>,
  payments: new Map<string, Record<string, unknown>>(),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_ec01', RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number }) => { const x = { id: `order_ec01_${++rzp.seq}`, amount: o.amount }; rzp.orders.push(x); return x },
      fetchPayments: async () => ({ items: [] }),
    },
    payments: {
      fetch: async (id: string) => { const p = rzp.payments.get(id); if (!p) throw new Error('no payment'); return p },
      refund: async () => ({ id: `rfnd_ec01_${++rzp.seq}` }),
    },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => ({ uid: UID, email: null }),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = { callerUid: UID, workspaceUid: UID, role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false }
  return { ...(await orig<typeof import('@/lib/team/workspace')>()),
    resolveWorkspaceUid: async () => ctx, authorizeWorkspace: async () => ({ ...ctx, ok: true, status: 200, error: '' }) }
})

const sign = (o: string, p: string) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex')
const post = (body: unknown) => new NextRequest('http://x/api/t', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body) })
const get  = () => new NextRequest('http://x/api/t', { method: 'GET', headers: { Authorization: 'Bearer t' } })

describeEmu('RD-EVENT-COMMERCE-01 · Phase C part 1 defect fixes', () => {
  let adminDb: import('firebase-admin/firestore').Firestore

  const draftData = (extra: Record<string, unknown> = {}) => ({
    uid: UID, status: 'published', eventType: 'sports',
    // One UNLIMITED pass — the draft-derived estimate calls this event "unlimited".
    pricing: { eventType: 'paid', passes: [{ id: 'p', name: 'Open', price: 100, unlimited: true, quantity: null, status: 'active' }] },
    eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'Tech Summit' } },
    ...extra,
  })

  async function seedPublished(capacity: number | null, eventExtra: Record<string, unknown> = {}) {
    await adminDb.doc(`users/${UID}/eventDrafts/${DRAFT}`).set(draftData())
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: DRAFT, totalCapacity: capacity, capacityPlan: 'pack_2500',
      lifecycleStatus: 'published', pricing: { eventType: 'paid' }, ...eventExtra })
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: UID, tier: 'free', status: 'active', version: 2,
      amountPaise: 195_762, orderId: `lic_${DRAFT}`, commercialModel: 'capacity', capacity })
  }

  async function wipe() {
    for (const c of ['licenseOrders', 'licenseHistory']) {
      for (const d of (await adminDb.collection(c).where('eventId', 'in', [SLUG, DRAFT]).get()).docs) await d.ref.delete()
    }
    for (const p of [`events/${SLUG}`, `eventLicenses/${SLUG}`, `users/${UID}/eventDrafts/${DRAFT}`,
                     `licenseOrders/lic_${DRAFT}`, `adminLicenseOverlays/${SLUG}`]) await adminDb.doc(p).delete().catch(() => null)
    rzp.orders.length = 0; rzp.payments.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)
  beforeEach(wipe, T)

  // ═══ D1 ══════════════════════════════════════════════════════════════════════
  it('D1 · quote → order → pay → confirm by DRAFT id changes the live event 1206 → 2000', async () => {
    await seedPublished(1206)
    const { POST: quote }   = await import('@/app/api/licensing/capacity/quote/route')
    const { POST: order }   = await import('@/app/api/licensing/capacity/order/route')
    const { POST: confirm } = await import('@/app/api/licensing/capacity/confirm/route')

    const q = await quote(post({ eventId: DRAFT, capacity: 2000 }))
    expect(q.status).toBe(200)                                   // was 404 "Event not found."
    expect(((await q.json()) as { quote: { totalPaise: number } }).quote.totalPaise).toBe(140_538)

    const o = await order(post({ eventId: DRAFT, capacity: 2000 }))
    expect(o.status).toBe(200)
    const ob = await o.json() as { orderId: string }
    expect(ob.orderId).toBe(`cap_${SLUG}_1`)                     // keyed by the SLUG, as before
    expect(rzp.orders[0].amount).toBe(140_538)                   // ₹1,405.38 — the whole delta

    const pay = `pay_ec01_${++rzp.seq}`
    rzp.payments.set(pay, { id: pay, order_id: rzp.orders[0].id, amount: 140_538, currency: 'INR', status: 'captured' })
    const c = await confirm(post({ eventId: DRAFT, orderId: ob.orderId, razorpay_order_id: rzp.orders[0].id, razorpay_payment_id: pay, razorpay_signature: sign(rzp.orders[0].id, pay) }))
    expect(c.status).toBe(200)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.totalCapacity).toBe(2000)
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).data()!.capacity).toBe(2000)
  }, T)

  it('D1 · an id that is neither this organizer’s draft nor a live event is still 404', async () => {
    const { POST: quote } = await import('@/app/api/licensing/capacity/quote/route')
    expect((await quote(post({ eventId: 'nobody-knows-this', capacity: 2000 }))).status).toBe(404)
  }, T)

  // ═══ D2 ══════════════════════════════════════════════════════════════════════
  it('D2 · the dashboard gets the ENFORCED capacity (1206), not the pass-derived "unlimited"', async () => {
    await seedPublished(1206)
    const { GET } = await import('@/app/api/organizer/events/[eventId]/route')
    const res  = await GET(get(), { params: Promise.resolve({ eventId: DRAFT }) } as never)
    const body = await res.json() as { event?: Record<string, unknown> } & Record<string, unknown>
    const ev   = (body.event ?? body) as { totalCapacity?: unknown; enforcedCapacity?: unknown }
    expect(res.status).toBe(200)
    expect(ev.enforcedCapacity).toBe(1206)
    // RD-FIN-02 · Part 8 — the displayed capacity IS the enforced capacity now (one definition). It
    // used to stay a pass-derived "unlimited" (null) beside an enforced 1206 — the contradiction fixed.
    expect(ev.totalCapacity).toBe(1206)
  }, T)

  it('D2 · no live event → enforcedCapacity is ABSENT (the panel shows "unavailable", never a guess)', async () => {
    await adminDb.doc(`users/${UID}/eventDrafts/${DRAFT}`).set(draftData({ status: 'draft' }))
    const { GET } = await import('@/app/api/organizer/events/[eventId]/route')
    const body = await (await GET(get(), { params: Promise.resolve({ eventId: DRAFT }) } as never)).json() as Record<string, unknown>
    const ev = (body.event ?? body) as Record<string, unknown>
    expect('enforcedCapacity' in ev).toBe(false)
  }, T)

  // ═══ D3 ══════════════════════════════════════════════════════════════════════
  it('D3 · the licence detail route answers instead of throwing a ReferenceError', async () => {
    await seedPublished(1206)
    const { GET } = await import('@/app/api/organizer/licenses/[eventId]/route')
    const res = await GET(get(), { params: Promise.resolve({ eventId: SLUG }) } as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { license?: { registrationLimit?: unknown } } & Record<string, unknown>
    expect(JSON.stringify(body)).toContain('1206')
  }, T)

  // ═══ D4 ══════════════════════════════════════════════════════════════════════
  it('D4 · a legacy event (no capacityPlan) that bought capacity keeps it through getEventBySlug', async () => {
    const { getEventBySlug } = await import('@/lib/firebase/firestore/events')
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: DRAFT, totalCapacity: 500, pricing: { eventType: 'free' } })
    expect((await getEventBySlug(SLUG))!.totalCapacity).toBe(500)           // was reset to 100
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: DRAFT, totalCapacity: null, pricing: { eventType: 'free' } })
    expect((await getEventBySlug(SLUG))!.totalCapacity).toBeNull()          // explicit unlimited kept
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: DRAFT, pricing: { eventType: 'free' } })
    expect((await getEventBySlug(SLUG))!.totalCapacity).toBe(100)           // truly legacy: backfill unchanged
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: DRAFT, pricing: { eventType: 'paid' } })
    expect((await getEventBySlug(SLUG))!.totalCapacity).toBeNull()
  }, T)

  // ═══ D5 ══════════════════════════════════════════════════════════════════════
  it('D5 · admin REISSUE keeps a purchased 1206 (was reset to the free-tier limit)', async () => {
    await seedPublished(1206)
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await applyLicenseAction(SLUG, { action: 'reissue', reason: 'support recovery test' }, ADMIN)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.totalCapacity).toBe(1206)
  }, T)

  // RD-EVENT-COMMERCE-05 — tier actions are now RETIRED for every licence (410, was 409 for capacity
  // licences only). The guarantee this test exists for is unchanged: refused, capacity untouched.
  it('D5 · admin UPGRADE / DOWNGRADE / GRANT are refused on a capacity licence (retired: 410)', async () => {
    await seedPublished(1206)
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    for (const req of [
      { action: 'upgrade',   reason: 'test', tier: 'professional' },
      { action: 'downgrade', reason: 'test', tier: 'free' },
    ] as const) {
      await expect(applyLicenseAction(SLUG, req as never, ADMIN)).rejects.toMatchObject({ status: 410 })
    }
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ status: 'suspended' }, { merge: true })   // so grant reaches our guard
    await expect(applyLicenseAction(SLUG, { action: 'grant', reason: 'test', tier: 'professional' } as never, ADMIN))
      .rejects.toMatchObject({ status: 410 })
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.totalCapacity).toBe(1206)
  }, T)

  it('D5 · a TIER licence still re-syncs on reissue (legacy behaviour preserved)', async () => {
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: DRAFT, totalCapacity: 1, pricing: { eventType: 'paid' } })
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: UID, tier: 'professional', status: 'active', version: 2, amountPaise: 0, orderId: null })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await applyLicenseAction(SLUG, { action: 'reissue', reason: 'test' }, ADMIN)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.totalCapacity).not.toBe(1)
  }, T)

  // ═══ X1 ══════════════════════════════════════════════════════════════════════
  it('X1 · buying by TIER (no capacity) is refused, and no Razorpay order is created', async () => {
    await adminDb.doc(`users/${UID}/eventDrafts/${DRAFT}`).set(draftData({ status: 'draft', licenseTier: 'enterprise' }))
    const purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    const res = await purchase(post({ eventId: DRAFT, tier: 'enterprise' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { failureReason?: string }).failureReason).toBe('capacity_required')
    expect(rzp.orders).toHaveLength(0)
    expect((await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).exists).toBe(false)
  }, T)

  it('X1 · a capacity order ignores a client-sent tier — it is always stamped with the default tier', async () => {
    await adminDb.doc(`users/${UID}/eventDrafts/${DRAFT}`).set(draftData({ status: 'draft' }))
    const purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    const res = await purchase(post({ eventId: DRAFT, capacity: 1206, tier: 'enterprise' }))
    expect(res.status).toBe(200)
    const orderDoc = (await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!
    expect(orderDoc.tier).toBe('free')
    expect(orderDoc.razorpayAmountPaise).toBe(195_762)
  }, T)

  // ═══ M1 ══════════════════════════════════════════════════════════════════════
  it('M1 · a capacity licence resolves media limits from the GLOBAL layer, a tier licence from its tier', async () => {
    const { resolveEventTier } = await import('@/lib/config/resolveMediaConfig')
    await seedPublished(5000)
    expect(await resolveEventTier(SLUG)).toBeNull()              // was 'free' ⇒ 50 photos
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: UID, tier: 'professional', status: 'active', version: 2 })
    expect(await resolveEventTier(SLUG)).toBe('professional')    // historical tier licences unchanged
  }, T)
})
