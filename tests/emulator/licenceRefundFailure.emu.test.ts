// M2 / M3 — licence refunds seen by the Razorpay refund webhook, on REAL Firestore.
//
//   M3  the EXPECTED echo of a licence refund RegisterDesk issued (activation order being refunded, same
//       payment, same amount, licence refunded, and the read-only gateway list shows exactly this refund)
//       raises NO financial alert. Every mismatch — amount, payment, currency, a non-activation order, an
//       order not being refunded, a second (double) refund, an unreadable gateway list — still alerts.
//   M2  a licence refund the gateway ACCEPTED and later reports FAILED is recorded as a durable, audited
//       manual-review state on the licence (evidence: confirmed_no_refund · refunded_elsewhere · partial ·
//       ambiguous). Nothing is retried, re-issued, reactivated or restored. Idempotent per refund id under
//       duplicate and concurrent delivery. A Super Admin acknowledges it (reason required, audited,
//       all-or-nothing, exactly once under concurrency).
// Razorpay is an in-memory stub — no request leaves the process; the refund stub only ever runs inside
// the in-app licence refund that sets up each case, and its call count is pinned afterwards.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const SUPER = `lrf-super-${P}`
const ADMIN = `lrf-admin-${P}`
const WHSEC = 'lrf_webhook_secret'
const PASS = 'pass-a'
const AMOUNT = 17_700

const h = vi.hoisted(() => ({
  /** What Razorpay "holds": every refund, per payment, with its gateway status. */
  refunds: [] as Array<{ id: string; paymentId: string; amount: number; status: string }>,
  /** fetchMultipleRefund: 'real' (the list above) | 'throw' (the lookup fails). */
  lookup: 'real' as 'real' | 'throw',
  refundCalls: 0,
  admin: '' as string,
  alerts: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_lrf', RAZORPAY_KEY_SECRET: 'lrf',
  razorpay: {
    orders: { fetchPayments: async () => ({ items: [] }) },
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        h.refundCalls++
        const r = { id: `rfnd_lrf_${P}_${h.refundCalls}`, paymentId, amount: o.amount, status: 'processed' }
        h.refunds.push(r)
        return { id: r.id, amount: r.amount, status: r.status }
      },
      fetchMultipleRefund: async (paymentId: string) => {
        if (h.lookup === 'throw') throw new Error('lookup unavailable')
        const items = h.refunds.filter(r => r.paymentId === paymentId).map(r => ({ id: r.id, amount: r.amount, status: r.status }))
        return { entity: 'collection', count: items.length, items }
      },
    },
  },
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0 }) }))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.admin || null),
  legacyAdminClaimOnly: async () => false,
  resolveSuperAdminUid: async () => (h.admin === SUPER ? h.admin : null),
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (e: unknown, ctx?: Record<string, unknown>) => { h.alerts.push({ message: e instanceof Error ? e.message : String(e), ...(ctx ?? {}) }) },
  captureError: () => {}, captureWebhookError: () => {}, flushMonitoring: async () => {},
}))

