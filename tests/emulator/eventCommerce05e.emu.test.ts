// RD-EVENT-COMMERCE-05E — the Fee Collection Method is organizer-editable after publishing, for
// FUTURE checkouts only. Driven through the REAL routes against REAL Firestore:
//   PATCH /api/organizer/events/[eventId]/edit   (the one post-publish path that changes it)
//   POST  /api/registrations/create-order        (what an attendee checkout is priced with)
// Stubbed: organizer auth (a chosen uid), the pricing-engine switch, the fee rates, the rate
// limiter, the registration gate, and the payment GATEWAY adapter (no real Razorpay call is ever
// made). Everything that decides the fee model — the event document, the payment intent, the
// attempt claim — is production code on the emulator.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

const OWNER    = `c05e-owner-${process.pid}`
const INTRUDER = `c05e-intruder-${process.pid}`
const DRAFT    = `C05eDraft${process.pid}`
const SLUG     = `c05e-city-run-${process.pid}`

const h = vi.hoisted(() => ({ uid: '', engine: true, seq: 0, orders: [] as Array<{ id: string; amountPaise: number }> }))

vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', callerUid: h.uid, workspaceUid: h.uid,
    role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false,
  }),
}))
vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: h.engine } }),
}))
vi.mock('@/lib/billing/feeEngine', async orig => ({
  ...(await orig<typeof import('@/lib/billing/feeEngine')>()),
  getFeePlanForOrganizer: async () => ({ planTier: 'standard', feeConfigId: 'fc_test' }),
}))
vi.mock('@/lib/fees/resolveFeeConfig', async orig => ({
  ...(await orig<typeof import('@/lib/fees/resolveFeeConfig')>()),
  // 2% platform fee + 18% GST on it, 2% gateway estimate — test rates, not the product's.
  resolveFeeConfig: async () => ({ platformFeePercentBps: 200, platformFeeFixedPaise: 0, platformFeeMinPaise: 0, platformFeeMaxPaise: 0,
    gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 }),
}))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock('@/lib/registrations/gate', () => ({ checkRegistrationGate: async () => ({ allowed: true }) }))
vi.mock('@/lib/payments/providers', async orig => {
  const real = await orig<typeof import('@/lib/payments/providers')>()
  const adapter = {
    createOrder: async ({ amountPaise }: { amountPaise: number }) => {
      const id = `order_c05e_${process.pid}_${++h.seq}`
      h.orders.push({ id, amountPaise })
      return { providerOrderId: id, checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' } }
    },
    getCheckoutHandoff: async () => ({ provider: 'razorpay', keyId: 'rzp_test_stub' }),
    fetchOrderPayments: async () => [],
  }
  return {
    ...real,
    resolveActivePaymentProviderForNewOrder: async () => ({ ok: true, provider: 'razorpay' }),
    resolvePaymentProvider: () => adapter,
  }
})

const PASS = {
  id: 'pass_10k', name: '10K', type: 'paid', price: 500, earlyBirdEnabled: false, unlimited: false, quantity: 500,
  visibility: 'public', status: 'active', advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
}
const pricing = (feeModel: string) => ({ eventType: 'paid', feeModel, passes: [PASS], advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } })
const details = { info: { name: 'City Run' }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: SLUG } }

const patch = (body: unknown) => new NextRequest('http://x/api/t', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body) })
const orderReq = (key: string, email = 'runner@example.test') => new NextRequest('http://x/api/registrations/create-order', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: SLUG, passId: PASS.id, attendee: { name: 'Runner', email }, formResponses: {}, idempotencyKey: key, termsAccepted: true }),
})

