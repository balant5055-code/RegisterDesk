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
  captureFinancialError: () => undefined, captureError: () => undefined,
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
    await hook('refund.processed', { refund: { entity: { id: `rfnd_b6_${P}`, order_id: first.orderId, payment_id: p2.id, amount: PRICE } } })
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
    // a refund of the WRONG amount is not evidence: it stays pending
    await hook('refund.processed', { refund: { entity: { id: `rfnd_p13_bad_${P}`, order_id: s.orderId, payment_id: s.pay.id, amount: 100 } } })
    expect((await db.doc(`registrations/${s.registrationId}`).get()).get('paymentStatus')).toBe('refund_pending')
    // the real one finishes it
    const refundId = `rfnd_p13_${P}`
    for (let i = 0; i < 2; i++) await hook('refund.processed', { refund: { entity: { id: refundId, order_id: s.orderId, payment_id: s.pay.id, amount: PRICE } } })
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
})
