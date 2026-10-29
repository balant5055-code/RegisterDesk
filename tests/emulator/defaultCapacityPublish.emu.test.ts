// RD-CAPACITY-DEFAULT — an organizer who leaves License & Services at its default 100 free
// registrations can publish, and the event stores 100 — proved through the REAL draft-save route
// (the wizard's only write path) and the REAL publish route, on real Firestore.
//
// ═══ WHAT THIS PINS ══════════════════════════════════════════════════════════
//   • the capacity the wizard persists for an untouched step (capacityIntentToPersist) is saved
//     by /api/organizer/drafts, reloads as 100, and publishes with totalCapacity 100 — no payment;
//   • a draft saved BEFORE this fix (no capacity) is fixed the same way when License opens;
//   • a capacity the organizer chose (paid) is never overwritten, and still has to be paid for;
//   • a VERIFIED legacy paid tier (paid, owned, historical lic_ tier order) is reported by the quote,
//     gets NO default written, and publishes at its exact historical tier capacity;
//   • a forged/stale tier (draft licenseTier only, unpaid order, foreign order) is not an entitlement:
//     the default 100 is written, and the event never publishes with a paid tier;
//   • a genuinely missing or invalid capacity is still refused by the server.
//
// Razorpay is an in-memory stub. Auth, `after()` and the review notifications are stubbed because
// they need a request scope; every capacity and money decision is production code.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { withPublishAgreement } from '../helpers/publishAgreement'
import { capacityIntentToPersist } from '@/lib/events/builder/capacityIntent'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const SECRET = 'rd_capacity_default_secret'
const UID = `capdef-org-${process.pid}`

const rzp = vi.hoisted(() => ({
  seq: 0,
  orders:   [] as Array<{ id: string; amount: number; currency: string }>,
  payments: new Map<string, Record<string, unknown>>(),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_capdef',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        const order = { id: `order_capdef_${++rzp.seq}`, amount: o.amount, currency: o.currency }
        rzp.orders.push(order)
        return order
      },
      fetchPayments: async () => ({ items: [] }),
    },
    payments: {
      fetch: async (id: string) => {
        const p = rzp.payments.get(id)
        if (!p) throw new Error('payment not found')
        return p
      },
      refund: async () => ({ id: `rfnd_capdef_${++rzp.seq}` }),
    },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => ({ uid: UID, email: null }),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = { callerUid: UID, workspaceUid: UID, role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false }
  return {
    ...(await orig<typeof import('@/lib/team/workspace')>()),
    resolveWorkspaceUid: async () => ctx,
    authorizeWorkspace:  async () => ({ ...ctx, ok: true, status: 200, error: '' }),
  }
})
vi.mock('next/server', async orig => ({
  ...(await orig<typeof import('next/server')>()),
  after: () => undefined,
}))
vi.mock('@/lib/events/reviewNotifications', () => ({ sendEventReviewEmail: async () => undefined }))
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))

const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex')
const req = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const ctx = (draftId: string) => ({ params: Promise.resolve({ draftId }) })

/** A draft that passes every publish requirement and carries NO registration capacity. */
function draftDoc(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, uid: UID, status: 'draft', lifecycleStatus: 'draft', currentStep: 7, completedValues: Array(9).fill(null),
    eventType: 'sports', eventSubtype: 'marathon', customEventSubtype: null, campaignType: 'event_only', linkedCampaign: null,
    visibility: 'public', accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    pricing: { eventType: 'paid', feeModel: 'organizer_pays', passes: [{
      id: 'pass_0', name: '10K', code: 'TENK', description: 'Ten kilometres.', type: 'paid', price: 1500,
      earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '', unlimited: true, quantity: null,
      minPurchase: 1, maxPurchase: 5, hideWhenSoldOut: false, salesStartDate: '2026-01-01', salesEndDate: '2099-12-30',
      showRemainingSeats: true, visibility: 'public', featured: false, benefits: ['Medal'], customBenefits: [],
      raceDetails: null, eventType: 'sports', eventSubtype: 'running',
      advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, status: 'active' }] },
    registrationForm: { template: 'standard', fields: [
      { id: 'f0', label: 'T-shirt size', type: 'select', required: true, placeholder: '', helpText: '', options: ['S', 'M', 'L'], linkedPassIds: [] }] },
    eventDetails: {
      info: { name: `Capdef ${id}`, tagline: 'Default capacity',
        description: 'An event used to verify that the default registration capacity publishes. '.repeat(3),
        coverImage: 'https://example.test/cover.jpg', logoUrl: 'https://example.test/logo.png', socialLinks: [] },
      schedule: { startDate: '2099-12-31', startTime: '06:00', endDate: '2099-12-31', endTime: '12:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: 'Cubbon Park', address: 'MG Road', city: 'Bengaluru', state: 'Karnataka' } },
      organizer: { name: 'Capdef Events', email: 'capdef@example.test', phone: '+919999999999', website: 'https://example.test' },
    },
    communicationBilling: null, licenseTier: 'free', publishedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  }
}

