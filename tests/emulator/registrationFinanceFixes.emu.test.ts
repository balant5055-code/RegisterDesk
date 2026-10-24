// RD-FIN-02 — regression pins for the Registration / Dashboard / Finance fix pass, on REAL Firestore.
//
// Real: create-order, verify-payment, the Razorpay webhook, the admin failed-refund retry and review
// routes; the one settlement; the ledger + wallet; registrationCounters; organizerDailyStats; the
// finance / analytics / reconciliation / admin-report readers. Stubbed: the Razorpay SDK (in-memory —
// no network, refunds are recorded objects, never real), the fee/pricing config (engine OFF), the
// rate limiter, email, the inbox notification, Sentry, and admin identity (a header-keyed stub).
// Attendee-pays is NEVER enabled: the B5 case seeds an isolated intent that carries a fee breakdown.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const OWNER = `finfix-owner-${P}`
const KEY_SECRET = 'finfix_key_secret'
const WHSEC = 'finfix_webhook_secret'
const PRICE = 50_000

const h = vi.hoisted(() => ({
  seq: 0,
  ordersCreated: [] as Array<{ id: string; amount: number }>,
  payments: new Map<string, Array<Record<string, unknown>>>(),
  refunds: new Map<string, Array<Record<string, unknown>>>(),   // paymentId → gateway refunds (stub)
  refundCalls: 0,
  gateOverride: null as null | { allowed: boolean; reason?: string },
  /** M1 — every captureFinancialError (message + context), so a test can assert an alert or its absence. */
  alerts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_finfix', RAZORPAY_KEY_SECRET: KEY_SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        const id = `order_finfix_${process.pid}_${++h.seq}`
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
      // An in-memory stub: it RECORDS a refund object; no money moves anywhere.
      refund: async (paymentId: string, opts: { amount: number }) => {
        h.refundCalls++
        const r = { id: `rfnd_finfix_${process.pid}_${h.refundCalls}`, amount: opts.amount, status: 'processed', payment_id: paymentId }
        h.refunds.set(paymentId, [...(h.refunds.get(paymentId) ?? []), r])
        return r
      },
      fetchMultipleRefund: async (paymentId: string) => ({ entity: 'collection', count: (h.refunds.get(paymentId) ?? []).length, items: h.refunds.get(paymentId) ?? [] }),
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
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({
  ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()),
  notifyPaymentReceived: async () => undefined,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (e: unknown, ctx?: Record<string, unknown>) => { h.alerts.push({ message: e instanceof Error ? e.message : String(e), ...(ctx ?? {}) }) },
  captureError: () => undefined,
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? `finfix-super-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? `finfix-super-${process.pid}` : null),
  legacyAdminClaimOnly: async () => false,
}))

const PASS = (quantity: number) => ({
  id: 'p1', name: 'General', type: 'paid', price: PRICE / 100, earlyBirdEnabled: false, unlimited: false, quantity,
  visibility: 'public', status: 'active', advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
})
const sign = (orderId: string, payId: string) => crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${payId}`).digest('hex')
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describeEmu('RD-FIN-02 · registration / dashboard / finance fix pass (real routes, real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let createOrder: (r: NextRequest) => Promise<Response>
  let verify: (r: NextRequest) => Promise<Response>
  let webhook: (r: NextRequest) => Promise<Response>
  let L: {
    settle: typeof import('@/lib/payments/settleCapturedRegistration').settleCapturedRegistration
    getIntent: typeof import('@/lib/firebase/firestore/paymentIntents').getPaymentIntent
    cancel: typeof import('@/lib/firebase/firestore/registrations').cancelRegistration
    restore: typeof import('@/lib/firebase/firestore/registrations').restoreRegistration
    revenue: typeof import('@/lib/firebase/firestore/registrationCounters').sumConfirmedRevenueFromLedgerChecked
    resetFeeCache: typeof import('@/lib/firebase/firestore/registrationCounters').resetAttendeeFeeExistenceCache
    reconcileEvent: typeof import('@/lib/reconciliation/events').reconcileOneEvent
    reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
    ledger: typeof import('@/lib/finance/financeAnalytics').getLedgerTotals
    split: typeof import('@/lib/finance/financeAnalytics').getRegistrationSplit
    readRefunds: typeof import('@/lib/finance/financeAnalytics').readRefundSource
    netRefunds: typeof import('@/lib/finance/financeAnalytics').refundsAgainstConfirmedPaise
    adminTotals: typeof import('@/lib/reports/adminBuilders').computeAdminTotals
    credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
    reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
    sweep: typeof import('@/lib/payments/registrationReconciliation').recoverCapturedPaymentIntents
    daily: typeof import('@/lib/dashboard/dailyStatsAdmin').readDailyStats
    dayKey: typeof import('@/lib/dashboard/dailyStats').dayKey
  }
  let n = 0
  let slug = ''

  async function seedEvent(quantity: number) {
    slug = `finfix-${P}-${++n}`
    await db.doc(`events/${slug}`).set({
      uid: OWNER, draftId: `${slug}-draft`, slug, status: 'published', lifecycleStatus: 'published', totalCapacity: quantity,
      pricing: { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [PASS(quantity)], advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } },
      eventDetails: { info: { name: `Fix ${n}` }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: slug } },
      registrationForm: { sections: [] }, accessControl: { type: 'open' },
    })
    await db.doc(`registrationCounters/${slug}`).set({ eventSlug: slug, totalCount: 0, passCounts: {}, revenuePaise: 0, statsVersion: 2 })
  }
  const orderReq = (key: string, email: string) => new NextRequest('http://x/api/registrations/create-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, passId: 'p1', attendee: { name: 'Attendee', email }, formResponses: {}, idempotencyKey: key, termsAccepted: true }),
  })
  const order = async (key: string, email: string) => (await json(await createOrder(orderReq(key, email)))).body.orderId as string
  function capture(orderId: string, payId: string, amount = PRICE, status = 'captured') {
    const p = { id: payId, order_id: orderId, status, amount, currency: 'INR' }
    h.payments.set(orderId, [...(h.payments.get(orderId) ?? []).filter(x => x.id !== payId), p])
    return p
  }
  const verifyReq = (orderId: string, payId: string) => new NextRequest('http://x/api/registrations/verify-payment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: sign(orderId, payId) }),
  })
  function hook(event: string, payload: Record<string, unknown>) {
    const body = JSON.stringify({ event, payload })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  const captured = (p: Record<string, unknown>) => hook('payment.captured', { payment: { entity: p } })
  /**
   * W1 — the DOCUMENTED Razorpay refund webhook payload (refund.created / processed / failed):
   * payload.refund.entity has NO order_id; the order is on payload.payment.entity
   * (https://razorpay.com/docs/webhooks/payloads/refunds/ — "contains": ["refund","payment"]).
   */
  function refundPayload(o: {
    id: string; pay: { id: string; order_id: string; amount?: number }; amount: number
    status?: string; currency?: string; withPayment?: boolean; payment?: Record<string, unknown>
  }) {
    return {
      refund: { entity: {
        id: o.id, entity: 'refund', amount: o.amount, currency: o.currency ?? 'INR', payment_id: o.pay.id,
        notes: {}, receipt: null, acquirer_data: {}, created_at: 0, batch_id: null,
        status: o.status ?? 'processed', speed_processed: 'normal', speed_requested: 'optimum',
      } },
      ...(o.withPayment === false ? {} : { payment: { entity: {
        id: o.pay.id, entity: 'payment', amount: o.pay.amount ?? PRICE, currency: 'INR', status: 'captured',
        order_id: o.pay.order_id, amount_refunded: o.amount, refund_status: (o.amount >= (o.pay.amount ?? PRICE)) ? 'full' : 'partial', ...(o.payment ?? {}),
      } } }),
    }
  }
  const refundHook = (event: 'refund.processed' | 'refund.failed', o: Parameters<typeof refundPayload>[0]) =>
    hook(event, refundPayload({ ...o, status: o.status ?? (event === 'refund.failed' ? 'failed' : 'processed') }))
  const today = async () => (await L.daily(OWNER, slug, [L.dayKey(Date.now())]))[0]
  const counter = async () => (await db.doc(`registrationCounters/${slug}`).get()).data() ?? {}
  const regsOf = async () => (await db.collection('registrations').where('eventSlug', '==', slug).get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  const holdsOf = async () => (await db.collection('failedRefunds').where('eventSlug', '==', slug).get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))
  async function paidRegistration(email: string) {
    const orderId = await order(`fx${email.replace(/[^a-z0-9]/gi, '').slice(0, 30)}AAAA`, email)
    const pay = capture(orderId, `pay_${email.replace(/[^a-z0-9]/gi, '')}_${P}`)
    const v = await json(await verify(verifyReq(orderId, pay.id)))
    expect(v.status).toBe(200)
    return { orderId, pay, registrationId: v.body.registrationId as string }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    await import('@/lib/razorpay/client')
    ;({ POST: createOrder } = await import('@/app/api/registrations/create-order/route'))
    ;({ POST: verify } = await import('@/app/api/registrations/verify-payment/route'))
    ;({ POST: webhook } = await import('@/app/api/webhooks/razorpay/route'))
    const counters = await import('@/lib/firebase/firestore/registrationCounters')
    const fin = await import('@/lib/finance/financeAnalytics')
    const ptx = await import('@/lib/firebase/firestore/platformTransactions')
    L = {
      settle: (await import('@/lib/payments/settleCapturedRegistration')).settleCapturedRegistration,
      getIntent: (await import('@/lib/firebase/firestore/paymentIntents')).getPaymentIntent,
      cancel: (await import('@/lib/firebase/firestore/registrations')).cancelRegistration,
      restore: (await import('@/lib/firebase/firestore/registrations')).restoreRegistration,
      revenue: counters.sumConfirmedRevenueFromLedgerChecked, resetFeeCache: counters.resetAttendeeFeeExistenceCache,
      reconcileEvent: (await import('@/lib/reconciliation/events')).reconcileOneEvent,
      reconcileWallet: (await import('@/lib/reconciliation/wallets')).reconcileOneWallet,
      ledger: fin.getLedgerTotals, split: fin.getRegistrationSplit, readRefunds: fin.readRefundSource, netRefunds: fin.refundsAgainstConfirmedPaise,
      adminTotals: (await import('@/lib/reports/adminBuilders')).computeAdminTotals,
      credit: ptx.recordPlatformTransactionAndCredit, reverse: ptx.reversePlatformTransactionAndDebit,
      sweep: (await import('@/lib/payments/registrationReconciliation')).recoverCapturedPaymentIntents,
      daily: (await import('@/lib/dashboard/dailyStatsAdmin')).readDailyStats,
      dayKey: (await import('@/lib/dashboard/dailyStats')).dayKey,
    }
    await db.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
  }, T)
  beforeEach(() => { h.gateOverride = null })

  // ═══ PART 1 · B5 — one ticket-revenue basis, future attendee-pays included ═══════════════════
  it('B5 · an attendee-pays charge: counter, daily rollup, Σ revenue, cancel, restore and reconciliation all use the TICKET BASIS', async () => {
    await seedEvent(100)
    // organizer-pays registration (today's production shape): no attendeeFeePaise key at all
    const plain = await paidRegistration('b5-plain@finfix.test')
    expect((await db.doc(`registrations/${plain.registrationId}`).get()).data()).not.toHaveProperty('attendeeFeePaise')

    // an isolated intent carrying an attendee-pays breakdown: base 50,000 + fees 2,360 = charge 52,360
    const orderId = await order('fxb5feeAAAAAAAAA', 'b5-fee@finfix.test')
    const fin = { financialVersion: 1, feeModel: 'customer_pays', ticketBasePaise: PRICE, chargeAmountPaise: 52_360,
      platformFeeBasePaise: 1_500, platformFeeGstPaise: 270, platformFeeTotalPaise: 1_770, gatewayFeeEstimatePaise: 590,
      attendeeFeeTotalPaise: 2_360, organizerFeeTotalPaise: 0, netSettlementPaise: PRICE }
    await db.doc(`paymentIntents/${orderId}`).update({ amount: 52_360, financials: fin })
    const pay = capture(orderId, `pay_b5fee_${P}`, 52_360)
    const regId = (await json(await verify(verifyReq(orderId, pay.id)))).body.registrationId as string
    expect((await db.doc(`registrations/${regId}`).get()).data()).toMatchObject({ amount: 52_360, attendeeFeePaise: 2_360 })

    L.resetFeeCache()
    const twoBases = 2 * PRICE
    expect((await counter()).revenuePaise).toBe(twoBases)
    expect((await today())?.revenuePaise).toBe(twoBases)
    expect(await L.revenue(slug)).toEqual({ value: twoBases, ok: true })
    expect((await L.reconcileEvent(slug, { events: true, passes: false }, false)).filter(m => m.field === 'revenuePaise')).toEqual([])

    await L.cancel(regId, OWNER)
    expect((await counter()).revenuePaise).toBe(PRICE)          // exactly the basis it added — never the charge
    expect((await today())?.revenuePaise).toBe(PRICE)
    expect((await L.reconcileEvent(slug, { events: true, passes: false }, false)).filter(m => m.field === 'revenuePaise')).toEqual([])
    await L.restore(regId, OWNER)
    expect((await counter()).revenuePaise).toBe(twoBases)
    expect((await today())?.revenuePaise).toBe(twoBases)
    expect(await L.revenue(slug)).toEqual({ value: twoBases, ok: true })
  }, T)

  // ═══ PART 7 · one "Paid" ═════════════════════════════════════════════════════════════════════
  it('PAID · Finance "Paid" = charged (paid + refund_pending + refunded), whatever the status; free / pending excluded', async () => {
    slug = `finfix-${P}-paid`
    const mk = (id: string, status: string, paymentStatus: string, amount: number) =>
      db.doc(`registrations/${slug}-${id}`).set({ eventSlug: slug, organizerUid: OWNER, passId: 'p1', status, paymentStatus, amount })
    await Promise.all([
      mk('a', 'confirmed', 'paid', PRICE), mk('b', 'cancelled', 'paid', PRICE), mk('c', 'confirmed', 'refunded', PRICE),
      mk('d', 'cancelled', 'refunded', PRICE), mk('e', 'confirmed', 'refund_pending', PRICE), mk('f', 'confirmed', 'not_required', 0),
      mk('g', 'pending', 'pending', PRICE),
    ])
    const s = await L.split({ organizerUid: OWNER, eventSlug: slug, from: null, to: null }, ['paid', 'not_required', 'refunded', 'refund_pending', 'pending'])
    expect(s.paid).toBe(5)
    expect(s.free).toBe(1)
    expect(s.total).toBe(7)
  }, T)

  // ═══ PART 9 · net after refunds never subtracts the same money twice ═════════════════════════
  it('NET · refunds net against confirmed revenue only while the registration is still confirmed (refund→cancel, cancel→refund)', async () => {
    slug = `finfix-${P}-net`
    const reg = (id: string, status: string) => db.doc(`registrations/${slug}-${id}`).set({ eventSlug: slug, organizerUid: OWNER, passId: 'p1', status, paymentStatus: 'refunded', amount: PRICE })
    const refund = (id: string, regId: string | null, amount = PRICE) => db.doc(`registrationRefunds/rfnd_${slug}_${id}`).set({
      id: `rfnd_${slug}_${id}`, razorpayRefundId: `rfnd_${slug}_${id}`, registrationId: regId, eventSlug: slug, organizerUid: OWNER,
      amountPaise: amount, status: 'processed', origin: 'webhook', initiatedBy: 'webhook', reason: 'x', createdAt: new Date() })
    await Promise.all([reg('A', 'confirmed'), reg('B', 'cancelled'), reg('C', 'cancelled')])
    await Promise.all([refund('A', `${slug}-A`), refund('B', `${slug}-B`), refund('C', `${slug}-C`), refund('D', null, 1_000)])
    const read = await L.readRefunds({ organizerUid: OWNER, eventSlug: slug })
    // A (confirmed) + D (unlinked) only — B / C already left confirmed revenue when cancelled
    expect(await L.netRefunds(read)).toEqual({ ok: true, paise: PRICE + 1_000 })
  }, T)

  // ═══ PARTS 3 + 4 · payable after refunds; wallet reconciliation tells reversal from mismatch ══
  it('PAYABLE + WALLET · a registration refund reverses in place: payable drops by its net; the wallet check stays clean; a forged flip IS caught', async () => {
    const org = `finfix-wallet-${P}`
    slug = `finfix-${P}-wallet`
    const row = (id: string) => ({ id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: org, entityId: slug, entityType: 'event',
      sourceId: id, sourceType: 'registration', payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: 1_000, platformFeeBasePaise: 0, platformFeeGstPaise: 0,
      platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: 1_000, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}` })
    const credit = { organizerUid: org, grossAmountPaise: 1_000, feesTotalPaise: 0, netSettlementPaise: 1_000 }
    for (const id of [`${slug}-A`, `${slug}-B`, `${slug}-C`]) await L.credit(row(id) as never, credit)
    await L.reverse(`ptx_${slug}-B`)                                       // a real registration refund reversal
    const lt = await L.ledger({ organizerUid: org, eventSlug: null, from: null, to: null })
    expect(lt.ledgerNetAllRows).toEqual({ ok: true, paise: 3_000 })
    expect(lt.organizerPayable).toEqual({ ok: true, paise: 2_000 })         // B's net no longer payable
    const wallet = (await db.doc(`organizerRevenueWallets/${org}`).get()).data()!
    expect(await L.reconcileWallet(org, wallet)).toEqual([])                // a legitimate reversal is NOT a mismatch
    // genuine fault: a row flipped to 'refunded' WITHOUT the wallet debit
    await db.doc(`platformTransactions/ptx_${slug}-C`).update({ status: 'refunded' })
    const mm = await L.reconcileWallet(org, (await db.doc(`organizerRevenueWallets/${org}`).get()).data()!)
    expect(mm.map(m => m.field)).toContain('balanceSum')
  }, T)

  // ═══ PART 5 · admin finance report ═══════════════════════════════════════════════════════════
  it('ADMIN REPORT · registration refunds are reported; a donation reversal row is not counted in GMV and the refund is not deducted twice', async () => {
    const from = new Date(Date.now() - 60_000), to = new Date(Date.now() + 60_000)
    const base = await L.adminTotals({ from, to } as never)
    const t = Date.now()
    await db.doc(`platformTransactions/ptx_finfix_sale_${P}`).set({ organizerUid: `finfix-report-${P}`, grossAmountPaise: 10_000, platformFeeTotalPaise: 0, platformFeeGstPaise: 0, netSettlementPaise: 10_000, paidAt: new Date(t), status: 'completed' })
    await db.doc(`platformTransactions/ptx_finfix_rev_${P}`).set({ organizerUid: `finfix-report-${P}`, grossAmountPaise: -3_000, platformFeeTotalPaise: 0, platformFeeGstPaise: 0, netSettlementPaise: -3_000, paidAt: new Date(t), status: 'refunded', parentTransactionId: 'ptx_x', sourceType: 'donation' })
    await db.doc(`donationRefunds/finfix_dr_${P}`).set({ amountPaise: 3_000, status: 'processed', createdAt: new Date(t) })
    await db.doc(`donationRefunds/finfix_drp_${P}`).set({ amountPaise: 700, status: 'pending', createdAt: new Date(t) })
    await db.doc(`registrationRefunds/rfnd_finfix_adm_${P}`).set({ amountPaise: 4_000, status: 'linked', createdAt: new Date(t) })
    const after = await L.adminTotals({ from, to } as never)
    expect(after.gmvPaise - base.gmvPaise).toBe(10_000)                              // the reversal row is NOT a sale
    expect(after.reversalGrossPaise - base.reversalGrossPaise).toBe(-3_000)
    expect(after.refundsPaise - base.refundsPaise).toBe(3_000)
    expect(after.registrationRefundsPaise - base.registrationRefundsPaise).toBe(4_000)
    expect(after.donationRefundsPendingPaise - base.donationRefundsPendingPaise).toBe(700)   // reported, never deducted
    expect(after.netGmvPaise).toBe(after.gmvPaise - after.registrationRefundsPaise - after.refundsPaise)
  }, T)

  // ═══ PART 10 · B6 — a second capture on an already-paid order ═════════════════════════════════
  it('B6 · a second captured payment is a durable review hold — no registration, no revenue, no refund; replays idempotent; its refund never touches the settled registration', async () => {
    await seedEvent(100)
    const first = await paidRegistration('b6@finfix.test')
    const before = { regs: (await regsOf()).length, counter: await counter() }
    const p2 = capture(first.orderId, `pay_b6_second_${P}`)
    for (let i = 0; i < 3; i++) expect((await captured(p2)).status).toBe(200)
    expect((await json(await verify(verifyReq(first.orderId, p2.id)))).body.registrationId).toBe(first.registrationId)
    const holds = (await holdsOf()).filter(x => x.kind === 'duplicate_payment_hold')
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({ status: 'review', registrationId: null, paymentId: p2.id, settledRegistrationId: first.registrationId, settledPaymentId: first.pay.id })
    expect((holds[0].detectedBy as string[]).sort()).toEqual(['verify', 'webhook'])
    expect((await regsOf()).length).toBe(before.regs)
    expect(await counter()).toEqual(before.counter)
    // a refund of P2 (the duplicate) must not refund the settled registration
    // W1 — documented shape: the payment entity is P2 (on the SAME order as the settled payment)
    await refundHook('refund.processed', { id: `rfnd_b6_${P}`, pay: { id: p2.id, order_id: first.orderId }, amount: PRICE })
    expect((await db.doc(`registrations/${first.registrationId}`).get()).get('paymentStatus')).toBe('paid')
    expect((await db.doc(`registrationRefunds/rfnd_b6_${P}`).get()).data()).toMatchObject({ registrationId: null, status: 'processed' })
    expect((await db.doc(`platformTransactions/ptx_${first.registrationId}`).get()).get('status')).not.toBe('refunded')
  }, T)

  // ═══ PART 11 · R1 — a held payment is never auto-settled; approval refuses a settled payment ══
  it('R1 · a capacity-held payment stays held when the seat frees: the sweep and a webhook replay create nothing; the hold stays in review', async () => {
    await seedEvent(1)
    await paidRegistration('r1-first@finfix.test')                          // takes the only seat
    const orderId = await order('fxr1heldAAAAAAAA', 'r1-held@finfix.test')
    const pay = capture(orderId, `pay_r1_${P}`)
    expect((await captured(pay)).status).toBe(200)                         // → HELD (capacity full)
    expect((await L.getIntent(orderId))?.status).toBe('registration_failed')
    const hold = (await holdsOf()).find(x => x.orderId === orderId)!
    expect(hold.status).toBe('review')
    // the seat frees up
    const firstReg = (await regsOf()).find(r => r.status === 'confirmed')!
    await L.cancel(firstReg.id as string, OWNER)
    await db.doc(`paymentIntents/${orderId}`).update({ createdAt: new Date(Date.now() - 20 * 60_000) })   // inside the sweep window
    await L.sweep(500); await L.sweep(500)
    expect((await captured(pay)).status).toBe(200)
    expect((await regsOf()).filter(r => r.status === 'confirmed')).toHaveLength(0)
    expect((await db.doc(`failedRefunds/${hold.id as string}`).get()).get('status')).toBe('review')
  }, T)

  it('R1 · approve_refund and retry REFUSE a hold whose payment now backs a confirmed registration (pre-fix overtaken state)', async () => {
    await seedEvent(100)
    const s = await paidRegistration('r1-overtaken@finfix.test')
    const holdId = `settlement_hold_${s.orderId}`
    await db.doc(`failedRefunds/${holdId}`).set({ orderId: s.orderId, paymentId: s.pay.id, amountPaise: PRICE, reason: 'x', eventSlug: slug,
      attendeeEmail: 'r1-overtaken@finfix.test', registrationId: null, kind: 'settlement_hold', status: 'review', createdAt: new Date() })
    const { POST: review } = await import('@/app/api/admin/failed-refunds/[id]/review/route')
    const r = await json(await review(new NextRequest('http://x', { method: 'POST', headers: { authorization: 'Bearer super', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve_refund', reason: 'try to refund a live registration' }) }), { params: Promise.resolve({ id: holdId }) } as never))
    expect(r.status).toBe(409); expect(r.body.code).toBe('HOLD_PAYMENT_SETTLED')
    await db.doc(`failedRefunds/${holdId}`).update({ status: 'open', reviewApproval: { by: 'someone', reason: 'pre-fix approval' } })
    const calls = h.refundCalls
    const { POST: retry } = await import('@/app/api/admin/failed-refunds/[id]/retry/route')
    const rr = await retry(new NextRequest('http://x', { method: 'POST', headers: { authorization: 'Bearer super', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'try to refund a live registration' }) }), { params: Promise.resolve({ id: holdId }) } as never)
    expect(rr.status).toBe(409)
    expect(h.refundCalls).toBe(calls)                                       // no gateway refund issued
  }, T)

  // ═══ PART 12 · R2 — authorized is not money yet ═════════════════════════════════════════════
  it('R2 · the sweep never settles a payment that is only AUTHORIZED; once captured it settles exactly once', async () => {
    await seedEvent(100)
    const orderId = await order('fxr2authAAAAAAAA', 'r2@finfix.test')
    capture(orderId, `pay_r2_${P}`, PRICE, 'authorized')
    await db.doc(`paymentIntents/${orderId}`).update({ createdAt: new Date(Date.now() - 20 * 60_000) })
    await L.sweep(500)
    expect(await regsOf()).toHaveLength(0)
    expect((await L.getIntent(orderId))?.status).toBe('created')
    capture(orderId, `pay_r2_${P}`, PRICE, 'captured')
    await L.sweep(500); await L.sweep(500)
    expect((await regsOf()).filter(r => r.status === 'confirmed')).toHaveLength(1)
  }, T)

  // ═══ PART 13 · refund_pending recovery + retry history ════════════════════════════════════════
  it('P13 · a refund stuck in refund_pending (route died after the gateway refund) is finished by refund.processed — with evidence, exactly once', async () => {
    await seedEvent(100)
    const s = await paidRegistration('p13@finfix.test')
    await db.doc(`registrations/${s.registrationId}`).update({ paymentStatus: 'refund_pending', refundClaim: { paymentId: s.pay.id, amountPaise: PRICE, by: 'super' } })
    // a refund of the WRONG amount is not evidence: it stays pending (W1 — a partial refund: recorded and
    // flagged for review, nothing applied). Checked on a SEPARATE registration: on this one a ₹1 refund
    // followed by the full ₹500 would exceed the charge — impossible at the gateway, and W1 refuses it.
    const bad = await paidRegistration('p13bad@finfix.test')
    await db.doc(`registrations/${bad.registrationId}`).update({ paymentStatus: 'refund_pending', refundClaim: { paymentId: bad.pay.id, amountPaise: PRICE, by: 'super' } })
    await refundHook('refund.processed', { id: `rfnd_p13_bad_${P}`, pay: bad.pay, amount: 100 })
    expect((await db.doc(`registrations/${bad.registrationId}`).get()).get('paymentStatus')).toBe('refund_pending')
    expect((await db.doc(`registrationRefunds/rfnd_p13_bad_${P}`).get()).get('reviewRequired')).toBe('partial_refund')
    // the real one finishes it
    const refundId = `rfnd_p13_${P}`
    for (let i = 0; i < 2; i++) await refundHook('refund.processed', { id: refundId, pay: s.pay, amount: PRICE })
    const reg = (await db.doc(`registrations/${s.registrationId}`).get()).data()!
    expect(reg).toMatchObject({ paymentStatus: 'refunded', refundId, refundAmount: PRICE })
    expect((await db.doc(`platformTransactions/ptx_${s.registrationId}`).get()).get('status')).toBe('refunded')
    expect((await db.doc(`registrationRefunds/${refundId}`).get()).get('status')).toBe('processed')
  }, T)

  it('P13 · a failed-refund retry writes the registrationRefunds record (gateway id + actual amount) — the Refunds figures see it', async () => {
    await seedEvent(100)
    const s = await paidRegistration('p13-retry@finfix.test')
    const id = `finfix_fr_${P}`
    await db.doc(`failedRefunds/${id}`).set({ orderId: s.orderId, paymentId: s.pay.id, amountPaise: PRICE, reason: 'gateway_error',
      registrationId: s.registrationId, status: 'open', createdAt: new Date() })
    const { POST: retry } = await import('@/app/api/admin/failed-refunds/[id]/retry/route')
    const rr = await retry(new NextRequest('http://x', { method: 'POST', headers: { authorization: 'Bearer super', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'retry the failed refund' }) }), { params: Promise.resolve({ id }) } as never)
    expect(rr.status).toBe(200)
    const refundId = (await db.doc(`failedRefunds/${id}`).get()).get('retryRefundId') as string
    expect((await db.doc(`registrationRefunds/${refundId}`).get()).data()).toMatchObject({ origin: 'admin', amountPaise: PRICE, registrationId: s.registrationId, gatewayPaymentId: s.pay.id })
    expect((await db.doc(`registrations/${s.registrationId}`).get()).get('paymentStatus')).toBe('refunded')
    // retrying again cannot refund twice
    const again = await retry(new NextRequest('http://x', { method: 'POST', headers: { authorization: 'Bearer super', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'retry the failed refund' }) }), { params: Promise.resolve({ id }) } as never)
    expect(again.status).toBe(409)
    expect((h.refunds.get(s.pay.id) ?? []).length).toBe(1)
  }, T)
  // ═══ PART 15 · end-to-end reconciliation across every source, two events ══════════════════════
  it('PART 15 · two events, every path (free, paid, failed, duplicate webhook, verify retry, refund, refund+cancel, cancel): every source reconciles', async () => {
    const { createRegistration } = await import('@/lib/firebase/firestore/registrations')
    const { getEventAnalytics } = await import('@/lib/analytics/eventAnalytics')
    const { POST: refundRoute } = await import('@/app/api/organizer/registrations/[registrationId]/refund/route')
    const refund = (registrationId: string) => refundRoute(new NextRequest('http://x', { method: 'POST',
      headers: { authorization: 'Bearer super', 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'attendee asked for a refund' }) }),
      { params: Promise.resolve({ registrationId }) } as never)

    const table: Array<Record<string, unknown>> = []
    for (const label of ['A', 'B'] as const) {
      await seedEvent(50)
      const ev = slug
      // free registration (₹0, not_required) through the real free-path transaction
      await createRegistration({ eventSlug: ev, passId: 'p1', passName: 'General', passCapacity: 50, eventName: label, organizerUid: OWNER,
        attendee: { name: 'Free', email: `free-${label}@finfix.test` }, amountPaise: 0, paymentStatusOverride: 'not_required' } as never)
      // paid ×3 (B: ×2) — one with a duplicate webhook + verify retry
      const paid = [] as Array<{ orderId: string; pay: Record<string, unknown>; registrationId: string }>
      for (let i = 0; i < (label === 'A' ? 3 : 2); i++) paid.push(await paidRegistration(`p15-${label}-${i}@finfix.test`))
      await captured(paid[0].pay); await captured(paid[0].pay)
      await verify(verifyReq(paid[0].orderId, paid[0].pay.id as string))
      // a failed payment (no money) and a pending one (order never paid)
      const failedOrder = await order(`fxp15fail${label}AAAAAA`, `p15-fail-${label}@finfix.test`)
      await hook('payment.failed', { payment: { entity: { id: `pay_p15f_${label}_${P}`, order_id: failedOrder, status: 'failed', amount: PRICE, currency: 'INR' } } })
      await order(`fxp15pend${label}AAAAAA`, `p15-pend-${label}@finfix.test`)
      if (label === 'A') {
        expect((await refund(paid[1].registrationId)).status).toBe(200)          // refund (stays confirmed)
        expect((await refund(paid[2].registrationId)).status).toBe(200)          // refund …
        await L.cancel(paid[2].registrationId, OWNER)                              // … then cancel
      } else {
        await L.cancel(paid[1].registrationId, OWNER)                              // cancel without refund
      }

      const regs = await regsOf()
      const intents = (await db.collection('paymentIntents').where('eventSlug', '==', ev).get()).docs.map(d => d.data())
      const ptxRows = (await db.collection('platformTransactions').where('entityId', '==', ev).get()).docs.map(d => d.data())
      const c = await counter()
      const confirmed = regs.filter(r => r.status === 'confirmed')
      const paidRegs = regs.filter(r => ['paid', 'refund_pending', 'refunded'].includes(r.paymentStatus as string))
      const a = (await getEventAnalytics(ev, { includeFinancial: true, comparison: false }))?.analytics
      const lt = await L.ledger({ organizerUid: OWNER, eventSlug: ev, from: null, to: null })
      const day = await today()
      const refundsRows = (await db.collection('registrationRefunds').where('eventSlug', '==', ev).get()).docs.map(d => d.data())
      const row = {
        event: label, registrations: regs.length, confirmed: confirmed.length, paidRegistrations: paidRegs.length,
        paidIntents: intents.filter(i => i.status === 'paid').length, financeRows: ptxRows.length,
        refundedRows: ptxRows.filter(t => t.status === 'refunded').length, refundRecords: refundsRows.length,
        counterTotal: c.totalCount, counterRevenue: c.revenuePaise, dailyConfirmed: day?.confirmed, dailyRevenue: day?.revenuePaise,
        analyticsConfirmed: a?.kpis.confirmed, analyticsPaid: a?.kpis.paidCharged,
        analyticsRevenue: a?.financial?.confirmedRevenuePaise, analyticsNet: a?.financial?.netRevenuePaise,
        ledgerGross: lt.grossPaise, payable: lt.organizerPayable,
      }
      table.push(row)
      const nPaid = label === 'A' ? 3 : 2
      const confirmedPaid = label === 'A' ? 2 : 1                                  // A: #2 cancelled · B: #1 cancelled
      const refundedConfirmed = label === 'A' ? 1 : 0                              // A: #1 refunded, still confirmed
      expect(row).toMatchObject({
        registrations: 1 + nPaid, confirmed: 1 + confirmedPaid, paidRegistrations: nPaid, paidIntents: nPaid, financeRows: nPaid,
        refundedRows: label === 'A' ? 2 : 0, refundRecords: label === 'A' ? 2 : 0,
        counterTotal: 1 + confirmedPaid, counterRevenue: confirmedPaid * PRICE,
        dailyConfirmed: 1 + confirmedPaid, dailyRevenue: confirmedPaid * PRICE,
        analyticsConfirmed: 1 + confirmedPaid, analyticsPaid: nPaid,
      })
      expect(row.analyticsRevenue).toEqual({ ok: true, paise: confirmedPaid * PRICE })
      // net after refunds: only the still-confirmed refunded registration nets — never twice
      expect(row.analyticsNet).toEqual({ ok: true, paise: (confirmedPaid - refundedConfirmed) * PRICE })
      expect(row.ledgerGross).toEqual({ ok: true, paise: nPaid * PRICE })
      // payable: every paid row's net, less the in-place-reversed (refunded) rows
      const netOf = (t: Record<string, unknown>) => t.netSettlementPaise as number
      expect(row.payable).toEqual({ ok: true, paise: ptxRows.filter(t => t.status !== 'refunded').reduce((s, t) => s + netOf(t), 0) })
    }
    // the wallet (both events, all reversals) reconciles — no false mismatch
    expect(await L.reconcileWallet(OWNER, (await db.doc(`organizerRevenueWallets/${OWNER}`).get()).data()!)).toEqual([])
    console.log('RD-FIN-02 reconciliation', JSON.stringify(table))
  }, T)
  // ═══ W1 · refund webhook: documented payload, full / partial / cumulative, refund.failed, ordering ══════
  const ADMIN_ALL = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) } as never   // the window shape the ADMIN REPORT test uses
  const regDoc    = async (id: string) => (await db.doc(`registrations/${id}`).get()).data() ?? {}
  const refundDoc = async (id: string) => (await db.doc(`registrationRefunds/${id}`).get()).data()
  const ptxStatus = async (regId: string) => (await db.doc(`platformTransactions/ptx_${regId}`).get()).get('status')
  const intentDoc = async (orderId: string) => (await db.doc(`paymentIntents/${orderId}`).get()).data() ?? {}
  const walletClean = async () => expect(await L.reconcileWallet(OWNER, (await db.doc(`organizerRevenueWallets/${OWNER}`).get()).data()!)).toEqual([])
  const refundTotal = async () => {
    const read = await L.readRefunds({ organizerUid: OWNER, eventSlug: slug })
    return read.records.reduce((a, r) => a + Number(r.amountPaise ?? 0), 0)
  }

  it('W1 · a real-shaped dashboard FULL refund (order only on payload.payment.entity) is associated and applied once; redeliveries change nothing', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1full@finfix.test')
    const id = `rfnd_w1full_${P}`
    for (let i = 0; i < 3; i++) expect((await refundHook('refund.processed', { id, pay: s.pay, amount: PRICE })).status).toBe(200)
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: id, refundAmount: PRICE })
    expect(await ptxStatus(s.registrationId)).toBe('refunded')
    // attributed to the payment's owner from its own intent — never left to the capped unattributed recovery
    expect(await refundDoc(id)).toMatchObject({ status: 'processed', registrationId: s.registrationId, organizerUid: OWNER, gatewayOrderId: s.orderId, gatewayPaymentId: s.pay.id, amountPaise: PRICE, ledgerReversed: true })
    expect(await intentDoc(s.orderId)).toMatchObject({ gatewayRefundsPaise: { [id]: PRICE }, gatewayRefundFullBy: id, refundAmount: PRICE })
    expect(await refundTotal()).toBe(PRICE)
    await walletClean()                                                   // reversed and debited exactly once
  }, T)

  it('W1 · a PARTIAL refund is recorded (and counted as money out) but never marks the registration refunded or reverses its ledger; a redelivery is not double-counted', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1part@finfix.test')
    const id = `rfnd_w1part_${P}`
    for (let i = 0; i < 2; i++) await refundHook('refund.processed', { id, pay: s.pay, amount: 20_000 })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    expect(await ptxStatus(s.registrationId)).not.toBe('refunded')
    expect(await refundDoc(id)).toMatchObject({ status: 'linked', amountPaise: 20_000, reviewRequired: 'partial_refund', reviewReasons: ['partial_refund'], reviewDetails: { partial_refund: { cumulativePaise: 20_000, chargedPaise: PRICE, settlementHeld: true } } })
    // F1 — this payment's settlement is HELD (never released while the partial refund is open)
    expect((await db.doc(`platformTransactions/ptx_${s.registrationId}`).get()).data()).toMatchObject({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: [id] } })
    expect((await intentDoc(s.orderId)).gatewayRefundsPaise).toEqual({ [id]: 20_000 })
    expect((await intentDoc(s.orderId)).gatewayRefundFullBy).toBeUndefined()
    expect(await refundTotal()).toBe(20_000)
    await walletClean()
  }, T)

  it('W1 · multiple partial refunds accumulate; the one that completes the full charge applies the full-refund effects exactly once', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1multi@finfix.test')
    const a = `rfnd_w1m_a_${P}`, b = `rfnd_w1m_b_${P}`, c = `rfnd_w1m_c_${P}`
    await refundHook('refund.processed', { id: a, pay: s.pay, amount: 10_000 })
    await refundHook('refund.processed', { id: b, pay: s.pay, amount: 15_000 })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    await refundHook('refund.processed', { id: c, pay: s.pay, amount: 25_000 })       // 10k + 15k + 25k = the full 50k
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: c, refundAmount: PRICE })
    expect(await ptxStatus(s.registrationId)).toBe('refunded')
    expect(await refundDoc(c)).toMatchObject({ status: 'processed' })
    expect((await refundDoc(a))?.status).toBe('linked'); expect((await refundDoc(b))?.status).toBe('linked')
    expect(await intentDoc(s.orderId)).toMatchObject({ gatewayRefundsPaise: { [a]: 10_000, [b]: 15_000, [c]: 25_000 }, gatewayRefundFullBy: c })
    expect(await refundTotal()).toBe(PRICE)
    // a stale redelivery of an earlier partial after the full refund changes nothing
    await refundHook('refund.processed', { id: a, pay: s.pay, amount: 10_000 })
    expect((await intentDoc(s.orderId)).gatewayRefundFullBy).toBe(c)
    await walletClean()
  }, T)

  it('W1 · a refund AFTER the payment is fully refunded, and a refund that would EXCEED the charge, are flagged — never applied, never counted toward the charge', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1over@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_w1o_a_${P}`, pay: s.pay, amount: 40_000 })
    await refundHook('refund.processed', { id: `rfnd_w1o_b_${P}`, pay: s.pay, amount: 20_000 })       // 60k > 50k
    expect(await refundDoc(`rfnd_w1o_b_${P}`)).toMatchObject({ reviewRequired: 'refund_exceeds_charge', status: 'linked' })
    expect((await intentDoc(s.orderId)).gatewayRefundsPaise).toEqual({ [`rfnd_w1o_a_${P}`]: 40_000 })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    const f = await paidRegistration('w1after@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_w1af_a_${P}`, pay: f.pay, amount: PRICE })
    await refundHook('refund.processed', { id: `rfnd_w1af_b_${P}`, pay: f.pay, amount: 100 })
    expect(await refundDoc(`rfnd_w1af_b_${P}`)).toMatchObject({ reviewRequired: 'refund_after_full' })
    expect(await regDoc(f.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: `rfnd_w1af_a_${P}`, refundAmount: PRICE })
    await walletClean()
  }, T)

  it('W1 · refund.failed records the failure (never money out), changes no registration or ledger; a duplicate changes nothing; a success arriving AFTER it is flagged, not applied', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1fail@finfix.test')
    const id = `rfnd_w1fail_${P}`
    const adminBefore = (await L.adminTotals(ADMIN_ALL)).registrationRefundsPaise
    for (let i = 0; i < 2; i++) expect((await refundHook('refund.failed', { id, pay: s.pay, amount: PRICE })).status).toBe(200)
    expect(await refundDoc(id)).toMatchObject({ status: 'failed', registrationId: s.registrationId, amountPaise: PRICE })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    expect(await ptxStatus(s.registrationId)).not.toBe('refunded')
    expect(await refundTotal()).toBe(0)                                   // a failed refund is never counted
    expect((await L.adminTotals(ADMIN_ALL)).registrationRefundsPaise).toBe(adminBefore)     // nor in the platform report
    await refundHook('refund.processed', { id, pay: s.pay, amount: PRICE })                 // out of order
    expect(await refundDoc(id)).toMatchObject({ status: 'failed', reviewRequired: 'processed_after_failed' })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    expect((await intentDoc(s.orderId)).gatewayRefundsPaise).toBeUndefined()
    await walletClean()
  }, T)

  it('W1 · refund.failed AFTER a processed refund never overwrites the success: flagged for review, nothing rolled back', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1fap@finfix.test')
    const id = `rfnd_w1fap_${P}`
    await refundHook('refund.processed', { id, pay: s.pay, amount: PRICE })
    await refundHook('refund.failed', { id, pay: s.pay, amount: PRICE })
    expect(await refundDoc(id)).toMatchObject({ status: 'processed', reviewRequired: 'failed_after_processed' })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded' })
    expect(await ptxStatus(s.registrationId)).toBe('refunded')
    expect(await refundTotal()).toBe(PRICE)
    await walletClean()
  }, T)

  it('W1 · an APP-initiated refund and its webhook never double-apply; a later refund.failed for it is flagged (no automatic re-credit, no second refund)', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1app@finfix.test')
    const { POST: refundRoute } = await import('@/app/api/organizer/registrations/[registrationId]/refund/route')
    const callsBefore = h.refundCalls
    const r = await refundRoute(new NextRequest('http://x', { method: 'POST',
      headers: { authorization: 'Bearer super', 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'attendee asked for a refund' }) }),
      { params: Promise.resolve({ registrationId: s.registrationId }) } as never)
    expect(r.status).toBe(200)
    expect(h.refundCalls).toBe(callsBefore + 1)                           // the explicit Super Admin action
    const refundId = (await regDoc(s.registrationId)).refundId as string
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded' })
    // the corresponding webhook (twice) adds nothing
    for (let i = 0; i < 2; i++) await refundHook('refund.processed', { id: refundId, pay: s.pay, amount: PRICE })
    expect(await ptxStatus(s.registrationId)).toBe('refunded')
    expect(await refundTotal()).toBe(PRICE)
    await walletClean()
    // …and if the gateway later reports that refund FAILED: recorded + flagged, nothing re-credited or retried
    await refundHook('refund.failed', { id: refundId, pay: s.pay, amount: PRICE })
    // The app route's record stays `linked` (its side effects ran through the route), so the failure marks it
    // failed, UN-counts it from the intent and flags BOTH facts — in one transaction (F2 / F3).
    const rec = await refundDoc(refundId)
    expect(rec).toMatchObject({ status: 'failed', reviewRequired: 'failed_after_counted' })
    expect([...(rec?.reviewReasons ?? [])].sort()).toEqual(['failed_after_counted', 'failed_after_side_effects'])
    expect((await intentDoc(s.orderId)).gatewayRefundsPaise?.[refundId]).toBeUndefined()
    expect((await intentDoc(s.orderId)).gatewayRefundFullBy).toBeUndefined()
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded' })
    expect(await ptxStatus(s.registrationId)).toBe('refunded')
    expect(h.refundCalls).toBe(callsBefore + 1)                           // the webhook never refunds
  }, T)

  it('W1 · association: no payment entity ⇒ resolved from the trusted intent by payment id; an unknown payment ⇒ recorded unlinked; a mismatched payment entity ⇒ flagged, nothing applied', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1assoc@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_w1np_${P}`, pay: s.pay, amount: PRICE, withPayment: false })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: `rfnd_w1np_${P}` })
    // unknown payment, no payment entity: the gateway fact is kept, attributed to nothing
    await refundHook('refund.processed', { id: `rfnd_w1unk_${P}`, pay: { id: `pay_w1_unknown_${P}`, order_id: 'x' }, amount: 999, withPayment: false })
    expect(await refundDoc(`rfnd_w1unk_${P}`)).toMatchObject({ status: 'unlinked', registrationId: null, gatewayOrderId: null })
    // mismatched: the payment entity names ANOTHER payment than the refund
    const m = await paidRegistration('w1mis@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_w1mis_${P}`, pay: m.pay, amount: PRICE, payment: { id: `pay_someone_else_${P}` } })
    expect(await refundDoc(`rfnd_w1mis_${P}`)).toMatchObject({ registrationId: null, reviewRequired: 'payment_mismatch' })
    expect(await regDoc(m.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    expect(await ptxStatus(m.registrationId)).not.toBe('refunded')
    await walletClean()
  }, T)

  it('W1 · malformed refund payloads and a currency mismatch never touch a registration', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1bad@finfix.test')
    const base = refundPayload({ id: `rfnd_w1bad_${P}`, pay: s.pay, amount: PRICE })
    const variants = [
      { ...base, refund: { entity: { ...base.refund.entity, amount: -5 } } },
      { ...base, refund: { entity: { ...base.refund.entity, amount: 12.5 } } },
      { ...base, refund: { entity: { ...base.refund.entity, id: '' } } },
      { ...base, refund: { entity: { ...base.refund.entity, payment_id: undefined } } },
      { payment: base.payment },
    ]
    for (const v of variants) expect((await hook('refund.processed', v)).status).toBe(200)
    expect(await refundDoc(`rfnd_w1bad_${P}`)).toBeUndefined()
    await refundHook('refund.processed', { id: `rfnd_w1usd_${P}`, pay: s.pay, amount: PRICE, currency: 'USD' })
    expect(await refundDoc(`rfnd_w1usd_${P}`)).toMatchObject({ registrationId: null, reviewRequired: 'currency_mismatch' })
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'paid' })
    expect(await ptxStatus(s.registrationId)).not.toBe('refunded')
  }, T)

  it('W1 · concurrency: two DIFFERENT refunds completing one payment, and three concurrent deliveries of one refund, apply the full-refund effects exactly once', async () => {
    await seedEvent(100)
    const s = await paidRegistration('w1conc@finfix.test')
    const a = `rfnd_w1c_a_${P}`, b = `rfnd_w1c_b_${P}`
    const rs = await Promise.all([
      refundHook('refund.processed', { id: a, pay: s.pay, amount: 25_000 }),
      refundHook('refund.processed', { id: b, pay: s.pay, amount: 25_000 }),
    ])
    expect(rs.map(r => r.status)).toEqual([200, 200])
    const it1 = await intentDoc(s.orderId)
    expect(it1.gatewayRefundsPaise).toEqual({ [a]: 25_000, [b]: 25_000 })
    expect([a, b]).toContain(it1.gatewayRefundFullBy)
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundAmount: PRICE, refundId: it1.gatewayRefundFullBy })
    expect([(await refundDoc(a))?.status, (await refundDoc(b))?.status].sort()).toEqual(['linked', 'processed'])
    await walletClean()

    const d = await paidRegistration('w1dup@finfix.test')
    const id = `rfnd_w1dup_${P}`
    const ds = await Promise.all([0, 1, 2].map(() => refundHook('refund.processed', { id, pay: d.pay, amount: PRICE })))
    expect(ds.every(r => r.status === 200)).toBe(true)
    expect(await regDoc(d.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: id })
    expect(await refundDoc(id)).toMatchObject({ status: 'processed', ledgerReversed: true })
    expect((await intentDoc(d.orderId)).gatewayRefundsPaise).toEqual({ [id]: PRICE })
    await walletClean()
  }, T)

  it('W1 · a refund of a NON-registration payment (licence order / donation) never becomes a registration refund', async () => {
    await seedEvent(100)
    const licOrder = `order_w1lic_${P}`, donOrder = `order_w1don_${P}`
    await db.doc(`licenseOrders/w1lic_${P}`).set({ orderId: `w1lic_${P}`, razorpayOrderId: licOrder, status: 'paid', purpose: 'purchase' })
    await db.doc(`donations/w1don_${P}`).set({ razorpayOrderId: donOrder, status: 'completed' })
    await refundHook('refund.processed', { id: `rfnd_w1lic_${P}`, pay: { id: `pay_w1lic_${P}`, order_id: licOrder }, amount: 1_000 })
    await refundHook('refund.processed', { id: `rfnd_w1don_${P}`, pay: { id: `pay_w1don_${P}`, order_id: donOrder }, amount: 1_000 })
    await refundHook('refund.failed', { id: `rfnd_w1donf_${P}`, pay: { id: `pay_w1don_${P}`, order_id: donOrder }, amount: 1_000 })
    expect(await refundDoc(`rfnd_w1lic_${P}`)).toBeUndefined()
    expect(await refundDoc(`rfnd_w1don_${P}`)).toBeUndefined()
    expect(await refundDoc(`rfnd_w1donf_${P}`)).toBeUndefined()
    await db.doc(`licenseOrders/w1lic_${P}`).delete(); await db.doc(`donations/w1don_${P}`).delete()
  }, T)
  // ═══ F1 · a partial refund holds THAT payment's settlement; unrelated settlements still release ══════
  const ptxDoc = async (regId: string) => (await db.doc(`platformTransactions/ptx_${regId}`).get()).data() ?? {}
  const backdate = (regId: string) => db.doc(`platformTransactions/ptx_${regId}`).update({ paidAt: new Date(Date.now() - 5 * 86_400_000) })

  it('F1 · partial refund ⇒ that settlement is held (concurrent release runs never release it); an unrelated settlement releases; a stale-query hold is refused in-transaction', async () => {
    await seedEvent(100)
    const { releaseEligibleFunds } = await import('@/lib/settlements/releaseFunds')
    const held = await paidRegistration('f1held@finfix.test')
    const free = await paidRegistration('f1free@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_f1_${P}`, pay: held.pay, amount: 20_000 })
    expect(await ptxDoc(held.registrationId)).toMatchObject({ status: 'completed', releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: [`rfnd_f1_${P}`] } })
    await backdate(held.registrationId); await backdate(free.registrationId)
    await Promise.all([releaseEligibleFunds({ limit: 500 }), releaseEligibleFunds({ limit: 500 })])
    expect((await ptxDoc(free.registrationId)).releaseStatus).toBe('released')          // unrelated: released
    expect((await ptxDoc(held.registrationId)).releaseStatus).toBe('held')              // affected: never
    expect((await db.collection('settlementReleases').where('transactionId', '==', `ptx_${held.registrationId}`).get()).size).toBe(0)
    // a hold placed after the release query ran (simulated: status 'pending' but releaseHold present) is refused in the txn
    await db.doc(`platformTransactions/ptx_${held.registrationId}`).update({ releaseStatus: 'pending' })
    const r = await releaseEligibleFunds({ limit: 500 })
    expect(r.held ?? 0).toBeGreaterThanOrEqual(1)
    expect((await ptxDoc(held.registrationId)).releaseStatus).toBe('pending')           // still not released
    expect((await db.collection('settlementReleases').where('transactionId', '==', `ptx_${held.registrationId}`).get()).size).toBe(0)
    await db.doc(`platformTransactions/ptx_${held.registrationId}`).update({ releaseStatus: 'held' })
    await walletClean()
  }, T)

  it('F1 · a partial refund of funds ALREADY released cannot be held: recorded on the hold and in the review evidence', async () => {
    await seedEvent(100)
    const { releaseEligibleFunds } = await import('@/lib/settlements/releaseFunds')
    const s = await paidRegistration('f1rel@finfix.test')
    await backdate(s.registrationId)
    await releaseEligibleFunds({ limit: 500 })
    expect((await ptxDoc(s.registrationId)).releaseStatus).toBe('released')
    await refundHook('refund.processed', { id: `rfnd_f1rel_${P}`, pay: s.pay, amount: 10_000 })
    expect(await ptxDoc(s.registrationId)).toMatchObject({ releaseStatus: 'released', releaseHold: { alreadyReleased: true, refundIds: [`rfnd_f1rel_${P}`] } })
    expect(await refundDoc(`rfnd_f1rel_${P}`)).toMatchObject({ reviewRequired: 'partial_refund', reviewDetails: { partial_refund: { settlementHeld: false, settlementAlreadyReleased: true } } })
  }, T)

  // ═══ F2 · review reasons are durable across a failed write + redelivery, and accumulate ═════════════
  it('F2 · the counting+review transaction fails on the first delivery ⇒ 500, redelivery counts ONCE and the review + hold are durable', async () => {
    await seedEvent(100)
    const s = await paidRegistration('f2dur@finfix.test')
    const id = `rfnd_f2_${P}`
    const orig = db.runTransaction.bind(db)
    let calls = 0
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: never, opts?: never) => {
      calls++
      if (calls === 2) throw new Error('simulated review/counting write failure')      // ensureRecord(1) · accumulate(2)
      return orig(fn, opts)
    }) as never)
    expect((await refundHook('refund.processed', { id, pay: s.pay, amount: 20_000 })).status).toBe(500)
    vi.restoreAllMocks()
    expect(await refundDoc(id)).toMatchObject({ status: 'linked' })                     // the gateway fact was kept
    expect((await refundDoc(id))?.reviewRequired).toBeUndefined()
    for (let i = 0; i < 2; i++) expect((await refundHook('refund.processed', { id, pay: s.pay, amount: 20_000 })).status).toBe(200)
    expect(await refundDoc(id)).toMatchObject({ reviewRequired: 'partial_refund', reviewReasons: ['partial_refund'] })
    expect((await intentDoc(s.orderId)).gatewayRefundsPaise).toEqual({ [id]: 20_000 })
    expect((await ptxDoc(s.registrationId)).releaseStatus).toBe('held')
  }, T)

  it('F2 · refund.failed: the record+review transaction fails ⇒ 500; redelivery records it once; reasons accumulate (first reason kept)', async () => {
    await seedEvent(100)
    const s = await paidRegistration('f2fail@finfix.test')
    const id = `rfnd_f2f_${P}`
    await refundHook('refund.processed', { id, pay: s.pay, amount: 20_000 })              // partial: reason #1
    const orig = db.runTransaction.bind(db)
    let calls = 0
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: never, opts?: never) => {
      calls++
      if (calls === 1) throw new Error('simulated failure-record write failure')
      return orig(fn, opts)
    }) as never)
    expect((await refundHook('refund.failed', { id, pay: s.pay, amount: 20_000 })).status).toBe(500)
    vi.restoreAllMocks()
    expect((await refundDoc(id))?.status).toBe('linked')
    for (let i = 0; i < 2; i++) expect((await refundHook('refund.failed', { id, pay: s.pay, amount: 20_000 })).status).toBe(200)
    const rec = await refundDoc(id)
    expect(rec).toMatchObject({ status: 'failed', reviewRequired: 'partial_refund' })   // the first reason is never overwritten
    expect([...(rec?.reviewReasons ?? [])].sort()).toEqual(['failed_after_counted', 'partial_refund'])
    expect((await intentDoc(s.orderId)).gatewayRefundsPaise?.[id]).toBeUndefined()      // F3 — no longer counted
    expect(await refundTotal()).toBe(0)
    expect((await ptxDoc(s.registrationId)).releaseStatus).toBe('held')                // contradictory: hold kept for review
  }, T)

  // ═══ F3 · success and failure for the SAME refund at the same time ═════════════════════════════════
  /** The only consistent end states: applied in full (failure flagged after), or failed and nothing applied. */
  async function assertConsistent(s: { registrationId: string; orderId: string }, id: string) {
    const rec = (await refundDoc(id))!
    const reg = await regDoc(s.registrationId)
    const intent = await intentDoc(s.orderId)
    const ptx = await ptxDoc(s.registrationId)
    if (rec.status === 'processed') {
      expect(reg.paymentStatus).toBe('refunded')
      expect(ptx.status).toBe('refunded')
      expect(intent.gatewayRefundsPaise?.[id]).toBe(PRICE)
      expect(rec.reviewReasons ?? []).toContain('failed_after_processed')             // the later failure is flagged
    } else {
      expect(rec.status).toBe('failed')
      expect(reg.paymentStatus === 'paid' || reg.paymentStatus === 'refund_pending').toBe(true)
      expect(ptx.status).not.toBe('refunded')
      expect(intent.gatewayRefundsPaise?.[id]).toBeUndefined()                          // never stays counted
      expect(intent.gatewayRefundFullBy).toBeUndefined()
      expect((rec.reviewReasons ?? []).length).toBeGreaterThan(0)                         // never silent
    }
    await walletClean()
  }

  it('F3 · refund.processed and refund.failed for one refund, simultaneously (paid registration) ⇒ always a consistent, reviewed end state', async () => {
    await seedEvent(100)
    for (let round = 0; round < 4; round++) {
      const s = await paidRegistration(`f3paid${round}@finfix.test`)
      const id = `rfnd_f3p${round}_${P}`
      const order = round % 2 === 0
        ? [refundHook('refund.processed', { id, pay: s.pay, amount: PRICE }), refundHook('refund.failed', { id, pay: s.pay, amount: PRICE })]
        : [refundHook('refund.failed', { id, pay: s.pay, amount: PRICE }), refundHook('refund.processed', { id, pay: s.pay, amount: PRICE })]
      const rs = await Promise.all(order)
      expect(rs.every(r => r.status === 200)).toBe(true)
      await assertConsistent(s, id)
    }
  }, T)

  it('F3 · the refund_pending variant: success + failure simultaneously never leave the registration refunded on a failed refund', async () => {
    await seedEvent(100)
    for (let round = 0; round < 4; round++) {
      const s = await paidRegistration(`f3pend${round}@finfix.test`)
      await db.doc(`registrations/${s.registrationId}`).update({ paymentStatus: 'refund_pending', refundClaim: { paymentId: s.pay.id, amountPaise: PRICE, by: 'super' } })
      const id = `rfnd_f3q${round}_${P}`
      const rs = await Promise.all([
        refundHook('refund.processed', { id, pay: s.pay, amount: PRICE }),
        refundHook('refund.failed', { id, pay: s.pay, amount: PRICE }),
      ])
      expect(rs.every(r => r.status === 200)).toBe(true)
      await assertConsistent(s, id)
      const rec = (await refundDoc(id))!
      if (rec.status === 'failed') expect((await regDoc(s.registrationId)).paymentStatus).toBe('refund_pending')
    }
  }, T)

  it('F3 · sequential failure-before-success and success-before-failure, both orders, end consistent', async () => {
    await seedEvent(100)
    const a = await paidRegistration('f3seqa@finfix.test')
    await refundHook('refund.failed', { id: `rfnd_f3sa_${P}`, pay: a.pay, amount: PRICE })
    await refundHook('refund.processed', { id: `rfnd_f3sa_${P}`, pay: a.pay, amount: PRICE })
    await assertConsistent(a, `rfnd_f3sa_${P}`)
    expect((await refundDoc(`rfnd_f3sa_${P}`))?.reviewReasons).toContain('processed_after_failed')
    const b = await paidRegistration('f3seqb@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_f3sb_${P}`, pay: b.pay, amount: PRICE })
    await refundHook('refund.failed', { id: `rfnd_f3sb_${P}`, pay: b.pay, amount: PRICE })
    await assertConsistent(b, `rfnd_f3sb_${P}`)
  }, T)

  // ═══ M1 · a hold whose payment is now FULLY refunded and reversed is closed — on consistent evidence only ═══
  const holdAudits = async (regId: string) =>
    (await db.collection('adminAuditLogs').where('entityId', '==', `ptx_${regId}`).where('action', '==', 'settlement.refund_hold_closed').get()).docs
  const holdAlerts = () => h.alerts.filter(a => String(a.scope ?? '').startsWith('razorpay.refund_processed.hold_'))
  const closureDoc = async (regId: string) => (await db.doc(`refundHoldClosureReconciliation/${regId}`).get()).data()
  const L2 = { drain: async (n: number) => (await import('@/lib/payments/registrationReconciliation')).retryPendingRefundHoldClosures(n) }

  it('M1 · partial refund ⇒ held; the remainder completes the FULL refund ⇒ hold closed (evidence kept), review closed, audited once; never released; health drops while a real hold stays visible', async () => {
    await seedEvent(100)
    const { releaseEligibleFunds } = await import('@/lib/settlements/releaseFunds')
    const { getOperationsHealth } = await import('@/lib/operations/healthMetrics')
    const s = await paidRegistration('m1close@finfix.test')
    const other = await paidRegistration('m1open@finfix.test')
    const a = `rfnd_m1_a_${P}`, b = `rfnd_m1_b_${P}`, o = `rfnd_m1_o_${P}`
    await refundHook('refund.processed', { id: a, pay: s.pay, amount: 20_000 })
    await refundHook('refund.processed', { id: o, pay: other.pay, amount: 20_000 })         // a genuinely unresolved hold
    expect(await ptxDoc(s.registrationId)).toMatchObject({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: [a] } })
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: true, reviewReasons: ['partial_refund'] })
    const before = (await getOperationsHealth()).financial
    h.alerts.length = 0
    const refundCallsBefore = h.refundCalls

    for (let i = 0; i < 2; i++) expect((await refundHook('refund.processed', { id: b, pay: s.pay, amount: 30_000 })).status).toBe(200)   // + a redelivery
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: b, refundAmount: PRICE })
    const ptx = await ptxDoc(s.registrationId)
    expect(ptx.status).toBe('refunded')                                                    // reversed — never released
    expect(ptx.releaseHold).toBeUndefined()
    expect(ptx.releaseStatus).toBe('pending')
    const closure = ptx.releaseHoldHistory?.[`full_refund_${b}`]
    expect(closure).toMatchObject({
      hold: { reason: 'refund_review', refundIds: [a], alreadyReleased: false },
      outcome: 'closed_full_refund', by: 'system:full_refund',
      evidence: { gatewayRefundFullBy: b, countedRefundsPaise: PRICE, chargedPaise: PRICE, ledgerStatus: 'refunded' },
    })
    expect(closure.hold.heldAt).toBeTruthy()                                               // the original hold evidence
    // the review is CLOSED, its reasons and details preserved
    expect(await refundDoc(a)).toMatchObject({
      reviewOpen: false, reviewRequired: 'partial_refund', reviewReasons: ['partial_refund'],
      reviewDetails: { partial_refund: { cumulativePaise: 20_000, chargedPaise: PRICE } },
      reviewClosed: { by: 'system:full_refund', closedReasons: ['partial_refund'], evidence: { gatewayRefundFullBy: b } },
    })
    const audit = await holdAudits(s.registrationId)
    expect(audit).toHaveLength(1)                                                          // the redelivery closed nothing twice
    expect(audit[0].data()).toMatchObject({
      actorRole: 'system', adminUid: 'system:razorpay_webhook', entityType: 'settlement',
      before: { releaseStatus: 'held', refundIds: [a] }, after: { releaseStatus: 'pending', ledgerStatus: 'refunded' },
      metadata: { outcome: 'closed_full_refund', closedRefundIds: [a] },
      correlation: { registrationId: s.registrationId, orderId: s.orderId, paymentId: s.pay.id },
    })
    expect(holdAlerts()).toEqual([])
    // the release job never takes the reversed transaction, however old
    await backdate(s.registrationId)
    await releaseEligibleFunds({ limit: 500 })
    expect(await ptxDoc(s.registrationId)).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })
    expect((await db.collection('settlementReleases').where('transactionId', '==', `ptx_${s.registrationId}`).get()).size).toBe(0)
    // the unrelated, genuinely unresolved hold is untouched — and still counted
    expect(await ptxDoc(other.registrationId)).toMatchObject({ releaseStatus: 'held', releaseHold: { refundIds: [o] } })
    expect(await refundDoc(o)).toMatchObject({ reviewOpen: true })
    const after = (await getOperationsHealth()).financial
    expect(after.settlementsHeldForRefundReview).toBe(before.settlementsHeldForRefundReview - 1)
    expect(after.registrationRefundsNeedingReview).toBe(before.registrationRefundsNeedingReview - 1)
    expect(after.settlementsHeldForRefundReview).toBeGreaterThanOrEqual(1)
    expect(after.registrationRefundsNeedingReview).toBeGreaterThanOrEqual(1)
    expect(h.refundCalls).toBe(refundCallsBefore)                                          // no money moved by RegisterDesk
    await walletClean()
  }, T)

  it('M1 · an unresolved contradiction PREVENTS closure: an exceeding refund, or a failure of a counted refund, keeps the hold and every review open (alerted, still counted)', async () => {
    await seedEvent(100)
    const { releaseEligibleFunds } = await import('@/lib/settlements/releaseFunds')
    const { closeRefundHoldAfterFullRefund } = await import('@/lib/refunds/registrationRefunds')
    h.alerts.length = 0
    // (a) 40k partial, a 20k refund that would EXCEED the charge, then 10k completes the charge
    const x = await paidRegistration('m1exceed@finfix.test')
    const x1 = `rfnd_m1x1_${P}`, x2 = `rfnd_m1x2_${P}`, x3 = `rfnd_m1x3_${P}`
    await refundHook('refund.processed', { id: x1, pay: x.pay, amount: 40_000 })
    await refundHook('refund.processed', { id: x2, pay: x.pay, amount: 20_000 })
    await refundHook('refund.processed', { id: x3, pay: x.pay, amount: 10_000 })
    expect(await regDoc(x.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundAmount: PRICE })
    expect(await ptxDoc(x.registrationId)).toMatchObject({ status: 'refunded', releaseStatus: 'held', releaseHold: { reason: 'refund_review' } })
    expect((await ptxDoc(x.registrationId)).releaseHoldHistory).toBeUndefined()
    expect(await refundDoc(x1)).toMatchObject({ reviewOpen: true })
    expect(await refundDoc(x2)).toMatchObject({ reviewOpen: true, reviewRequired: 'refund_exceeds_charge' })
    expect((await refundDoc(x1))?.reviewClosed).toBeUndefined()
    expect(holdAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_processed.hold_not_closed', why: 'contradictory_review', registrationId: x.registrationId })])
    expect(await closeRefundHoldAfterFullRefund({ orderId: x.orderId, registrationId: x.registrationId })).toEqual({ closed: false, why: 'contradictory_review' })
    expect(await holdAudits(x.registrationId)).toHaveLength(0)

    // (b) 20k partial that then FAILS at the gateway (uncounted, flagged), then 30k + 20k complete the charge
    const y = await paidRegistration('m1failed@finfix.test')
    const y1 = `rfnd_m1y1_${P}`, y2 = `rfnd_m1y2_${P}`, y3 = `rfnd_m1y3_${P}`
    await refundHook('refund.processed', { id: y1, pay: y.pay, amount: 20_000 })
    await refundHook('refund.failed', { id: y1, pay: y.pay, amount: 20_000 })
    await refundHook('refund.processed', { id: y2, pay: y.pay, amount: 30_000 })
    await refundHook('refund.processed', { id: y3, pay: y.pay, amount: 20_000 })
    expect(await intentDoc(y.orderId)).toMatchObject({ gatewayRefundsPaise: { [y2]: 30_000, [y3]: 20_000 } })
    expect(await ptxDoc(y.registrationId)).toMatchObject({ status: 'refunded', releaseStatus: 'held' })
    expect(await refundDoc(y1)).toMatchObject({ status: 'failed', reviewOpen: true })
    expect([...((await refundDoc(y1))?.reviewReasons ?? [])]).toContain('failed_after_counted')
    expect(holdAlerts().filter(a => a.registrationId === y.registrationId)).toEqual([expect.objectContaining({ why: 'contradictory_review' })])

    // (c) a payment only PARTIALLY refunded is never closed by a direct call either
    const z = await paidRegistration('m1partial@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_m1z_${P}`, pay: z.pay, amount: 20_000 })
    expect(await closeRefundHoldAfterFullRefund({ orderId: z.orderId, registrationId: z.registrationId })).toEqual({ closed: false, why: 'not_reversed' })
    expect(await ptxDoc(z.registrationId)).toMatchObject({ status: 'completed', releaseStatus: 'held' })

    // none of the contradictory holds is ever released
    for (const r of [x, y, z]) await backdate(r.registrationId)
    await releaseEligibleFunds({ limit: 500 })
    for (const r of [x, y, z]) {
      expect((await ptxDoc(r.registrationId)).releaseStatus).toBe('held')
      expect((await db.collection('settlementReleases').where('transactionId', '==', `ptx_${r.registrationId}`).get()).size).toBe(0)
    }
    await walletClean()
  }, T)

  it('M1 · closure is all-or-nothing with its audit row (a failed audit write closes NOTHING, alerted); concurrent closures close exactly once', async () => {
    await seedEvent(100)
    const { closeRefundHoldAfterFullRefund } = await import('@/lib/refunds/registrationRefunds')
    const s = await paidRegistration('m1audit@finfix.test')
    const a = `rfnd_m1au_a_${P}`, b = `rfnd_m1au_b_${P}`
    await refundHook('refund.processed', { id: a, pay: s.pay, amount: 20_000 })
    // the audit row is append-only (create): an existing row at its id makes the closure transaction FAIL
    const blocker = db.doc(`adminAuditLogs/settlement_hold_ptx_${s.registrationId}_full_refund_${b}`)
    await blocker.set({ action: 'blocker', entityId: 'none' })
    h.alerts.length = 0
    expect((await refundHook('refund.processed', { id: b, pay: s.pay, amount: 30_000 })).status).toBe(200)
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded' })     // the refund itself is applied
    const ptx = await ptxDoc(s.registrationId)
    expect(ptx).toMatchObject({ status: 'refunded', releaseStatus: 'held', releaseHold: { refundIds: [a] } })
    expect(ptx.releaseHoldHistory).toBeUndefined()
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: true })
    expect((await refundDoc(a))?.reviewClosed).toBeUndefined()
    expect(holdAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_processed.hold_close_failed', registrationId: s.registrationId })])
    // the failure is QUEUED durably (that is why the webhook could answer 200) — and visible in health
    expect(await closureDoc(s.registrationId)).toMatchObject({ status: 'pending', attempts: 1, orderId: s.orderId, ptxId: `ptx_${s.registrationId}`, refundId: b })
    expect(h.alerts.some(x => x.scope === 'refundHoldClosureReconciliation.recorded')).toBe(true)
    const { getOperationsHealth } = await import('@/lib/operations/healthMetrics')
    const pending0 = (await getOperationsHealth()).financial.refundHoldClosuresPending
    expect(pending0).toBeGreaterThanOrEqual(1)
    // the cron retry while the cause persists: still pending, nothing closed, attempts counted
    const r1 = await L2.drain(500)
    expect(r1.stillPending).toBeGreaterThanOrEqual(1)
    expect(await closureDoc(s.registrationId)).toMatchObject({ status: 'pending', attempts: 2 })
    expect((await ptxDoc(s.registrationId)).releaseHold).toBeTruthy()
    await blocker.delete()
    // two concurrent cron runs: exactly one closure (one audit row); the record resolves; health drops
    await Promise.all([L2.drain(500), L2.drain(500)])
    expect(await holdAudits(s.registrationId)).toHaveLength(1)
    expect(await closureDoc(s.registrationId)).toMatchObject({ status: 'resolved' })
    expect(['closed', 'no_hold']).toContain((await closureDoc(s.registrationId))!.outcome)
    expect(await ptxDoc(s.registrationId)).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })
    expect((await ptxDoc(s.registrationId)).releaseHold).toBeUndefined()
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: false })
    expect((await getOperationsHealth()).financial.refundHoldClosuresPending).toBe(pending0 - 1)
    // a direct repeat changes nothing
    expect(await closeRefundHoldAfterFullRefund({ orderId: s.orderId, registrationId: s.registrationId })).toEqual({ closed: false, why: 'no_hold' })
    await walletClean()
  }, T)

  it('M1 · the closure failed AND its retry record could not be written ⇒ 500; the redelivery retries ONLY the closure (no second debit, refund or side effect)', async () => {
    await seedEvent(100)
    const s = await paidRegistration('m1redeliver@finfix.test')
    const a = `rfnd_m1rd_a_${P}`, b = `rfnd_m1rd_b_${P}`
    await refundHook('refund.processed', { id: a, pay: s.pay, amount: 20_000 })
    const blocker = db.doc(`adminAuditLogs/settlement_hold_ptx_${s.registrationId}_full_refund_${b}`)
    await blocker.set({ action: 'blocker', entityId: 'none' })
    const origCol = db.collection.bind(db)
    vi.spyOn(db, 'collection').mockImplementation(((name: string) => name === 'refundHoldClosureReconciliation'
      ? { doc: () => ({ set: async () => { throw new Error('simulated queue write failure') } }) }
      : origCol(name)) as never)
    h.alerts.length = 0
    const refundCalls = h.refundCalls
    expect((await refundHook('refund.processed', { id: b, pay: s.pay, amount: 30_000 })).status).toBe(500)
    vi.restoreAllMocks()
    expect(h.alerts.some(x => x.scope === 'refundHoldClosureReconciliation.persist_failed')).toBe(true)
    expect(await regDoc(s.registrationId)).toMatchObject({ paymentStatus: 'refunded', refundId: b })   // the refund itself was applied
    expect(await ptxDoc(s.registrationId)).toMatchObject({ status: 'refunded', releaseStatus: 'held' })
    expect(await closureDoc(s.registrationId)).toBeUndefined()
    const reversedOnce = (await refundDoc(b))!
    expect(reversedOnce).toMatchObject({ status: 'processed', ledgerReversed: true })
    await blocker.delete()
    expect((await refundHook('refund.processed', { id: b, pay: s.pay, amount: 30_000 })).status).toBe(200)   // Razorpay redelivers
    expect((await ptxDoc(s.registrationId)).releaseHold).toBeUndefined()
    expect(await holdAudits(s.registrationId)).toHaveLength(1)
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: false })
    expect((await refundDoc(b))?.ledgerReversedPaise).toEqual(reversedOnce.ledgerReversedPaise)
    expect(await intentDoc(s.orderId)).toMatchObject({ gatewayRefundsPaise: { [a]: 20_000, [b]: 30_000 }, gatewayRefundFullBy: b })
    expect(h.refundCalls).toBe(refundCalls)                                                     // never a gateway refund
    await walletClean()                                                                          // debited exactly once
  }, T)

  it('M1 · the retry queue never forces a closure: it WAITS while the settlement is not reversed, and a contradiction is REFUSED (alerted, hold kept)', async () => {
    await seedEvent(100)
    const { recordRefundHoldClosureRetry } = await import('@/lib/payments/registrationReconciliation')
    const w = await paidRegistration('m1wait@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_m1w_${P}`, pay: w.pay, amount: 20_000 })   // partial: held, NOT reversed
    expect(await recordRefundHoldClosureRetry({ registrationId: w.registrationId, orderId: w.orderId, refundId: `rfnd_m1w_${P}`, error: 'test' })).toBe(true)
    await L2.drain(500)
    expect(await closureDoc(w.registrationId)).toMatchObject({ status: 'pending', lastError: 'waiting: not_reversed' })
    expect(await ptxDoc(w.registrationId)).toMatchObject({ status: 'completed', releaseStatus: 'held' })

    const x = await paidRegistration('m1refuse@finfix.test')
    await refundHook('refund.processed', { id: `rfnd_m1r1_${P}`, pay: x.pay, amount: 40_000 })
    await refundHook('refund.processed', { id: `rfnd_m1r2_${P}`, pay: x.pay, amount: 20_000 })   // exceeds: a contradiction
    await refundHook('refund.processed', { id: `rfnd_m1r3_${P}`, pay: x.pay, amount: 10_000 })   // completes the charge
    expect(await recordRefundHoldClosureRetry({ registrationId: x.registrationId, orderId: x.orderId, refundId: `rfnd_m1r3_${P}`, error: 'test' })).toBe(true)
    h.alerts.length = 0
    await L2.drain(500)
    expect(await closureDoc(x.registrationId)).toMatchObject({ status: 'refused', outcome: 'contradictory_review' })
    expect(h.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'refundHoldClosureReconciliation.refused', why: 'contradictory_review' })]))
    expect(await ptxDoc(x.registrationId)).toMatchObject({ status: 'refunded', releaseStatus: 'held' })
    expect(await holdAudits(x.registrationId)).toHaveLength(0)
    await db.doc(`refundHoldClosureReconciliation/${w.registrationId}`).delete()   // leave no pending test record behind
    await walletClean()
  }, T)

  it('M1 · a NEW review reason on a closed record REOPENS it (reviewOpen) — a closure never hides a later contradiction', async () => {
    await seedEvent(100)
    const s = await paidRegistration('m1reopen@finfix.test')
    const a = `rfnd_m1ro_a_${P}`, b = `rfnd_m1ro_b_${P}`
    await refundHook('refund.processed', { id: a, pay: s.pay, amount: 20_000 })
    await refundHook('refund.processed', { id: b, pay: s.pay, amount: 30_000 })
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: false })
    await refundHook('refund.failed', { id: a, pay: s.pay, amount: 20_000 })               // the counted partial now FAILS
    const rec = (await refundDoc(a))!
    expect(rec.reviewOpen).toBe(true)
    expect(rec.reviewReasons).toContain('failed_after_counted')
    expect(rec.reviewClosed).toMatchObject({ by: 'system:full_refund' })                   // the earlier closure stays on record
  }, T)
})
