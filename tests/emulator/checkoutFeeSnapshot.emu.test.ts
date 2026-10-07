// RD-PHASE4-S2 — a checkout keeps the fee terms in force when it was CREATED.
//
// With the pricing engine OFF (production), the attendee pays the ticket price and the organizer-side
// platform fee used to be computed at SETTLEMENT from the live configuration — so a global fee change
// between checkout and a late webhook / recovery sweep re-priced an order already created. The fee
// inputs are now captured on the payment intent by the REAL create-order route and consumed by the
// REAL ledger builder (the one settlement, the webhook, the capture sweep and the ledger rebuild all
// call, passing the intent's `feeInputs` — pinned by tests/unit/phase4Stage2Contracts.test.ts).
//
// Stubbed: the engine switch, the (global) fee rate — mutable, to simulate a Super Admin change —
// the rate limiter, the registration gate and the payment gateway adapter (no real Razorpay call).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const OWNER = `feesnap-owner-${process.pid}`
const SLUG  = `feesnap-run-${process.pid}`

const h = vi.hoisted(() => ({ engine: false, bps: 200, seq: 0, orders: [] as Array<{ id: string; amountPaise: number }> }))

vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: h.engine } }),
}))
vi.mock('@/lib/billing/feeEngine', async orig => ({
  ...(await orig<typeof import('@/lib/billing/feeEngine')>()),
  getFeePlanForOrganizer: async () => ({ planTier: 'starter', feeConfigId: 'plan:starter' }),
}))
vi.mock('@/lib/fees/resolveFeeConfig', async orig => ({
  ...(await orig<typeof import('@/lib/fees/resolveFeeConfig')>()),
  // the LIVE global rate — tests change it to simulate a Super Admin pricing change
  resolveFeeConfig: async () => ({ platformFeePercentBps: h.bps, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise: 0,
    gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 }),
}))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock('@/lib/registrations/gate', () => ({ checkRegistrationGate: async () => ({ allowed: true }) }))
vi.mock('@/lib/payments/providers', async orig => {
  const real = await orig<typeof import('@/lib/payments/providers')>()
  const adapter = {
    createOrder: async ({ amountPaise }: { amountPaise: number }) => {
      const id = `order_feesnap_${process.pid}_${++h.seq}`
      h.orders.push({ id, amountPaise })
      return { providerOrderId: id, checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' } }
    },
    getCheckoutHandoff: async () => ({ provider: 'razorpay', keyId: 'rzp_test_stub' }),
    fetchOrderPayments: async () => [],
  }
  return { ...real, resolveActivePaymentProviderForNewOrder: async () => ({ ok: true, provider: 'razorpay' }), resolvePaymentProvider: () => adapter }
})

const PASS = {
  id: 'pass_5k', name: '5K', type: 'paid', price: 500, earlyBirdEnabled: false, unlimited: false, quantity: 500,
  visibility: 'public', status: 'active', advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
}
const orderReq = (key: string, email = 'runner@example.test') => new NextRequest('http://x/api/registrations/create-order', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: SLUG, passId: PASS.id, attendee: { name: 'Runner', email }, formResponses: {}, idempotencyKey: key, termsAccepted: true }),
})