describeEmu('RD-EVENT-COMMERCE-05E · Fee Collection Method after publishing — future checkouts only', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let editRoute: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let createOrder: (r: NextRequest) => Promise<Response>

  const draftRef = (uid = OWNER) => adminDb.doc(`users/${uid}/eventDrafts/${DRAFT}`)
  const liveRef  = () => adminDb.doc(`events/${SLUG}`)
  const edit = (body: unknown) => editRoute(patch(body), { params: Promise.resolve({ eventId: DRAFT }) })
  const liveFee  = async () => ((await liveRef().get()).data()!.pricing as { feeModel?: string }).feeModel
  const draftFee = async () => ((await draftRef().get()).data()!.pricing as { feeModel?: string }).feeModel
  const intent = async (orderId: string) => (await adminDb.doc(`paymentIntents/${orderId}`).get()).data()!

  async function seed(status: 'published' | 'pending_review', feeModel = 'organizer_absorbs') {
    await draftRef().set({ uid: OWNER, status, lifecycleStatus: status, eventType: 'sports', pricing: pricing(feeModel), eventDetails: details })
    await liveRef().set({ uid: OWNER, draftId: DRAFT, slug: SLUG, status, lifecycleStatus: status, totalCapacity: 500,
      pricing: pricing(feeModel), eventDetails: details, registrationForm: { sections: [] }, accessControl: { type: 'open' } })
  }
  async function wipe() {
    await adminDb.recursiveDelete(liveRef()).catch(() => null)
    await draftRef().delete().catch(() => null)
    for (const o of h.orders) await adminDb.doc(`paymentIntents/${o.id}`).delete().catch(() => null)
    const claims = await adminDb.collection('paymentAttemptClaims').where('eventSlug', '==', SLUG).get().catch(() => null)
    for (const c of claims?.docs ?? []) await c.ref.delete().catch(() => null)
    h.orders.length = 0
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ PATCH: editRoute } = await import('@/app/api/organizer/events/[eventId]/edit/route'))
    ;({ POST: createOrder } = await import('@/app/api/registrations/create-order/route'))
  }, T)
  afterAll(wipe, T)
  beforeEach(async () => { h.uid = OWNER; h.engine = true; await wipe() }, T)

  // ═══ RD-PHASE4-S3 · Q1 — SUPERSEDES the RD-EVENT-COMMERCE-05E behaviour ══════════════════════
  // Fee collection is FIXED to organizer-pays. The Fee Collection Method is no longer organizer-editable
  // (before or after publishing), and a stored legacy value never makes an attendee pay platform fees.
  // What remains pinned from 05E: an in-progress checkout keeps its own terms, and completed ones never move.

  it('the organizer can NOT change it on a LIVE event (403 PRICING_NOT_ORGANIZER_EDITABLE); nothing is written', async () => {
    await seed('published')
    const before = (await liveRef().get()).data()!
    for (const v of ['attendee_pays', 'organizer_absorbs']) {
      const res = await edit({ feeModel: v })
      expect(res.status, v).toBe(403)
      expect(await res.json(), v).toMatchObject({ success: false, code: 'PRICING_NOT_ORGANIZER_EDITABLE' })
    }
    expect(await liveFee()).toBe('organizer_absorbs')
    expect(await draftFee()).toBe('organizer_absorbs')
    const after = (await liveRef().get()).data()!
    expect(after.lifecycleStatus).toBe('published')
    expect(after.publishedAt ?? null).toEqual(before.publishedAt ?? null)
    expect((await adminDb.collection('licenseOrders').where('eventId', 'in', [DRAFT, SLUG]).get()).size).toBe(0)
    expect(h.orders).toHaveLength(0)
  }, T)

  it('another organizer is refused too (the pricing refusal comes before any lookup); nothing is written', async () => {
    await seed('published')
    h.uid = INTRUDER
    expect((await edit({ feeModel: 'attendee_pays' })).status).toBe(403)
    expect(await liveFee()).toBe('organizer_absorbs')
  }, T)

  it('refused whatever the value, whatever the engine state, and whatever else rides along', async () => {
    await seed('published')
    for (const engine of [true, false]) {
      h.engine = engine
      for (const body of [{ feeModel: 'customer_pays' }, { feeModel: 'attendee_pays' }, { feeModel: 'attendee_pays', passPrices: { pass_10k: 1 } }, { feeModel: 'organizer_absorbs', tagline: 'x' }]) {
        expect((await edit(body)).status, JSON.stringify({ engine, body })).toBe(403)
      }
    }
    expect(await liveFee()).toBe('organizer_absorbs')
    expect(await draftFee()).toBe('organizer_absorbs')
  }, T)

  it('awaiting approval: refused as well; a content-only edit stays draft-only and the approval status is unchanged', async () => {
    await seed('pending_review')
    expect((await edit({ feeModel: 'attendee_pays' })).status).toBe(403)
    const res = await edit({ tagline: 'Draft-only tagline' })
    expect(res.status).toBe(200)
    const live = (await liveRef().get()).data()!
    expect((live.pricing as { feeModel: string }).feeModel).toBe('organizer_absorbs')
    expect((live.eventDetails as { info: { tagline?: string } }).info.tagline).toBeUndefined()   // other content: draft only
    expect(live.lifecycleStatus).toBe('pending_review')
    const dr = (await draftRef().get()).data()!
    expect(dr.status).toBe('pending_review')
    expect((dr.pricing as { feeModel: string }).feeModel).toBe('organizer_absorbs')
  }, T)

  it('a stored legacy attendee_pays never charges the attendee; an in-progress checkout keeps its terms; completed terms never move', async () => {
    await seed('published', 'attendee_pays')                      // a legacy / organizer-written value on the LIVE event
    const regRef = adminDb.doc(`registrations/c05e-reg-${process.pid}`)
    await regRef.set({ eventSlug: SLUG, amountPaise: 50_000, financials: { feeModel: 'organizer_pays', chargeAmountPaise: 50_000 } })
    const regBefore = (await regRef.get()).data()

    // 1. Checkout A (engine ON): organizer-pays — the attendee is charged the ticket only.
    const a1 = await (await createOrder(orderReq('c05eKeyAAAAAAAA'))).json() as { orderId: string; amount: number }
    expect(a1.amount).toBe(50_000)
    expect((await intent(a1.orderId)).financials.feeModel).toBe('organizer_pays')

    // 2. Retried: SAME order, SAME amount, SAME terms — nothing re-priced or superseded.
    const a2 = await (await createOrder(orderReq('c05eKeyAAAAAAAA'))).json() as { orderId: string; amount: number; reused?: boolean }
    expect(a2).toMatchObject({ orderId: a1.orderId, amount: 50_000, reused: true })
    expect((await intent(a1.orderId)).financials.feeModel).toBe('organizer_pays')

    // 3. A NEW checkout B is organizer-pays too — the stored attendee_pays is not an input.
    const b = await (await createOrder(orderReq('c05eKeyBBBBBBBB', 'second@example.test'))).json() as { orderId: string; amount: number }
    expect(b.orderId).not.toBe(a1.orderId)
    expect(b.amount).toBe(50_000)
    expect((await intent(b.orderId)).financials.feeModel).toBe('organizer_pays')
    expect(h.orders).toHaveLength(2)

    // 4. The completed registration is untouched.
    expect((await regRef.get()).data()).toEqual(regBefore)
    await regRef.delete()
  }, T)
})
