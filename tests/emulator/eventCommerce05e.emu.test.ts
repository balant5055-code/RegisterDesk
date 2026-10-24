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

const previewReq = () => new NextRequest('http://x/api/registrations/fee-preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: SLUG, passId: PASS.id }),
})

// Stub rates: 2% platform + 18% GST on it, 2% gateway estimate, on a ₹500 ticket (50,000 paise).
const TICKET          = 50_000
const PLATFORM_BASE   = 1_000     // 2% of 50,000
const PLATFORM_GST    = 180       // 18% of 1,000
const GATEWAY_EST     = 1_000     // 2% of 50,000
const ATTENDEE_CHARGE = TICKET + PLATFORM_BASE + PLATFORM_GST + GATEWAY_EST   // 52,180
const ORGANIZER_NET   = TICKET - PLATFORM_BASE - PLATFORM_GST - GATEWAY_EST   // 47,820

describeEmu('RD-FEE-RESTORE-01 · Fee Collection Method after publishing — future checkouts only', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let editRoute: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let createOrder: (r: NextRequest) => Promise<Response>
  let feePreview: (r: NextRequest) => Promise<Response>

  const draftRef = (uid = OWNER) => adminDb.doc(`users/${uid}/eventDrafts/${DRAFT}`)
  const liveRef  = () => adminDb.doc(`events/${SLUG}`)
  const edit = (body: unknown) => editRoute(patch(body), { params: Promise.resolve({ eventId: DRAFT }) })
  const liveFee  = async () => ((await liveRef().get()).data()!.pricing as { feeModel?: string }).feeModel
  const draftFee = async () => ((await draftRef().get()).data()!.pricing as { feeModel?: string }).feeModel
  /** RD-FEE-RESTORE-01 — the EXPLICIT record, which is the only thing checkout reads. */
  const liveChoice  = async () => ((await liveRef().get()).data()!.pricing as { feeCollection?: { model?: string } }).feeCollection?.model ?? null
  const draftChoice = async () => ((await draftRef().get()).data()!.pricing as { feeCollection?: { model?: string } }).feeCollection?.model ?? null
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
    ;({ POST: feePreview } = await import('@/app/api/registrations/fee-preview/route'))
  }, T)
  afterAll(wipe, T)
  beforeEach(async () => { h.uid = OWNER; h.engine = true; await wipe() }, T)

  // ═══ RD-FEE-RESTORE-01 — SUPERSEDES the Q1 inversion of this file ════════════════════════════
  // Q1 fixed fee collection to organizer-pays and these cases asserted the refusal. The product
  // decision has been reversed: organizers choose again, gated on pricingEngineEnabled. What Q1
  // was really protecting is unchanged and is case 4 below — a stored LEGACY value still never
  // charges an attendee, so every event that exists today is priced exactly as it is today.

  it('1 · engine OFF: the change is refused (403) and nothing is written — Q1 behaviour, preserved', async () => {
    await seed('published')
    h.engine = false
    for (const v of ['attendee_pays', 'organizer_absorbs']) {
      const res = await edit({ feeModel: v })
      expect(res.status, v).toBe(403)
      expect(await res.json(), v).toMatchObject({ success: false, code: 'PRICING_NOT_ORGANIZER_EDITABLE' })
    }
    expect(await liveChoice()).toBeNull()
    expect(await draftChoice()).toBeNull()
    expect(await liveFee()).toBe('organizer_absorbs')
  }, T)

  it('2 · engine ON: the choice is recorded on BOTH the draft and the live event, atomically', async () => {
    await seed('published')
    const res = await edit({ feeModel: 'attendee_pays' })
    expect(res.status).toBe(200)
    // Both documents, or neither — the batch is what stops a republish silently reverting it.
    expect(await liveChoice()).toBe('attendee_pays')
    expect(await draftChoice()).toBe('attendee_pays')
    // The LEGACY field is deliberately untouched: it is what every pre-existing event carries.
    expect(await liveFee()).toBe('organizer_absorbs')
    expect(await draftFee()).toBe('organizer_absorbs')
    // Provenance is recorded with the choice.
    const fc = ((await liveRef().get()).data()!.pricing as { feeCollection: { setBy: string; setAt: string; version: number } }).feeCollection
    expect(fc.setBy).toBe(OWNER)
    expect(typeof fc.setAt).toBe('string')
    expect(fc.version).toBe(1)
  }, T)

  it('3 · another organizer cannot change it — the draft path is uid-scoped', async () => {
    await seed('published')
    h.uid = INTRUDER
    const res = await edit({ feeModel: 'attendee_pays' })
    expect(res.status).not.toBe(200)
    expect(await liveChoice()).toBeNull()
  }, T)

  it('4 · THE COMPATIBILITY GUARANTEE: a stored legacy attendee_pays still charges the ticket only', async () => {
    // The exact shape of a live event today: `pricing.feeModel = attendee_pays`, no explicit
    // record. It has been charged organizer-absorbs for its whole life and must keep being so.
    await seed('published', 'attendee_pays')
    const o = await (await createOrder(orderReq('c05eLegacyAAAAA'))).json() as { orderId: string; amount: number }
    expect(o.amount).toBe(TICKET)
    const f = (await intent(o.orderId)).financials
    expect(f.feeModel).toBe('organizer_pays')
    expect(f.chargeAmountPaise).toBe(TICKET)
    expect(f.netSettlementPaise).toBe(ORGANIZER_NET)
  }, T)

  it('5 · ORGANIZER-ABSORBS checkout: the attendee pays the ticket, fees come off the payout', async () => {
    await seed('published')
    expect((await edit({ feeModel: 'organizer_absorbs' })).status).toBe(200)
    const o = await (await createOrder(orderReq('c05eOaAAAAAAAAA'))).json() as { orderId: string; amount: number }
    expect(o.amount).toBe(TICKET)
    const f = (await intent(o.orderId)).financials
    expect(f.feeModel).toBe('organizer_pays')
    expect(f.chargeAmountPaise).toBe(TICKET)
    expect(f.netSettlementPaise).toBe(ORGANIZER_NET)
    // The gateway was asked for exactly the charge.
    expect(h.orders.at(-1)!.amountPaise).toBe(TICKET)
  }, T)

  it('6 · ATTENDEE-PAYS checkout: fees are added on top and the organizer receives the full ticket', async () => {
    await seed('published')
    expect((await edit({ feeModel: 'attendee_pays' })).status).toBe(200)
    const o = await (await createOrder(orderReq('c05eApAAAAAAAAA'))).json() as { orderId: string; amount: number }
    expect(o.amount).toBe(ATTENDEE_CHARGE)
    const f = (await intent(o.orderId)).financials
    expect(f.feeModel).toBe('customer_pays')
    expect(f.ticketBasePaise).toBe(TICKET)
    expect(f.chargeAmountPaise).toBe(ATTENDEE_CHARGE)
    expect(f.netSettlementPaise).toBe(TICKET)           // the organizer receives the FULL ticket
    expect(f.attendeeFeeTotalPaise).toBe(ATTENDEE_CHARGE - TICKET)
    expect(h.orders.at(-1)!.amountPaise).toBe(ATTENDEE_CHARGE)
  }, T)

  it('7 · the QUOTE equals the CHARGE, under both models', async () => {
    await seed('published')
    const cases = [
      { model: 'organizer_absorbs', expected: TICKET,          key: 'c05eQoaAAAAAAAA', email: 'quote-oa@example.test' },
      { model: 'attendee_pays',     expected: ATTENDEE_CHARGE, key: 'c05eQapAAAAAAAA', email: 'quote-ap@example.test' },
    ] as const
    for (const c of cases) {
      expect((await edit({ feeModel: c.model })).status, c.model).toBe(200)
      const q = await (await feePreview(previewReq())).json() as { amountPaise: number }
      const o = await (await createOrder(orderReq(c.key, c.email))).json() as { amount: number }
      expect(q.amountPaise, `${c.model} quote`).toBe(c.expected)
      expect(o.amount, `${c.model} charge`).toBe(c.expected)
      expect(q.amountPaise, `${c.model} quote vs charge`).toBe(o.amount)
    }
  }, T)

  it('8 · an OPEN attempt keeps its original model AND amount when the organizer changes the setting', async () => {
    await seed('published')
    expect((await edit({ feeModel: 'attendee_pays' })).status).toBe(200)

    const a1 = await (await createOrder(orderReq('c05ePinAAAAAAAA'))).json() as { orderId: string; amount: number }
    expect(a1.amount).toBe(ATTENDEE_CHARGE)

    // The organizer switches mid-checkout. The customer is already at the gateway.
    expect((await edit({ feeModel: 'organizer_absorbs' })).status).toBe(200)
    expect(await liveChoice()).toBe('organizer_absorbs')

    // The retry is the SAME order at the SAME amount, still priced attendee-pays.
    const a2 = await (await createOrder(orderReq('c05ePinAAAAAAAA'))).json() as { orderId: string; amount: number; reused?: boolean }
    expect(a2).toMatchObject({ orderId: a1.orderId, amount: ATTENDEE_CHARGE, reused: true })
    expect((await intent(a1.orderId)).financials.feeModel).toBe('customer_pays')
  }, T)

  it('9 · a NEW attempt uses the UPDATED model', async () => {
    await seed('published')
    expect((await edit({ feeModel: 'attendee_pays' })).status).toBe(200)
    const a = await (await createOrder(orderReq('c05eNewAAAAAAAA'))).json() as { orderId: string; amount: number }
    expect(a.amount).toBe(ATTENDEE_CHARGE)

    expect((await edit({ feeModel: 'organizer_absorbs' })).status).toBe(200)
    // Different attendee + different key ⇒ a genuinely new attempt, not a retry.
    const b = await (await createOrder(orderReq('c05eNewBBBBBBBB', 'later@example.test'))).json() as { orderId: string; amount: number }
    expect(b.orderId).not.toBe(a.orderId)
    expect(b.amount).toBe(TICKET)
    expect((await intent(b.orderId)).financials.feeModel).toBe('organizer_pays')
    // …and the earlier intent was never re-priced.
    expect((await intent(a.orderId)).financials.chargeAmountPaise).toBe(ATTENDEE_CHARGE)
  }, T)

  it('10 · a completed registration is never touched by a later change', async () => {
    await seed('published')
    const regRef = adminDb.doc(`registrations/c05e-reg-${process.pid}`)
    await regRef.set({ eventSlug: SLUG, amountPaise: TICKET, financials: { feeModel: 'organizer_pays', chargeAmountPaise: TICKET } })
    const before = (await regRef.get()).data()
    expect((await edit({ feeModel: 'attendee_pays' })).status).toBe(200)
    expect((await regRef.get()).data()).toEqual(before)
    await regRef.delete()
  }, T)
})
