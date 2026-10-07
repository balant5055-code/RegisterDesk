// RD-FIN-01 — Registration + Dashboard + Finance integrity, end to end on REAL Firestore.
//
// Real: create-order, verify-payment and the Razorpay webhook ROUTES; the one settlement; the
// ledger + wallet credit; registrationCounters; organizerDailyStats; the dashboard / finance
// readers (getLedgerTotals, aggregateRegistrationStatusCounts, readDailyStats); cancelRegistration.
// Stubbed: the Razorpay SDK (no network — an in-memory gateway), the fee/pricing config (fixed,
// engine OFF as in production), the distributed rate limiter, the confirmation email (counted, can
// be made to fail), the inbox notification and Sentry. No real payment, no refund, no production.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const OWNER = `finint-owner-${P}`
const OTHER = `finint-other-${P}`
const KEY_SECRET = 'finint_key_secret'
const WHSEC = 'finint_webhook_secret'
const PRICE_RUPEES = 500
const PRICE = PRICE_RUPEES * 100

const h = vi.hoisted(() => ({
  seq: 0,
  ordersCreated: [] as Array<{ id: string; amount: number }>,
  payments: new Map<string, Array<Record<string, unknown>>>(),   // orderId → gateway payments
  emails: [] as string[],
  emailThrows: false,
  gateOverride: null as null | { allowed: boolean; reason?: string },
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_finint', RAZORPAY_KEY_SECRET: KEY_SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        const id = `order_finint_${process.pid}_${++h.seq}`
        h.ordersCreated.push({ id, amount: o.amount })
        return { id, amount: o.amount, currency: o.currency, status: 'created' }
      },
      fetchPayments: async (orderId: string) => ({ items: h.payments.get(orderId) ?? [] }),
    },
    payments: {
      fetch: async (id: string) => {
        for (const list of h.payments.values()) { const p = list.find(x => x.id === id); if (p) return p }
        throw new Error('payment not found')
      },
      refund: async () => { throw new Error('NO REFUNDS in this suite') },
    },
  },
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0 }) }))
vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: false } }),
}))
vi.mock('@/lib/billing/feeEngine', async orig => ({
  ...(await orig<typeof import('@/lib/billing/feeEngine')>()),
  getFeePlanForOrganizer: async () => ({ planTier: 'starter', feeConfigId: 'plan:starter' }),
}))
vi.mock('@/lib/fees/resolveFeeConfig', async orig => ({
  ...(await orig<typeof import('@/lib/fees/resolveFeeConfig')>()),
  resolveFeeConfig: async () => ({ platformFeePercentBps: 200, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise: 0,
    gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 }),
}))
vi.mock('@/lib/registrations/gate', async orig => {
  const real = await orig<typeof import('@/lib/registrations/gate')>()
  return { ...real, checkRegistrationGate: async () => h.gateOverride ?? { allowed: true } }
})
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({
  sendConfirmationEmail: async (r: { registrationId?: string; id?: string }) => {
    if (h.emailThrows) throw new Error('SES down')
    h.emails.push(String(r?.registrationId ?? r?.id ?? 'x'))
  },
}))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({
  ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()),
  notifyPaymentReceived: async () => undefined,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: () => undefined,
}))