describeEmu('RD-CAPACITY-DEFAULT · the default 100 free registrations publish without interaction', () => {
  let adminDb:  import('firebase-admin/firestore').Firestore
  let publish:  (r: NextRequest) => Promise<Response>
  let purchase: (r: NextRequest) => Promise<Response>
  let confirm:  (r: NextRequest) => Promise<Response>
  let draftRoute: typeof import('@/app/api/organizer/drafts/[draftId]/route')
  let quoteRoute: (r: NextRequest) => Promise<Response>
  const drafts = new Set<string>()
  const slugs  = new Set<string>()
  const FREE = DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity
  let lastLegacy: { tier: string; totalCapacity: number | null } | null = null

  /** A HISTORICAL tier order exactly as checkout/confirm wrote them before retirement. */
  async function seedTierOrder(id: string, over: Record<string, unknown> = {}) {
    await adminDb.doc(`licenseOrders/lic_${id}`).set({
      orderId: `lic_${id}`, eventId: id, organizerUid: UID, tier: 'professional', fromTier: null, purpose: 'purchase',
      amountPaise: 99_900, currency: 'INR', status: 'paid', razorpayOrderId: 'order_legacy_paid',
      razorpayPaymentId: 'pay_legacy_paid', razorpayAmountPaise: 99_900,
      createdAt: new Date('2026-06-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z'), paidAt: new Date('2026-06-01T00:00:00Z'),
      ...over,
    })
  }
  /** The capacity the legacy path grants for a tier — the route's own formula and catalog. */
  async function legacyCapacity(tier: string) {
    const { getLicenseCatalog, getLicenseCatalogV2 } = await import('@/lib/licensing/resolveCatalog')
    const { pickVersionedDefinition } = await import('@/lib/licensing/licenseCatalogShared')
    const { CURRENT_LICENSE_VERSION } = await import('@/lib/licensing/eventLicense')
    const { capacityPlanForRegistrationLimit, resolveTotalCapacity } = await import('@/lib/registrations/capacity')
    const [v1, v2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
    const def = pickVersionedDefinition(v1, v2, tier, CURRENT_LICENSE_VERSION)
    expect(def.licensePricePaise).toBeGreaterThan(0)          // a genuinely PAID legacy tier
    const plan = capacityPlanForRegistrationLimit(def.limits.maxRegistrations)
    return { plan, total: resolveTotalCapacity(plan) }
  }

  const draftRef = (id: string) => adminDb.doc(`users/${UID}/eventDrafts/${id}`)
  async function seedDraft(id: string, extra: Record<string, unknown> = {}) {
    drafts.add(id)
    await draftRef(id).set(draftDoc(id, extra))
  }
  /**
   * What the wizard does when License & Services opens: load the draft, quote the displayed capacity
   * (the step's own request), then persist it only if the quote reports no verified legacy tier.
   */
  async function openLicenseStep(id: string) {
    const loaded = await draftRoute.GET(req(undefined, 'GET'), ctx(id))
    const { draft } = await loaded.json() as { draft: { id: string; status?: string; registrationCapacity?: unknown } }
    const displayed = typeof draft.registrationCapacity === 'number' && Number.isInteger(draft.registrationCapacity) && draft.registrationCapacity > 0
      ? draft.registrationCapacity : FREE   // page.tsx `selectedCapacity`
    const q = await quoteRoute(req({ eventId: id, capacity: displayed, services: { whatsapp: 0, certificates: 0, media: 0 } }))
    expect(q.status).toBe(200)
    const quote = await q.json() as { mode: string; legacyEntitlement?: { tier: string; totalCapacity: number | null } | null }
    lastLegacy = quote.legacyEntitlement ?? null
    const legacy = quote.mode === 'draft' ? quote.legacyEntitlement != null : null   // LicenseServicesStep
    const intent = capacityIntentToPersist(draft, true, displayed, legacy)
    if (intent !== null) {
      const saved = await draftRoute.PATCH(req({ registrationCapacity: intent }, 'PATCH'), ctx(id))
      expect(saved.status).toBe(200)
    }
    return intent
  }
  async function doPublish(id: string) {
    const res  = await publish(req({ draftId: id }))
    const body = await res.json() as { canPublish?: boolean; reason?: string; error?: string; slug?: string }
    if (body.slug) slugs.add(body.slug)
    return { status: res.status, body }
  }
  async function activate(id: string, capacity: number) {
    const before = rzp.orders.length
    expect((await purchase(req({ eventId: id, capacity }))).status).toBe(200)
    const order = rzp.orders[before]
    const paymentId = `pay_capdef_${++rzp.seq}`
    rzp.payments.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' })
    const c = await confirm(req({ eventId: id, razorpay_order_id: order.id, razorpay_payment_id: paymentId, razorpay_signature: sign(order.id, paymentId) }))
    expect(c.status).toBe(200)
  }
  async function wipe() {
    for (const id of drafts) {
      await draftRef(id).delete().catch(() => null)
      await adminDb.doc(`licenseOrders/lic_${id}`).delete().catch(() => null)
      await adminDb.doc(`publishBaselines/${id}`).delete().catch(() => null)
    }
    for (const s of slugs) {
      for (const c of ['events', 'eventLicenses', 'registrationCounters', 'publishBaselines']) {
        await adminDb.recursiveDelete(adminDb.doc(`${c}/${s}`)).catch(() => null)
      }
    }
    for (const c of ['licenseHistory', 'walletTransactions']) {
      for (const d of (await adminDb.collection(c).where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    }
    await adminDb.doc(`organizerWallets/${UID}`).delete().catch(() => null)
    drafts.clear(); slugs.clear()
    rzp.orders.length = 0; rzp.payments.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    publish  = withPublishAgreement((await import('@/app/api/events/publish/route')).POST)
    purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    ;({ POST: confirm } = await import('@/app/api/licensing/checkout/confirm/route'))
    draftRoute = await import('@/app/api/organizer/drafts/[draftId]/route')
    ;({ POST: quoteRoute } = await import('@/app/api/licensing/checkout/quote/route'))
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true }, { merge: true })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)
  beforeEach(wipe, T)

  it('default 100, no interaction: saved by the draft route, reloads as 100, publishes with totalCapacity 100 and no payment', async () => {
    const id = `capdef-new-${process.pid}`
    await seedDraft(id)
    expect(await openLicenseStep(id)).toBe(FREE)
    // persisted, and survives a reload through the wizard's own read path
    expect((await draftRef(id).get()).data()!.registrationCapacity).toBe(FREE)
    const reloaded = await (await draftRoute.GET(req(undefined, 'GET'), ctx(id))).json() as { draft: { registrationCapacity: unknown } }
    expect(reloaded.draft.registrationCapacity).toBe(FREE)

    const r = await doPublish(id)
    expect([r.status, r.body.reason ?? null]).toEqual([200, null])
    const event = (await adminDb.doc(`events/${r.body.slug}`).get()).data()!
    expect(event.totalCapacity).toBe(FREE)                   // the EFFECTIVE capacity, not a UI value
    expect(rzp.orders).toHaveLength(0)                       // free: nothing charged
  }, T)

  it('a draft saved before the fix (no capacity) is refused as-is, then publishes once License has opened', async () => {
    const id = `capdef-old-${process.pid}`
    await seedDraft(id)
    const before = await doPublish(id)
    expect([before.status, before.body.reason]).toEqual([422, 'CAPACITY_NOT_CONFIGURED'])   // genuinely missing: still refused
    await openLicenseStep(id)
    const after = await doPublish(id)
    expect(after.status).toBe(200)
    expect((await adminDb.doc(`events/${after.body.slug}`).get()).data()!.totalCapacity).toBe(FREE)
  }, T)

  it('an explicitly chosen paid capacity is never overwritten and still has to be paid for', async () => {
    const id = `capdef-paid-${process.pid}`
    await seedDraft(id, { registrationCapacity: 437 })
    expect(await openLicenseStep(id)).toBeNull()               // nothing written over the choice
    expect((await draftRef(id).get()).data()!.registrationCapacity).toBe(437)
    const unpaid = await doPublish(id)
    expect([unpaid.status, unpaid.body.reason]).toEqual([402, 'CAPACITY_PAYMENT_REQUIRED'])
    await activate(id, 437)
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    expect((await adminDb.doc(`events/${r.body.slug}`).get()).data()!.totalCapacity).toBe(437)
  }, T)

  it('VERIFIED legacy paid tier, no capacity: the quote reports it, no default is written, publish grants the exact tier capacity', async () => {
    const id = `capdef-legacy-${process.pid}`
    await seedDraft(id, { licenseTier: 'professional' })
    await seedTierOrder(id)
    const { plan, total } = await legacyCapacity('professional')
    expect(await openLicenseStep(id)).toBeNull()
    expect(lastLegacy).toEqual({ tier: 'professional', totalCapacity: total })
    expect((await draftRef(id).get()).data()!.registrationCapacity).toBeUndefined()   // NOT overwritten with 100
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    const ev = (await adminDb.doc(`events/${r.body.slug}`).get()).data()!
    expect(ev.capacityPlan).toBe(plan)
    expect(ev.totalCapacity).toBe(total)
    expect(ev.totalCapacity).not.toBe(FREE)
    expect((await adminDb.doc(`eventLicenses/${r.body.slug}`).get()).data()!.tier).toBe('professional')
  }, T)

  const forged: ReadonlyArray<[string, Record<string, unknown> | null]> = [
    ['forged draft tier, no order', null],
    ['tier order never paid', { status: 'created' }],
    ['paid tier order owned by another organizer', { organizerUid: 'someone-else' }],
  ]
  forged.forEach(([label, order], n) => {
    it(`stale/forged tier (${label}): not an entitlement — default 100 written, no paid tier granted`, async () => {
      const id = `capdef-forged-${n}-${process.pid}`
      await seedDraft(id, { licenseTier: 'professional' })
      if (order) await seedTierOrder(id, order)
      expect(await openLicenseStep(id)).toBe(FREE)
      expect(lastLegacy).toBeNull()
      expect((await draftRef(id).get()).data()!.registrationCapacity).toBe(FREE)
      const r = await doPublish(id)
      if (order && 'organizerUid' in order) {
        expect([r.status, r.body.reason]).toEqual([403, 'ENTITLEMENT_INVALID'])   // a foreign order is refused outright
      } else {
        expect(r.status).toBe(200)
        expect((await adminDb.doc(`events/${r.body.slug}`).get()).data()!.totalCapacity).toBe(FREE)
        expect((await adminDb.doc(`eventLicenses/${r.body.slug}`).get()).data()!.tier).not.toBe('professional')
      }
    }, T)
  })

  it('an invalid stored capacity is still refused by the server when published directly', async () => {
    const id = `capdef-bad-${process.pid}`
    await seedDraft(id, { registrationCapacity: 1.5 })
    const r = await doPublish(id)
    expect(r.status).toBe(422)
    expect((await adminDb.collection('events').where('draftId', '==', id).get()).empty).toBe(true)
  }, T)
})
