// RD-SA-COMMERCE-P1 (review fixes) — refund holds on prepaid units, the review state, hold recovery,
// capacity purchases on inactive licences, and existing registrations — on REAL Firestore.
//
//   • while a licence refund is in flight its unused WhatsApp / certificate / photo units are HELD:
//     every consumer (decideReserve, the photo gate) refuses them; finalize retires exactly them;
//   • RACES: a refund running against concurrent WhatsApp reservations / photo uploads never returns
//     the money for a unit that was used — either the refund is refused for review, or nothing used it;
//   • stored photos count as used media units (a full refund with photos stored needs review);
//   • a refund refused for review leaves a durable review record (licence + history + audit);
//   • a gateway failure releases the unit hold; `releaseRefundHold` recovers an interrupted refund
//     only when Razorpay confirms no refund exists;
//   • a service-request approval cannot move held units;
//   • capacity cannot be bought / applied / freely changed on an inactive licence (authorized Super
//     Admin overrides still work, and still do not restart sales);
//   • existing registrations: check-in and cancel keep working, records are untouched.
// Razorpay is an in-memory stub — no request leaves the process.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const SUPER = `lrh-super-${P}`
const PASS = 'pass-a'

const h = vi.hoisted(() => ({
  refunds: [] as Array<{ paymentId: string; amount: number }>,
  failRefund: false,
  gate: null as null | Promise<void>,
  gatewayRefunds: new Map<string, Array<{ status: string; amount?: number }>>(),
  lookupThrows: false,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_lrh', RAZORPAY_KEY_SECRET: 'lrh',
  razorpay: {
    orders: { fetchPayments: async () => ({ items: [] }) },
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        if (h.gate) await h.gate
        // H1 — a DEFINITE gateway rejection, in the shape the Razorpay SDK rethrows an API error response
        // ({ statusCode, error }); a plain Error (timeout / network) is ambiguous and keeps everything held.
        if (h.failRefund) throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'simulated gateway rejection' } }
        h.refunds.push({ paymentId, amount: o.amount })
        return { id: `rfnd_lrh_${h.refunds.length}`, amount: o.amount, status: 'processed' }
      },
      fetchMultipleRefund: async (paymentId: string) => {
        if (h.lookupThrows) throw new Error('lookup failed')
        const items = h.gatewayRefunds.get(paymentId) ?? []
        return { entity: 'collection', count: items.length, items }
      },
    },
  },
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {}, flushMonitoring: async () => {},
}))

