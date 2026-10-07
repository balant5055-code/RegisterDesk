// RD-LICENSE-E2E-03 — publish never infers a capacity, and the enforced capacity is always
// `events.totalCapacity` — proved against REAL Firestore through the REAL routes.
//
// ═══ WHAT THIS PINS ══════════════════════════════════════════════════════════
//   • a NEW draft with no registration capacity is refused (CAPACITY_NOT_CONFIGURED) and
//     never becomes the legacy free tier's 200;
//   • a GENUINE pre-migration draft — a paid legacy tier backed by a paid, server-written
//     order — still publishes through the grandfathered tier path, exactly as before;
//   • 1,206 / 437 / 200,000 / 100 are stored EXACTLY, and the registration gate enforces
//     `totalCapacity` even when a legacy `capacityPlan` label says something else;
//   • invalid capacities are refused by the server;
//   • the 1,206 activation is a full-price Razorpay payment and the communication wallet is
//     untouched end to end (purchase → verify → confirm → publish).
//
// Razorpay is an in-memory stub (no request leaves the process — `.env.local` holds LIVE
// keys). Auth, the post-response review email and `after()` are stubbed because they need a
// request scope; everything that decides money or capacity is the production code.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
// RD-EVENT-COMMERCE-05F — requests carry the Publish Agreement, as the wizard's always do.
import { withPublishAgreement } from '../helpers/publishAgreement'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const SECRET = 'rd_license_e2e_03_secret'
const UID = `pubcap-org-${process.pid}`

const rzp = vi.hoisted(() => ({
  seq: 0,
  orders:   [] as Array<{ id: string; amount: number; currency: string }>,
  payments: new Map<string, Record<string, unknown>>(),
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_pubcap',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        const order = { id: `order_pubcap_${++rzp.seq}`, amount: o.amount, currency: o.currency }
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
      refund: async () => ({ id: `rfnd_pubcap_${++rzp.seq}` }),
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
const req = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
})

/** A draft that passes every publish requirement — only the capacity/licence fields vary. */
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
      info: { name: `Pubcap ${id}`, tagline: 'Capacity hardening',
        description: 'An event used to verify that publish never infers a registration capacity. '.repeat(3),
        coverImage: 'https://example.test/cover.jpg', logoUrl: 'https://example.test/logo.png', socialLinks: [] },
      schedule: { startDate: '2099-12-31', startTime: '06:00', endDate: '2099-12-31', endTime: '12:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: 'Cubbon Park', address: 'MG Road', city: 'Bengaluru', state: 'Karnataka' } },
      organizer: { name: 'Pubcap Events', email: 'pubcap@example.test', phone: '+919999999999', website: 'https://example.test' },
    },
    communicationBilling: null, licenseTier: 'free', publishedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  }
}

