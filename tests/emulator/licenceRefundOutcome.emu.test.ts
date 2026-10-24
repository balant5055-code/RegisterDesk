// RD-SA-COMMERCE-P1 (final-review corrections P1-1 … P1-6) — licence refund OUTCOMES on REAL Firestore.
//
//   P1-1  a thrown / timed-out refund call never reverts or lifts holds by itself: the gateway is ASKED.
//         Razorpay shows the refund → the refund is finished; shows none → the claim is undone;
//         partial or no answer → everything stays held (phase `unknown`) for reconciliation.
//   P1-2  every step that ends a hold is an atomic transition on the attempt that owns it: the gateway
//         fence refuses a replaced hold (no money sent); a release needs the hold ≥ 15 min old AND a
//         verified gateway/wallet/finalization outcome; finalize is never a silent no-op.
//   P1-3  an order left `refunding` with NO hold (pre-hold code) is visible, and released or completed.
//   P1-4  `completeRefund` finishes a refund whose money moved, only after re-verifying it; idempotent.
//   P1-5  hold state: Event 360 health, the platform-wide hold list + counts, the stale-hold alert.
//   P1-6  a refused refund whose review transaction fails still leaves a durable audit record.
// Razorpay is an in-memory stub — no request leaves the process.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const SUPER = `lro-super-${P}`
const PASS = 'pass-a'
const MIN = 60_000

const h = vi.hoisted(() => ({
  /** Refunds Razorpay "holds", per payment. */
  refunds: [] as Array<{ paymentId: string; amount: number }>,
  /** 'ok' · 'fail' (a DEFINITE 400 rejection, nothing created) · 'lost' (created, then the call throws) ·
   *  'timeout' (no response; nothing created YET) · 'server' (a 5xx response; nothing created yet). */
  refundMode: 'ok' as 'ok' | 'fail' | 'lost' | 'timeout' | 'server',
  /** fetchMultipleRefund: 'real' (what was created) | 'throw' | 'partial' (an extra ₹1 refund only). */
  lookup: 'real' as 'real' | 'throw' | 'partial',
  gate: null as null | Promise<void>,
  refundCalls: 0,
  admin: '' as string,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_lro', RAZORPAY_KEY_SECRET: 'lro',
  razorpay: {
    orders: { fetchPayments: async () => ({ items: [] }) },
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        h.refundCalls++
        if (h.gate) await h.gate
        // The shapes the Razorpay SDK produces: an API error response is rethrown as { statusCode, error };
        // a timeout / network failure has no response at all.
        if (h.refundMode === 'fail') throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'simulated gateway rejection' } }
        if (h.refundMode === 'timeout') throw new Error('timeout of 0ms exceeded (simulated: no response)')
        if (h.refundMode === 'server') throw { statusCode: 502, error: { code: 'SERVER_ERROR', description: 'simulated gateway 502' } }
        h.refunds.push({ paymentId, amount: o.amount })
        if (h.refundMode === 'lost') throw new Error('simulated timeout after Razorpay accepted the refund')
        return { id: `rfnd_lro_${h.refunds.length}`, amount: o.amount, status: 'processed' }
      },
      fetchMultipleRefund: async (paymentId: string) => {
        if (h.lookup === 'throw') throw new Error('lookup unavailable')
        if (h.lookup === 'partial') return { entity: 'collection', count: 1, items: [{ id: 'rfnd_lro_p', amount: 100, status: 'processed' }] }
        const items = h.refunds.filter(r => r.paymentId === paymentId).map((r, i) => ({ id: `rfnd_lro_${i}`, amount: r.amount, status: 'processed' }))
        return { entity: 'collection', count: items.length, items }
      },
    },
  },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.admin === SUPER ? h.admin : null),
  legacyAdminClaimOnly: async () => false,
  resolveSuperAdminUid: async () => (h.admin === SUPER ? h.admin : null),
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {}, flushMonitoring: async () => {},
}))

