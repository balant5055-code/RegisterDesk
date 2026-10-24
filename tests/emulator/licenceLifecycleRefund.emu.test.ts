// RD-SA-COMMERCE-P1 — licence lifecycle enforcement + the assessed licence refund, on REAL Firestore.
//
//   • suspended / cancelled / refunded licences refuse NEW seats on every seat-adding path
//     (create, settle a captured payment, restore, approve) and in the gate; existing
//     registrations, payments and history are untouched;
//   • the refund preview changes nothing; the refund takes only the activation order's charged seats
//     off the event and never goes below registrations already taken; when a full refund would
//     return money for something used it is refused for review with nothing moved;
//   • a gateway failure lifts the refund hold; a refunded licence is restored only explicitly;
//   • only a Super Admin can preview a refund or restore a refunded licence (route);
//   • races: a refund / suspend running against concurrent registrations never oversells and never
//     loses a counted registration.
// Razorpay is an in-memory stub — no request leaves the process.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const SUPER = `llr-super-${P}`, PLAIN = `llr-plain-${P}`
const PASS = 'pass-a'

const h = vi.hoisted(() => ({
  refunds: [] as Array<{ paymentId: string; amount: number }>,
  failRefund: false,
  admin: '' as string,
  supers: [] as string[],
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_llr', RAZORPAY_KEY_SECRET: 'llr',
  razorpay: {
    orders: { fetchPayments: async () => ({ items: [] }) },
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        // H1 — a DEFINITE gateway rejection, in the shape the Razorpay SDK rethrows an API error response
        // ({ statusCode, error }); a plain Error (timeout / network) is ambiguous and keeps everything held.
        if (h.failRefund) throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'simulated gateway rejection' } }
        h.refunds.push({ paymentId, amount: o.amount })
        return { id: `rfnd_llr_${h.refunds.length}`, amount: o.amount, status: 'processed' }
      },
      // RD-SA-COMMERCE-P1 (P1-1) — the gateway is asked after a failed call; it reports the refunds it holds.
      fetchMultipleRefund: async (paymentId: string) => {
        const items = h.refunds.filter(r => r.paymentId === paymentId).map((r, i) => ({ id: `rfnd_llr_${i}`, amount: r.amount, status: 'processed' }))
        return { entity: 'collection', count: items.length, items }
      },
    },
  },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.admin === SUPER || h.admin === PLAIN ? h.admin : null),
  legacyAdminClaimOnly: async () => h.admin === PLAIN,
  resolveSuperAdminUid: async () => (h.supers.includes(h.admin) ? h.admin : null),
}))
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => {} }))
vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({
  recordPlatformTransactionAndCredit: async () => {}, reversePlatformTransactionAndDebit: async () => {},
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {}, flushMonitoring: async () => {},
}))