describeEmu('RD-LICENSE-E2E-03 · publish capacity hardening on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let publish:  (r: NextRequest) => Promise<Response>
  let purchase: (r: NextRequest) => Promise<Response>
  let confirm:  (r: NextRequest) => Promise<Response>
  let checkRegistrationGate: typeof import('@/lib/registrations/gate').checkRegistrationGate
  const drafts = new Set<string>()
  const slugs  = new Set<string>()

  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const balance   = async () => ((await walletRef().get()).data()?.balancePaise ?? null) as number | null

  async function seedDraft(id: string, extra: Record<string, unknown> = {}) {
    drafts.add(id)
    await adminDb.doc(`users/${UID}/eventDrafts/${id}`).set(draftDoc(id, extra))
  }
  async function doPublish(id: string) {
    const res  = await publish(req({ draftId: id }))
    const body = await res.json() as { canPublish?: boolean; reason?: string; error?: string; slug?: string }
    if (body.slug) slugs.add(body.slug)
    return { status: res.status, body }
  }
  const eventOf = async (slug: string) => (await adminDb.doc(`events/${slug}`).get()).data()!

  /** Purchase + pay (stub) + confirm — the organizer's full Razorpay activation. */
  async function activate(id: string, capacity: number) {
    const before = rzp.orders.length
    const p = await purchase(req({ eventId: id, capacity }))
    expect(p.status).toBe(200)
    const order = rzp.orders[before]
    const paymentId = `pay_pubcap_${++rzp.seq}`
    rzp.payments.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' })
    const c = await confirm(req({ eventId: id, razorpay_order_id: order.id, razorpay_payment_id: paymentId, razorpay_signature: sign(order.id, paymentId) }))
    expect(c.status).toBe(200)
    return order
  }

  async function wipe() {
    for (const id of drafts) {
      await adminDb.doc(`users/${UID}/eventDrafts/${id}`).delete().catch(() => null)
      await adminDb.doc(`licenseOrders/lic_${id}`).delete().catch(() => null)
      await adminDb.doc(`publishBaselines/${id}`).delete().catch(() => null)
    }
    for (const s of slugs) {
      for (const c of ['events', 'eventLicenses', 'registrationCounters', 'publishBaselines']) {
        await adminDb.recursiveDelete(adminDb.doc(`${c}/${s}`)).catch(() => null)
      }
    }
    for (const d of (await adminDb.collection('licenseHistory').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    await walletRef().delete().catch(() => null)
    drafts.clear(); slugs.clear()
    rzp.orders.length = 0; rzp.payments.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;publish  = withPublishAgreement((await import('@/app/api/events/publish/route')).POST)
    ;purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    ;({ POST: confirm }  = await import('@/app/api/licensing/checkout/confirm/route'))
    ;({ checkRegistrationGate } = await import('@/lib/registrations/gate'))
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', emailVerified: true }, { merge: true })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)
  beforeEach(wipe, T)

  // ═══ A + Task 6 · 1,206 end to end, organizer already has a live event ═══════
  it('A · 1206: full-price Razorpay activation → publish → totalCapacity 1206, wallet untouched', async () => {
    await seedDraft(`pubcap-live-${process.pid}`, { status: 'published', lifecycleStatus: 'published', registrationCapacity: 100 })
    const id = `pubcap-1206-${process.pid}`
    await seedDraft(id, { registrationCapacity: 1206 })
    await walletRef().set({ balancePaise: 500_000, currency: 'INR' })

    const order = await activate(id, 1206)
    expect(order.amount).toBe(195_762)                       // ₹1,957.62 — the WHOLE price
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    expect(r.body.canPublish).toBe(true)
    const ev = await eventOf(r.body.slug!)
    expect(ev.totalCapacity).toBe(1206)
    const lic = (await adminDb.doc(`eventLicenses/${r.body.slug}`).get()).data()!
    expect(lic.commercialModel).toBe('capacity')
    expect(lic.capacity).toBe(1206)
    expect(await balance()).toBe(500_000)                    // communication wallet unchanged
  }, T)

  // ═══ B · a missing capacity fails closed — never 200 ════════════════════════
  for (const [label, extra] of [
    ['absent',                  {}],
    ['null',                    { registrationCapacity: null }],
    ['a non-numeric string',    { registrationCapacity: '1206' }],
  ] as const) {
    it(`B · capacity ${label} → CAPACITY_NOT_CONFIGURED, no event, no licence`, async () => {
      const id = `pubcap-missing-${label.length}-${process.pid}`
      await seedDraft(id, extra)
      const r = await doPublish(id)
      expect(r.status).toBe(422)
      expect(r.body.reason).toBe('CAPACITY_NOT_CONFIGURED')
      expect(r.body.slug).toBeUndefined()
      const created = await adminDb.collection('events').where('draftId', '==', id).get()
      expect(created.empty).toBe(true)                       // nothing at 200 — nothing at all
      expect((await adminDb.doc(`users/${UID}/eventDrafts/${id}`).get()).data()!.status).toBe('draft')
    }, T)
  }

  // ═══ C · a GENUINE pre-migration draft keeps the grandfathered path ══════════
  it('C · paid legacy tier + paid tier order, no capacity → publishes exactly as before', async () => {
    const { getLicenseCatalog, getLicenseCatalogV2 } = await import('@/lib/licensing/resolveCatalog')
    const { pickVersionedDefinition } = await import('@/lib/licensing/licenseCatalogShared')
    const { CURRENT_LICENSE_VERSION } = await import('@/lib/licensing/eventLicense')
    const { capacityPlanForRegistrationLimit, resolveTotalCapacity } = await import('@/lib/registrations/capacity')
    const [v1, v2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
    const def = pickVersionedDefinition(v1, v2, 'professional', CURRENT_LICENSE_VERSION)
    expect(def.licensePricePaise).toBeGreaterThan(0)         // a genuinely PAID legacy tier

    const id = `pubcap-legacy-${process.pid}`
    await seedDraft(id, { licenseTier: 'professional' })     // no registrationCapacity
    await adminDb.doc(`licenseOrders/lic_${id}`).set({
      orderId: `lic_${id}`, eventId: id, organizerUid: UID, tier: 'professional', fromTier: null, purpose: 'purchase',
      amountPaise: def.licensePricePaise, currency: 'INR', status: 'paid', razorpayOrderId: 'order_legacy_paid',
      razorpayPaymentId: 'pay_legacy_paid', razorpayAmountPaise: def.licensePricePaise,
      createdAt: new Date('2026-06-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z'), paidAt: new Date('2026-06-01T00:00:00Z'),
    })
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    const ev = await eventOf(r.body.slug!)
    const plan = capacityPlanForRegistrationLimit(def.limits.maxRegistrations)
    expect(ev.capacityPlan).toBe(plan)                       // the legacy formula, byte-for-byte
    expect(ev.totalCapacity).toBe(resolveTotalCapacity(plan))
    expect((await adminDb.doc(`eventLicenses/${r.body.slug}`).get()).data()!.tier).toBe('professional')
  }, T)

  // RD-LEGACY-01 — the draft's (client-writable) tier is no longer read at all: without a paid
  // historical tier order the draft is a plain capacity draft, refused for having no capacity.
  it('C · a paid legacy tier WITHOUT a paid order is still refused, not given a capacity', async () => {
    const id = `pubcap-legacy-unpaid-${process.pid}`
    await seedDraft(id, { licenseTier: 'professional' })
    const r = await doPublish(id)
    expect([r.status, r.body.reason]).toEqual([422, 'CAPACITY_NOT_CONFIGURED'])
    expect((await adminDb.collection('events').where('draftId', '==', id).get()).empty).toBe(true)
  }, T)

  // ═══ free, arbitrary and maximum capacities are stored EXACTLY ═══════════════
  it('100 (free): publishes with no payment → totalCapacity 100, no Razorpay order', async () => {
    const id = `pubcap-100-${process.pid}`
    await seedDraft(id, { registrationCapacity: 100 })
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    expect((await eventOf(r.body.slug!)).totalCapacity).toBe(100)
    expect(rzp.orders).toHaveLength(0)
  }, T)

  for (const [cap, total] of [[437, 59_649], [200_000, 35_382_300]] as const) {
    it(`${cap}: Razorpay order ${total} → publish → totalCapacity exactly ${cap}`, async () => {
      const id = `pubcap-${cap}-${process.pid}`
      await seedDraft(id, { registrationCapacity: cap })
      const order = await activate(id, cap)
      expect(order.amount).toBe(total)
      const r = await doPublish(id)
      expect(r.status).toBe(200)
      expect((await eventOf(r.body.slug!)).totalCapacity).toBe(cap)
    }, T)
  }

  it('a chargeable capacity that was never paid for is refused (402), not published', async () => {
    const id = `pubcap-unpaid-${process.pid}`
    await seedDraft(id, { registrationCapacity: 1206 })
    const r = await doPublish(id)
    expect(r.status).toBe(402)
    expect(r.body.reason).toBe('CAPACITY_PAYMENT_REQUIRED')
  }, T)

  // ═══ G · invalid capacities are refused by the server ════════════════════════
  for (const bad of [0, -5, 200_001, 1.5, Number.NaN]) {
    it(`G · publish refuses capacity ${String(bad)}`, async () => {
      const id = `pubcap-bad-${String(bad).replace(/\W/g, '_')}-${process.pid}`
      // NaN cannot be stored in a way that survives as NaN everywhere; Firestore keeps it as a double.
      await seedDraft(id, { registrationCapacity: bad })
      const r = await doPublish(id)
      expect(r.status).toBe(422)
      expect(r.body.canPublish).toBe(false)
      expect((await adminDb.collection('events').where('draftId', '==', id).get()).empty).toBe(true)
    }, T)
  }

  for (const bad of [0, -5, 200_001, 1.5, 'abc', null]) {
    it(`G · purchase refuses capacity ${JSON.stringify(bad)} without creating any order`, async () => {
      const id = `pubcap-pbad-${process.pid}`
      await seedDraft(id, { registrationCapacity: 1206 })
      const res  = await purchase(req({ eventId: id, capacity: bad }))
      // `null` is "no capacity" → the legacy tier path, which for the free stamp is a ₹0
      // non-order; every other value is rejected by the capacity validator.
      if (bad === null) {
        expect(res.status).toBe(400)                         // tier is required without a capacity
      } else {
        expect(res.status).toBe(422)
        expect(((await res.json()) as { failureReason?: string }).failureReason).toBe('invalid_capacity')
      }
      expect(rzp.orders).toHaveLength(0)
      expect((await adminDb.doc(`licenseOrders/lic_${id}`).get()).exists).toBe(false)
    }, T)
  }

  // ═══ D/E/F · the registration gate enforces totalCapacity, not capacityPlan ══
  for (const [cap, plan] of [[1206, 'pack_2500'], [437, 'pack_500'], [200_000, 'unlimited']] as const) {
    it(`enforces totalCapacity ${cap} even though capacityPlan says ${plan}`, async () => {
      const slug = `pubcap-gate-${cap}-${process.pid}`
      slugs.add(slug)
      await adminDb.doc(`events/${slug}`).set({
        uid: UID, draftId: slug, lifecycleStatus: 'published', capacityPlan: plan, totalCapacity: cap,
        pricing: draftDoc(slug).pricing, eventDetails: draftDoc(slug).eventDetails,
      })
      const counter = adminDb.doc(`registrationCounters/${slug}`)
      await counter.set({ totalCount: cap - 1, passCounts: { pass_0: cap - 1 } })
      expect((await checkRegistrationGate(slug, 'pass_0')).allowed).toBe(true)
      await counter.set({ totalCount: cap, passCounts: { pass_0: cap } })
      const full = await checkRegistrationGate(slug, 'pass_0')
      expect(full.allowed).toBe(false)
      expect(full.reason).toBe('EVENT_CAPACITY_FULL')          // at cap — not at the plan's limit
    }, T)
  }

  // ═══ RD-LEGACY-01 · decision 4 — no obsolete tier price or forged tier decides a publish ═══
  const CFG = 'system/businessConfiguration'
  async function withConfigPatch(patch: Record<string, unknown>, run: () => Promise<void>) {
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    const backup = (await adminDb.doc(CFG).get()).data()
    await adminDb.doc(CFG).set(patch, { merge: true }); businessConfig.invalidateCache()
    try { await run() } finally {
      if (backup) await adminDb.doc(CFG).set(backup); else await adminDb.doc(CFG).delete().catch(() => null)
      businessConfig.invalidateCache()
    }
  }
  const HAZARD = { licensing: { tierOverridesV2: {
    free:         { offerPricePaise: 99_900, regularPricePaise: 99_900, licensePricePaise: 99_900 },
    professional: { offerPricePaise: 1_23_400, regularPricePaise: 1_23_400, licensePricePaise: 1_23_400 },
  } } }

  it('L1 · a NEW free event (capacity 100, no order) publishes — no tier, no payment', async () => {
    const id = `pubcap-free-${process.pid}`
    await seedDraft(id, { registrationCapacity: 100 })
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    expect((await eventOf(r.body.slug!)).totalCapacity).toBe(100)
    expect((await adminDb.doc(`eventLicenses/${r.body.slug}`).get()).data()!.tier).toBe('free')   // compatibility stamp only
  }, T)

  it('L2 · a FORGED stored free-tier price (raw config) cannot block a free publish or create a tier charge', async () => {
    await withConfigPatch(HAZARD, async () => {
      const id = `pubcap-freeprice-${process.pid}`
      await seedDraft(id, { registrationCapacity: 100 })
      const r = await doPublish(id)
      expect(r.status).toBe(200)                                // was 402 "Payment is required before publishing a Free event"
      expect((await eventOf(r.body.slug!)).totalCapacity).toBe(100)
      expect(rzp.orders).toHaveLength(0)                        // nothing was charged
    })
  }, T)

  it('L3 · a NEW paid-capacity event uses the commercial capacity price: unpaid → 402 CAPACITY_PAYMENT_REQUIRED; paid → publishes', async () => {
    const id = `pubcap-paidcap-${process.pid}`
    await seedDraft(id, { registrationCapacity: 500 })
    const unpaid = await doPublish(id)
    expect([unpaid.status, unpaid.body.reason]).toEqual([402, 'CAPACITY_PAYMENT_REQUIRED'])
    const order = await activate(id, 500)
    expect(order.amount).toBe(70_800)                          // 400 × ₹1.50 + 18% GST — not a tier price
    const r = await doPublish(id)
    expect(r.status).toBe(200)
    expect((await eventOf(r.body.slug!)).totalCapacity).toBe(500)
  }, T)

  it('L4 · a FORGED old tier on the draft is ignored: no capacity → 422; a capacity still has to be paid', async () => {
    for (const tier of ['starter', 'professional', 'business', 'enterprise']) {
      const id = `pubcap-forged-${tier}-${process.pid}`
      await seedDraft(id, { licenseTier: tier })
      const none = await doPublish(id)
      expect([none.status, none.body.reason], tier).toEqual([422, 'CAPACITY_NOT_CONFIGURED'])
      await adminDb.doc(`users/${UID}/eventDrafts/${id}`).update({ registrationCapacity: 5_000 })
      const big = await doPublish(id)
      expect([big.status, big.body.reason], tier).toEqual([402, 'CAPACITY_PAYMENT_REQUIRED'])
    }
  }, T)

  it('L5 · a paid CAPACITY order carrying a forged tier field grants no tier path', async () => {
    const id = `pubcap-capforge-${process.pid}`
    await seedDraft(id, { licenseTier: 'enterprise' })
    await adminDb.doc(`licenseOrders/lic_${id}`).set({ orderId: `lic_${id}`, eventId: id, organizerUid: UID, tier: 'enterprise', fromTier: null,
      purpose: 'purchase', amountPaise: 0, currency: 'INR', status: 'paid', commercialModel: 'capacity', razorpayOrderId: null, razorpayPaymentId: null })
    const r = await doPublish(id)
    expect([r.status, r.body.reason]).toEqual([422, 'CAPACITY_NOT_CONFIGURED'])
  }, T)

  it('L6 · NEW Starter / Professional / Business / Enterprise orders are rejected (purchase + confirm), nothing written', async () => {
    for (const tier of ['starter', 'professional', 'business', 'enterprise']) {
      const id = `pubcap-newtier-${tier}-${process.pid}`
      await seedDraft(id, { licenseTier: tier })
      const p = await purchase(req({ eventId: id, tier }))
      expect(p.status, tier).toBe(400)
      expect(((await p.json()) as { failureReason?: string }).failureReason, tier).toBe('capacity_required')
      const c = await confirm(req({ eventId: id, tier, razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'sig' }))
      expect(c.status, tier).toBe(410)
      expect(((await c.json()) as { code?: string }).code, tier).toBe('TIER_RETIRED')
      expect((await adminDb.doc(`licenseOrders/lic_${id}`).get()).exists, tier).toBe(false)
    }
    expect(rzp.orders).toHaveLength(0)
  }, T)

  it('L7 · a HISTORICAL tier order created before retirement still settles — at its OWN stored price, not today’s catalog', async () => {
    await withConfigPatch(HAZARD, async () => {                // the catalog now says ₹1,234 for Professional
      const id = `pubcap-hist-${process.pid}`
      await seedDraft(id, { licenseTier: 'professional' })
      const STORED = 4_99_900
      const rzpOrder = `order_pubcap_hist_${process.pid}`
      await adminDb.doc(`licenseOrders/lic_${id}`).set({ orderId: `lic_${id}`, eventId: id, organizerUid: UID, tier: 'professional', fromTier: null,
        purpose: 'purchase', amountPaise: STORED, currency: 'INR', status: 'created', razorpayOrderId: rzpOrder, razorpayPaymentId: null,
        razorpayAmountPaise: STORED, createdAt: new Date('2026-06-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z') })
      const paymentId = `pay_pubcap_hist_${process.pid}`
      rzp.payments.set(paymentId, { id: paymentId, order_id: rzpOrder, amount: STORED, currency: 'INR', status: 'captured' })
      const c = await confirm(req({ eventId: id, tier: 'professional', razorpay_order_id: rzpOrder, razorpay_payment_id: paymentId, razorpay_signature: sign(rzpOrder, paymentId) }))
      expect(c.status).toBe(200)
      const ord = (await adminDb.doc(`licenseOrders/lic_${id}`).get()).data()!
      expect(ord.status).toBe('paid')
      expect(ord.amountPaise).toBe(STORED)                     // frozen — never re-priced to the catalog's ₹1,234
      const r = await doPublish(id)                            // the grandfathered publish path still honours it
      expect(r.status).toBe(200)
      expect((await adminDb.doc(`eventLicenses/${r.body.slug}`).get()).data()!.tier).toBe('professional')
    })
  }, T)
})