describeEmu('M2 / M3 · licence refund webhook: expected echoes, failures after acceptance, Super Admin acknowledgement', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let svc: typeof import('@/lib/admin/licenseAdminService')
  let regs: typeof import('@/lib/firebase/firestore/registrations')
  let webhook: (r: NextRequest) => Promise<Response>
  let licenceRoute: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let health: typeof import('@/lib/operations/healthMetrics').getOperationsHealth
  const paths = new Set<string>()
  const slugs = new Set<string>()
  const drafts = new Set<string>()
  let n = 0

  const put = async (path: string, data: Record<string, unknown>) => { paths.add(path); await adminDb.doc(path).set(data) }
  const get = async (path: string) => (await adminDb.doc(path).get()).data()
  const act = (slug: string, body: Record<string, unknown>) =>
    svc.applyLicenseAction(slug, { reason: 'test reason', ...body } as never, SUPER, { actorRole: 'super_admin' })
  const history = async (slug: string, action: string) =>
    (await adminDb.collection('licenseHistory').where('eventId', '==', slug).where('action', '==', action).get()).docs
  const audits = async (slug: string, action: string) =>
    (await adminDb.collection('adminAuditLogs').where('entityId', '==', slug).where('action', '==', action).get()).docs
  const licenceAlerts = () => h.alerts.filter(a => /^razorpay\.refund_(processed|failed)\.(licence|non_registration)$/.test(String(a.scope ?? '')))

  /** A published capacity-licence event, its activation order paid through Razorpay order `rzpOrder`. */
  async function event(o: { orderPrefix?: string; status?: string } = {}) {
    const k = ++n
    const uid = `lrf-org-${k}-${P}`, d = `lrf-d${k}-${P}`, slug = `lrf-ev${k}-${P}`
    const orderId = `${o.orderPrefix ?? 'lic'}_${d}`, paymentId = `pay_lrf_${k}_${P}`, rzpOrder = `order_lrf_${k}_${P}`
    slugs.add(slug); drafts.add(d)
    await put(`events/${slug}`, {
      slug, uid, draftId: d, lifecycleStatus: 'published', totalCapacity: 250, capacityPlan: 'custom',
      eventDetails: { info: { name: 'LRF Event' }, schedule: { startDate: '2099-01-01', endDate: '2099-01-02', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata' } },
      pricing: { eventType: 'paid', passes: [{ id: PASS, name: 'Pass A', price: 100, status: 'active', unlimited: true, quantity: null }] },
      registrationForm: { sections: [], conditionalRules: [], registrationRules: {} },
      accessControl: { type: 'public', confirmationMode: 'auto' },
    })
    await put(`registrationCounters/${slug}`, { eventSlug: slug, totalCount: 0, passCounts: { [PASS]: 0 }, revenuePaise: 0, statsVersion: 3 })
    await put(`eventLicenses/${slug}`, { eventId: slug, organizerUid: uid, orderId, commercialModel: 'capacity', capacity: 250, tier: 'free', version: 2, status: 'active', createdAt: FS.Timestamp.now() })
    const item = { service: 'whatsapp', quantity: 10, unitPricePaise: 100, basePaise: 1000, gstRatePercent: 18, gstPaise: 180, totalPaise: 1180, onExhausted: 'block' }
    await put(`licenseOrders/${orderId}`, {
      orderId, eventId: d, organizerUid: uid, status: o.status ?? 'paid', amountPaise: AMOUNT, razorpayPaymentId: paymentId, razorpayOrderId: rzpOrder,
      purpose: 'purchase', commercialModel: 'capacity', serviceItems: [item],
      capacityChange: { operation: 'activation', capacity: 250, previousCapacity: null, freeCapacity: 100, chargeableCapacity: 150, totalPaise: AMOUNT },
    })
    await put(`eventServiceAllowances/${d}`, { draftId: d, organizerUid: uid, appliedOrders: { [orderId]: true }, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    return { uid, d, slug, orderId, paymentId, rzpOrder }
  }
  /** An event whose licence was refunded IN-APP (the gateway ACCEPTED the refund). */
  async function refundedEvent() {
    const e = await event()
    await act(e.slug, { action: 'refund' })
    const refund = h.refunds.find(r => r.paymentId === e.paymentId)!
    expect(refund).toBeTruthy()
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    return { ...e, refundId: refund.id }
  }
  const register = (slug: string, uid: string, i: number) => regs.createRegistration({
    eventSlug: slug, passId: PASS, passName: 'Pass A', passCapacity: null, eventName: 'LRF Event', organizerUid: uid,
    attendee: { name: `A${i}`, email: `lrf-${slug}-${i}@example.com` },
  } as never)

  /** The documented Razorpay refund webhook payload: the order is on payload.payment.entity. */
  function refundHook(event: 'refund.processed' | 'refund.failed', o: { id: string; paymentId: string; rzpOrder: string; amount: number; currency?: string }) {
    const body = JSON.stringify({ event, payload: {
      refund: { entity: {
        id: o.id, entity: 'refund', amount: o.amount, currency: o.currency ?? 'INR', payment_id: o.paymentId, notes: {}, receipt: null,
        acquirer_data: {}, created_at: 0, batch_id: null, status: event === 'refund.failed' ? 'failed' : 'processed', speed_processed: 'normal', speed_requested: 'optimum',
      } },
      payment: { entity: {
        id: o.paymentId, entity: 'payment', amount: AMOUNT, currency: 'INR', status: 'captured', order_id: o.rzpOrder,
        amount_refunded: event === 'refund.failed' ? 0 : o.amount, refund_status: event === 'refund.failed' ? null : 'full',
      } },
    } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  const ackReq = (slug: string, body: Record<string, unknown>) => licenceRoute(
    new NextRequest(`http://x/api/admin/licenses/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ eventId: slug }) },
  )
  /** The licence fields a failure / acknowledgement must never touch (lifecycle, capacity, refund facts). */
  const licenceCore = async (slug: string) => {
    const core = { ...(await get(`eventLicenses/${slug}`))! }
    delete core.refundFailure; delete core.updatedAt
    return core
  }
  /** Fails every audit-row write inside transactions (stageAdminAudit uses tx.create on adminAuditLogs). */
  function failAuditWrites() {
    const orig = adminDb.runTransaction.bind(adminDb)
    vi.spyOn(adminDb, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const create = tx.create.bind(tx)
        ;(tx as unknown as { create: unknown }).create = (ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) => {
          if (ref.parent.id === 'adminAuditLogs') throw new Error('simulated audit write failure')
          return create(ref, data)
        }
        return fn(tx)
      }, opts)) as never)
  }

  async function wipe() {
    for (const p of paths) await adminDb.doc(p).delete().catch(() => null)
    for (const slug of slugs) {
      for (const [col, field] of [['licenseHistory', 'eventId'], ['adminAuditLogs', 'entityId'], ['adminAuditFailures', 'entityId'], ['registrations', 'eventSlug']] as const) {
        for (const x of (await adminDb.collection(col).where(field, '==', slug).get()).docs) await x.ref.delete()
      }
      for (const col of ['registrationClaims', 'ticketCodeClaims', 'freeRegIdempotencyKeys']) {
        for (const x of (await adminDb.collection(col).where('eventSlug', '==', slug).get()).docs) await x.ref.delete()
      }
    }
    for (const d of drafts) await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${d}`)).catch(() => null)
    paths.clear(); slugs.clear(); drafts.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    svc = await import('@/lib/admin/licenseAdminService')
    regs = await import('@/lib/firebase/firestore/registrations')
    ;({ POST: webhook } = await import('@/app/api/webhooks/razorpay/route'))
    ;({ POST: licenceRoute } = await import('@/app/api/admin/licenses/[eventId]/route'))
    ;({ getOperationsHealth: health } = await import('@/lib/operations/healthMetrics'))
  }, T)
  beforeEach(async () => {
    h.refunds.length = 0; h.lookup = 'real'; h.refundCalls = 0; h.admin = ''; h.alerts.length = 0
    vi.restoreAllMocks()
    await wipe()
  }, T)
  afterAll(wipe, T)

  // ═══ M3 · an expected licence refund echo is not a financial error ══════════════════════════════════
  it('M3 · the echo of an in-app licence refund (and its redelivery) raises NO alert and changes nothing', async () => {
    const e = await refundedEvent()
    const before = await licenceCore(e.slug)
    h.alerts.length = 0
    for (let i = 0; i < 2; i++) {
      expect((await refundHook('refund.processed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })).status).toBe(200)
    }
    expect(licenceAlerts()).toEqual([])
    expect(await licenceCore(e.slug)).toEqual(before)
    expect((await adminDb.doc(`registrationRefunds/${e.refundId}`).get()).exists).toBe(false)   // never a registration refund
    expect(h.refundCalls).toBe(1)                                                                // only the in-app refund itself
  }, T)

  it('M3 · genuine anomalies STILL alert: wrong amount, other payment, currency, a second (double) refund, unreadable gateway, order not refunding, non-activation order, top-up', async () => {
    const e = await refundedEvent()
    const hook = (o: Partial<{ id: string; paymentId: string; amount: number; currency: string }>) =>
      refundHook('refund.processed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT, ...o })
    const expectAlert = (why: string) => {
      expect(licenceAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_processed.non_registration', purpose: 'license', licenceMismatch: why })])
      h.alerts.length = 0
    }
    h.alerts.length = 0
    await hook({ amount: 100 });                                        expectAlert('amount_mismatch')
    await hook({ paymentId: `pay_lrf_other_${P}` });                    expectAlert('payment_mismatch')
    await hook({ currency: 'USD' });                                    expectAlert('currency_mismatch')
    // a SECOND refund of the same payment for the same amount: the gateway list shows double money out
    h.refunds.push({ id: `rfnd_lrf_double_${P}`, paymentId: e.paymentId, amount: AMOUNT, status: 'processed' })
    await hook({ id: `rfnd_lrf_double_${P}` });                         expectAlert('gateway_mismatch')
    await hook({});                                                     expectAlert('gateway_mismatch')   // even the original, now
    h.refunds.pop()
    h.lookup = 'throw'
    await hook({});                                                     expectAlert('gateway_unverified')
    h.lookup = 'real'
    await hook({});                                                     expect(licenceAlerts()).toEqual([])  // consistent again

    const paid = await event()                                         // never refunded in-app
    h.refunds.push({ id: `rfnd_lrf_manual_${P}`, paymentId: paid.paymentId, amount: AMOUNT, status: 'processed' })
    await refundHook('refund.processed', { id: `rfnd_lrf_manual_${P}`, paymentId: paid.paymentId, rzpOrder: paid.rzpOrder, amount: AMOUNT })
    expectAlert('order_not_refunding')

    const cap = await event({ orderPrefix: 'cap', status: 'refunded' })  // a capacity order is never refunded in-app
    h.refunds.push({ id: `rfnd_lrf_cap_${P}`, paymentId: cap.paymentId, amount: AMOUNT, status: 'processed' })
    await refundHook('refund.processed', { id: `rfnd_lrf_cap_${P}`, paymentId: cap.paymentId, rzpOrder: cap.rzpOrder, amount: AMOUNT })
    expectAlert('not_activation_order')

    const topup = `order_lrf_topup_${P}`
    await put(`walletTopups/${topup}`, { status: 'credited' })
    await refundHook('refund.processed', { id: `rfnd_lrf_top_${P}`, paymentId: `pay_lrf_top_${P}`, rzpOrder: topup, amount: 500 })
    expect(licenceAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_processed.non_registration', purpose: 'wallet_topup' })])
    expect(h.refundCalls).toBe(1)
  }, T)

  // ═══ M2 · a licence refund the gateway accepted, then reported FAILED ═══════════════════════════════
  it('M2 · confirmed failure: recorded once (history + audit + alert), licence stays refunded and blocked, nothing retried or restored; duplicates change nothing; health counts it', async () => {
    const e = await refundedEvent()
    const before = await licenceCore(e.slug)
    const orderBefore = (await get(`licenseOrders/${e.orderId}`))!
    const unitsBefore = (await get(`eventServiceAllowances/${e.d}`))!.whatsapp
    const h0 = (await health()).financial.licenceRefundFailuresOpen
    h.refunds.find(r => r.id === e.refundId)!.status = 'failed'          // the gateway now reports it FAILED
    h.alerts.length = 0

    for (let i = 0; i < 2; i++) {
      expect((await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })).status).toBe(200)
    }
    const lic = (await get(`eventLicenses/${e.slug}`))!
    expect(lic.refundFailure).toMatchObject({
      status: 'open', refundIds: [e.refundId], orderId: e.orderId, paymentId: e.paymentId, amountPaise: AMOUNT, evidence: 'confirmed_no_refund',
    })
    expect(lic.refundFailure.firstAt).toBeTruthy()
    expect(await licenceCore(e.slug)).toEqual(before)                    // lifecycle, capacity, refundedAt untouched
    expect(await get(`licenseOrders/${e.orderId}`)).toEqual(orderBefore)  // order stays refunded
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp).toEqual(unitsBefore)
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
    expect(await history(e.slug, 'refund_failed_at_gateway')).toHaveLength(1)
    const audit = await audits(e.slug, 'license.refund_failed_at_gateway')
    expect(audit).toHaveLength(1)
    expect(audit[0].data()).toMatchObject({ actorRole: 'system', adminUid: 'system:razorpay_webhook', metadata: { refundId: e.refundId, evidence: 'confirmed_no_refund' } })
    expect(licenceAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_failed.licence', outcome: 'recorded', evidence: 'confirmed_no_refund', licence: e.slug })])
    expect((await health()).financial.licenceRefundFailuresOpen).toBe(h0 + 1)
    expect(h.refundCalls).toBe(1)                                         // never retried
  }, T)

  it('M2 · gateway evidence: ambiguous (lookup fails), partial, refunded_elsewhere — each recorded open, nothing concluded or restored', async () => {
    const cases: Array<[string, (e: { refundId: string; paymentId: string }) => void]> = [
      ['ambiguous', () => { h.lookup = 'throw' }],
      ['partial', e => { h.refunds.find(r => r.id === e.refundId)!.status = 'failed'; h.refunds.push({ id: `rfnd_lrf_p_${P}`, paymentId: e.paymentId, amount: 100, status: 'processed' }) }],
      ['refunded_elsewhere', () => { /* the gateway list still shows the full refund processed: contradictory */ }],
    ]
    for (const [evidence, setup] of cases) {
      h.lookup = 'real'
      const e = await refundedEvent()
      const before = await licenceCore(e.slug)
      setup(e)
      h.alerts.length = 0
      expect((await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })).status).toBe(200)
      expect((await get(`eventLicenses/${e.slug}`))!.refundFailure).toMatchObject({ status: 'open', evidence, refundIds: [e.refundId] })
      expect(await licenceCore(e.slug)).toEqual(before)
      expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
      expect(licenceAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_failed.licence', outcome: 'recorded', evidence })])
    }
    expect(h.refundCalls).toBe(3)                                         // one in-app refund per case, nothing more
  }, T)

  it('M2 · concurrent deliveries of one failure record it exactly once; a failure that does not match the in-app refund is NOT recorded but alerted', async () => {
    const e = await refundedEvent()
    h.refunds.find(r => r.id === e.refundId)!.status = 'failed'
    h.alerts.length = 0
    const rs = await Promise.all([0, 1, 2].map(() => refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })))
    expect(rs.map(r => r.status)).toEqual([200, 200, 200])
    expect(await history(e.slug, 'refund_failed_at_gateway')).toHaveLength(1)
    expect(await audits(e.slug, 'license.refund_failed_at_gateway')).toHaveLength(1)
    expect(licenceAlerts().filter(a => a.outcome === 'recorded')).toHaveLength(1)
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure.refundIds).toEqual([e.refundId])

    const f = await refundedEvent()
    h.alerts.length = 0
    await refundHook('refund.failed', { id: f.refundId, paymentId: f.paymentId, rzpOrder: f.rzpOrder, amount: 100 })   // not the refunded amount
    expect((await get(`eventLicenses/${f.slug}`))!.refundFailure).toBeUndefined()
    expect(await history(f.slug, 'refund_failed_at_gateway')).toHaveLength(0)
    expect(licenceAlerts()).toEqual([expect.objectContaining({ scope: 'razorpay.refund_failed.licence', outcome: 'not_applicable', why: 'amount_mismatch' })])
    expect(h.refundCalls).toBe(2)
  }, T)

  it('M2 · a failed audit write records NOTHING (500 → Razorpay redelivers); the redelivery records it once', async () => {
    const e = await refundedEvent()
    h.refunds.find(r => r.id === e.refundId)!.status = 'failed'
    failAuditWrites()
    expect((await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })).status).toBe(500)
    vi.restoreAllMocks()
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure).toBeUndefined()
    expect(await history(e.slug, 'refund_failed_at_gateway')).toHaveLength(0)
    expect((await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })).status).toBe(200)
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure).toMatchObject({ status: 'open', evidence: 'confirmed_no_refund' })
    expect(await history(e.slug, 'refund_failed_at_gateway')).toHaveLength(1)
    expect(await audits(e.slug, 'license.refund_failed_at_gateway')).toHaveLength(1)
    expect(h.refundCalls).toBe(1)
  }, T)

  // ═══ M2 · the Super Admin decision: acknowledgeRefundFailure ════════════════════════════════════════
  it('M2 · acknowledge: Super Admin only, reason required, audited; licence otherwise untouched; health drops; a second acknowledge is refused', async () => {
    const e = await refundedEvent()
    h.refunds.find(r => r.id === e.refundId)!.status = 'failed'
    await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })
    const before = await licenceCore(e.slug)
    const h0 = (await health()).financial.licenceRefundFailuresOpen

    h.admin = ''
    expect((await ackReq(e.slug, { action: 'acknowledgeRefundFailure', reason: 'decided offline' })).status).toBe(403)
    h.admin = ADMIN                                                       // an admin who is NOT a Super Admin
    const r403 = await ackReq(e.slug, { action: 'acknowledgeRefundFailure', reason: 'decided offline' })
    expect(r403.status).toBe(403)
    expect(await r403.json()).toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    h.admin = SUPER
    expect((await ackReq(e.slug, { action: 'acknowledgeRefundFailure' })).status).toBe(400)          // no reason
    expect((await ackReq(e.slug, { action: 'acknowledgeRefundFailure', reason: 'x' })).status).toBe(400)  // too short
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure.status).toBe('open')

    const ok = await ackReq(e.slug, { action: 'acknowledgeRefundFailure', reason: 'Organizer refunded by bank transfer' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ message: 'The failed refund was acknowledged. Nothing was refunded or restored.' })
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure).toMatchObject({
      status: 'acknowledged', acknowledgedBy: SUPER, acknowledgedReason: 'Organizer refunded by bank transfer', evidence: 'confirmed_no_refund', refundIds: [e.refundId],
    })
    expect(await licenceCore(e.slug)).toEqual(before)
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
    expect(await history(e.slug, 'refund_failure_acknowledged')).toHaveLength(1)
    expect((await audits(e.slug, 'license.refund_failure_acknowledged'))[0]?.data()).toMatchObject({ adminUid: SUPER, actorRole: 'super_admin' })
    expect((await health()).financial.licenceRefundFailuresOpen).toBe(h0 - 1)

    const again = await ackReq(e.slug, { action: 'acknowledgeRefundFailure', reason: 'second time' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'ALREADY_ACKNOWLEDGED' })
    // a duplicate delivery of the SAME failure after acknowledgement does not reopen it
    await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure.status).toBe('acknowledged')
    // a licence with no failure has nothing to acknowledge
    const clean = await event()
    await expect(act(clean.slug, { action: 'acknowledgeRefundFailure' })).rejects.toMatchObject({ status: 409 })
    expect(h.refundCalls).toBe(1)
  }, T)

  it('M2 · acknowledge is all-or-nothing with its audit row, and exactly once under concurrency', async () => {
    const e = await refundedEvent()
    h.refunds.find(r => r.id === e.refundId)!.status = 'failed'
    await refundHook('refund.failed', { id: e.refundId, paymentId: e.paymentId, rzpOrder: e.rzpOrder, amount: AMOUNT })
    failAuditWrites()
    await expect(act(e.slug, { action: 'acknowledgeRefundFailure' })).rejects.toThrow('simulated audit write failure')
    vi.restoreAllMocks()
    expect((await get(`eventLicenses/${e.slug}`))!.refundFailure.status).toBe('open')
    expect(await history(e.slug, 'refund_failure_acknowledged')).toHaveLength(0)

    const rs = await Promise.allSettled([0, 1, 2].map(() => act(e.slug, { action: 'acknowledgeRefundFailure' })))
    expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of rs.filter(x => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
    expect(await history(e.slug, 'refund_failure_acknowledged')).toHaveLength(1)
    expect(await audits(e.slug, 'license.refund_failure_acknowledged')).toHaveLength(1)
    expect(h.refundCalls).toBe(1)
  }, T)
})