describeEmu('RD-SA-COMMERCE-P1 · licence refund outcomes, hold transitions, recovery and visibility', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let svc: typeof import('@/lib/admin/licenseAdminService')
  let regs: typeof import('@/lib/firebase/firestore/registrations')
  const paths = new Set<string>()
  const slugs = new Set<string>()
  const drafts = new Set<string>()
  let n = 0

  const put = async (path: string, data: Record<string, unknown>) => { paths.add(path); await adminDb.doc(path).set(data) }
  const get = async (path: string) => (await adminDb.doc(path).get()).data()
  const act = (slug: string, body: Record<string, unknown>) =>
    svc.applyLicenseAction(slug, { reason: 'test reason', ...body } as never, SUPER, { actorRole: 'super_admin' })
  const ageHold = (slug: string, minutes = 20) =>
    adminDb.doc(`eventLicenses/${slug}`).update({ 'refundHold.at': FS.Timestamp.fromMillis(Date.now() - minutes * MIN) })
  const history = async (slug: string, action: string) =>
    (await adminDb.collection('licenseHistory').where('eventId', '==', slug).where('action', '==', action).get()).docs
  const audits = async (slug: string, action: string) =>
    (await adminDb.collection('adminAuditLogs').where('entityId', '==', slug).where('action', '==', action).get()).docs

  /** A published capacity-licence event: 250 seats = 100 free + 150 paid; 10 prepaid WhatsApp units. */
  async function event(o: { sold?: number } = {}) {
    const k = ++n
    const uid = `lro-org-${k}-${P}`, d = `lro-d${k}-${P}`, slug = `lro-ev${k}-${P}`, orderId = `lic_${d}`, paymentId = `pay_lro_${k}_${P}`
    slugs.add(slug); drafts.add(d)
    await put(`events/${slug}`, {
      slug, uid, draftId: d, lifecycleStatus: 'published', totalCapacity: 250, capacityPlan: 'custom',
      eventDetails: { info: { name: 'LRO Event' }, schedule: { startDate: '2099-01-01', endDate: '2099-01-02', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata' } },
      pricing: { eventType: 'paid', passes: [{ id: PASS, name: 'Pass A', price: 100, status: 'active', unlimited: true, quantity: null }] },
      registrationForm: { sections: [], conditionalRules: [], registrationRules: {} },
      accessControl: { type: 'public', confirmationMode: 'auto' },
    })
    await put(`registrationCounters/${slug}`, { eventSlug: slug, totalCount: o.sold ?? 0, passCounts: { [PASS]: o.sold ?? 0 }, revenuePaise: 0, statsVersion: 3 })
    await put(`eventLicenses/${slug}`, { eventId: slug, organizerUid: uid, orderId, commercialModel: 'capacity', capacity: 250, tier: 'free', version: 2, status: 'active', createdAt: FS.Timestamp.now() })
    const item = { service: 'whatsapp', quantity: 10, unitPricePaise: 100, basePaise: 1000, gstRatePercent: 18, gstPaise: 180, totalPaise: 1180, onExhausted: 'block' }
    await put(`licenseOrders/${orderId}`, {
      orderId, eventId: d, organizerUid: uid, status: 'paid', amountPaise: 17_700, razorpayPaymentId: paymentId,
      purpose: 'purchase', commercialModel: 'capacity', serviceItems: [item],
      capacityChange: { operation: 'activation', capacity: 250, previousCapacity: null, freeCapacity: 100, chargeableCapacity: 150, totalPaise: 17_700 },
    })
    await put(`eventServiceAllowances/${d}`, { draftId: d, organizerUid: uid, appliedOrders: { [orderId]: true }, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    return { uid, d, slug, orderId, paymentId }
  }
  const register = (slug: string, uid: string, i: number) => regs.createRegistration({
    eventSlug: slug, passId: PASS, passName: 'Pass A', passCapacity: null, eventName: 'LRO Event', organizerUid: uid,
    attendee: { name: `A${i}`, email: `lro-${slug}-${i}@example.com` },
  } as never)

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
  }, T)
  beforeEach(async () => {
    h.refunds.length = 0; h.refundMode = 'ok'; h.lookup = 'real'; h.gate = null; h.refundCalls = 0; h.admin = ''
    vi.restoreAllMocks()
    await wipe()
  }, T)
  afterAll(wipe, T)

  // ═══ P1-1 · the gateway outcome is established, never assumed ═════════════════════════════════════
  it('P1-1 · the call throws AFTER Razorpay refunded (lost response) → the refund is FINISHED, never reverted', async () => {
    const e = await event()
    h.refundMode = 'lost'
    const res = await act(e.slug, { action: 'refund' })
    expect(res.refund).toMatchObject({ gatewayRefunded: true, servicesRetired: { whatsapp: 10 }, capacityBefore: 250, capacityAfter: 100 })
    expect(res.reconciliation).toEqual(['gateway_error_but_refunded'])
    expect(h.refunds).toHaveLength(1)                                      // never a second refund
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    const lic = (await get(`eventLicenses/${e.slug}`))!
    expect(lic.refundedAt).toBeTruthy(); expect(lic.refundHold).toBeUndefined()
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
  }, T)

  it('P1-1 · the call throws and the lookup fails → NOTHING is released: order refunding, both holds kept, phase unknown, recorded', async () => {
    const e = await event()
    h.refundMode = 'fail'; h.lookup = 'throw'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 502, details: { code: 'REFUND_OUTCOME_UNKNOWN', gatewayOutcome: 'unknown' } })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')
    const lic = (await get(`eventLicenses/${e.slug}`))!
    expect(lic.refundHold).toMatchObject({ orderId: e.orderId, phase: 'unknown', gatewayOutcome: 'unknown' })
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toMatchObject({ orderId: e.orderId, units: { whatsapp: 10 } })
    expect(await history(e.slug, 'refund_outcome_unknown')).toHaveLength(1)
    expect(await audits(e.slug, 'license.refund_outcome_unknown')).toHaveLength(1)
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
    // Neither recovery acts while Razorpay cannot answer, and a release also waits for the 15 minutes.
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 503 })
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_HOLD_TOO_RECENT' } })
    await ageHold(e.slug)
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 503 })
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeTruthy()
    // Razorpay answers "none": completion refuses (no money moved), release succeeds — sales resume.
    h.lookup = 'real'
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'NO_REFUND_FOUND' } })
    await act(e.slug, { action: 'releaseRefundHold' })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeUndefined()
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toBeUndefined()
    await register(e.slug, e.uid, 2)
  }, T)

  it('P1-1 · a PARTIAL refund at the gateway is never concluded: held; completion and release both refuse', async () => {
    const e = await event()
    h.refundMode = 'fail'; h.lookup = 'partial'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 502, details: { code: 'REFUND_OUTCOME_UNKNOWN', gatewayOutcome: 'partial' } })
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ phase: 'unknown', gatewayOutcome: 'partial' })
    await ageHold(e.slug)
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'PARTIAL_REFUND_AT_GATEWAY' } })
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_FOUND_AT_GATEWAY' } })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')
  }, T)

  it('P1-1 · a CONFIRMED rejection (Razorpay shows no refund) undoes the claim at once', async () => {
    const e = await event()
    h.refundMode = 'fail'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 502 })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeUndefined()
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toBeUndefined()
    await register(e.slug, e.uid, 1)
  }, T)

  // ═══ P1-4 · completing a refund whose money moved ═══════════════════════════════════════════════════
  it('P1-4 · money moved but the outcome was unknown → completeRefund re-verifies, then finishes exactly once (audited)', async () => {
    const e = await event({ sold: 30 })
    h.refundMode = 'lost'; h.lookup = 'throw'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ details: { code: 'REFUND_OUTCOME_UNKNOWN' } })
    expect(h.refunds).toHaveLength(1)                                      // the money DID move
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')
    h.lookup = 'real'
    // A takeover within 15 minutes of the claim is refused only while the claim may still be running
    // (phase claimed / gateway); this hold is `unknown`, so completion may proceed once verified.
    const res = await act(e.slug, { action: 'completeRefund' })
    expect(res.refund).toMatchObject({ gatewayRefunded: true, servicesRetired: { whatsapp: 10 }, capacityBefore: 250, capacityAfter: 100 })
    expect(h.refunds).toHaveLength(1)                                      // completion moves no money
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    const lic = (await get(`eventLicenses/${e.slug}`))!
    expect(lic.refundedAt).toBeTruthy(); expect(lic.refundHold).toBeUndefined(); expect(lic.admin.lifecycle).toBe('cancelled')
    expect((await get(`events/${e.slug}`))!.totalCapacity).toBe(100)
    expect(await audits(e.slug, 'license.refund_completed')).toHaveLength(1)
    expect(await history(e.slug, 'refund_completed')).toHaveLength(1)
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409 })   // idempotent
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409 })
  }, T)

  it('P1-4 · completion refuses a hold whose claim is younger than 15 minutes and still in flight (claimed / gateway)', async () => {
    const e = await event()
    await adminDb.doc(`licenseOrders/${e.orderId}`).update({ status: 'refunding', refundClaimedFrom: 'paid' })
    await adminDb.doc(`eventLicenses/${e.slug}`).set({ refundHold: { at: FS.Timestamp.now(), by: SUPER, orderId: e.orderId, attemptId: 'a1', phase: 'gateway' } }, { merge: true })
    h.refunds.push({ paymentId: e.paymentId, amount: 17_700 })
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_HOLD_TOO_RECENT' } })
    await ageHold(e.slug)
    await act(e.slug, { action: 'completeRefund' })
    expect((await get(`eventLicenses/${e.slug}`))!.refundedAt).toBeTruthy()
  }, T)

  // ═══ P1-2 · atomic transitions on the owning attempt ════════════════════════════════════════════════
  it('P1-2 · the gateway FENCE: a hold replaced between claim and send ⇒ no money is sent, nothing is undone', async () => {
    const e = await event()
    const orig = adminDb.runTransaction.bind(adminDb)
    let calls = 0
    vi.spyOn(adminDb, 'runTransaction').mockImplementation((async (fn: never, opts?: never) => {
      calls++
      if (calls === 2) await adminDb.doc(`eventLicenses/${e.slug}`).update({ 'refundHold.attemptId': 'another-attempt' })
      return orig(fn, opts)
    }) as never)
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_HOLD_LOST' } })
    vi.restoreAllMocks()
    expect(h.refundCalls).toBe(0)
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ attemptId: 'another-attempt' })   // not ours: untouched
  }, T)

  it('P1-2 · a release forced during an in-flight refund (beyond any real request lifetime) cannot make finalize a silent no-op', async () => {
    const e = await event()
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    const running = act(e.slug, { action: 'refund' })
    // wait until the attempt is past its fence and inside the gateway call
    for (let i = 0; i < 200 && h.refundCalls === 0; i++) await new Promise(r => setTimeout(r, 25))
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ phase: 'gateway' })
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ details: { code: 'REFUND_HOLD_TOO_RECENT' } })
    await ageHold(e.slug)                                                  // simulate an impossible 20-minute request
    await act(e.slug, { action: 'releaseRefundHold' })                     // the gateway shows nothing yet
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
    open()
    const res = await running                                              // the refund then succeeds
    expect(res.reconciliation).toContain('order_status_changed_during_refund')
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')   // finalized, not skipped
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)   // units retired
    expect((await get(`eventLicenses/${e.slug}`))!.refundedAt).toBeTruthy()
  }, T)

  // ═══ P1-3 · legacy `refunding` orders ═══════════════════════════════════════════════════════════════
  it('P1-3 · an order left refunding with NO hold is visible, released only when old + gateway shows none', async () => {
    const e = await event()
    await adminDb.doc(`licenseOrders/${e.orderId}`).update({ status: 'refunding', updatedAt: FS.Timestamp.fromMillis(Date.now() - 2 * 3_600_000) })
    const st = (await svc.getLicenseDetail(e.slug))!.refundState!
    expect(st.hold).toBeNull()
    expect(st.legacyRefundingOrder).toMatchObject({ orderId: e.orderId })
    expect((await svc.getLicenseDetail(e.slug))!.row.paymentStatus).toBe('refunding')
    await act(e.slug, { action: 'releaseRefundHold' })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
    expect((await history(e.slug, 'refund_hold_released'))[0].data().note).toMatch(/Legacy/)
  }, T)

  it('P1-3 · a legacy refunding order whose money DID move is completed (not released)', async () => {
    const e = await event()
    await adminDb.doc(`licenseOrders/${e.orderId}`).update({ status: 'refunding', updatedAt: FS.Timestamp.fromMillis(Date.now() - 2 * 3_600_000) })
    h.refunds.push({ paymentId: e.paymentId, amount: 17_700 })
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ details: { code: 'REFUND_FOUND_AT_GATEWAY' } })
    await act(e.slug, { action: 'completeRefund' })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    expect((await get(`eventLicenses/${e.slug}`))!.refundedAt).toBeTruthy()
  }, T)

  // ═══ P1-5 · visibility ══════════════════════════════════════════════════════════════════════════════
  it('P1-5 · Event 360 health, the platform-wide hold list + counts and the stale-hold alert all show the hold', async () => {
    const e = await event()
    h.refundMode = 'fail'; h.lookup = 'throw'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ details: { code: 'REFUND_OUTCOME_UNKNOWN' } })
    h.admin = SUPER
    const { GET } = await import('@/app/api/admin/events/[slug]/360/route')
    const r = await GET(new NextRequest(`http://x/api/admin/events/${e.slug}/360`, { headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ slug: e.slug }) } as never)
    const body = await r.json() as { overview: { health: Array<{ key: string; level: string; detail: string }>; license: { refundState: { hold: { phase: string } } } } }
    expect(body.overview.health.find(x => x.key === 'license')).toMatchObject({ level: 'red', detail: 'Refund outcome unconfirmed — sales blocked' })
    expect(body.overview.health.find(x => x.key === 'payments')).toMatchObject({ level: 'yellow', detail: 'Refund in progress' })
    expect(body.overview.license.refundState.hold.phase).toBe('unknown')

    const list = await svc.listLicenses({ pageSize: 25, status: 'refund_hold' })
    expect(list.items.map(i => i.eventId)).toContain(e.slug)
    expect(list.nextCursor).toBeNull()
    const { getLicenseCenterOverview } = await import('@/lib/admin/licenseCenterService')
    const ov = await getLicenseCenterOverview()
    expect(ov.licenses.refundHold).toBeGreaterThanOrEqual(1)
    expect(ov.licenses.refundingOrders).toBeGreaterThanOrEqual(1)
    expect(ov.health.find(x => x.key === 'refund_holds')).toMatchObject({ level: 'red' })

    const ops = await import('@/lib/operations/healthMetrics')
    expect(ops.evaluateAlerts(await ops.getOperationsHealth()).some(a => a.id === 'licence_refund_holds_stale')).toBe(false)   // < 15 min
    await ageHold(e.slug)
    const health = await ops.getOperationsHealth()
    expect(health.financial.licenceRefundHoldsStale).toBeGreaterThanOrEqual(1)
    expect(ops.evaluateAlerts(health).find(a => a.id === 'licence_refund_holds_stale')).toMatchObject({ severity: 'critical' })
  }, T)

  // ═══ P1-6 · a refused refund always leaves a durable record ════════════════════════════════════════
  it('P1-6 · the review transaction fails ⇒ the refusal is still recorded (audit row), and the caller still gets 409', async () => {
    const e = await event({ sold: 200 })                                  // seats in use → review required
    const orig = adminDb.runTransaction.bind(adminDb)
    let calls = 0
    vi.spyOn(adminDb, 'runTransaction').mockImplementation((async (fn: never, opts?: never) => {
      calls++
      if (calls === 2) throw new Error('simulated review-record failure')
      return orig(fn, opts)
    }) as never)
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_REVIEW_REQUIRED' } })
    vi.restoreAllMocks()
    expect((await get(`eventLicenses/${e.slug}`))!.refundReview).toBeUndefined()
    const a = await audits(e.slug, 'license.refund_review_required')
    expect(a).toHaveLength(1)
    expect(a[0].data().metadata).toMatchObject({ reviewRecordFailed: true, conflicts: ['SEATS_IN_USE'] })
    expect(h.refundCalls).toBe(0)
  }, T)
  // ═══ H1 · an ambiguous failure is never concluded from an immediate lookup ══════════════════════════
  it('H1 · timeout (no response) + immediate lookup "none" + the refund appears LATER ⇒ held throughout; resolved only by a verified Complete refund — no second refund', async () => {
    const e = await event()
    h.refundMode = 'timeout'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 502, details: { code: 'REFUND_OUTCOME_UNKNOWN', gatewayOutcome: 'none', ambiguousError: true } })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ phase: 'unknown', gatewayOutcome: 'none_after_ambiguous_error' })
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toMatchObject({ orderId: e.orderId })
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })   // sales stay blocked
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ details: { code: 'REFUND_HOLD_TOO_RECENT' } })
    // …Razorpay processes the request after all.
    h.refunds.push({ paymentId: e.paymentId, amount: 17_700 })
    await ageHold(e.slug)
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ details: { code: 'REFUND_FOUND_AT_GATEWAY' } })
    await act(e.slug, { action: 'completeRefund' })
    expect(h.refundCalls).toBe(1)                                          // never a second refund
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    expect((await get(`eventLicenses/${e.slug}`))!.refundedAt).toBeTruthy()
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)
  }, T)

  it('H1 · a 5xx response is not a rejection: held even though the lookup shows none', async () => {
    const e = await event()
    h.refundMode = 'server'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 502, details: { code: 'REFUND_OUTCOME_UNKNOWN', ambiguousError: true } })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ phase: 'unknown' })
  }, T)

  it('H1 · a stale attempt cannot release another attempt\'s holds (its definite rejection writes nothing)', async () => {
    const e = await event()
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    h.refundMode = 'fail'
    const running = act(e.slug, { action: 'refund' })
    for (let i = 0; i < 200 && h.refundCalls === 0; i++) await new Promise(r => setTimeout(r, 25))
    await adminDb.doc(`eventLicenses/${e.slug}`).update({ 'refundHold.attemptId': 'another-attempt' })   // a newer owner
    open()
    await expect(running).rejects.toMatchObject({ status: 502 })
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ attemptId: 'another-attempt' })
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toMatchObject({ orderId: e.orderId })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')   // not reverted by the stale attempt
  }, T)

  // ═══ H2 · recovery after an interrupted finalization ════════════════════════════════════════════════
  const COUPON = `LRO${P}`
  /** Gateway refund succeeds, finalize FAILS, the licence cancel succeeds → the interrupted state. */
  async function interruptedRefund(): Promise<Awaited<ReturnType<typeof event>>> {
    const e = await event()
    await adminDb.doc(`licenseOrders/${e.orderId}`).update({ couponCode: COUPON })
    await put(`licenseCoupons/${COUPON}/organizerRedemptions/${e.uid}`, { count: 1 })
    const orig = adminDb.runTransaction.bind(adminDb)
    let calls = 0
    vi.spyOn(adminDb, 'runTransaction').mockImplementation((async (fn: never, opts?: never) => {
      calls++
      if (calls === 3) throw new Error('simulated finalize failure')   // claim(1) · fence(2) · finalize(3)
      return orig(fn, opts)
    }) as never)
    const res = await act(e.slug, { action: 'refund' })
    vi.restoreAllMocks()
    expect(res.reconciliation).toContain('order_finalize_failed')
    return e
  }
  const couponCount = async (uid: string) => (await get(`licenseCoupons/${COUPON}/organizerRedemptions/${uid}`))?.count

  it('H2 · gateway refunded + licence cancelled + finalize failed ⇒ held (reconcile), never releasable; Complete refund finishes it once', async () => {
    const e = await interruptedRefund()
    expect(h.refunds).toHaveLength(1)
    const lic = (await get(`eventLicenses/${e.slug}`))!
    expect(lic.refundedAt).toBeTruthy()
    expect(lic.refundHold).toMatchObject({ phase: 'reconcile', orderId: e.orderId })   // still visible / alerting
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunding')
    expect((await get(`eventServiceAllowances/${e.d}`))!).toMatchObject({ refundHold: { orderId: e.orderId }, whatsapp: { purchased: 10 } })
    expect(await couponCount(e.uid)).toBe(1)
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
    await ageHold(e.slug)
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_FINALIZE_PENDING' } })

    const res = await act(e.slug, { action: 'completeRefund' })
    expect(res.refund).toMatchObject({ servicesRetired: { whatsapp: 10 } })
    expect(h.refundCalls).toBe(1)                                          // reconciliation only — no money moved
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('refunded')
    const lg = (await get(`eventServiceAllowances/${e.d}`))!
    expect(lg.refundHold).toBeUndefined(); expect(lg.whatsapp.purchased).toBe(0)
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeUndefined()
    expect(await couponCount(e.uid)).toBe(0)                               // released exactly once
    const a = await audits(e.slug, 'license.refund_completed')
    expect(a).toHaveLength(1); expect(a[0].data().metadata).toMatchObject({ finalizationRecovered: true })
    // Repeated recovery: refused, nothing changes again.
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_ALREADY_COMPLETE' } })
    expect(await couponCount(e.uid)).toBe(0)
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)
  }, T)

  it('H2 · two concurrent Complete refund requests ⇒ exactly one finalizes; coupon and units change once', async () => {
    const e = await interruptedRefund()
    const results = await Promise.allSettled([act(e.slug, { action: 'completeRefund' }), act(e.slug, { action: 'completeRefund' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rej = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(rej.reason).toMatchObject({ status: 409 })
    expect(await couponCount(e.uid)).toBe(0)
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)
    expect(await audits(e.slug, 'license.refund_completed')).toHaveLength(1)
    expect(h.refundCalls).toBe(1)
  }, T)

  it('H2 · partial / unreadable / missing gateway refund on the interrupted state ⇒ refused, every protection kept', async () => {
    const e = await interruptedRefund()
    const snapshot = async () => ({
      order: (await get(`licenseOrders/${e.orderId}`))!.status,
      hold: (await get(`eventLicenses/${e.slug}`))!.refundHold?.phase,
      ledgerHold: !!(await get(`eventServiceAllowances/${e.d}`))!.refundHold,
      coupon: await couponCount(e.uid),
    })
    const before = await snapshot()
    h.lookup = 'partial'
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'PARTIAL_REFUND_AT_GATEWAY' } })
    h.lookup = 'throw'
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 503 })
    h.lookup = 'real'; h.refunds.length = 0                                // contradictory: refunded licence, no refund anywhere
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_STATE_CONTRADICTORY' } })
    expect(await snapshot()).toEqual(before)
    expect(before).toEqual({ order: 'refunding', hold: 'reconcile', ledgerHold: true, coupon: 1 })
  }, T)

  it('H2 · order already refunded but its units still on the ledger hold ⇒ only the ledger step runs (coupon not touched again)', async () => {
    const e = await event()
    await adminDb.doc(`licenseOrders/${e.orderId}`).update({ status: 'refunded', refundClaimedFrom: 'paid', couponCode: COUPON })
    await put(`licenseCoupons/${COUPON}/organizerRedemptions/${e.uid}`, { count: 1 })   // another use — must stay
    await adminDb.doc(`eventLicenses/${e.slug}`).set({ refundedAt: FS.Timestamp.now(), admin: { lifecycle: 'cancelled' } }, { merge: true })
    await adminDb.doc(`eventServiceAllowances/${e.d}`).set({ refundHold: { orderId: e.orderId, units: { whatsapp: 10 } } }, { merge: true })
    h.refunds.push({ paymentId: e.paymentId, amount: 17_700 })
    await act(e.slug, { action: 'completeRefund' })
    const lg = (await get(`eventServiceAllowances/${e.d}`))!
    expect(lg.refundHold).toBeUndefined(); expect(lg.whatsapp.purchased).toBe(0); expect(lg.refundedOrders[e.orderId]).toBe(true)
    expect((await get(`licenseOrders/${e.orderId}`))!).toMatchObject({ status: 'refunded', servicesRetiredOnRefund: { whatsapp: 10 } })
    expect(await couponCount(e.uid)).toBe(1)
    expect(h.refundCalls).toBe(0)
  }, T)

  it('H2 · contradictory: licence refunded but its order still PAID ⇒ refused for review; a fully finished refund ⇒ nothing to do', async () => {
    const e = await event()
    await adminDb.doc(`eventLicenses/${e.slug}`).set({ refundedAt: FS.Timestamp.now(), refundHold: { orderId: e.orderId, phase: 'reconcile' } }, { merge: true })
    h.refunds.push({ paymentId: e.paymentId, amount: 17_700 })
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_STATE_CONTRADICTORY' } })
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
    const f = await event()
    await act(f.slug, { action: 'refund' })                               // a normal, complete refund
    await expect(act(f.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_ALREADY_COMPLETE' } })
  }, T)

  it('H2 · the recovery\'s closing record fails ⇒ 500, nothing reported as success, hold kept; a later retry completes without repeating side effects', async () => {
    const e = await interruptedRefund()
    const orig = adminDb.runTransaction.bind(adminDb)
    let calls = 0
    vi.spyOn(adminDb, 'runTransaction').mockImplementation((async (fn: never, opts?: never) => {
      calls++
      if (calls === 3) throw new Error('simulated record failure')     // takeover(1) · finalize(2) · record(3)
      return orig(fn, opts)
    }) as never)
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ status: 500, details: { code: 'REFUND_RECOVERY_FAILED', stage: 'record' } })
    vi.restoreAllMocks()
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toMatchObject({ phase: 'completing' })   // not released
    expect((await audits(e.slug, 'license.refund_audit_recovered')).some(d => d.data().metadata?.recoveryFailed === true)).toBe(true)
    expect(await couponCount(e.uid)).toBe(0)                               // finalize did commit (once)
    await expect(act(e.slug, { action: 'completeRefund' })).rejects.toMatchObject({ details: { code: 'REFUND_COMPLETION_IN_PROGRESS' } })
    await adminDb.doc(`eventLicenses/${e.slug}`).update({ 'refundHold.completingAt': FS.Timestamp.fromMillis(Date.now() - 20 * MIN) })
    await act(e.slug, { action: 'completeRefund' })
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeUndefined()
    expect(await couponCount(e.uid)).toBe(0)
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)
    expect(await audits(e.slug, 'license.refund_completed')).toHaveLength(1)
  }, T)

  // ═══ concurrency ════════════════════════════════════════════════════════════════════════════════════
  it('concurrency · two administrators release the same verified hold at once ⇒ exactly one release', async () => {
    const e = await event()
    h.refundMode = 'fail'; h.lookup = 'throw'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ details: { code: 'REFUND_OUTCOME_UNKNOWN' } })
    await ageHold(e.slug)
    h.lookup = 'real'
    const results = await Promise.allSettled([act(e.slug, { action: 'releaseRefundHold' }), act(e.slug, { action: 'releaseRefundHold' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
    expect(await history(e.slug, 'refund_hold_released')).toHaveLength(1)
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
  }, T)
  it('concurrency · two Complete refund requests on a NOT-yet-refunded licence (outcome unknown, money moved) ⇒ exactly one completes', async () => {
    const e = await event()
    h.refundMode = 'lost'; h.lookup = 'throw'
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ details: { code: 'REFUND_OUTCOME_UNKNOWN' } })
    h.lookup = 'real'
    const results = await Promise.allSettled([act(e.slug, { action: 'completeRefund' }), act(e.slug, { action: 'completeRefund' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
    expect(await audits(e.slug, 'license.refund_completed')).toHaveLength(1)
    expect((await get(`eventServiceAllowances/${e.d}`))!.whatsapp.purchased).toBe(0)
    expect((await get(`events/${e.slug}`))!.totalCapacity).toBe(100)
    expect(h.refundCalls).toBe(1)
  }, T)
})