describeEmu('RD-PHASE4-S2 · checkout-time fee snapshot (pricing engine off)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createOrder: (r: NextRequest) => Promise<Response>
  let buildLedger: typeof import('@/lib/payments/registrationLedger').buildRegistrationLedgerAndCredit

  const intent = async (orderId: string) => (await adminDb.doc(`paymentIntents/${orderId}`).get()).data()!
  /** Exactly the mapping settleCapturedRegistration / the ledger sweep use. */
  const ledgerFor = (i: Record<string, unknown>, withSnapshot = true) => buildLedger({
    registrationId: `reg_${i.orderId as string}`, provider: 'razorpay', organizerUid: i.organizerUid as string,
    eventSlug: i.eventSlug as string, attendeeName: 'Runner', attendeeEmail: 'runner@example.test',
    grossAmountPaise: i.amount as number, paymentId: 'pay_x', orderId: i.orderId as string,
    financials: i.financials as never, ...(withSnapshot ? { feeInputs: i.feeInputs as never } : {}),
  })

  async function wipe() {
    await adminDb.recursiveDelete(adminDb.doc(`events/${SLUG}`)).catch(() => null)
    for (const o of h.orders) await adminDb.doc(`paymentIntents/${o.id}`).delete().catch(() => null)
    const claims = await adminDb.collection('paymentAttemptClaims').where('eventSlug', '==', SLUG).get().catch(() => null)
    for (const c of claims?.docs ?? []) await c.ref.delete().catch(() => null)
    h.orders.length = 0
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: createOrder } = await import('@/app/api/registrations/create-order/route'))
    ;({ buildRegistrationLedgerAndCredit: buildLedger } = await import('@/lib/payments/registrationLedger'))
  }, T)
  afterAll(wipe, T)
  beforeEach(async () => {
    h.engine = false; h.bps = 200
    await wipe()
    await adminDb.doc(`events/${SLUG}`).set({
      uid: OWNER, draftId: 'feesnapDraft', slug: SLUG, status: 'published', lifecycleStatus: 'published', totalCapacity: 500,
      pricing: { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [PASS], advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } },
      eventDetails: { info: { name: 'Fee Snap Run' }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: SLUG } },
      registrationForm: { sections: [] }, accessControl: { type: 'open' },
    })
  }, T)

  it('create-order captures the fee inputs in force; the attendee is charged the ticket price only', async () => {
    const r = await createOrder(orderReq('feesnapKeyK1AAAAAAA'))
    expect(r.status).toBe(200)
    const o = h.orders[0]
    expect(o.amountPaise).toBe(50_000)                              // unchanged: the ticket, no fee
    const i = await intent(o.id)
    expect(i.amount).toBe(50_000)
    expect(i.financials).toBeUndefined()
    expect(i.feeInputs).toMatchObject({ version: 1, planTier: 'starter', feeConfigId: 'plan:starter' })
    expect(i.feeInputs.feeConfig).toMatchObject({ platformFeePercentBps: 200, platformFeeFixedPaise: 500, gstRatePercent: 18 })
    expect(typeof i.feeInputs.capturedAt).toBe('string')
  }, T)

  it('a GLOBAL fee change after checkout does NOT re-price it: settlement uses the snapshot; a pre-snapshot (legacy) order keeps today’s behaviour', async () => {
    expect((await createOrder(orderReq('feesnapKeyK2AAAAAAA'))).status).toBe(200)
    const i = await intent(h.orders[0].id)
    const atCheckout = await ledgerFor(i)                          // settled before the change
    h.bps = 500                                                    // Super Admin raises the global fee to 5%
    const late = await ledgerFor(i)                                // late webhook / sweep AFTER the change
    expect(late.ledger.platformFeeBasePaise).toBe(atCheckout.ledger.platformFeeBasePaise)
    expect(late.ledger.platformFeeBasePaise).toBe(1_500)           // 2% of ₹500 + ₹5 fixed — the checkout terms
    expect(late.ledger.netSettlementPaise).toBe(atCheckout.ledger.netSettlementPaise)
    expect(late.credit).toEqual(atCheckout.credit)
    // compatibility: an intent without a snapshot is priced from the CURRENT configuration, as before
    const legacy = await ledgerFor(i, false)
    expect(legacy.ledger.platformFeeBasePaise).toBe(3_000)         // 5% + ₹5 — the established legacy behaviour
    expect(late.ledger.grossAmountPaise).toBe(50_000)
  }, T)

  it('a retry of the SAME checkout keeps its original snapshot; a NEW checkout gets the new global terms', async () => {
    expect((await createOrder(orderReq('feesnapKeyK3AAAAAAA'))).status).toBe(200)
    const first = await intent(h.orders[0].id)
    h.bps = 500
    expect((await createOrder(orderReq('feesnapKeyK3AAAAAAA'))).status).toBe(200)   // same attempt (idempotency key)
    expect(h.orders).toHaveLength(1)                               // the SAME order is reused
    const again = await intent(h.orders[0].id)
    expect(again.feeInputs).toEqual(first.feeInputs)               // never overwritten
    expect((await createOrder(orderReq('feesnapKeyK4AAAAAAA', 'other@example.test'))).status).toBe(200)
    const fresh = await intent(h.orders[1].id)
    expect(fresh.feeInputs.feeConfig.platformFeePercentBps).toBe(500)   // immediate for NEW checkouts
    expect(fresh.amount).toBe(50_000)                                   // attendee charge unchanged
  }, T)

  it('engine ON keeps its existing snapshot (financials) and writes no feeInputs; a malformed snapshot is ignored', async () => {
    h.engine = true
    expect((await createOrder(orderReq('feesnapKeyK5AAAAAAA'))).status).toBe(200)
    const i = await intent(h.orders[0].id)
    expect(i.financials).toBeTruthy()
    expect(i.feeInputs).toBeUndefined()
    const { isCheckoutFeeInputs } = await import('@/lib/fees/types')
    expect(isCheckoutFeeInputs({ version: 1, planTier: 'starter', feeConfigId: 'x', capturedAt: 'now', feeConfig: { platformFeePercentBps: 200 } })).toBe(false)
    h.engine = false; h.bps = 700
    const broken = await buildLedger({
      registrationId: 'reg_broken', organizerUid: OWNER, eventSlug: SLUG, attendeeName: 'R', attendeeEmail: 'r@x.test',
      grossAmountPaise: 50_000, paymentId: 'p', orderId: 'o', feeInputs: { version: 1 } as never,
    })
    expect(broken.ledger.platformFeeBasePaise).toBe(4_000)   // malformed ⇒ ignored ⇒ current config (7% + ₹5)
  }, T)
})