const PASS = (quantity: number) => ({
  id: 'p1', name: 'General', type: 'paid', price: PRICE_RUPEES, earlyBirdEnabled: false, unlimited: false, quantity,
  visibility: 'public', status: 'active', advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
})
const sign = (orderId: string, payId: string) => crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${payId}`).digest('hex')
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describeEmu('RD-FIN-01 · registration + dashboard + finance integrity (real routes, real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let createOrder: (r: NextRequest) => Promise<Response>
  let verify: (r: NextRequest) => Promise<Response>
  let webhook: (r: NextRequest) => Promise<Response>
  let lib: {
    settle: typeof import('@/lib/payments/settleCapturedRegistration').settleCapturedRegistration
    getIntent: typeof import('@/lib/firebase/firestore/paymentIntents').getPaymentIntent
    cancel: typeof import('@/lib/firebase/firestore/registrations').cancelRegistration
    ledger: typeof import('@/lib/finance/financeAnalytics').getLedgerTotals
    statusCounts: typeof import('@/lib/firebase/firestore/registrationCounters').aggregateRegistrationStatusCounts
    daily: typeof import('@/lib/dashboard/dailyStatsAdmin').readDailyStats
    dayKey: typeof import('@/lib/dashboard/dailyStats').dayKey
  }
  let n = 0
  let slug = ''

  async function seedEvent(quantity: number, totalCapacity = quantity) {
    slug = `finint-${P}-${++n}`
    await db.doc(`events/${slug}`).set({
      uid: OWNER, draftId: `${slug}-draft`, slug, status: 'published', lifecycleStatus: 'published', totalCapacity,
      pricing: { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [PASS(quantity)], advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } },
      eventDetails: { info: { name: `Integrity ${n}` }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: slug } },
      registrationForm: { sections: [] }, accessControl: { type: 'open' },
    })
    await db.doc(`registrationCounters/${slug}`).set({ eventSlug: slug, totalCount: 0, passCounts: {}, revenuePaise: 0, statsVersion: 2 })
  }
  const orderReq = (key: string, email: string, extra: Record<string, unknown> = {}) => new NextRequest('http://x/api/registrations/create-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, passId: 'p1', attendee: { name: 'Attendee', email }, formResponses: {}, idempotencyKey: key, termsAccepted: true, ...extra }),
  })
  async function order(key: string, email: string, extra: Record<string, unknown> = {}) {
    const r = await json(await createOrder(orderReq(key, email, extra)))
    return r
  }
  /** The attendee pays at the gateway: the order now carries a captured payment. */
  function capture(orderId: string, payId: string, amount = PRICE) {
    const p = { id: payId, order_id: orderId, status: 'captured', amount, currency: 'INR', fee: 1180, tax: 180, method: 'upi' }
    h.payments.set(orderId, [...(h.payments.get(orderId) ?? []).filter(x => x.id !== payId), p])
    return p
  }
  const verifyReq = (orderId: string, payId: string, sig = sign(orderId, payId)) => new NextRequest('http://x/api/registrations/verify-payment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: sig }),
  })
  /**
   * Exactly what verify-payment does once the HMAC is valid (route.ts: settleCapturedRegistration
   * with source 'verify' and the freshly read intent). Used for the CONCURRENT cases: vitest's
   * mocker can load the real Razorpay client for a dynamic import issued under concurrency, so the
   * signature step (covered sequentially above) is not raced here — the settlement transaction is.
   */
  async function verifySettle(orderId: string, paymentId: string) {
    const intent = (await lib.getIntent(orderId))!
    return lib.settle({ orderId, paymentId, intent, source: 'verify' })
  }
  function hook(event: string, entity: Record<string, unknown>) {
    const body = JSON.stringify({ event, payload: { payment: { entity } } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }

  /** Every independent source for one event, read the way the product reads it. */
  async function sources() {
    const regs = (await db.collection('registrations').where('eventSlug', '==', slug).get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
    const intents = (await db.collection('paymentIntents').where('eventSlug', '==', slug).get()).docs.map(d => d.data())
    const ptx = (await db.collection('platformTransactions').where('entityId', '==', slug).get()).docs.map(d => d.data())
    const counter = (await db.doc(`registrationCounters/${slug}`).get()).data() ?? {}
    const ledger = await lib.ledger({ organizerUid: OWNER, eventSlug: slug, from: null, to: null })
    const status = await lib.statusCounts(OWNER, slug)
    const [today] = await lib.daily(OWNER, slug, [lib.dayKey(Date.now())])
    const holds = (await db.collection('failedRefunds').where('eventSlug', '==', slug).get()).docs.map(d => d.data())
    const confirmed = regs.filter(r => r.status === 'confirmed')
    return {
      regs, confirmed, intents, ptx, counter, ledger, status, today, holds,
      paidIntents: intents.filter(i => i.status === 'paid').length,
      sumConfirmedAmount: confirmed.reduce((s, r) => s + (r.amount as number), 0),
    }
  }
  /** The release-blocking invariants: every independent source tells the same story. */
  function expectReconciled(s: Awaited<ReturnType<typeof sources>>, paid: number, capacity: number) {
    expect(s.confirmed).toHaveLength(paid)                                         // registrations
    expect(s.paidIntents).toBe(paid)                                               // verified payments
    expect(s.ptx.filter(t => t.status !== 'refunded')).toHaveLength(paid)          // finance ledger rows
    expect(s.counter.totalCount ?? 0).toBe(paid)                                   // dashboard counter
    expect((s.counter.passCounts as Record<string, number> | undefined)?.p1 ?? 0).toBe(paid)
    expect(s.counter.revenuePaise ?? 0).toBe(paid * PRICE)                         // dashboard ticket revenue
    expect(s.sumConfirmedAmount).toBe(paid * PRICE)                                // analytics Σ amount
    expect(s.ledger.transactions).toBe(paid)
    expect(s.ledger.grossPaise).toEqual({ ok: true, paise: paid * PRICE })         // finance ticket value
    expect(s.status.confirmed).toBe(paid)                                          // registrations-page stats
    expect(capacity - (s.counter.totalCount as number ?? 0)).toBeGreaterThanOrEqual(0)
    // every registration is backed by exactly one paid intent and one ledger row, and vice versa
    for (const r of s.confirmed) {
      expect(s.intents.filter(i => i.registrationId === r.id && i.status === 'paid'), `intent for ${r.id}`).toHaveLength(1)
      expect(s.ptx.filter(t => t.sourceId === r.id || t.registrationId === r.id), `ledger for ${r.id}`).toHaveLength(1)
    }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    // The Razorpay adapter loads its client LAZILY (dynamic import). Concurrent first-time dynamic
    // imports race vitest's mock registration and can load the REAL client (which demands live
    // keys). Load the mocked module once, up front — a harness concern, not a product one.
    await import('@/lib/razorpay/client')
    const rzpAdapter = (await import('@/lib/payments/providers')).resolvePaymentProvider('razorpay')
    await rzpAdapter.verifyCheckoutSignature({ providerOrderId: 'warm', providerPaymentId: 'warm', signature: '00' })
    await rzpAdapter.fetchOrderPayments('warm')
    ;({ POST: createOrder }= await import('@/app/api/registrations/create-order/route'))
    ;({ POST: verify } = await import('@/app/api/registrations/verify-payment/route'))
    ;({ POST: webhook } = await import('@/app/api/webhooks/razorpay/route'))
    lib = {
      settle: (await import('@/lib/payments/settleCapturedRegistration')).settleCapturedRegistration,
      getIntent: (await import('@/lib/firebase/firestore/paymentIntents')).getPaymentIntent,
      cancel: (await import('@/lib/firebase/firestore/registrations')).cancelRegistration,
      ledger: (await import('@/lib/finance/financeAnalytics')).getLedgerTotals,
      statusCounts: (await import('@/lib/firebase/firestore/registrationCounters')).aggregateRegistrationStatusCounts,
      daily: (await import('@/lib/dashboard/dailyStatsAdmin')).readDailyStats,
      dayKey: (await import('@/lib/dashboard/dailyStats')).dayKey,
    }
    await db.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
  }, T)
  beforeEach(() => { h.emails.length = 0; h.emailThrows = false; h.gateOverride = null })

  // ═══ 3 · END-TO-END PAID REGISTRATION ═════════════════════════════════════════════════
  it('E2E · forged client money ignored → order at the server price → verify → duplicate webhooks + verify retry are no-ops; every source agrees', async () => {
    await seedEvent(100)
    const o = await order('finintKeyE2EAAAAA', 'e2e@finint.test', {
      // §5/§16 forged financial + identity fields — none may reach the money path
      price: 1, amount: 100, amountPaise: 100, quantity: 5, discount: 49_900, fee: 0, gst: 0, total: 1,
      uid: OTHER, organizerUid: OTHER, eventId: 'someone-else', registrationId: 'forged-reg', orderId: 'order_forged', paymentId: 'pay_forged',
    })
    expect(o.status).toBe(200)
    const orderId = o.body.orderId as string
    expect(h.ordersCreated.at(-1)).toEqual({ id: orderId, amount: PRICE })            // gateway charged the SERVER price
    const intent0 = (await db.doc(`paymentIntents/${orderId}`).get()).data()!
    expect(intent0).toMatchObject({ amount: PRICE, status: 'created', organizerUid: OWNER, eventSlug: slug, passId: 'p1' })

    // PENDING (§4G): an unpaid order is not money and not a registration
    let s = await sources()
    expect(s.regs).toHaveLength(0); expect(s.ptx).toHaveLength(0); expect(s.counter.totalCount).toBe(0)

    const pay = capture(orderId, `pay_e2e_${P}`)
    const v = await json(await verify(verifyReq(orderId, pay.id)))
    expect(v.status).toBe(200)
    const registrationId = v.body.registrationId as string
    expect(registrationId).toBeTruthy()

    // duplicate webhooks (×2) and a verify retry — no second anything
    expect((await hook('payment.captured', pay)).status).toBe(200)
    expect((await hook('payment.captured', pay)).status).toBe(200)
    const again = await json(await verify(verifyReq(orderId, pay.id)))
    expect(again.status).toBe(200); expect(again.body.registrationId).toBe(registrationId)

    s = await sources()
    expectReconciled(s, 1, 100)
    expect(s.confirmed[0]).toMatchObject({ amount: PRICE, paymentStatus: 'paid', organizerUid: OWNER, eventSlug: slug, paymentId: pay.id })
    expect(s.confirmed[0].uid).not.toBe(OTHER)
    expect(h.emails).toHaveLength(1)                                                 // one confirmation
    // RD-FIN-01 · the dashboard daily rollup now includes the ONLINE PAID registration
    expect(s.today?.confirmed).toBe(1)
    expect(s.today?.revenuePaise).toBe(PRICE)
  }, T)

  it('§4D · webhook after the browser closed settles alone; a late verify returns the same registration', async () => {
    await seedEvent(100)
    const orderId = (await order('finintKeyWHAAAAAA', 'webhook@finint.test')).body.orderId as string
    const pay = capture(orderId, `pay_wh_${P}`)
    expect((await hook('payment.captured', pay)).status).toBe(200)
    const s = await sources()
    expectReconciled(s, 1, 100)
    const late = await json(await verify(verifyReq(orderId, pay.id)))
    expect(late.status).toBe(200); expect(late.body.registrationId).toBe(s.confirmed[0].id)
    expectReconciled(await sources(), 1, 100)
  }, T)

  // ═══ 4B / 16 · no paid registration without a verified payment ══════════════════════════
  it('§4B · a forged signature, an unpaid order and an under-paid webhook create nothing', async () => {
    await seedEvent(100)
    const orderId = (await order('finintKeyFORGEAAA', 'forge@finint.test')).body.orderId as string
    // forged signature (no capture at all)
    expect((await verify(verifyReq(orderId, `pay_forge_${P}`, 'f'.repeat(64)))).status).toBe(400)
    // a "captured" webhook for LESS than the order amount
    const cheap = { id: `pay_cheap_${P}`, order_id: orderId, status: 'captured', amount: 100, currency: 'INR' }
    h.payments.set(orderId, [cheap])
    expect((await hook('payment.captured', cheap)).status).toBe(200)
    const s = await sources()
    expect(s.regs).toHaveLength(0); expect(s.ptx).toHaveLength(0)
    expect(s.counter.totalCount).toBe(0); expect(s.counter.revenuePaise).toBe(0)
  }, T)

  // ═══ 4F · failed payment ═════════════════════════════════════════════════════════════════
  it('§4F · a failed payment: no registration, no revenue, no count, no capacity, no confirmation', async () => {
    await seedEvent(1)
    const orderId = (await order('finintKeyFAILAAAA', 'fail@finint.test')).body.orderId as string
    expect((await hook('payment.failed', { id: `pay_fail_${P}`, order_id: orderId, status: 'failed', amount: PRICE, currency: 'INR', error_code: 'BAD_REQUEST_ERROR' })).status).toBe(200)
    const s = await sources()
    expect(s.regs).toHaveLength(0); expect(s.ptx).toHaveLength(0); expect(h.emails).toHaveLength(0)
    expect(s.counter.totalCount).toBe(0); expect(s.counter.revenuePaise).toBe(0)
    expect(s.intents[0].status).toBe('registration_failed')
  }, T)

  // ═══ B1 · double charge after a failed attempt ═══════════════════════════════════════════
  it('B1 · payment.failed, then a retry on the SAME order is captured → verify does not claim "refunded", create-order mints NO second order; the webhook recovers ONE registration', async () => {
    await seedEvent(100)
    const key = 'finintKeyB1AAAAAA'
    const orderId = (await order(key, 'b1@finint.test')).body.orderId as string
    await hook('payment.failed', { id: `pay_b1a_${P}`, order_id: orderId, status: 'failed', amount: PRICE, currency: 'INR' })
    const pay = capture(orderId, `pay_b1b_${P}`)                                    // the retry succeeds at the gateway

    const v = await json(await verify(verifyReq(orderId, pay.id)))
    expect(v.status).toBe(409)
    expect(String(v.body.error)).not.toMatch(/refund will appear|was refunded/i)      // B3 · it was NOT refunded

    const ordersBefore = h.ordersCreated.length
    const retry = await json(await createOrder(orderReq(key, 'b1@finint.test')))
    expect(retry.status).toBe(409)                                                  // B1 · "do not pay again"
    expect(retry.body.reason).toBe('PAYMENT_IN_PROGRESS')
    expect(h.ordersCreated.length).toBe(ordersBefore)                               // NO second payable order

    expect((await hook('payment.captured', pay)).status).toBe(200)                  // recovery
    expectReconciled(await sources(), 1, 100)
  }, T)

  // ═══ 10 · concurrency ═════════════════════════════════════════════════════════════════════
  it('§10 · last seat, two payers settling at once: exactly one registration, the other HELD (not refunded, not oversold)', async () => {
    await seedEvent(1)
    const a = (await order('finintKeyLASTAAAA', 'last-a@finint.test')).body.orderId as string
    const b = (await order('finintKeyLASTBBBB', 'last-b@finint.test')).body.orderId as string
    const pa = capture(a, `pay_last_a_${P}`), pb = capture(b, `pay_last_b_${P}`)
    await Promise.all([verifySettle(a, pa.id), verifySettle(b, pb.id), hook('payment.captured', pa), hook('payment.captured', pb)])
    const s = await sources()
    expectReconciled(s, 1, 1)
    expect(s.counter.totalCount).toBe(1)
    expect(s.holds.filter(x => x.status === 'review')).toHaveLength(1)              // the loser's money is parked for review
    expect(s.intents.filter(i => i.status === 'registration_failed')).toHaveLength(1)
  }, T)

  it('§10 · verify + two webhooks for the SAME payment at once: one registration, one revenue, one ledger row, one email', async () => {
    await seedEvent(100)
    const orderId = (await order('finintKeyRACEAAAA', 'race@finint.test')).body.orderId as string
    const pay = capture(orderId, `pay_race_${P}`)
    await Promise.all([verifySettle(orderId, pay.id), hook('payment.captured', pay), hook('payment.captured', pay), verifySettle(orderId, pay.id)])
    expectReconciled(await sources(), 1, 100)
    expect(h.emails).toHaveLength(1)
  }, T)

  it('B2 · a STALE settlement whose gate now says "full" (because the intent itself took the seat) never flips the paid intent nor files a hold', async () => {
    await seedEvent(1)
    const orderId = (await order('finintKeyB2AAAAAA', 'b2@finint.test')).body.orderId as string
    const pay = capture(orderId, `pay_b2_${P}`)
    const stale = (await lib.getIntent(orderId))!                                     // read BEFORE settlement
    expect((await verify(verifyReq(orderId, pay.id))).status).toBe(200)               // verify takes the last seat
    h.gateOverride = { allowed: false, reason: 'EVENT_CAPACITY_FULL' }                // …so the gate now reads full
    const out = await lib.settle({ orderId, paymentId: pay.id, intent: stale, source: 'webhook' })
    expect(out.kind).toBe('already_settled')
    const s = await sources()
    expect(s.intents[0].status).toBe('paid')
    expect(s.holds).toHaveLength(0)
    expectReconciled(s, 1, 1)
  }, T)

  // ═══ 11 · notification failure ═════════════════════════════════════════════════════════════
  it('§11 · the confirmation email failing does not fail the payment or the registration', async () => {
    await seedEvent(100)
    const orderId = (await order('finintKeyMAILAAAA', 'mail@finint.test')).body.orderId as string
    const pay = capture(orderId, `pay_mail_${P}`)
    h.emailThrows = true
    const v = await json(await verify(verifyReq(orderId, pay.id)))
    expect(v.status).toBe(200)
    expectReconciled(await sources(), 1, 100)
  }, T)

  // ═══ 4H / 14 · cancellation (no refund) ════════════════════════════════════════════════════
  it('§4H · cancelling a paid registration releases seat + counted revenue exactly once, never negative; money is NOT refunded (ledger untouched)', async () => {
    await seedEvent(100)
    const orderId = (await order('finintKeyCANCAAAA', 'cancel@finint.test')).body.orderId as string
    const pay = capture(orderId, `pay_cancel_${P}`)
    const regId = (await json(await verify(verifyReq(orderId, pay.id)))).body.registrationId as string

    await expect(lib.cancel(regId, OTHER)).rejects.toThrow()                          // §12 another organizer cannot
    await lib.cancel(regId, OWNER)
    await expect(lib.cancel(regId, OWNER)).rejects.toThrow()                          // no double subtraction
    const s = await sources()
    expect(s.counter).toMatchObject({ totalCount: 0, revenuePaise: 0, cancelledCount: 1 })
    expect((s.counter.passCounts as Record<string, number>).p1).toBe(0)
    expect(s.status).toMatchObject({ confirmed: 0, cancelled: 1 })
    // the day nets to zero (confirmed then reversed) — never negative
    expect(s.today?.confirmed).toBe(0)
    expect(s.today?.revenuePaise).toBe(0)
    // INTENTIONAL: cancellation is not a refund — the payment and its ledger row stay
    expect(s.ptx).toHaveLength(1); expect(s.ptx[0].status).not.toBe('refunded')
    expect(s.regs[0]).toMatchObject({ status: 'cancelled', paymentStatus: 'paid' })
  }, T)

  // ═══ 9 / 18 · reconciliation table ═════════════════════════════════════════════════════════
  it('§9 · ten attendees through mixed paths (verify / webhook-only / both), one failure — the reconciliation table has no mismatch', async () => {
    await seedEvent(50)
    const rows: Array<{ orderId: string; pay: Record<string, unknown> }> = []
    for (let i = 0; i < 11; i++) {
      const orderId = (await order(`finintKeyTEN${String(i).padStart(4, '0')}A`, `ten-${i}@finint.test`)).body.orderId as string
      if (i === 10) { await hook('payment.failed', { id: `pay_ten_f_${P}`, order_id: orderId, status: 'failed', amount: PRICE, currency: 'INR' }); continue }
      rows.push({ orderId, pay: capture(orderId, `pay_ten_${i}_${P}`) })
    }
    await Promise.all(rows.map(({ orderId, pay }, i) =>
      i % 3 === 0 ? verifySettle(orderId, pay.id as string)
      : i % 3 === 1 ? hook('payment.captured', pay)
      : Promise.all([verifySettle(orderId, pay.id as string), hook('payment.captured', pay)])))
    const s = await sources()
    expectReconciled(s, 10, 50)
    const table = {
      event: slug, registrations: s.regs.length, verifiedPayments: s.paidIntents, paidRegistrations: s.confirmed.length,
      financeTransactions: s.ledger.transactions, dashboardPaidCount: s.counter.totalCount, dashboardRevenue: s.counter.revenuePaise,
      financeRevenue: s.ledger.grossPaise.ok ? s.ledger.grossPaise.paise : null, dailyRollupConfirmed: s.today?.confirmed,
      capacityUsed: s.counter.totalCount, capacityRemaining: 50 - (s.counter.totalCount as number),
    }
    console.log('RD-FIN-01 reconciliation', JSON.stringify(table))
    expect(table).toMatchObject({
      registrations: 10, verifiedPayments: 10, paidRegistrations: 10, financeTransactions: 10, dashboardPaidCount: 10,
      dashboardRevenue: 10 * PRICE, financeRevenue: 10 * PRICE, dailyRollupConfirmed: 10, capacityUsed: 10, capacityRemaining: 40,
    })
  }, T)
})