describeEmu('RD-SA-COMMERCE-P1 · refund holds, review state, recovery, capacity, existing registrations', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let svc: typeof import('@/lib/admin/licenseAdminService')
  let regs: typeof import('@/lib/firebase/firestore/registrations')
  let ledgerMod: typeof import('@/lib/licensing/serviceAllowanceLedger')
  let photo: typeof import('@/features/media-studio/services/photoCapacityGate')
  let cap: typeof import('@/lib/licensing/capacityChange')
  let sr: typeof import('@/lib/wallet/serviceRequests')
  const paths = new Set<string>()
  const slugs = new Set<string>()
  const drafts = new Set<string>()
  let n = 0

  const put = async (path: string, data: Record<string, unknown>) => { paths.add(path); await adminDb.doc(path).set(data) }
  const get = async (path: string) => (await adminDb.doc(path).get()).data()
  const act = (slug: string, body: Record<string, unknown>) =>
    svc.applyLicenseAction(slug, { reason: 'test reason', ...body } as never, SUPER, { actorRole: 'super_admin' })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const waitFor = async (pred: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await pred()) return; await sleep(50) }
    throw new Error('timed out waiting')
  }

  /** A published capacity-licence event; the activation order optionally carries prepaid units. */
  async function event(o: { whatsapp?: number; certificates?: number; media?: number; lifecycle?: string } = {}) {
    const k = ++n
    const uid = `lrh-org-${k}-${P}`, d = `lrh-d${k}-${P}`, slug = `lrh-ev${k}-${P}`, orderId = `lic_${d}`
    slugs.add(slug); drafts.add(d)
    await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    await put(`events/${slug}`, {
      slug, uid, draftId: d, lifecycleStatus: o.lifecycle ?? 'published', totalCapacity: 250, capacityPlan: 'custom',
      eventDetails: { info: { name: 'LRH Event' }, schedule: { startDate: '2099-01-01', endDate: '2099-01-02', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata' } },
      pricing: { eventType: 'paid', passes: [{ id: PASS, name: 'Pass A', price: 100, status: 'active', unlimited: true, quantity: null }] },
      registrationForm: { sections: [], conditionalRules: [], registrationRules: {} },
      accessControl: { type: 'public', confirmationMode: 'auto' },
    })
    await put(`registrationCounters/${slug}`, { eventSlug: slug, totalCount: 0, passCounts: {}, revenuePaise: 0, statsVersion: 3 })
    await put(`eventLicenses/${slug}`, { eventId: slug, organizerUid: uid, orderId, commercialModel: 'capacity', capacity: 250, tier: 'free', version: 2, status: 'active' })
    const item = (service: string, quantity: number) => ({ service, quantity, unitPricePaise: 100, basePaise: quantity * 100, gstRatePercent: 18, gstPaise: quantity * 18, totalPaise: quantity * 118, onExhausted: 'block' })
    const items = (['whatsapp', 'certificates', 'media'] as const).filter(s => (o[s] ?? 0) > 0).map(s => item(s, o[s] as number))
    await put(`licenseOrders/${orderId}`, {
      orderId, eventId: d, organizerUid: uid, status: 'paid', amountPaise: 17_700, razorpayPaymentId: `pay_lrh_${k}_${P}`,
      purpose: 'purchase', commercialModel: 'capacity', serviceItems: items,
      capacityChange: { operation: 'activation', capacity: 250, previousCapacity: null, freeCapacity: 100, chargeableCapacity: 150, totalPaise: 17_700 },
    })
    if (items.length) {
      const lines: Record<string, unknown> = {}
      for (const i of items) lines[i.service] = { purchased: i.quantity, consumed: 0, onExhausted: 'block' }
      await put(`eventServiceAllowances/${d}`, { draftId: d, organizerUid: uid, appliedOrders: { [orderId]: true }, ...lines })
    }
    return { uid, d, slug, orderId, paymentId: `pay_lrh_${k}_${P}` }
  }
  const reserveWa = (d: string, key: string, service: 'whatsapp' | 'certificates' = 'whatsapp') =>
    ledgerMod.reserveServiceUnits({ draftId: d, service, unitKey: `lrh_${key}`, source: 'test' })
  const reservePhoto = (e: { uid: string; d: string; slug: string }, i: number) => photo.reservePhotoUpload({
    assetId: `lrh-asset-${e.d}-${i}`, organizerUid: e.uid, eventId: e.d, eventSlug: e.slug, galleryId: 'g1', albumId: null,
    renditions: {}, visibility: 'PRIVATE', uploadedBy: e.uid,
  } as never)
  const register = (slug: string, uid: string, i: number, extra: Record<string, unknown> = {}) => regs.createRegistration({
    eventSlug: slug, passId: PASS, passName: 'Pass A', passCapacity: null, eventName: 'LRH Event', organizerUid: uid,
    attendee: { name: `A${i}`, email: `lrh-${slug}-${i}@example.com` }, ...extra,
  } as never)

  async function wipe() {
    for (const p of paths) await adminDb.doc(p).delete().catch(() => null)
    for (const slug of slugs) {
      for (const [col, field] of [['licenseHistory', 'eventId'], ['adminAuditLogs', 'entityId'], ['registrations', 'eventSlug']] as const) {
        for (const x of (await adminDb.collection(col).where(field, '==', slug).get()).docs) await x.ref.delete()
      }
      for (const col of ['registrationClaims', 'ticketCodeClaims', 'freeRegIdempotencyKeys']) {
        for (const x of (await adminDb.collection(col).where('eventSlug', '==', slug).get()).docs) await x.ref.delete()
      }
      for (const x of (await adminDb.collection('licenseOrders').where('eventId', '==', slug).get()).docs) await x.ref.delete()
    }
    for (const d of drafts) {
      for (const x of (await adminDb.collection(`eventServiceAllowances/${d}/usage`).get()).docs) await x.ref.delete()
      for (const x of (await adminDb.collection('mediaAssets').where('eventId', '==', d).get()).docs) await x.ref.delete()
      for (const x of (await adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', d).get()).docs) await x.ref.delete()
      await adminDb.doc(`eventPhotoUsage/${d}`).delete().catch(() => null)
    }
    paths.clear(); slugs.clear(); drafts.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    svc = await import('@/lib/admin/licenseAdminService')
    regs = await import('@/lib/firebase/firestore/registrations')
    ledgerMod = await import('@/lib/licensing/serviceAllowanceLedger')
    photo = await import('@/features/media-studio/services/photoCapacityGate')
    cap = await import('@/lib/licensing/capacityChange')
    sr = await import('@/lib/wallet/serviceRequests')
  }, T)
  beforeEach(async () => {
    h.refunds.length = 0; h.failRefund = false; h.gate = null; h.gatewayRefunds.clear(); h.lookupThrows = false
    await wipe()
  }, T)
  afterAll(wipe, T)

  // ═══ 1 · the hold, observed while the gateway call is in flight ═══════════════════════════════════
  it('during the gateway call: held WhatsApp / certificate / photo units are refused, no capacity can be bought; afterwards exactly the held units are retired', async () => {
    const e = await event({ whatsapp: 20, certificates: 10, media: 5 })
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    const refund = act(e.slug, { action: 'refund' })
    await waitFor(async () => !!(await get(`eventServiceAllowances/${e.d}`))?.refundHold)
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toMatchObject({ orderId: e.orderId, units: { whatsapp: 20, certificates: 10, media: 5 } })
    expect(await reserveWa(e.d, 'during-wa')).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(await reserveWa(e.d, 'during-cert', 'certificates')).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(await reservePhoto(e, 1)).toMatchObject({ ok: false })
    expect(await cap.createCapacityChangeOrder({ eventId: e.slug, organizerUid: e.uid, newCapacity: 300 })).toMatchObject({ ok: false, code: 'LICENCE_INACTIVE' })
    open()
    const res = await refund
    expect(res.refund).toMatchObject({ gatewayRefunded: true, servicesRetired: { whatsapp: 20, certificates: 10, media: 5 } })
    const l = (await get(`eventServiceAllowances/${e.d}`))!
    expect(l.refundHold).toBeUndefined()
    expect(l).toMatchObject({ whatsapp: { purchased: 0, consumed: 0 }, certificates: { purchased: 0, consumed: 0 }, media: { purchased: 0 } })
    expect((await adminDb.collection(`eventServiceAllowances/${e.d}/usage`).get()).size).toBe(0)
  }, T)

  // ═══ 2 · races ══════════════════════════════════════════════════════════════════════════════════
  it('RACE · refund vs 20 concurrent WhatsApp reservations: never money back for a used unit', async () => {
    for (let round = 0; round < 3; round++) {
      const e = await event({ whatsapp: 20 })
      const results = await Promise.allSettled([act(e.slug, { action: 'refund' }), ...Array.from({ length: 20 }, (_, i) => reserveWa(e.d, `r${round}_${i}`))])
      const refundOk = results[0].status === 'fulfilled'
      const taken = results.slice(1).filter(r => r.status === 'fulfilled' && (r.value as { mode: string; already?: boolean }).mode === 'allowance').length
      const l = (await get(`eventServiceAllowances/${e.d}`))!
      expect(l.refundHold).toBeUndefined()
      if (refundOk) {
        expect(taken).toBe(0)                                                           // nothing used a refunded unit
        expect(l.whatsapp).toMatchObject({ purchased: 0, consumed: 0 })
        expect(h.refunds.filter(r => r.paymentId === e.paymentId)).toHaveLength(1)
      } else {
        expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, details: { code: 'REFUND_REVIEW_REQUIRED' } })
        expect(taken).toBeGreaterThan(0)
        expect((l.whatsapp as { consumed: number }).consumed).toBe(taken)               // ledger agrees with outcomes
        expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
        expect(h.refunds.filter(r => r.paymentId === e.paymentId)).toHaveLength(0)
      }
    }
  }, T)

  it('RACE · refund vs 10 concurrent photo uploads: never money back for capacity a photo holds', async () => {
    for (let round = 0; round < 3; round++) {
      const e = await event({ media: 10 })
      const results = await Promise.allSettled([act(e.slug, { action: 'refund' }), ...Array.from({ length: 10 }, (_, i) => reservePhoto(e, round * 100 + i))])
      const refundOk = results[0].status === 'fulfilled'
      const stored = results.slice(1).filter(r => r.status === 'fulfilled' && (r.value as { ok: boolean }).ok).length
      expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toBeUndefined()
      if (refundOk) {
        expect(stored).toBe(0)
        expect((await get(`eventServiceAllowances/${e.d}`))!.media).toMatchObject({ purchased: 0 })
      } else {
        expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, details: { code: 'REFUND_REVIEW_REQUIRED' } })
        expect(stored).toBeGreaterThan(0)
        expect((await get(`eventServiceAllowances/${e.d}`))!.media).toMatchObject({ purchased: 10 })
      }
    }
  }, T)

  // ═══ 3 · photos count as used media units; the review state is durable ═════════════════════════
  it('stored photos are used media units: the full refund is refused and a durable review record is written', async () => {
    const e = await event({ media: 10 })
    for (let i = 0; i < 3; i++) expect(await reservePhoto(e, i)).toMatchObject({ ok: true })
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({
      status: 409, details: { code: 'REFUND_REVIEW_REQUIRED', refundAssessment: { conflicts: [{ code: 'SERVICE_UNITS_CONSUMED' }], services: [{ service: 'media', retirable: 7, consumed: 3 }] } },
    })
    expect(h.refunds).toHaveLength(0)
    const lic = (await get(`eventLicenses/${e.slug}`))!
    expect(lic.refundHold).toBeUndefined()
    expect(lic.refundReview).toMatchObject({ by: SUPER, reason: 'test reason', conflicts: ['SERVICE_UNITS_CONSUMED'], totalRefundPaise: 17_700 })
    const hist = (await adminDb.collection('licenseHistory').where('eventId', '==', e.slug).where('action', '==', 'refund_review_required').get()).docs
    expect(hist).toHaveLength(1)
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', e.slug).where('action', '==', 'license.refund_review_required').get()).docs
    expect(audit).toHaveLength(1)
    // Visible to Super Admins in the licence detail (read-only projection of the durable record).
    expect((await svc.getLicenseDetail(e.slug))!.refundState).toMatchObject({
      hold: null, blocksNewSales: false,
      review: { by: SUPER, reason: 'test reason', conflicts: ['SERVICE_UNITS_CONSUMED'], totalRefundPaise: 17_700 },
    })
    expect(await register(e.slug, e.uid, 1)).toMatchObject({ registrationId: expect.any(String) })   // review does not block sales
  }, T)

  // ═══ 4 · rollback + recovery ═════════════════════════════════════════════════════════════════════
  it('a gateway failure releases the unit hold — units are usable again', async () => {
    const e = await event({ whatsapp: 5 })
    h.failRefund = true
    await expect(act(e.slug, { action: 'refund' })).rejects.toMatchObject({ status: 502 })
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toBeUndefined()
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeUndefined()
    expect(await reserveWa(e.d, 'after-fail')).toEqual({ mode: 'allowance', already: false })
  }, T)

  it('releaseRefundHold: refused when money moved / unverifiable / already refunded; releases an interrupted refund otherwise', async () => {
    const e = await event({ whatsapp: 5 })
    // An interrupted refund: claim committed (order refunding, both holds), process died before the gateway.
    await adminDb.doc(`licenseOrders/${e.orderId}`).set({ status: 'refunding' }, { merge: true })
    await adminDb.doc(`eventLicenses/${e.slug}`).set({ refundHold: { at: FS.Timestamp.now(), by: SUPER, orderId: e.orderId } }, { merge: true })
    await adminDb.doc(`eventServiceAllowances/${e.d}`).set({ refundHold: { orderId: e.orderId, units: { whatsapp: 5 } } }, { merge: true })
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
    // PD-2 — a hold younger than 15 minutes is never released, even though the gateway shows no refund.
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_HOLD_TOO_RECENT' } })
    await adminDb.doc(`eventLicenses/${e.slug}`).update({ 'refundHold.at': FS.Timestamp.fromMillis(Date.now() - 20 * 60_000) })

    h.gatewayRefunds.set(e.paymentId, [{ status: 'processed', amount: 17_700 }])
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_FOUND_AT_GATEWAY' } })
    h.gatewayRefunds.clear(); h.lookupThrows = true
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 503 })
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeTruthy()             // still held after refusals
    h.lookupThrows = false
    // A (historical) wallet credit-back row means money moved through the wallet: never released.
    await put(`walletTransactions/license_refund_${e.slug}`, { type: 'license_refund', organizerUid: e.uid })
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_FOUND_IN_WALLET' } })
    await adminDb.doc(`walletTransactions/license_refund_${e.slug}`).delete()

    // Visibility: the Super Admin detail shows the hold (with its age) — and nothing released it for being old.
    await adminDb.doc(`eventLicenses/${e.slug}`).set({ refundHold: { at: FS.Timestamp.fromMillis(Date.now() - 50 * 3_600_000), by: SUPER, orderId: e.orderId } }, { merge: true })
    const detail = await svc.getLicenseDetail(e.slug)
    expect(detail!.refundState).toMatchObject({ hold: { orderId: e.orderId, by: SUPER }, blocksNewSales: true })
    expect(detail!.refundState!.hold!.ageHours).toBeGreaterThanOrEqual(49)
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeTruthy()

    const res = await act(e.slug, { action: 'releaseRefundHold' })
    expect(res.ok).toBe(true)
    expect((await get(`licenseOrders/${e.orderId}`))!.status).toBe('paid')
    expect((await get(`eventLicenses/${e.slug}`))!.refundHold).toBeUndefined()
    expect((await get(`eventServiceAllowances/${e.d}`))!.refundHold).toBeUndefined()
    expect(await reserveWa(e.d, 'released')).toEqual({ mode: 'allowance', already: false })
    await register(e.slug, e.uid, 2)
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', e.slug).where('action', '==', 'license.refund_hold_released').get()).docs
    expect(audit).toHaveLength(1)

    // An order already refunded is never "released".
    await adminDb.doc(`licenseOrders/${e.orderId}`).set({ status: 'refunded' }, { merge: true })
    await adminDb.doc(`eventLicenses/${e.slug}`).set({ refundHold: { orderId: e.orderId } }, { merge: true })
    await expect(act(e.slug, { action: 'releaseRefundHold' })).rejects.toMatchObject({ status: 409, details: { code: 'REFUND_FINALIZED' } })
  }, T)

  // ═══ 5 · service-request approvals cannot move held units ═════════════════════════════════════════
  it('a wallet service-request approval refuses while a licence refund holds the units', async () => {
    const e = await event({ whatsapp: 10, lifecycle: 'completed' })
    await adminDb.doc(`events/${e.slug}`).set({ completedAt: FS.Timestamp.fromMillis(Date.now() - 3_600_000) }, { merge: true })
    await put(`users/${e.uid}/eventDrafts/${e.d}`, {
      eventDetails: { info: { name: 'LRH Event' }, seo: { urlSlug: e.slug } }, status: 'published', lifecycleStatus: 'completed',
      completedAt: FS.Timestamp.fromMillis(Date.now() - 3_600_000), updatedAt: FS.Timestamp.now(),
    })
    const req = await sr.submitServiceRequest({ uid: e.uid, callerUid: e.uid, kind: 'refund', draftId: e.d, service: 'whatsapp', note: 'unused' })
    await adminDb.doc(`eventServiceAllowances/${e.d}`).set({ refundHold: { orderId: e.orderId, units: { whatsapp: 10 } } }, { merge: true })
    await expect(sr.decideServiceRequest({ adminUid: SUPER, id: req.id, action: 'approve', reason: 'approve it', approvedAmountPaise: 100 }))
      .rejects.toMatchObject({ status: 409, code: 'LICENCE_REFUND_IN_PROGRESS' })
    await adminDb.doc(`eventServiceAllowances/${e.d}`).set({ refundHold: FS.FieldValue.delete() }, { merge: true })
    await sr.decideServiceRequest({ adminUid: SUPER, id: req.id, action: 'approve', reason: 'approve it', approvedAmountPaise: 100 })
    expect((await adminDb.doc(`walletServiceRequests/${req.id}`).get()).get('status')).toBe('approved')
  }, T)

  // ═══ 6 · capacity purchases on an inactive licence ════════════════════════════════════════════════
  it('inactive licence: no capacity order, a created order is not applied (payment held), no free change; a Super Admin override still works but sales stay closed', async () => {
    const e = await event()
    const created = await cap.createCapacityChangeOrder({ eventId: e.slug, organizerUid: e.uid, newCapacity: 300 })
    expect(created).toMatchObject({ ok: true })
    const orderId = (created as { result: { orderId: string } }).result.orderId
    paths.add(`licenseOrders/${orderId}`)
    await act(e.slug, { action: 'suspend' })

    expect(await cap.createCapacityChangeOrder({ eventId: e.slug, organizerUid: e.uid, newCapacity: 320 })).toMatchObject({ ok: false, code: 'LICENCE_INACTIVE' })
    expect(await cap.loadCapacityChangeContext(e.slug, e.uid)).toMatchObject({ ok: false, code: 'LICENCE_INACTIVE' })
    const applied = await cap.applyCapacityChange({ eventId: e.slug, organizerUid: e.uid, orderId, razorpayOrderId: 'order_x', razorpayPaymentId: 'pay_x' })
    expect(applied.kind).toBe('lifecycle_ineligible')
    expect(await get(`licenseOrders/${orderId}`)).toMatchObject({ status: 'failed', failReason: 'lifecycle_ineligible', licenceInactiveAtSettlement: true })
    expect((await get(`events/${e.slug}`))!.totalCapacity).toBe(250)
    expect(await cap.applyFreeCapacityChange({ eventId: e.slug, organizerUid: e.uid, snapshot: { operation: 'decrease', previousCapacity: 250, capacity: 240, totalPaise: 0 } as never }))
      .toBe('lifecycle_ineligible')

    await act(e.slug, { action: 'overrideLimit', limitKey: 'maxRegistrations', limitValue: 400 })   // authorized recovery path
    expect((await get(`events/${e.slug}`))!.totalCapacity).toBe(400)
    await expect(register(e.slug, e.uid, 1)).rejects.toMatchObject({ reason: 'LICENCE_INACTIVE' })
  }, T)

  // ═══ 7 · existing registrations are untouched by an inactive licence ═════════════════════════════
  it('suspended licence: existing registrations can be checked in and cancelled; pending ones stay as they were', async () => {
    const e = await event()
    const a = await register(e.slug, e.uid, 1)
    const b = await register(e.slug, e.uid, 2)
    const p = await register(e.slug, e.uid, 3, { approvalMode: 'manual' })
    const pendingBefore = await get(`registrations/${p.registrationId}`)
    await act(e.slug, { action: 'suspend' })
    const out = await regs.checkInRegistration(a.registrationId, e.uid, { byUid: e.uid, workspaceUid: e.uid })
    expect(JSON.stringify(out)).not.toMatch(/LICENCE/)
    expect((await get(`registrations/${a.registrationId}`))!.checkedIn).toBe(true)
    await regs.cancelRegistration(b.registrationId, e.uid)
    expect((await get(`registrations/${b.registrationId}`))!.status).toBe('cancelled')
    expect(await get(`registrations/${p.registrationId}`)).toEqual(pendingBefore)        // untouched while blocked
    expect(((await get(`registrationCounters/${e.slug}`)) as { totalCount: number }).totalCount).toBe(1)
  }, T)
})