describeEmu('RD-SA-COMMERCE-P1 · licence lifecycle + assessed licence refund (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/lib/admin/licenseAdminService')
  let regs: typeof import('@/lib/firebase/firestore/registrations')
  let settle: typeof import('@/lib/payments/settleCapturedRegistration')['settleCapturedRegistration']
  let gate: typeof import('@/lib/registrations/gate')['checkRegistrationGate']
  const paths = new Set<string>()
  const slugs = new Set<string>()
  let n = 0

  const put = async (path: string, data: Record<string, unknown>) => { paths.add(path); await adminDb.doc(path).set(data) }
  const get = async (path: string) => (await adminDb.doc(path).get()).data()
  const act = (slug: string, body: Record<string, unknown>) =>
    svc.applyLicenseAction(slug, { reason: 'test reason', ...body } as never, SUPER, { actorRole: 'super_admin' })
  const counter = async (slug: string) => ((await get(`registrationCounters/${slug}`)) ?? {}) as { totalCount?: number }

  /** A published, capped capacity-licence event: 250 seats = 100 free + 150 paid by the activation order. */
  async function event(o: { sold?: number; services?: { bought: number; consumed: number } } = {}) {
    const k = ++n
    const uid = `llr-org-${k}-${P}`, d = `llr-d${k}-${P}`, slug = `llr-ev${k}-${P}`, orderId = `lic_${d}`
    slugs.add(slug)
    await put(`events/${slug}`, {
      slug, uid, draftId: d, lifecycleStatus: 'published', totalCapacity: 250, capacityPlan: 'custom',
      eventDetails: { info: { name: 'LLR Event' }, schedule: { startDate: '2099-01-01', endDate: '2099-01-02', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata' } },
      pricing: { eventType: 'paid', passes: [{ id: PASS, name: 'Pass A', price: 100, status: 'active', unlimited: true, quantity: null }] },
      registrationForm: { sections: [], conditionalRules: [], registrationRules: {} },
      accessControl: { type: 'public', confirmationMode: 'auto' },
    })
    await put(`registrationCounters/${slug}`, { eventSlug: slug, totalCount: o.sold ?? 0, passCounts: { [PASS]: o.sold ?? 0 }, revenuePaise: 0, statsVersion: 3 })
    await put(`eventLicenses/${slug}`, { eventId: slug, organizerUid: uid, orderId, commercialModel: 'capacity', capacity: 250, tier: 'free', version: 2, status: 'active' })
    const items = o.services ? [{ service: 'whatsapp', quantity: o.services.bought, unitPricePaise: 45, basePaise: 0, gstRatePercent: 18, gstPaise: 0, totalPaise: 0, onExhausted: 'block' }] : []
    await put(`licenseOrders/${orderId}`, {
      orderId, eventId: d, organizerUid: uid, status: 'paid', amountPaise: 17_700, razorpayPaymentId: `pay_llr_${k}_${P}`,
      purpose: 'purchase', commercialModel: 'capacity', serviceItems: items,
      capacityChange: { operation: 'activation', capacity: 250, previousCapacity: null, freeCapacity: 100, chargeableCapacity: 150, totalPaise: 17_700 },
    })
    if (o.services) await put(`eventServiceAllowances/${d}`, { draftId: d, organizerUid: uid, appliedOrders: { [orderId]: true }, whatsapp: { purchased: o.services.bought, consumed: o.services.consumed, onExhausted: 'block' } })
    return { uid, d, slug, orderId }
  }

  const register = (slug: string, uid: string, i: number, extra: Record<string, unknown> = {}) => regs.createRegistration({
    eventSlug: slug, passId: PASS, passName: 'Pass A', passCapacity: null, eventName: 'LLR Event', organizerUid: uid,
    attendee: { name: `A${i}`, email: `llr-${slug}-${i}@example.com` }, ...extra,
  } as never)
  const regDocs = async (slug: string) => (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).docs

  async function wipe() {
    for (const p of paths) await adminDb.doc(p).delete().catch(() => null)
    for (const slug of slugs) {
      const byField: Array<[string, string]> = [['licenseHistory', 'eventId'], ['adminAuditLogs', 'entityId'], ['registrations', 'eventSlug'], ['paymentIntents', 'eventSlug']]
      for (const [col, field] of byField) for (const x of (await adminDb.collection(col).where(field, '==', slug).get()).docs) await x.ref.delete()
      for (const col of ['registrationClaims', 'ticketCodeClaims', 'failedRefunds', 'freeRegIdempotencyKeys']) {
        for (const x of (await adminDb.collection(col).where('eventSlug', '==', slug).get()).docs) await x.ref.delete()
      }
    }
    paths.clear(); slugs.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/admin/licenseAdminService')
    regs = await import('@/lib/firebase/firestore/registrations')
    ;({ settleCapturedRegistration: settle } = await import('@/lib/payments/settleCapturedRegistration'))
    ;({ checkRegistrationGate: gate } = await import('@/lib/registrations/gate'))
  }, T)
  beforeEach(async () => { h.refunds.length = 0; h.failRefund = false; h.admin = ''; h.supers = [SUPER]; await wipe() }, T)
  afterAll(wipe, T)

  // ═══ 1 · lifecycle enforcement on every seat-adding path ════════════════════════════════════════
  it('suspend → new registrations refused (create + gate), existing ones untouched; reactivate → accepted again', async () => {
    const { uid, slug } = await event()
    await register(slug, uid, 1)
    const before = (await regDocs(slug)).map(d => d.data())
    await act(slug, { action: 'suspend' })
    await expect(register(slug, uid, 2)).rejects.toMatchObject({ name: 'CapacityExceededError', reason: 'LICENCE_INACTIVE' })
    expect(await gate(slug, PASS)).toEqual({ allowed: false, reason: 'LICENCE_INACTIVE' })
    expect((await regDocs(slug)).map(d => d.data())).toEqual(before)          // existing registration untouched
    expect((await counter(slug)).totalCount).toBe(1)
    await act(slug, { action: 'reactivate' })
    await register(slug, uid, 3)
    expect((await counter(slug)).totalCount).toBe(2)
  }, T)

  it('cancelled licence: approve of a pending registration and restore of a cancelled one are refused', async () => {
    const { uid, slug } = await event()
    const pending = await register(slug, uid, 1, { approvalMode: 'manual' })
    const done = await register(slug, uid, 2)
    await regs.cancelRegistration(done.registrationId, uid)
    await act(slug, { action: 'cancel' })
    await expect(regs.approveRegistration(pending.registrationId, uid)).rejects.toMatchObject({ name: 'CapacityBlocksApprovalError', reason: 'LICENCE_INACTIVE' })
    await expect(regs.restoreRegistration(done.registrationId, uid)).rejects.toMatchObject({ name: 'CapacityBlocksRestoreError', reason: 'LICENCE_INACTIVE' })
    expect((await get(`registrations/${pending.registrationId}`))!.status).toBe('pending')
    expect((await get(`registrations/${done.registrationId}`))!.status).toBe('cancelled')
  }, T)

  it('a captured payment for a suspended licence is HELD for review — no registration, no refund', async () => {
    const { uid, slug } = await event()
    await act(slug, { action: 'suspend' })
    const orderId = `order_llr_${++n}_${P}`
    await put(`paymentIntents/${orderId}`, {
      orderId, eventSlug: slug, passId: PASS, passName: 'Pass A', passCapacity: null, eventName: 'LLR Event', organizerUid: uid,
      amount: 10_000, currency: 'INR', attendee: { name: 'Held', email: `held-${orderId}@example.com`, formResponses: {} },
      status: 'created', createdAt: new Date(), updatedAt: new Date(),
    })
    paths.add(`failedRefunds/settlement_hold_${orderId}`)
    const intent = await get(`paymentIntents/${orderId}`)
    const out = await settle({ orderId, paymentId: `pay_${orderId}`, intent: intent as never, source: 'webhook' })
    expect(out).toMatchObject({ kind: 'held', reason: 'LICENCE_INACTIVE' })
    expect((await adminDb.doc(`failedRefunds/settlement_hold_${orderId}`).get()).exists).toBe(true)
    expect(await regDocs(slug)).toHaveLength(0)
    expect(h.refunds).toHaveLength(0)
  }, T)

  // ═══ 2 · the assessed refund ════════════════════════════════════════════════════════════════════
  it('preview changes nothing', async () => {
    const { slug, orderId } = await event({ sold: 40 })
    const res = await act(slug, { action: 'refund', dryRun: true })
    expect(res.refundAssessment).toMatchObject({ totalRefundPaise: 17_700, paidSeats: 150, sold: 40, capacityBefore: 250, capacityAfter: 100, capacityChange: true, conflicts: [] })
    expect(h.refunds).toHaveLength(0)
    expect((await get(`licenseOrders/${orderId}`))!.status).toBe('paid')
    const lic = (await get(`eventLicenses/${slug}`))!
    expect(lic.refundedAt).toBeUndefined(); expect(lic.refundHold).toBeUndefined()
    expect((await get(`events/${slug}`))!.totalCapacity).toBe(250)
  }, T)

  it('refund within the floor: paid seats come off (250 → 100), registrations preserved, then the event takes no more', async () => {
    const { uid, slug, orderId } = await event()
    for (let i = 0; i < 3; i++) await register(slug, uid, i)
    const regsBefore = (await regDocs(slug)).map(d => d.data())
    const res = await act(slug, { action: 'refund' })
    expect(res.refund).toMatchObject({ gatewayRefunded: true, capacityBefore: 250, capacityAfter: 100, sold: 3 })
    expect(h.refunds).toEqual([{ paymentId: expect.stringMatching(/^pay_llr_/), amount: 17_700 }])
    expect((await get(`events/${slug}`))!.totalCapacity).toBe(100)
    const lic = (await get(`eventLicenses/${slug}`))!
    expect(lic).toMatchObject({ capacity: 100, refundCapacity: { before: 250, after: 100, sold: 3, paidSeats: 150 } })
    expect(lic.refundHold).toBeUndefined()
    expect((await get(`licenseOrders/${orderId}`))!.status).toBe('refunded')
    expect((await regDocs(slug)).map(d => d.data())).toEqual(regsBefore)       // nothing touched
    await expect(register(slug, uid, 9)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
    const hist = (await adminDb.collection('licenseHistory').where('eventId', '==', slug).where('action', '==', 'refunded').get()).docs
    expect(hist).toHaveLength(1)
    expect(hist[0].data()).toMatchObject({ after: { capacity: 100, sold: 3, paidSeatsRemoved: 150 } })
  }, T)

  it('registrations already in the refunded seats → refused for review; NOTHING moves, no hold left', async () => {
    const { slug, orderId } = await event({ sold: 120 })
    await expect(act(slug, { action: 'refund' })).rejects.toMatchObject({
      status: 409, details: { code: 'REFUND_REVIEW_REQUIRED', refundAssessment: { capacityAfter: 120, conflicts: [{ code: 'SEATS_IN_USE' }] } },
    })
    expect(h.refunds).toHaveLength(0)
    expect((await get(`licenseOrders/${orderId}`))!.status).toBe('paid')
    expect((await get(`events/${slug}`))!.totalCapacity).toBe(250)
    const lic = (await get(`eventLicenses/${slug}`))!
    expect(lic.refundHold).toBeUndefined(); expect(lic.refundedAt).toBeUndefined()
  }, T)

  it('a CONFIRMED gateway failure (Razorpay shows no refund) lifts the refund hold and reverts the order — registrations resume', async () => {
    const { uid, slug, orderId } = await event()
    h.failRefund = true
    await expect(act(slug, { action: 'refund' })).rejects.toMatchObject({ status: 502 })
    expect((await get(`licenseOrders/${orderId}`))!.status).toBe('paid')
    expect((await get(`eventLicenses/${slug}`))!.refundHold).toBeUndefined()
    expect((await get(`events/${slug}`))!.totalCapacity).toBe(250)
    await register(slug, uid, 1)
    expect((await counter(slug)).totalCount).toBe(1)
  }, T)

  // ═══ 3 · restoring a refunded licence ════════════════════════════════════════════════════════════
  it('a refunded licence is restored only explicitly (confirmation, then audited stamp) — and only by a Super Admin', async () => {
    const { uid, slug } = await event()
    await act(slug, { action: 'refund' })
    await expect(act(slug, { action: 'reactivate' })).rejects.toMatchObject({ status: 409, details: { code: 'CONFIRMATION_REQUIRED', confirmField: 'restoreRefundedEntitlement' } })
    await expect(act(slug, { action: 'reissue' })).rejects.toMatchObject({ status: 409 })
    await expect(register(slug, uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })

    // Route: a plain admin can neither preview a refund nor restore a refunded licence.
    const { POST } = await import('@/app/api/admin/licenses/[eventId]/route')
    const call = (body: unknown) => POST(new NextRequest('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ eventId: slug }) })
    h.admin = PLAIN
    expect((await call({ action: 'reactivate', reason: 'restore it', restoreRefundedEntitlement: true })).status).toBe(403)
    expect((await call({ action: 'refund', reason: 'preview it', dryRun: true })).status).toBe(403)
    h.admin = SUPER
    const ok = await call({ action: 'reactivate', reason: 'restore it', restoreRefundedEntitlement: true })
    expect(ok.status).toBe(200)

    const lic = (await get(`eventLicenses/${slug}`))!
    expect(lic.entitlementRestoredAt).toBeTruthy(); expect(lic.entitlementRestoredBy).toBe(SUPER)
    expect((lic.admin as { lifecycle: string }).lifecycle).toBe('active')
    await register(slug, uid, 2)                                                   // accepted again (capacity stays reduced)
    expect((await get(`events/${slug}`))!.totalCapacity).toBe(100)
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', slug).get()).docs.map(d => d.data())
    expect(audit.some(a => (a.metadata as Record<string, unknown> | undefined)?.restoreRefundedEntitlement === true)).toBe(true)
  }, T)

  // ═══ 4 · concurrency ═════════════════════════════════════════════════════════════════════════════
  it('RACE · refund vs concurrent registrations: every registration is either counted or refused; capacity ≥ sold', async () => {
    const { uid, slug } = await event()
    const results = await Promise.allSettled([
      act(slug, { action: 'refund' }),
      ...Array.from({ length: 12 }, (_, i) => register(slug, uid, 100 + i)),
    ])
    expect(results[0].status).toBe('fulfilled')
    for (const r of results.slice(1)) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ reason: 'LICENCE_INACTIVE' })
    }
    const ok = results.slice(1).filter(r => r.status === 'fulfilled').length
    const sold = (await counter(slug)).totalCount ?? 0
    expect(sold).toBe(ok)                                                          // nothing lost, nothing extra
    expect(await regDocs(slug)).toHaveLength(ok)
    const cap = (await get(`events/${slug}`))!.totalCapacity as number
    expect(cap).toBe(Math.max(sold, 100))
    await expect(register(slug, uid, 999)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
  }, T)

  it('RACE · suspend vs concurrent registrations: counter and documents agree; nothing lands after the suspend', async () => {
    const { uid, slug } = await event()
    const results = await Promise.allSettled([
      act(slug, { action: 'suspend' }),
      ...Array.from({ length: 12 }, (_, i) => register(slug, uid, 200 + i)),
    ])
    expect(results[0].status).toBe('fulfilled')
    const ok = results.slice(1).filter(r => r.status === 'fulfilled').length
    for (const r of results.slice(1)) if (r.status === 'rejected') expect(r.reason).toMatchObject({ reason: 'LICENCE_INACTIVE' })
    expect((await counter(slug)).totalCount).toBe(ok)
    expect(await regDocs(slug)).toHaveLength(ok)
    await expect(register(slug, uid, 999)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
  }, T)
})
