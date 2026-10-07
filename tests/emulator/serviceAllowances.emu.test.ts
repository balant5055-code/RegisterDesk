// RD-EVENT-COMMERCE-02 — prepaid service allowances and the combined License & Services payment,
// proved against REAL Firestore through the REAL routes and settlement transactions.
//
//   • one combined Razorpay order for capacity + WhatsApp + certificates, exact integer paise
//   • fail closed: an unconfigured service cannot be bought; forged amounts are refused
//   • exactly-once application of a paid order to the allowance ledger (confirm replays)
//   • pre-publish add-on orders: the DIFFERENCE only, reuse on identical selection, supersede on change
//   • publish re-checks capacity (incl. add-ons) and the selected services
//   • concurrent consumption can never exceed the allowance; release is exactly-once
//   • WhatsApp registration confirmations and broadcasts consume the allowance; exhausted ⇒ policy
//   • lifecycle: a submitted draft cannot start a new purchase
//
// Razorpay and the Meta provider are in-memory stubs (no request leaves the process). The prepaid
// catalog is mocked with TEST-ONLY values — no production price exists (see the audit, D1–D6).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { FieldValue } from 'firebase-admin/firestore'
// RD-EVENT-COMMERCE-05F — requests carry the Publish Agreement, as the wizard's always do.
import { withPublishAgreement } from '../helpers/publishAgreement'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const SECRET = 'rd_commerce_02_secret'
const UID = `c02svc-org-${process.pid}`

const h = vi.hoisted(() => ({
  seq: 0,
  orders:   [] as Array<{ id: string; amount: number; currency: string }>,
  payments: new Map<string, Record<string, unknown>>(),
  captured: new Map<string, { amount: number; status?: string }>(),   // razorpay order id → captured payment
  /** RD-M3 — per-call fetchPayments behaviour, consumed in order: 'normal' | 'throw' | 'malformed'. Empty ⇒ normal. */
  fetchPlan: [] as Array<'normal' | 'throw' | 'malformed'>,
  /** RD-M4 — one-shot interleaving hooks (null ⇒ no interleaving). */
  beforeActivate: null as null | (() => Promise<void>),
  onFetch:        null as null | (() => Promise<void>),
  onRefund:       null as null | (() => Promise<void>),   // RD-M5 refund race — runs while the gateway refund is pending
  beforeApply:    null as null | (() => Promise<void>),   // RD-L6 D2 — runs between a caller's read and the REAL capacity apply
  catalog:  null as unknown,
  sends:    [] as string[],
  sendOk:   true,
  /** RD-HIGH-2 — the acting organizer; '' = the suite's UID, 'anon' = unauthenticated. */
  who:      '' as string,
  /** RD-F3 — injected TRANSIENT failures: each counter > 0 makes the next call of that step throw once. */
  fail:     { apply: 0, recordHold: 0, holdSuperseded: 0, couponCount: 0, refund: 0, counterRef: 0, rzpCreate: 0, attach: 0 } as Record<'apply' | 'recordHold' | 'holdSuperseded' | 'couponCount' | 'refund' | 'counterRef' | 'rzpCreate' | 'attach', number>,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_c02',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        if (h.fail.rzpCreate > 0) { h.fail.rzpCreate--; throw new Error('simulated Razorpay order creation failure') }
        const order = { id: `order_c02_${++h.seq}`, amount: o.amount, currency: o.currency }
        h.orders.push(order)
        return order
      },
      fetchPayments: async (id: string) => {
        if (h.onFetch) { const f = h.onFetch; h.onFetch = null; await f() }   // RD-M4 — settle mid-lookup
        const mode = h.fetchPlan.shift() ?? 'normal'
        if (mode === 'throw') throw new Error('simulated Razorpay timeout / network failure')
        if (mode === 'malformed') return { entity: 'collection', count: 1 }          // no `items` array
        const c = h.captured.get(id)
        return { items: c ? [{ id: `pay_cap_${id}`, status: c.status ?? 'captured', amount: c.amount, currency: 'INR' }] : [] }
      },
    },
    payments: {
      fetch: async (id: string) => {
        const p = h.payments.get(id)
        if (!p) throw new Error('payment not found')
        return p
      },
      refund: async () => {
        if (h.onRefund) { const f = h.onRefund; h.onRefund = null; await f() }
        if (h.fail.refund > 0) { h.fail.refund--; throw new Error('simulated gateway refund failure') }
        return { id: `rfnd_c02_${++h.seq}` }
      },
    },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who === 'anon' ? null : { uid: h.who || UID, email: null }),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = () => ({ callerUid: h.who || UID, workspaceUid: h.who || UID, role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false })
  return {
    ...(await orig<typeof import('@/lib/team/workspace')>()),
    resolveWorkspaceUid: async () => ctx(),
    authorizeWorkspace:  async () => (h.who === 'anon'
      ? { ok: false, status: 401, error: 'Unauthorized' }
      : { ...ctx(), ok: true, status: 200, error: '' }),
  }
})
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/events/reviewNotifications', () => ({ sendEventReviewEmail: async () => undefined }))
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))
vi.mock('@/lib/licensing/serviceAllowanceConfig', async () => {
  // RD-EVENT-COMMERCE-05 — the route now asks for the catalog WITH each service's sale state.
  const { serviceSaleState, SERVICE_KINDS } = await import('@/lib/licensing/serviceAllowances')
  return {
    getServiceAllowancesConfig: async () => h.catalog,
    getServiceCatalog: async () => ({ config: h.catalog, state: Object.fromEntries(SERVICE_KINDS.map(k => [k, serviceSaleState((h.catalog as never)[k])])) }),
  }
})
vi.mock('@/lib/licensing/mediaAllowance', () => ({ mediaBasePhotoCap: async () => 0, MEDIA_UNLIMITED_MESSAGE: 'no cap' }))   // RD-PHOTO-01: no free base
vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({
    sendTemplate: async (m: { to?: string }) => {
      h.sends.push(String(m.to ?? ''))
      return h.sendOk ? { success: true, messageId: `wamid_${h.sends.length}` } : { success: false, httpStatus: 400, error: 'rejected' }
    },
  }),
  resolveWhatsAppTemplate: (_t: unknown, to: string) => ({ ok: true, message: { to, templateName: 'registration_confirmation' } }),
}))
vi.mock('@/lib/email-logs/write', () => ({ writeEmailLog: async () => 'log', updateEmailLog: async () => undefined }))
// RD-F3 — transient-failure injection around the REAL functions (default: no failure → unchanged).
vi.mock('@/lib/licensing/capacityChange', async orig => {
  const real = await orig<typeof import('@/lib/licensing/capacityChange')>()
  return { ...real,
    applyCapacityChange: async (...a: Parameters<typeof real.applyCapacityChange>) => {
      if (h.fail.apply > 0) { h.fail.apply--; throw new Error('simulated transient Firestore failure (apply)') }
      if (h.beforeApply) { const f = h.beforeApply; h.beforeApply = null; await f() }   // RD-L6 D2 — interleave
      return real.applyCapacityChange(...a)
    },
    attachCapacityRazorpayOrder: async (...a: Parameters<typeof real.attachCapacityRazorpayOrder>) => {
      if (h.fail.attach > 0) { h.fail.attach--; throw new Error('simulated Firestore failure (attach Razorpay id)') }
      return real.attachCapacityRazorpayOrder(...a)
    },
  }
})
vi.mock('@/lib/licensing/manualRefundHold', async orig => {
  const real = await orig<typeof import('@/lib/licensing/manualRefundHold')>()
  return { ...real,
    recordManualRefundHold: async (...a: Parameters<typeof real.recordManualRefundHold>) => {
      if (h.fail.recordHold > 0) { h.fail.recordHold--; throw new Error('simulated transient Firestore failure (hold)') }
      return real.recordManualRefundHold(...a)
    },
    holdSupersededPayment: async (...a: Parameters<typeof real.holdSupersededPayment>) => {
      if (h.fail.holdSuperseded > 0) { h.fail.holdSuperseded--; throw new Error('simulated transient Firestore failure (superseded hold)') }
      return real.holdSupersededPayment(...a)
    },
  }
})
// RD-M4 — run a replacement between a caller's read and the REAL activation transaction.
vi.mock('@/lib/licensing/finalizeLicensePurchase', async orig => {
  const real = await orig<typeof import('@/lib/licensing/finalizeLicensePurchase')>()
  return { ...real, activateLicenseOrder: async (...a: Parameters<typeof real.activateLicenseOrder>) => {
    if (h.beforeActivate) { const f = h.beforeActivate; h.beforeActivate = null; await f() }
    return real.activateLicenseOrder(...a)
  } }
})
// RD-M5 — licence coupons ENABLED for these tests (Business Configuration defaults them OFF), and a
// switch that makes the organizer-usage lookup unverifiable. Everything else in the module is real.
vi.mock('@/lib/licensing/coupons', async orig => {
  const real = await orig<typeof import('@/lib/licensing/coupons')>()
  return { ...real,
    getLicenseCouponsConfig: async () => ({ enabled: true, maxPercentageDiscount: 100, maxFixedDiscountPaise: 0, allowFreeLicense: true, allowStacking: false }),
    countOrganizerCouponRedemptions: async (...a: Parameters<typeof real.countOrganizerCouponRedemptions>) => {
      if (h.fail.couponCount > 0) { h.fail.couponCount--; return { ok: false as const } }
      return real.countOrganizerCouponRedemptions(...a)
    },
    organizerRedemptionCounterRef: (...a: Parameters<typeof real.organizerRedemptionCounterRef>) => {
      if (h.fail.counterRef > 0) { h.fail.counterRef--; throw new Error('simulated Firestore failure (counter)') }
      return real.organizerRedemptionCounterRef(...a)
    },
  }
})
// RD-F2 — a TEST-ONLY webhook signing secret, so the real /api/webhooks/razorpay route can be driven.
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: 'whsec_f2_test_only' }))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return {
    ...real,
    getCommunicationConfig: async () => {
      const c = await real.getCommunicationConfig()
      return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50, walletChargeAttendeeNotifications: true } }
    },
  }
})

// TEST-ONLY catalog values.
const WA   = { enabled: true, unitPricePaise: 45,  gstRatePercent: 18, minQuantity: 100, maxQuantity: 50_000, presets: [], onExhausted: 'block' as const }
const CERT = { enabled: true, unitPricePaise: 200, gstRatePercent: 18, minQuantity: 10,  maxQuantity: 10_000, presets: [], onExhausted: 'wallet_payg' as const }
const UNCONFIGURED = { enabled: false, unitPricePaise: null, gstRatePercent: null, minQuantity: 1, maxQuantity: null, presets: [], onExhausted: null }

const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex')
const req = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
})

function draftDoc(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, uid: UID, status: 'draft', lifecycleStatus: 'draft', currentStep: 6, completedValues: Array(9).fill(null),
    eventType: 'conference', eventSubtype: 'tech', customEventSubtype: null, campaignType: 'event_only', linkedCampaign: null,
    visibility: 'public', accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    pricing: { eventType: 'paid', feeModel: 'organizer_pays', whatsappEnabled: true, passes: [{
      id: 'pass_0', name: 'Standard', code: 'STD', description: 'General admission.', type: 'paid', price: 1500,
      earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '', unlimited: true, quantity: null,
      minPurchase: 1, maxPurchase: 5, hideWhenSoldOut: false, salesStartDate: '2026-01-01', salesEndDate: '2099-12-30',
      showRemainingSeats: true, visibility: 'public', featured: false, benefits: ['Entry'], customBenefits: [],
      raceDetails: null, eventType: 'conference', eventSubtype: 'tech',
      advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, status: 'active' }] },
    registrationForm: { template: 'standard', fields: [
      { id: 'f0', label: 'Company', type: 'text', required: false, placeholder: '', helpText: '', options: [], linkedPassIds: [] }] },
    eventDetails: {
      info: { name: `C02 ${id}`, tagline: 'Commerce', description: 'An event used to verify prepaid service allowances end to end. '.repeat(3),
        coverImage: 'https://example.test/cover.jpg', logoUrl: 'https://example.test/logo.png', socialLinks: [] },
      schedule: { startDate: '2099-12-31', startTime: '09:00', endDate: '2099-12-31', endTime: '17:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: 'BIEC', address: 'Tumkur Road', city: 'Bengaluru', state: 'Karnataka' } },
      organizer: { name: 'C02 Events', email: 'c02@example.test', phone: '+919999999999', website: 'https://example.test' },
    },
    communicationBilling: null, licenseTier: 'free', publishedAt: null, registrationCapacity: 437,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  }
}

describeEmu('RD-EVENT-COMMERCE-02 · prepaid services on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let purchase: (r: NextRequest) => Promise<Response>
  let confirm:  (r: NextRequest) => Promise<Response>
  let publish:  (r: NextRequest) => Promise<Response>
  let pubPurchase: (r: NextRequest) => Promise<Response>
  let capConfirm:  (r: NextRequest) => Promise<Response>
  let ledgerMod: typeof import('@/lib/licensing/serviceAllowanceLedger')
  let billing:  typeof import('@/lib/communications/billing')
  let sendWa:   typeof import('@/lib/registrations/sendWhatsAppConfirmation').sendWhatsAppConfirmation
  const drafts = new Set<string>(), slugs = new Set<string>(), extraDocs = new Set<string>()

  const id = (s: string) => `c02-${s}-${process.pid}`
  const seed = async (draftId: string, extra: Record<string, unknown> = {}) => { drafts.add(draftId); await adminDb.doc(`users/${UID}/eventDrafts/${draftId}`).set(draftDoc(draftId, extra)) }
  const ledger = async (draftId: string) => (await adminDb.doc(`eventServiceAllowances/${draftId}`).get()).data() as Record<string, { purchased?: number; consumed?: number } | unknown> | undefined
  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

  async function pay(order: { id: string; amount: number }, eventId: string, orderId?: string) {
    // RD-CE-FIX M4 — a REPLAY (browser retry / webhook race) re-presents the SAME payment. A fresh
    // payment id on an already-paid order is a genuine second capture, which is now held for review.
    const prior = [...h.payments.values()].find(p => (p as { order_id?: string }).order_id === order.id) as { id: string } | undefined
    const paymentId = prior?.id ?? `pay_c02_${++h.seq}`
    h.payments.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' })
    return json(await confirm(req({ eventId, ...(orderId ? { orderId } : {}), razorpay_order_id: order.id, razorpay_payment_id: paymentId, razorpay_signature: sign(order.id, paymentId) })))
  }

  async function wipe() {
    for (const d of drafts) {
      await adminDb.doc(`users/${UID}/eventDrafts/${d}`).delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${d}`)).catch(() => null)
      for (const o of (await adminDb.collection('licenseOrders').where('eventId', '==', d).get()).docs) await o.ref.delete()
      await adminDb.doc(`publishBaselines/${d}`).delete().catch(() => null)
    }
    for (const s of slugs) for (const c of ['events', 'eventLicenses', 'registrationCounters', 'publishBaselines']) await adminDb.recursiveDelete(adminDb.doc(`${c}/${s}`)).catch(() => null)
    for (const s of slugs) for (const o of (await adminDb.collection('licenseOrders').where('eventId', '==', s).get()).docs) await o.ref.delete()
    for (const p of extraDocs) await adminDb.doc(p).delete().catch(() => null)
    for (const d of (await adminDb.collection('licenseHistory').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    await walletRef().delete().catch(() => null)
    drafts.clear(); slugs.clear(); extraDocs.clear()
    h.orders.length = 0; h.payments.clear(); h.captured.clear(); h.sends.length = 0; h.sendOk = true
    h.catalog = { whatsapp: WA, certificates: CERT, media: UNCONFIGURED }
    h.who = ''
    h.fail = { apply: 0, recordHold: 0, holdSuperseded: 0, couponCount: 0, refund: 0, counterRef: 0, rzpCreate: 0, attach: 0 }
    h.fetchPlan = []
    h.beforeActivate = null; h.onFetch = null; h.onRefund = null; h.beforeApply = null
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    ;({ POST: confirm }  = await import('@/app/api/licensing/checkout/confirm/route'))
    ;publish  = withPublishAgreement((await import('@/app/api/events/publish/route')).POST)
    ;({ POST: pubPurchase } = await import('@/app/api/licensing/published/purchase/route'))
    ;({ POST: capConfirm }  = await import('@/app/api/licensing/capacity/confirm/route'))
    ledgerMod = await import('@/lib/licensing/serviceAllowanceLedger')
    billing   = await import('@/lib/communications/billing')
    ;({ sendWhatsAppConfirmation: sendWa } = await import('@/lib/registrations/sendWhatsAppConfirmation'))
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', emailVerified: true }, { merge: true })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)
  beforeEach(wipe, T)

  it('one combined order: capacity + WhatsApp + certificates, exact paise; applied exactly once', async () => {
    const d = id('combined'); await seed(d)
    const p = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 1_000, certificates: 300 } })))
    expect(p.status).toBe(200)
    // activation 337×150 = 50,550 + 9,099 GST; WA 1,000×45 = 45,000 + 8,100; CERT 300×200 = 60,000 + 10,800
    const expected = 59_649 + 53_100 + 70_800
    expect(h.orders).toHaveLength(1)
    expect(h.orders[0].amount).toBe(expected)
    const created = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
    expect(created.amountPaise).toBe(expected)
    expect(created.servicesTotalPaise).toBe(53_100 + 70_800)
    expect(created.selection).toEqual({ capacity: 437, services: { whatsapp: 1_000, certificates: 300, media: 0 } })

    const c = await pay(h.orders[0], d)
    expect(c.status).toBe(200)
    const l = await ledger(d)
    expect((l!.whatsapp as { purchased: number }).purchased).toBe(1_000)
    expect((l!.certificates as { purchased: number }).purchased).toBe(300)

    // A replayed confirm (browser retry / webhook race) applies nothing twice.
    const again = await pay(h.orders[0], d)
    expect(again.status).toBe(200)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(1_000)
    const paid = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
    expect(paid.status).toBe('paid')
    expect(paid.serviceItems).toHaveLength(2)
  }, T)

  it('fail closed: an unconfigured service cannot be bought and creates no order', async () => {
    h.catalog = { whatsapp: UNCONFIGURED, certificates: CERT, media: UNCONFIGURED }
    const d = id('unconfigured'); await seed(d)
    const p = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } })))
    expect(p.status).toBe(422)
    expect(p.body.code).toBe('NOT_PURCHASABLE')
    expect(h.orders).toHaveLength(0)
    expect((await adminDb.doc(`licenseOrders/lic_${d}`).get()).exists).toBe(false)
  }, T)

  it('invalid quantities are refused before pricing', async () => {
    const d = id('invalid'); await seed(d)
    for (const services of [{ whatsapp: 5.5 }, { whatsapp: -1 }, { whatsapp: '500' }, { sms: 10 }, { whatsapp: 99 }, { whatsapp: 50_001 }]) {
      const r = await purchase(req({ eventId: d, capacity: 437, services }))
      expect([400, 422], JSON.stringify(services)).toContain(r.status)
    }
    expect(h.orders).toHaveLength(0)
  }, T)

  it('a forged amount in the body is ignored and a short payment is refused', async () => {
    const d = id('forged'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 100 }, amountPaise: 1, totalPaise: 1 }))
    expect(h.orders[0].amount).toBe(59_649 + 5_310)
    const paymentId = 'pay_short'
    h.payments.set(paymentId, { id: paymentId, order_id: h.orders[0].id, amount: 100, currency: 'INR', status: 'captured' })
    const r = await confirm(req({ eventId: d, razorpay_order_id: h.orders[0].id, razorpay_payment_id: paymentId, razorpay_signature: sign(h.orders[0].id, paymentId) }))
    expect(r.status).toBe(400)
    expect(await ledger(d)).toBeUndefined()
  }, T)

  it('free capacity with services still creates one payable order', async () => {
    const d = id('freecap'); await seed(d, { registrationCapacity: 100 })
    const p = await json(await purchase(req({ eventId: d, capacity: 100, services: { certificates: 50 } })))
    expect(p.status).toBe(200)
    expect(h.orders[0].amount).toBe(11_800)
    expect((await pay(h.orders[0], d)).status).toBe(200)
    expect(((await ledger(d))!.certificates as { purchased: number }).purchased).toBe(50)
  }, T)

  it('add-on: after payment only the DIFFERENCE is charged; identical re-request reuses; change supersedes', async () => {
    const d = id('addon'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect((await pay(h.orders[0], d)).status).toBe(200)

    // Covered selection (lower) → alreadyPaid, no new order.
    const covered = await json(await purchase(req({ eventId: d, capacity: 300, services: { whatsapp: 200 } })))
    expect(covered.body.alreadyPaid).toBe(true)
    expect(h.orders).toHaveLength(1)

    // More WhatsApp + more capacity → one add-on for the difference.
    const a1 = await json(await purchase(req({ eventId: d, capacity: 600, services: { whatsapp: 800 } })))
    expect(a1.body.purpose).toBe('addon')
    // capacity 437→600: 163×150 = 24,450 + 4,401 ; WA 300×45 = 13,500 + 2,430
    expect(h.orders[1].amount).toBe(28_851 + 15_930)
    // Same selection again → the SAME order (no second Razorpay order).
    const a2 = await json(await purchase(req({ eventId: d, capacity: 600, services: { whatsapp: 800 } })))
    expect(a2.body.orderId).toBe(a1.body.orderId)
    expect(h.orders).toHaveLength(2)
    // Changed selection (unpaid, nothing captured) → the old one is superseded.
    const a3 = await json(await purchase(req({ eventId: d, capacity: 600, services: { whatsapp: 900 } })))
    expect(a3.body.orderId).not.toBe(a1.body.orderId)
    expect((await adminDb.doc(`licenseOrders/${a1.body.orderId}`).get()).data()!.status).toBe('failed')

    const c = await pay(h.orders[2], d, a3.body.orderId as string)
    expect(c.status).toBe(200)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(900)
    // Replaying the add-on confirm applies nothing twice.
    await pay(h.orders[2], d, a3.body.orderId as string)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(900)

    // Publish at 600 is covered by the add-on; the services selection is covered.
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 600, serviceSelection: { whatsapp: 900, certificates: 0 } })
    const pub = await json(await publish(req({ draftId: d })))
    if (typeof pub.body.slug === 'string') slugs.add(pub.body.slug)
    expect(pub.status).toBe(200)
    expect((await adminDb.doc(`events/${pub.body.slug}`).get()).data()!.totalCapacity).toBe(600)
  }, T)

  it('a pending add-on with a CAPTURED payment is never superseded', async () => {
    const d = id('captured'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437 })); await pay(h.orders[0], d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 200 } }))
    h.captured.set(h.orders[1].id, { amount: h.orders[1].amount })
    const r = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 300 } })))
    expect(r.status).toBe(409)
    expect(h.orders).toHaveLength(2)
  }, T)

  it('publish refuses a services selection the ledger does not cover', async () => {
    const d = id('pubsvc'); await seed(d, { serviceSelection: { whatsapp: 500, certificates: 0 } })
    await purchase(req({ eventId: d, capacity: 437 })); await pay(h.orders[0], d)
    const r = await json(await publish(req({ draftId: d })))
    expect(r.status).toBe(402)
    expect(r.body.reason).toBe('SERVICES_PAYMENT_REQUIRED')
  }, T)

  // ═══ RD-EVENT-COMMERCE-05B · "Pay & Submit Event" on the FINAL step — the server side ═══════
  // The page runs: purchase → Razorpay → confirm (VERIFIED) → publish. These are the guarantees
  // that make that safe whatever the browser does: no submission before a verified payment, one
  // submission, one grant, and a failed submission after payment is retried with NO new charge.
  it('05B · Pay & Submit: never submitted before a verified payment; verified → submitted exactly once; failed submission retries without a new order', async () => {
    const d = id('paysubmit'); await seed(d, { serviceSelection: { whatsapp: 500, certificates: 0 } })

    // 1. Submit before paying (e.g. a forged / skipped payment step) → refused, nothing created.
    const early = await json(await publish(req({ draftId: d })))
    expect(early.status).toBe(402)
    expect((await adminDb.collection('events').where('draftId', '==', d).get()).size).toBe(0)

    // 2. The order exists but the checkout was cancelled / never paid → still refused.
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect(h.orders).toHaveLength(1)
    expect((await json(await publish(req({ draftId: d })))).status).toBe(402)
    expect(await ledger(d)).toBeUndefined()                                   // nothing granted

    // 3. Verified payment → allowance granted ONCE (a duplicate confirmation changes nothing).
    expect((await pay(h.orders[0], d)).status).toBe(200)
    await pay(h.orders[0], d)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)

    // 4. Submission fails AFTER payment (a readiness problem) → the event is not created …
    const good = (await adminDb.doc(`users/${UID}/eventDrafts/${d}`).get()).data()!
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ 'eventDetails.info.name': '' })
    const failed = await json(await publish(req({ draftId: d })))
    expect(failed.status).not.toBe(200)
    expect((await adminDb.collection('events').where('draftId', '==', d).get()).size).toBe(0)

    // … the organizer fixes it and retries: covered by the PAID orders — no new order, no charge.
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ 'eventDetails.info.name': good.eventDetails.info.name })
    const ok = await json(await publish(req({ draftId: d })))
    if (typeof ok.body.slug === 'string') slugs.add(ok.body.slug)
    expect(ok.status).toBe(200)
    expect(h.orders).toHaveLength(1)                                          // still ONE Razorpay order

    // 5. A repeated submit (double click / refresh / replay) never submits twice.
    const again = await json(await publish(req({ draftId: d })))
    expect(again.status).not.toBe(200)
    expect((await adminDb.collection('events').where('draftId', '==', d).get()).size).toBe(1)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)

    // RD-PHASE4-S3 · Q1 — SUPERSEDES 05C: the organizer no longer chooses the Fee Collection Method, and
    // publish stores the fixed organizer-pays model whatever the (organizer-controlled) draft carried.
    const live = (await adminDb.doc(`events/${ok.body.slug}`).get()).data()!
    expect((good.pricing as { feeModel?: string }).feeModel).not.toBe('organizer_absorbs')     // the draft said otherwise
    expect((live.pricing as { feeModel?: string }).feeModel).toBe('organizer_absorbs')

    // 6. No refund or refund-hold anywhere in the sequence.
    expect((await adminDb.collection('failedRefunds').where('eventId', '==', d).get()).size).toBe(0)
    for (const o of (await adminDb.collection('licenseOrders').where('eventId', '==', d).get()).docs) expect(o.get('status')).toBe('paid')
  }, T)

  it('05C · "Publish Event" with nothing payable (free capacity, no services) creates NO order', async () => {
    const d = id('freepub'); await seed(d, { registrationCapacity: 100, serviceSelection: { whatsapp: 0, certificates: 0 } })
    const r = await json(await publish(req({ draftId: d })))
    if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(r.status).toBe(200)
    expect(h.orders).toHaveLength(0)
    expect((await adminDb.collection('licenseOrders').where('eventId', '==', d).get()).size).toBe(0)
  }, T)

  // ═══ RD-EVENT-COMMERCE-05F · the Publish Agreement is enforced on the SERVER ═══════════════
  const AGREE = { accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true }

  it('05F · no Razorpay order and no publication without the Publish Agreement — missing, partial or forged', async () => {
    const d = id('agree-none'); await seed(d, { serviceSelection: { whatsapp: 500, certificates: 0 } })
    for (const bad of [
      {},                                                                   // nothing ticked
      { ...AGREE, settlementFeePolicy: undefined },                        // paid event, fee policy missing
      { ...AGREE, termsOfService: 'true' },                                // forged string
      { ...AGREE, privacyPolicy: 1 },                                      // forged number
      { ...AGREE, accurateInformation: false },
      'yes', [true, true, true, true],                                     // malformed
    ]) {
      const r = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 }, agreement: bad })))
      expect(r.status, JSON.stringify(bad)).toBe(422)
      expect(r.body.code).toBe('AGREEMENT_REQUIRED')
      const pub = await json(await publish(req({ draftId: d, agreement: bad })))
      expect(pub.status, JSON.stringify(bad)).toBe(422)
      expect(pub.body.reason).toBe('AGREEMENT_REQUIRED')
    }
    // A request with the key omitted entirely is refused the same way (bypassing the wrapper).
    const { POST: rawPublish } = await import('@/app/api/events/publish/route')
    const { POST: rawPurchase } = await import('@/app/api/licensing/purchase/route')
    expect((await rawPurchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))).status).toBe(422)
    expect((await rawPublish(req({ draftId: d }))).status).toBe(422)
    expect(h.orders).toHaveLength(0)                                                         // no Razorpay order
    expect((await adminDb.collection('licenseOrders').where('eventId', '==', d).get()).size).toBe(0)
    expect((await adminDb.collection('events').where('draftId', '==', d).get()).size).toBe(0)
    expect((await adminDb.doc(`users/${UID}/eventDrafts/${d}`).get()).data()!.status).toBe('draft')
  }, T)

  it('05F · accepted → one order → published only after verified payment; the consent is recorded once; recovery never charges again', async () => {
    const d = id('agree-ok'); await seed(d, { serviceSelection: { whatsapp: 500, certificates: 0 } })
    expect((await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 }, agreement: AGREE })))).status).toBe(200)
    expect(h.orders).toHaveLength(1)
    // Not published before a verified payment, even with a valid agreement.
    expect((await json(await publish(req({ draftId: d, agreement: AGREE })))).status).toBe(402)
    expect((await pay(h.orders[0], d)).status).toBe(200)
    await pay(h.orders[0], d)                                                                 // duplicate callback
    // Verified payment, but the submission arrives WITHOUT consent → refused, nothing charged again …
    expect((await json(await publish(req({ draftId: d, agreement: {} })))).status).toBe(422)
    // … the organizer ticks it again (the page keeps the ticks) and retries: covered, no new order.
    const ok = await json(await publish(req({ draftId: d, agreement: AGREE })))
    if (typeof ok.body.slug === 'string') slugs.add(ok.body.slug)
    expect(ok.status).toBe(200)
    expect(h.orders).toHaveLength(1)
    // Recorded atomically on the event AND the draft: the items, the documents, who — and NO version
    // (none exists for organizers).
    const ev = (await adminDb.doc(`events/${ok.body.slug}`).get()).data()!
    const dr = (await adminDb.doc(`users/${UID}/eventDrafts/${d}`).get()).data()!
    for (const rec of [ev.publishAgreement, dr.publishAgreement]) {
      expect(rec).toMatchObject({ items: AGREE, documents: { termsOfService: '/terms', privacyPolicy: '/privacy' }, acceptedBy: UID })
      expect(rec.acceptedAt).toBeDefined()
      expect(rec.version).toBeUndefined()
    }
    // A repeated submission neither re-publishes nor re-stamps consent.
    const stamp = JSON.stringify(ev.publishAgreement.acceptedAt)
    expect((await json(await publish(req({ draftId: d, agreement: AGREE })))).status).not.toBe(200)
    expect((await adminDb.collection('events').where('draftId', '==', d).get()).size).toBe(1)
    expect(JSON.stringify((await adminDb.doc(`events/${ok.body.slug}`).get()).data()!.publishAgreement.acceptedAt)).toBe(stamp)
    expect((await adminDb.collection('failedRefunds').where('eventId', '==', d).get()).size).toBe(0)   // no refunds
  }, T)

  it('05F · a FREE event: "Publish Event" needs the three items (no fee-policy item), creates no order', async () => {
    const base = draftDoc('x').pricing as Record<string, unknown>
    const freePass = { ...(base.passes as Record<string, unknown>[])[0], type: 'free', price: 0 }
    const d = id('agree-free')
    await seed(d, { registrationCapacity: 100, serviceSelection: { whatsapp: 0, certificates: 0 },
      pricing: { ...base, eventType: 'free', whatsappEnabled: false, passes: [freePass] } })
    const three = { accurateInformation: true, termsOfService: true, privacyPolicy: true }
    expect((await json(await publish(req({ draftId: d, agreement: { accurateInformation: true, termsOfService: true } })))).status).toBe(422)
    const r = await json(await publish(req({ draftId: d, agreement: three })))
    if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(r.status).toBe(200)
    expect(h.orders).toHaveLength(0)
    const rec = (await adminDb.doc(`events/${r.body.slug}`).get()).data()!.publishAgreement
    expect(rec.items).toEqual(three)                                                          // nothing not asked for is recorded
  }, T)

  // ═══ RD-HIGH-1 · a paid capacity entitlement publishes its OWN event, exactly once ════════
  /** A paid 437-capacity activation for draft `d` (the real purchase + verified confirm). */
  async function paidDraft(tag: string) {
    const d = id(tag); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    const before = h.orders.length
    expect((await json(await purchase(req({ eventId: d, capacity: 437 })))).status).toBe(200)
    expect((await pay(h.orders[before], d)).status).toBe(200)
    return d
  }
  const eventsOf = async (d: string) => (await adminDb.collection('events').where('draftId', '==', d).get()).docs
  const draftOf  = async (d: string) => (await adminDb.doc(`users/${UID}/eventDrafts/${d}`).get()).data()!
  const orderOf  = async (d: string) => (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!

  it('HIGH-1 · a valid paid entitlement publishes its intended event ONCE and is consumed in the same commit', async () => {
    const d = await paidDraft('h1-once')
    const r = await json(await publish(req({ draftId: d })))
    if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(r.status).toBe(200)
    const o = await orderOf(d)
    expect(o).toMatchObject({ consumed: true, boundEventId: d, eventSlug: r.body.slug, organizerUid: UID, status: 'paid' })
    expect((await eventsOf(d)).map(e => e.get('totalCapacity'))).toEqual([437])
    // A retry of the same publish never consumes or creates again.
    const again = await json(await publish(req({ draftId: d })))
    expect(again.status).not.toBe(200)
    expect(again.body.reason).toBe('EVENT_ALREADY_PUBLISHED')
    expect(await eventsOf(d)).toHaveLength(1)
    expect(h.orders).toHaveLength(1)
  }, T)

  it('HIGH-1 · a changed slug + an already-submitted status (pending, rejected) cannot mint a second event', async () => {
    const d = await paidDraft('h1-slug')
    const first = await json(await publish(req({ draftId: d })))
    if (typeof first.body.slug === 'string') slugs.add(first.body.slug)
    expect(first.status).toBe(200)
    // What a browser can do to its own draft: a NEW slug (rules allow eventDetails).
    const slug2 = `h1-second-${process.pid}`; slugs.add(slug2)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ 'eventDetails.seo.urlSlug': slug2 })
    const whileSubmitted = await json(await publish(req({ draftId: d })))
    expect(whileSubmitted.status).toBe(409)
    expect(whileSubmitted.body.reason).toBe('EVENT_ALREADY_PUBLISHED')
    // The server moves the draft back to 'draft' (as reject / unpublish / restore do) — publishedAt stays.
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ status: 'draft', lifecycleStatus: 'rejected' })
    const afterReject = await json(await publish(req({ draftId: d })))
    expect(afterReject.status).toBe(409)
    expect(afterReject.body.reason).toBe('ENTITLEMENT_ALREADY_USED')
    expect(await eventsOf(d)).toHaveLength(1)
    expect((await adminDb.doc(`events/${slug2}`).get()).exists).toBe(false)
    expect((await adminDb.doc(`eventLicenses/${slug2}`).get()).exists).toBe(false)
    expect(h.orders).toHaveLength(1)
  }, T)

  it('HIGH-1 · the in-transaction check alone: a consumed entitlement cannot publish even if the draft looks unsubmitted', async () => {
    const d = await paidDraft('h1-consumed')
    // Simulate the fast check being bypassed: the draft reads unsubmitted, but its paid order is
    // already consumed by another event.
    await adminDb.doc(`licenseOrders/lic_${d}`).set({ consumed: true, boundEventId: 'some-other-draft' }, { merge: true })
    const r = await json(await publish(req({ draftId: d })))
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('ENTITLEMENT_ALREADY_USED')
    expect(await eventsOf(d)).toHaveLength(0)
    expect((await draftOf(d)).status).toBe('draft')
  }, T)

  it('HIGH-1 · a mismatched or foreign paid entitlement cannot publish (owner, draft, status)', async () => {
    for (const bad of [{ organizerUid: 'someone-else' }, { eventId: 'another-draft' }, { organizerUid: null }]) {
      const d = await paidDraft(`h1-bad-${Object.keys(bad)[0]}-${String(Object.values(bad)[0])}`)
      await adminDb.doc(`licenseOrders/lic_${d}`).set(bad, { merge: true })
      const r = await json(await publish(req({ draftId: d })))
      expect(r.status, JSON.stringify(bad)).toBe(403)
      expect(r.body.reason).toBe('ENTITLEMENT_INVALID')
      expect(await eventsOf(d)).toHaveLength(0)
    }
  }, T)

  it('HIGH-1 · CONCURRENT publishes of one draft consume the entitlement once and create ONE event', async () => {
    const d = await paidDraft('h1-race')
    const results = await Promise.all([0, 1, 2].map(() => publish(req({ draftId: d })).then(json)))
    for (const r of results) if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(await eventsOf(d)).toHaveLength(1)
    expect((await orderOf(d)).consumed).toBe(true)
  }, T)

  it('HIGH-1 · a NEW event needs its own entitlement: another draft\'s consumed payment never covers it', async () => {
    const d1 = await paidDraft('h1-first')
    const p1 = await json(await publish(req({ draftId: d1 })))
    if (typeof p1.body.slug === 'string') slugs.add(p1.body.slug)
    expect(p1.status).toBe(200)
    const d2 = id('h1-new'); await seed(d2, { serviceSelection: { whatsapp: 0, certificates: 0 } })   // same capacity, own draft id
    const r = await json(await publish(req({ draftId: d2 })))
    expect(r.status).toBe(402)
    expect(r.body.reason).toBe('CAPACITY_PAYMENT_REQUIRED')
    expect(await eventsOf(d2)).toHaveLength(0)
    // …and with its OWN payment it publishes normally.
    const before = h.orders.length
    expect((await json(await purchase(req({ eventId: d2, capacity: 437 })))).status).toBe(200)
    expect((await pay(h.orders[before], d2)).status).toBe(200)
    const ok = await json(await publish(req({ draftId: d2 })))
    if (typeof ok.body.slug === 'string') slugs.add(ok.body.slug)
    expect(ok.status).toBe(200)
    // A free (≤ 100) new event still needs no payment at all.
    const d3 = id('h1-free'); await seed(d3, { registrationCapacity: 100, serviceSelection: { whatsapp: 0, certificates: 0 } })
    const free = await json(await publish(req({ draftId: d3 })))
    if (typeof free.body.slug === 'string') slugs.add(free.body.slug)
    expect(free.status).toBe(200)
  }, T)

  it('HIGH-1 · the published event keeps its OWN flows: Save Changes and an incremental capacity purchase still work', async () => {
    const d = await paidDraft('h1-edit')
    const r = await json(await publish(req({ draftId: d })))
    const slug = r.body.slug as string; slugs.add(slug)
    expect(r.status).toBe(200)
    // Auto-approve so Save Changes applies (it is for published events).
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ status: 'published', lifecycleStatus: 'published' })
    await adminDb.doc(`events/${slug}`).update({ lifecycleStatus: 'published' })
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ 'eventDetails.info.tagline': 'Edited after publish' })
    const { POST: saveChanges } = await import('@/app/api/organizer/events/[eventId]/save-changes/route')
    const saved = await saveChanges(req({}), { params: Promise.resolve({ eventId: d }) })
    expect(saved.status).toBe(200)
    expect(((await adminDb.doc(`events/${slug}`).get()).data()!.eventDetails as { info: { tagline: string } }).info.tagline).toBe('Edited after publish')
    // Capacity increase through the existing incremental purchase + verified payment.
    const before = h.orders.length
    const inc = await json(await pubPurchase(req({ eventId: d, capacity: 600 })))
    expect(inc.status).toBe(200)
    expect((await payCap(h.orders[before], d, inc.body.orderId as string)).status).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity).toBe(600)
    expect(await eventsOf(d)).toHaveLength(1)
  }, T)

  it('HIGH-1 · historical compatibility: a never-submitted draft WITHOUT a publishedAt field publishes normally', async () => {
    const d = await paidDraft('h1-legacy')
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ publishedAt: FieldValue.delete() })
    const r = await json(await publish(req({ draftId: d })))
    if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(r.status).toBe(200)
    expect((await orderOf(d)).consumed).toBe(true)
  }, T)

  // ═══ RD-HIGH-2 · paid entitlements under a draft id are usable ONLY by their owner ═════════
  const ORG_B = `c02svc-orgB-${process.pid}`
  /** Organizer B creates a draft under A's (publicly visible) draft id — allowed by the rules. */
  async function cloneAsB(d: string, extra: Record<string, unknown> = {}) {
    await adminDb.doc(`users/${ORG_B}`).set({ uid: ORG_B, role: 'organizer', accountStatus: 'active', emailVerified: true })
    const clone = draftDoc(d, { uid: ORG_B, serviceSelection: { whatsapp: 500, certificates: 0 }, ...extra }) as Record<string, unknown>
    ;(clone.eventDetails as Record<string, unknown>).seo = { urlSlug: `h2-clone-${process.pid}` }
    await adminDb.doc(`users/${ORG_B}/eventDrafts/${d}`).set(clone)
    extraDocs.add(`users/${ORG_B}/eventDrafts/${d}`); extraDocs.add(`users/${ORG_B}`)
    slugs.add(`h2-clone-${process.pid}`)
  }
  /** A pays for draft d: 437 capacity + 500 WhatsApp (real purchase + verified confirm). */
  async function aPaid(tag: string) {
    const d = id(tag); await seed(d, { serviceSelection: { whatsapp: 500, certificates: 0 } })
    const before = h.orders.length
    expect((await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } })))).status).toBe(200)
    expect((await pay(h.orders[before], d)).status).toBe(200)
    return d
  }

  it('HIGH-2 · the rightful organizer uses their own paid entitlement normally', async () => {
    const d = await aPaid('h2-own')
    const r = await json(await publish(req({ draftId: d })))
    if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(r.status).toBe(200)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)
  }, T)

  it('HIGH-2 · organizer B cannot PUBLISH on organizer A’s paid activation + allowance (same draft id)', async () => {
    const d = await aPaid('h2-pub')
    await cloneAsB(d)
    h.who = ORG_B
    const r = await json(await publish(req({ draftId: d })))
    h.who = ''
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('ENTITLEMENT_INVALID')
    expect(String(r.body.error)).not.toContain(UID)                                           // non-disclosing
    expect((await adminDb.doc(`events/h2-clone-${process.pid}`).get()).exists).toBe(false)
    const lic = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
    expect(lic).toMatchObject({ organizerUid: UID, status: 'paid' })
    expect(lic.consumed).toBeUndefined()                                                      // A's entitlement untouched
    expect((await ledger(d))!.organizerUid).toBe(UID)
  }, T)

  it('HIGH-2 · organizer B cannot PURCHASE or CONFIRM against A’s draft id or order — even claiming A’s uid', async () => {
    const d = await aPaid('h2-buy')
    const aOrder = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
    await cloneAsB(d)
    const ordersBefore = h.orders.length
    h.who = ORG_B
    const buy = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 1_000 }, organizerUid: UID })))
    expect(buy.status).toBe(403)
    expect(buy.body.code).toBe('FORBIDDEN')
    // confirm A's order with A's own (valid) payment → refused before the payment is examined
    const payId = `pay_h2_${++h.seq}`
    h.payments.set(payId, { id: payId, order_id: aOrder.razorpayOrderId, amount: aOrder.razorpayAmountPaise, currency: 'INR', status: 'captured' })
    const conf = await confirm(req({ eventId: d, razorpay_order_id: aOrder.razorpayOrderId, razorpay_payment_id: payId, razorpay_signature: sign(aOrder.razorpayOrderId as string, payId) }))
    expect(conf.status).toBe(403)
    h.who = ''
    expect(h.orders.length).toBe(ordersBefore)                                                // no Razorpay order for B
    const lic = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
    expect(lic).toMatchObject({ organizerUid: UID, razorpayOrderId: aOrder.razorpayOrderId, status: 'paid' })
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)       // nothing merged in
    expect((await ledger(d))!.organizerUid).toBe(UID)
  }, T)

  it('HIGH-2 · B’s event under A’s draft id never draws on A’s allowance (runtime consumption)', async () => {
    const d = await aPaid('h2-use')
    const r = await json(await publish(req({ draftId: d })))
    if (typeof r.body.slug === 'string') slugs.add(r.body.slug)
    expect(await ledgerMod.draftIdForEventSlug(r.body.slug as string)).toBe(d)                // A's event → A's ledger
    const bSlug = `h2-b-live-${process.pid}`; slugs.add(bSlug)
    await adminDb.doc(`events/${bSlug}`).set({ uid: ORG_B, draftId: d, slug: bSlug })       // a pre-fix collision
    expect(await ledgerMod.draftIdForEventSlug(bSlug)).toBeNull()                            // → B's own PAYG path
  }, T)

  it('HIGH-2 · unauthenticated, owner-less and substituted-id requests grant nothing', async () => {
    const d = await aPaid('h2-neg')
    h.who = 'anon'
    expect((await purchase(req({ eventId: d, capacity: 437 }))).status).toBe(401)
    expect((await publish(req({ draftId: d }))).status).toBe(401)
    h.who = ''
    // A ledger with NO owner blocks publishing (fail closed — never assigned to anyone).
    await adminDb.doc(`eventServiceAllowances/${d}`).update({ organizerUid: FieldValue.delete() })
    const r = await json(await publish(req({ draftId: d })))
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('ENTITLEMENT_INVALID')
    // An empty / unknown draft id gives no access to anyone's records.
    expect((await purchase(req({ eventId: '', capacity: 437 }))).status).toBe(400)
    h.who = ORG_B
    expect((await publish(req({ draftId: d }))).status).toBe(404)                               // B has no such draft of its own
    h.who = ''
    expect(await adminDb.collection('events').where('draftId', '==', d).get().then(q => q.size)).toBe(0)
  }, T)

  // ═══ RD-F1 · capacity is granted only for a CAPTURED payment on a GRANTABLE order ═════════
  /** Confirm order `orderId` (Razorpay order `rzp`) with a payment the test fully controls. */
  async function capConfirmWith(d: string, orderId: string, rzp: { id: string; amount: number }, pay: Partial<{ status: string; amount: number; currency: string; order_id: string }> = {}, sentRzpOrderId?: string) {
    const paymentId = `pay_f1_${++h.seq}`
    h.payments.set(paymentId, { id: paymentId, order_id: rzp.id, amount: rzp.amount, currency: 'INR', status: 'captured', ...pay })
    const rid = sentRzpOrderId ?? rzp.id
    return { paymentId, res: await json(await capConfirm(req({ eventId: d, orderId, razorpay_order_id: rid, razorpay_payment_id: paymentId, razorpay_signature: sign(rid, paymentId) }))) }
  }
  const eventCap = async (slug: string) => (await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity as number

  it('F1 · a stale order put on HOLD is never applied — not even when its capacity is restored and the SAME payment is replayed', async () => {
    const d = id('f1-hold'), slug = `c02-f1-hold-${process.pid}`
    await seedPublished(d, slug, { capacity: 500, sold: 0 })
    // Order A (500 → 1,000), created through the real route.
    const A = await json(await pubPurchase(req({ eventId: d, capacity: 1_000 })))
    const oA = h.orders[h.orders.length - 1]
    // The capacity moves underneath A (RD-L6: a second PAYABLE order can no longer be opened while A is
    // pending — the routes supersede A instead — so the move is made directly, as an admin change would).
    await adminDb.doc(`events/${slug}`).update({ totalCapacity: 501 })
    const first = await capConfirmWith(d, A.body.orderId as string, oA)                          // A is now stale
    expect(first.res.status).toBe(409)
    expect(first.res.body.code).toBe('STALE_CAPACITY')
    const hold = (await adminDb.doc(`failedRefunds/license_hold_${A.body.orderId}`).get()).data()!
    expect(hold.status).toBe('open')
    extraDocs.add(`failedRefunds/license_hold_${A.body.orderId}`)
    // The capacity comes back to 500 (the value A was priced against)…
    await adminDb.doc(`events/${slug}`).update({ totalCapacity: 500 })
    // …and A's ORIGINAL, valid payment is replayed, and a second one too.
    for (const replay of [first.paymentId, null]) {
      const r = replay
        ? await json(await capConfirm(req({ eventId: d, orderId: A.body.orderId, razorpay_order_id: oA.id, razorpay_payment_id: replay, razorpay_signature: sign(oA.id, replay) })))
        : (await capConfirmWith(d, A.body.orderId as string, oA)).res
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('ORDER_NOT_PAYABLE')
    }
    expect(await eventCap(slug)).toBe(500)                                                       // never 1,000
    const orderA = (await adminDb.doc(`licenseOrders/${A.body.orderId}`).get()).data()!
    expect(orderA.status).toBe('failed')
    expect((await adminDb.doc(`failedRefunds/license_hold_${A.body.orderId}`).get()).data()!.status).toBe('open')   // one hold, still open
  }, T)

  it('F1 · an AUTHORIZED (not captured) payment grants nothing and is not flagged; once CAPTURED it applies exactly once', async () => {
    const d = id('f1-auth'), slug = `c02-f1-auth-${process.pid}`
    await seedPublished(d, slug, { capacity: 500, sold: 0 })
    const p = await json(await pubPurchase(req({ eventId: d, capacity: 600 })))
    const o = h.orders[h.orders.length - 1]
    const auth = await capConfirmWith(d, p.body.orderId as string, o, { status: 'authorized' })
    expect(auth.res.status).toBe(409)
    expect(auth.res.body.code).toBe('PAYMENT_NOT_CAPTURED')
    expect(await eventCap(slug)).toBe(500)
    expect((await adminDb.doc(`licenseOrders/${p.body.orderId}`).get()).data()!.status).toBe('created')   // still payable
    expect((await adminDb.collection('suspiciousPayments').where('paymentId', '==', auth.paymentId).get()).size).toBe(0)
    // Razorpay captures it → confirm applies once; a replay is idempotent.
    h.payments.set(auth.paymentId, { ...h.payments.get(auth.paymentId)!, status: 'captured' })
    const ok = await json(await capConfirm(req({ eventId: d, orderId: p.body.orderId, razorpay_order_id: o.id, razorpay_payment_id: auth.paymentId, razorpay_signature: sign(o.id, auth.paymentId) })))
    expect(ok.status).toBe(200)
    expect(await eventCap(slug)).toBe(600)
    const again = await json(await capConfirm(req({ eventId: d, orderId: p.body.orderId, razorpay_order_id: o.id, razorpay_payment_id: auth.paymentId, razorpay_signature: sign(o.id, auth.paymentId) })))
    expect(again.body.alreadyApplied).toBe(true)
    expect(await eventCap(slug)).toBe(600)
  }, T)

  it('F1 · failed / refunded payments, and a mismatched order id, amount or currency, grant nothing', async () => {
    const d = id('f1-bad'), slug = `c02-f1-bad-${process.pid}`
    await seedPublished(d, slug, { capacity: 500, sold: 0 })
    const p = await json(await pubPurchase(req({ eventId: d, capacity: 700 })))
    const o = h.orders[h.orders.length - 1]
    for (const [label, pay, sentId] of [
      ['payment failed',   { status: 'failed' }, undefined],
      ['payment refunded', { status: 'refunded' }, undefined],
      ['amount short',     { amount: o.amount - 1 }, undefined],
      ['currency',         { currency: 'USD' }, undefined],
      ['payment for another order', { order_id: 'order_someone_else' }, undefined],
      ['order id mismatch', {}, 'order_forged'],
    ] as const) {
      const r = (await capConfirmWith(d, p.body.orderId as string, o, pay as never, sentId)).res
      expect(r.status, label).toBe(400)
    }
    expect(await eventCap(slug)).toBe(500)
    expect((await adminDb.doc(`licenseOrders/${p.body.orderId}`).get()).data()!.status).toBe('created')
    // …and the same order still settles normally with a valid captured payment.
    expect((await capConfirmWith(d, p.body.orderId as string, o)).res.status).toBe(200)
    expect(await eventCap(slug)).toBe(700)
  }, T)

  // ═══ RD-F2 · a CAPTURED payment on a SUPERSEDED order is HELD, never granted, never lost ═══════
  /** Drives the REAL /api/webhooks/razorpay with a correctly signed payment.captured event. */
  async function webhookCaptured(entity: { id: string; order_id: string; amount: number; currency?: string }, badSignature = false) {
    const { POST: webhook } = await import('@/app/api/webhooks/razorpay/route')
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { status: 'captured', currency: 'INR', ...entity } } } })
    const sig = badSignature ? 'f'.repeat(64) : crypto.createHmac('sha256', 'whsec_f2_test_only').update(body).digest('hex')
    return webhook(new NextRequest('http://localhost/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  /** A published event with capacity order A (500→700) SUPERSEDED by order B (500→800). */
  async function supersededCapacity(tag: string) {
    const d = id(tag), slug = `c02-${tag}-${process.pid}`
    await seedPublished(d, slug, { capacity: 500, sold: 0 })
    const A = await json(await pubPurchase(req({ eventId: d, capacity: 700 })))
    const oA = h.orders[h.orders.length - 1]
    const B = await json(await pubPurchase(req({ eventId: d, capacity: 800 })))
    expect(B.body.orderId).not.toBe(A.body.orderId)
    const a = (await adminDb.doc(`licenseOrders/${A.body.orderId}`).get()).data()!
    expect(a).toMatchObject({ status: 'failed', failReason: 'superseded' })
    extraDocs.add(`failedRefunds/license_hold_${A.body.orderId}`)
    return { d, slug, orderId: A.body.orderId as string, oA }
  }
  const holdOf  = async (orderId: string) => (await adminDb.doc(`failedRefunds/license_hold_${orderId}`).get()).data()
  const holdsFor = async (orderId: string) => (await adminDb.collection('failedRefunds').where('licenseOrderId', '==', orderId).get()).size
  const capOf   = async (slug: string) => (await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity as number
  const capturedOn = (o: { id: string; amount: number }, extra: Record<string, unknown> = {}) => {
    const paymentId = `pay_f2_${++h.seq}`
    h.payments.set(paymentId, { id: paymentId, order_id: o.id, amount: o.amount, currency: 'INR', status: 'captured', ...extra })
    return paymentId
  }
  const confirmCap = (d: string, orderId: string, rzpOrderId: string, paymentId: string) =>
    capConfirm(req({ eventId: d, orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sign(rzpOrderId, paymentId) })).then(json)

  it('F2 · capacity: confirm of a captured payment on a SUPERSEDED order → one durable hold, nothing granted; then the webhook adds nothing', async () => {
    const { d, slug, orderId, oA } = await supersededCapacity('f2-cap')
    const pay = capturedOn(oA)
    const r = await confirmCap(d, orderId, oA.id, pay)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('PAYMENT_HELD')
    const hold = (await holdOf(orderId))!
    expect(hold).toMatchObject({ kind: 'license_remainder_hold', status: 'open', reason: 'superseded_paid', source: 'license_capacity',
      licenseOrderId: orderId, orderId: oA.id, paymentId: pay, amountPaise: oA.amount, eventId: d, organizerUid: UID })
    const order = (await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!
    expect(order).toMatchObject({ status: 'failed', failReason: 'superseded', manualRefundHoldId: `license_hold_${orderId}` })   // history kept
    expect(await capOf(slug)).toBe(500)                                                            // nothing granted
    // Replayed confirm + the webhook for the same capture: same answer, still ONE hold.
    expect((await confirmCap(d, orderId, oA.id, pay)).body.code).toBe('PAYMENT_HELD')
    expect((await webhookCaptured({ id: pay, order_id: oA.id, amount: oA.amount })).status).toBe(200)
    expect(await holdsFor(orderId)).toBe(1)
    expect(await capOf(slug)).toBe(500)
    expect((await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!.status).toBe('failed')
  }, T)

  it('F2 · webhook FIRST (organizer never came back), then a late confirm: one hold, nothing granted', async () => {
    const { d, slug, orderId, oA } = await supersededCapacity('f2-wh')
    const pay = capturedOn(oA)
    expect((await webhookCaptured({ id: pay, order_id: oA.id, amount: oA.amount })).status).toBe(200)
    expect((await holdOf(orderId))).toMatchObject({ reason: 'superseded_paid', status: 'open', paymentId: pay })
    expect((await confirmCap(d, orderId, oA.id, pay)).body.code).toBe('PAYMENT_HELD')
    expect((await webhookCaptured({ id: pay, order_id: oA.id, amount: oA.amount })).status).toBe(200)   // duplicate delivery
    expect(await holdsFor(orderId)).toBe(1)
    expect(await capOf(slug)).toBe(500)
  }, T)

  it('F2 · CONCURRENT confirms and webhooks for the same capture create exactly ONE hold', async () => {
    const { d, slug, orderId, oA } = await supersededCapacity('f2-race')
    const pay = capturedOn(oA)
    const results = await Promise.all([
      confirmCap(d, orderId, oA.id, pay), confirmCap(d, orderId, oA.id, pay), confirmCap(d, orderId, oA.id, pay),
      webhookCaptured({ id: pay, order_id: oA.id, amount: oA.amount }).then(json),
      webhookCaptured({ id: pay, order_id: oA.id, amount: oA.amount }).then(json),
    ])
    for (const r of results.slice(0, 3)) expect(r.body.code).toBe('PAYMENT_HELD')
    expect(await holdsFor(orderId)).toBe(1)
    expect((await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!.manualRefundHoldId).toBe(`license_hold_${orderId}`)
    expect(await capOf(slug)).toBe(500)
  }, T)

  it('F2 · a payment captured BEFORE the supersede blocks the supersede and settles normally — no hold', async () => {
    const d = id('f2-before'), slug = `c02-f2-before-${process.pid}`
    await seedPublished(d, slug, { capacity: 500, sold: 0 })
    const A = await json(await pubPurchase(req({ eventId: d, capacity: 700 })))
    const oA = h.orders[h.orders.length - 1]
    h.captured.set(oA.id, { amount: oA.amount })                  // Razorpay already holds the money for A
    const B = await json(await pubPurchase(req({ eventId: d, capacity: 800 })))
    expect(B.status).not.toBe(200)                                // refused: never superseded while money is in flight
    expect((await adminDb.doc(`licenseOrders/${A.body.orderId}`).get()).data()!.status).toBe('created')
    const pay = capturedOn(oA)
    expect((await confirmCap(d, A.body.orderId as string, oA.id, pay)).status).toBe(200)
    expect(await capOf(slug)).toBe(700)
    expect(await holdOf(A.body.orderId as string)).toBeUndefined()
  }, T)

  it('F2 · add-on: a captured payment on a SUPERSEDED pre-publish add-on is held; the allowance is not granted', async () => {
    const d = id('f2-addon'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect((await pay(h.orders[0], d)).status).toBe(200)
    const a1 = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 800 } })))
    const o1 = h.orders[h.orders.length - 1]
    const a2 = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 900 } })))
    expect(a2.body.orderId).not.toBe(a1.body.orderId)
    expect((await adminDb.doc(`licenseOrders/${a1.body.orderId}`).get()).data()!).toMatchObject({ status: 'failed', failReason: 'superseded' })
    extraDocs.add(`failedRefunds/license_hold_${a1.body.orderId}`)
    const r = await pay(o1, d, a1.body.orderId as string)            // captured on the superseded add-on
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('PAYMENT_HELD')
    expect(await holdOf(a1.body.orderId as string)).toMatchObject({ reason: 'superseded_paid', source: 'license', amountPaise: o1.amount, organizerUid: UID })
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)   // nothing granted
    // the webhook for the same capture adds nothing
    const payId = [...h.payments.values()].filter(x => x.order_id === o1.id).map(x => x.id as string).pop()!
    expect((await webhookCaptured({ id: payId, order_id: o1.id, amount: o1.amount })).status).toBe(200)
    expect(await holdsFor(a1.body.orderId as string)).toBe(1)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)
  }, T)

  it('F2 · authorized-only, failed, mismatched or unverifiable payments on a superseded order create NO hold and grant nothing', async () => {
    const { d, slug, orderId, oA } = await supersededCapacity('f2-bad')
    expect((await confirmCap(d, orderId, oA.id, capturedOn(oA, { status: 'authorized' }))).body.code).toBe('PAYMENT_NOT_CAPTURED')
    expect((await confirmCap(d, orderId, oA.id, capturedOn(oA, { status: 'failed' }))).status).toBe(400)
    expect((await confirmCap(d, orderId, oA.id, capturedOn(oA, { amount: oA.amount - 1 }))).status).toBe(400)
    expect((await confirmCap(d, orderId, oA.id, capturedOn(oA, { currency: 'USD' }))).status).toBe(400)
    expect((await confirmCap(d, orderId, 'order_forged', capturedOn(oA))).status).toBe(400)
    // bad signature on the webhook, and a webhook whose amount does not match the order
    expect((await webhookCaptured({ id: 'pay_x', order_id: oA.id, amount: oA.amount }, true)).status).toBe(400)
    expect((await webhookCaptured({ id: 'pay_y', order_id: oA.id, amount: oA.amount - 5 })).status).toBe(200)
    expect(await holdOf(orderId)).toBeUndefined()
    expect(await capOf(slug)).toBe(500)
    expect((await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!.manualRefundHoldId).toBeUndefined()
  }, T)

  // ═══ RD-F2A · a SUPERSEDED new-event ACTIVATION order is archived; a late capture is HELD ═══
  /** Draft activation order A (437) superseded by B (500): returns both Razorpay orders + the archive id. */
  async function supersededActivation(tag: string) {
    const d = id(tag); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    expect((await json(await purchase(req({ eventId: d, capacity: 437 })))).status).toBe(200)
    const oA = h.orders[h.orders.length - 1]
    expect((await json(await purchase(req({ eventId: d, capacity: 500 })))).status).toBe(200)
    const oB = h.orders[h.orders.length - 1]
    expect(oB.id).not.toBe(oA.id)
    const archiveId = `lic_${d}__sup_${oA.id}`
    extraDocs.add(`licenseOrders/${archiveId}`); extraDocs.add(`failedRefunds/license_hold_${archiveId}`)
    return { d, oA, oB, archiveId }
  }
  const licOf = async (d: string) => (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
  const confirmAct = (d: string, rzp: string, paymentId: string) =>
    confirm(req({ eventId: d, razorpay_order_id: rzp, razorpay_payment_id: paymentId, razorpay_signature: sign(rzp, paymentId) })).then(json)

  it('F2A · supersede ARCHIVES the old activation order atomically (id, amount, owner, draft) — the current order is untouched', async () => {
    const { d, oA, oB, archiveId } = await supersededActivation('f2a-arch')
    const ar = (await adminDb.doc(`licenseOrders/${archiveId}`).get()).data()!
    expect(ar).toMatchObject({ orderId: archiveId, status: 'failed', failReason: 'superseded', razorpayOrderId: oA.id,
      razorpayAmountPaise: oA.amount, currency: 'INR', eventId: d, organizerUid: UID, supersededFrom: `lic_${d}` })
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: oB.id, razorpayAmountPaise: oB.amount })
    // exactly one document carries the old Razorpay id (deterministic webhook lookup)
    expect((await adminDb.collection('licenseOrders').where('razorpayOrderId', '==', oA.id).get()).docs.map(x => x.id)).toEqual([archiveId])
  }, T)

  it('F2A · CONFIRM of a captured payment on the superseded activation → one hold; nothing activated; then the webhook adds nothing', async () => {
    const { d, oA, oB, archiveId } = await supersededActivation('f2a-conf')
    const payId = `pay_f2a_${++h.seq}`
    h.payments.set(payId, { id: payId, order_id: oA.id, amount: oA.amount, currency: 'INR', status: 'captured' })
    const r = await confirmAct(d, oA.id, payId)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('PAYMENT_HELD')
    expect((await adminDb.doc(`failedRefunds/license_hold_${archiveId}`).get()).data()).toMatchObject({
      reason: 'superseded_paid', status: 'open', source: 'license', licenseOrderId: archiveId, orderId: oA.id,
      paymentId: payId, amountPaise: oA.amount, eventId: d, organizerUid: UID })
    expect((await adminDb.doc(`licenseOrders/${archiveId}`).get()).data()).toMatchObject({ status: 'failed', failReason: 'superseded', manualRefundHoldId: `license_hold_${archiveId}` })
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: oB.id })              // NOT activated
    expect((await json(await publish(req({ draftId: d })))).status).toBe(402)                       // no entitlement
    expect((await confirmAct(d, oA.id, payId)).body.code).toBe('PAYMENT_HELD')                      // retry
    expect((await webhookCaptured({ id: payId, order_id: oA.id, amount: oA.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', archiveId).get()).size).toBe(1)
    // …and the CURRENT order still settles and publishes normally (HIGH-1 consumes it once).
    expect((await pay(oB, d)).status).toBe(200)
    // the wizard records the chosen capacity on the draft (publish publishes the requested capacity)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 500 })
    const pub = await json(await publish(req({ draftId: d })))
    if (typeof pub.body.slug === 'string') slugs.add(pub.body.slug)
    expect(pub.status).toBe(200)
    expect((await adminDb.doc(`events/${pub.body.slug}`).get()).data()!.totalCapacity).toBe(500)
    expect((await adminDb.doc(`licenseOrders/${archiveId}`).get()).data()!.status).toBe('failed')   // never revived
  }, T)

  it('F2A · WEBHOOK first, then confirm; duplicate and CONCURRENT deliveries → exactly one hold', async () => {
    const { d, oA, archiveId } = await supersededActivation('f2a-wh')
    const payId = `pay_f2a_${++h.seq}`
    h.payments.set(payId, { id: payId, order_id: oA.id, amount: oA.amount, currency: 'INR', status: 'captured' })
    const rs = await Promise.all([
      webhookCaptured({ id: payId, order_id: oA.id, amount: oA.amount }).then(json),
      webhookCaptured({ id: payId, order_id: oA.id, amount: oA.amount }).then(json),
      confirmAct(d, oA.id, payId), confirmAct(d, oA.id, payId),
    ])
    for (const r of rs.slice(0, 2)) expect(r.status).toBe(200)
    for (const r of rs.slice(2)) expect(r.body.code).toBe('PAYMENT_HELD')
    expect((await webhookCaptured({ id: payId, order_id: oA.id, amount: oA.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', archiveId).get()).size).toBe(1)
    expect((await licOf(d)).status).toBe('created')
  }, T)

  it('F2A · a payment captured BEFORE the supersede is settled by the existing self-heal — no archive, no hold', async () => {
    const d = id('f2a-before'); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    expect((await json(await purchase(req({ eventId: d, capacity: 437 })))).status).toBe(200)
    const oA = h.orders[h.orders.length - 1]
    h.captured.set(oA.id, { amount: oA.amount })                                   // money already with Razorpay
    await json(await purchase(req({ eventId: d, capacity: 500 })))                 // would supersede — but A is paid
    expect(await licOf(d)).toMatchObject({ status: 'paid', razorpayOrderId: oA.id })
    expect((await adminDb.doc(`licenseOrders/lic_${d}__sup_${oA.id}`).get()).exists).toBe(false)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', `lic_${d}__sup_${oA.id}`).get()).size).toBe(0)
  }, T)

  it('F2A · authorized-only, failed, mismatched, badly signed or foreign attempts create no hold and grant nothing', async () => {
    const { d, oA, archiveId } = await supersededActivation('f2a-bad')
    const mk = (extra: Record<string, unknown>) => {
      const id2 = `pay_f2a_${++h.seq}`
      h.payments.set(id2, { id: id2, order_id: oA.id, amount: oA.amount, currency: 'INR', status: 'captured', ...extra }); return id2
    }
    expect((await confirmAct(d, oA.id, mk({ status: 'authorized' }))).body.code).toBe('PAYMENT_NOT_CAPTURED')
    expect((await confirmAct(d, oA.id, mk({ status: 'failed' }))).status).toBe(400)
    expect((await confirmAct(d, oA.id, mk({ amount: oA.amount - 1 }))).status).toBe(400)
    expect((await confirmAct(d, oA.id, mk({ currency: 'USD' }))).status).toBe(400)
    const good = mk({})
    expect((await json(await confirm(req({ eventId: d, razorpay_order_id: oA.id, razorpay_payment_id: good, razorpay_signature: 'bad' })))).status).toBe(400)
    expect((await webhookCaptured({ id: good, order_id: oA.id, amount: oA.amount }, true)).status).toBe(400)
    expect((await webhookCaptured({ id: good, order_id: oA.id, amount: oA.amount + 7 })).status).toBe(200)   // flagged, no hold
    // another organizer, even with a valid capture for A's superseded order (HIGH-2)
    const B = `c02svc-orgB2-${process.pid}`
    await adminDb.doc(`users/${B}`).set({ uid: B, role: 'organizer', accountStatus: 'active', emailVerified: true }); extraDocs.add(`users/${B}`)
    h.who = B
    expect((await confirmAct(d, oA.id, good)).status).toBe(403)
    h.who = ''
    expect((await adminDb.doc(`failedRefunds/license_hold_${archiveId}`).get()).exists).toBe(false)
    expect((await adminDb.doc(`licenseOrders/${archiveId}`).get()).data()!.manualRefundHoldId).toBeUndefined()
    expect((await licOf(d)).status).toBe('created')
  }, T)

  // ═══ RD-F3 · a genuine webhook processing failure is NOT acknowledged — Razorpay retries ═══
  const histFor = async (slug: string) => (await adminDb.collection('licenseHistory').where('eventId', '==', slug).get()).size
  /** A published event with an unpaid capacity order 500 → 700 (created). */
  async function capacityOrder(tag: string) {
    const d = id(tag), slug = `c02-${tag}-${process.pid}`
    await seedPublished(d, slug, { capacity: 500, sold: 0 })
    const p = await json(await pubPurchase(req({ eventId: d, capacity: 700 })))
    return { d, slug, orderId: p.body.orderId as string, o: h.orders[h.orders.length - 1] }
  }

  it('F3 · a captured capacity payment is settled by the webhook alone; replays and CONCURRENT duplicates grant once', async () => {
    const { slug, o } = await capacityOrder('f3-ok')
    const payId = `pay_f3_${++h.seq}`
    const rs = await Promise.all([0, 1, 2].map(() => webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })))
    for (const r of rs) expect(r.status).toBe(200)
    expect(await capOf(slug)).toBe(700)
    expect(await histFor(slug)).toBe(1)                                      // applied exactly once
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect(await histFor(slug)).toBe(1)
  }, T)

  it('F3 · a TRANSIENT settlement failure answers 500 (retry), grants nothing; the retry settles exactly once', async () => {
    const { slug, orderId, o } = await capacityOrder('f3-transient')
    const payId = `pay_f3_${++h.seq}`
    h.fail.apply = 1
    const first = await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })
    expect(first.status).toBe(500)                                           // NOT acknowledged
    expect(await capOf(slug)).toBe(500)
    expect((await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!.status).toBe('created')
    const retry = await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })   // Razorpay redelivers
    expect(retry.status).toBe(200)
    expect(await capOf(slug)).toBe(700)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect(await histFor(slug)).toBe(1)
  }, T)

  it('F3 · STALE capacity order whose hold write fails: 500, then the retry completes ONE hold (F1 keeps it ungranted)', async () => {
    const { slug, orderId, o } = await capacityOrder('f3-stale')
    // Capacity moves to 600 underneath A → A is stale (RD-L6: moved directly — the routes no longer open a
    // second payable order while A is pending).
    await adminDb.doc(`events/${slug}`).update({ totalCapacity: 600 })
    const payId = `pay_f3_${++h.seq}`
    h.fail.recordHold = 1
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(500)
    const a1 = (await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!
    expect(a1).toMatchObject({ status: 'failed', failReason: 'capacity_stale' })   // terminal (F1), hold not yet written
    expect(a1.manualRefundHoldId).toBeUndefined()
    extraDocs.add(`failedRefunds/license_hold_${orderId}`)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect((await adminDb.doc(`failedRefunds/license_hold_${orderId}`).get()).data()).toMatchObject({ reason: 'capacity_stale', status: 'open', amountPaise: o.amount })
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', orderId).get()).size).toBe(1)
    expect(await capOf(slug)).toBe(600)                                      // never 700
  }, T)

  it('F3 · superseded CAPACITY, ADD-ON and archived ACTIVATION orders: a failed hold write → 500; retry → exactly ONE hold', async () => {
    // capacity (F2)
    const c = await supersededCapacity('f3-sup-cap')
    const pc = capturedOn(c.oA)
    h.fail.holdSuperseded = 1
    expect((await webhookCaptured({ id: pc, order_id: c.oA.id, amount: c.oA.amount })).status).toBe(500)
    expect(await holdOf(c.orderId)).toBeUndefined()
    expect((await webhookCaptured({ id: pc, order_id: c.oA.id, amount: c.oA.amount })).status).toBe(200)
    expect((await webhookCaptured({ id: pc, order_id: c.oA.id, amount: c.oA.amount })).status).toBe(200)
    expect(await holdsFor(c.orderId)).toBe(1)
    expect(await capOf(c.slug)).toBe(500)
    // activation (F2A archive)
    const a = await supersededActivation('f3-sup-act')
    h.fail.holdSuperseded = 1
    expect((await webhookCaptured({ id: `pay_f3a_${++h.seq}`, order_id: a.oA.id, amount: a.oA.amount })).status).toBe(500)
    expect((await webhookCaptured({ id: `pay_f3a_${h.seq}`, order_id: a.oA.id, amount: a.oA.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', a.archiveId).get()).size).toBe(1)
    expect((await licOf(a.d)).status).toBe('created')
    // add-on (F2)
    const d = id('f3-sup-addon'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect((await pay(h.orders[h.orders.length - 1], d)).status).toBe(200)
    const a1 = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 800 } })))
    const o1 = h.orders[h.orders.length - 1]
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 900 } }))   // supersedes a1
    extraDocs.add(`failedRefunds/license_hold_${a1.body.orderId}`)
    h.fail.holdSuperseded = 1
    const payAdd = `pay_f3b_${++h.seq}`
    expect((await webhookCaptured({ id: payAdd, order_id: o1.id, amount: o1.amount })).status).toBe(500)
    expect((await webhookCaptured({ id: payAdd, order_id: o1.id, amount: o1.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', a1.body.orderId).get()).size).toBe(1)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(500)   // nothing granted
  }, T)

  it('F3 · PERMANENT outcomes are still acknowledged or rejected — never retried forever, never granted', async () => {
    const { slug, o } = await capacityOrder('f3-perm')
    // invalid signature → 400, nothing processed
    expect((await webhookCaptured({ id: 'pay_sig', order_id: o.id, amount: o.amount }, true)).status).toBe(400)
    // amount mismatch → flagged + acknowledged (a retry cannot make it valid)
    expect((await webhookCaptured({ id: 'pay_mis', order_id: o.id, amount: o.amount - 1 })).status).toBe(200)
    // unknown order (neither a registration nor a licence) → acknowledged
    expect((await webhookCaptured({ id: 'pay_unk', order_id: 'order_unknown_f3', amount: 100 })).status).toBe(200)
    // irrelevant event type → acknowledged
    const { POST: webhook } = await import('@/app/api/webhooks/razorpay/route')
    const body = JSON.stringify({ event: 'order.paid', payload: {} })
    const sig = crypto.createHmac('sha256', 'whsec_f2_test_only').update(body).digest('hex')
    expect((await webhook(new NextRequest('http://localhost/api/webhooks/razorpay', { method: 'POST', headers: { 'x-razorpay-signature': sig }, body }))).status).toBe(200)
    expect(await capOf(slug)).toBe(500)
  }, T)

  // ═══ RD-M3 · an UNKNOWN capture status never replaces, overwrites or activates an order ═════
  /** A draft with a pending (created, unpaid) activation order for 437. */
  async function pendingActivation(tag: string) {
    const d = id(tag); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    expect((await json(await purchase(req({ eventId: d, capacity: 437 })))).status).toBe(200)
    const o = h.orders[h.orders.length - 1]
    const before = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
    return { d, o, before }
  }
  const archivesOf = async (d: string) => (await adminDb.collection('licenseOrders').where('eventId', '==', d).get()).docs.filter(x => x.id.includes('__sup_')).length

  it('M3 · activation, changed selection, the REPLACEMENT lookup fails (throws / malformed) → 409, old order kept, no new order, no archive', async () => {
    for (const mode of ['throw', 'malformed'] as const) {
      const { d, o, before } = await pendingActivation(`m3-sup-${mode}`)
      const orders = h.orders.length
      h.fetchPlan = ['normal', mode]                           // self-heal: nothing captured · guard: UNKNOWN
      const r = await json(await purchase(req({ eventId: d, capacity: 500 })))
      expect(r.status, mode).toBe(409)
      expect(r.body.failureReason).toBe('payment_processing')
      const now = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
      expect(now).toMatchObject({ status: 'created', razorpayOrderId: o.id, razorpayAmountPaise: before.razorpayAmountPaise })
      expect(h.orders.length).toBe(orders)                      // no replacement Razorpay order
      expect(await archivesOf(d)).toBe(0)                       // no F2A archive
      expect((await adminDb.collection('failedRefunds').where('eventId', '==', d).get()).size).toBe(0)
    }
  }, T)

  it('M3 · activation, the SELF-HEAL lookup fails or is only authorised → 409, nothing activated, order untouched', async () => {
    for (const setup of ['throw', 'malformed', 'authorized'] as const) {
      const { d, o } = await pendingActivation(`m3-heal-${setup}`)
      if (setup === 'authorized') h.captured.set(o.id, { amount: o.amount, status: 'authorized' })
      else h.fetchPlan = [setup]
      const r = await json(await purchase(req({ eventId: d, capacity: 437 })))   // identical selection
      expect(r.status, setup).toBe(409)
      expect(r.body.failureReason).toBe('payment_processing')
      expect((await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()).toMatchObject({ status: 'created', razorpayOrderId: o.id })
      h.captured.delete(o.id)
    }
  }, T)

  it('M3 · RETRY once the lookup recovers: "none" → normal replacement + F2A archive; "captured" → self-heal activates exactly once', async () => {
    // none
    const a = await pendingActivation('m3-retry-none')
    h.fetchPlan = ['throw']
    expect((await json(await purchase(req({ eventId: a.d, capacity: 500 })))).status).toBe(409)
    const r1 = await json(await purchase(req({ eventId: a.d, capacity: 500 })))      // lookup healthy again
    expect(r1.status).toBe(200)
    expect((await adminDb.doc(`licenseOrders/lic_${a.d}`).get()).data()!.razorpayOrderId).not.toBe(a.o.id)
    expect((await adminDb.doc(`licenseOrders/lic_${a.d}__sup_${a.o.id}`).get()).data()).toMatchObject({ status: 'failed', failReason: 'superseded', razorpayOrderId: a.o.id })
    extraDocs.add(`licenseOrders/lic_${a.d}__sup_${a.o.id}`)
    // captured
    const b = await pendingActivation('m3-retry-captured')
    h.fetchPlan = ['throw']
    expect((await json(await purchase(req({ eventId: b.d, capacity: 437 })))).status).toBe(409)
    h.captured.set(b.o.id, { amount: b.o.amount })
    const payId = `pay_cap_${b.o.id}`
    h.payments.set(payId, { id: payId, order_id: b.o.id, amount: b.o.amount, currency: 'INR', status: 'captured' })
    const ordersBefore = h.orders.length
    const r2 = await json(await purchase(req({ eventId: b.d, capacity: 437 })))
    expect(r2.status).toBe(200)
    expect(r2.body.alreadyPaid).toBe(true)
    expect((await adminDb.doc(`licenseOrders/lic_${b.d}`).get()).data()).toMatchObject({ status: 'paid', razorpayOrderId: b.o.id })
    expect((await json(await purchase(req({ eventId: b.d, capacity: 437 })))).body.alreadyPaid).toBe(true)   // once
    expect(h.orders.length).toBe(ordersBefore)                  // no second Razorpay order
    expect((await adminDb.collection('licenseHistory').where('eventId', '==', b.d).get()).size).toBeLessThanOrEqual(1)
  }, T)

  it('M3 · add-on and published capacity: a MALFORMED lookup → processing; the pending order is kept, no replacement', async () => {
    // add-on (draftCommerce)
    const d = id('m3-addon'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect((await pay(h.orders[h.orders.length - 1], d)).status).toBe(200)
    const a1 = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 800 } })))
    const n1 = h.orders.length
    h.fetchPlan = ['malformed']
    const r = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 900 } })))
    expect(r.status).toBe(409)
    expect(r.body.failureReason).toBe('payment_processing')
    expect((await adminDb.doc(`licenseOrders/${a1.body.orderId}`).get()).data()!.status).toBe('created')
    expect(h.orders.length).toBe(n1)
    // published capacity
    const pd = id('m3-pub'), slug = `c02-m3-pub-${process.pid}`
    await seedPublished(pd, slug, { capacity: 500, sold: 0 })
    const A = await json(await pubPurchase(req({ eventId: pd, capacity: 700 })))
    const n2 = h.orders.length
    h.fetchPlan = ['malformed']
    const B = await json(await pubPurchase(req({ eventId: pd, capacity: 800 })))
    expect(B.status).toBe(409)
    expect(B.body.code).toBe('PAYMENT_PROCESSING')
    expect((await adminDb.doc(`licenseOrders/${A.body.orderId}`).get()).data()!.status).toBe('created')
    expect(h.orders.length).toBe(n2)
  }, T)

  it('M3 · existing protections unchanged: a captured OR authorised payment still blocks replacement; "none" still replaces', async () => {
    for (const status of ['captured', 'authorized'] as const) {
      const pd = id(`m3-block-${status}`), slug = `c02-m3-block-${status}-${process.pid}`
      await seedPublished(pd, slug, { capacity: 500, sold: 0 })
      const A = await json(await pubPurchase(req({ eventId: pd, capacity: 700 })))
      const oA = h.orders[h.orders.length - 1]
      h.captured.set(oA.id, { amount: oA.amount, status })
      const B = await json(await pubPurchase(req({ eventId: pd, capacity: 800 })))
      expect(B.body.code, status).toBe('PAYMENT_PROCESSING')
      expect((await adminDb.doc(`licenseOrders/${A.body.orderId}`).get()).data()!.status).toBe('created')
    }
    const { d, o } = await pendingActivation('m3-none')
    expect((await json(await purchase(req({ eventId: d, capacity: 500 })))).status).toBe(200)   // healthy "none" → replaced
    expect((await adminDb.doc(`licenseOrders/lic_${d}__sup_${o.id}`).get()).exists).toBe(true)
    extraDocs.add(`licenseOrders/lic_${d}__sup_${o.id}`)
  }, T)

  // ═══ RD-M4 · replacement races: a stale payment never lands on the current order ═══════════
  it('M4 D1 · CONFIRM: the order is replaced between confirm’s read and activation → old payment HELD on its archive; current order untouched', async () => {
    const { d, o: oA } = await pendingActivation('m4-d1-conf')
    const payA = `pay_m4_${++h.seq}`
    h.payments.set(payA, { id: payA, order_id: oA.id, amount: oA.amount, currency: 'INR', status: 'captured' })
    h.beforeActivate = async () => {                              // a changed-selection purchase commits mid-confirm
      expect((await json(await purchase(req({ eventId: d, capacity: 500 })))).status).toBe(200)
    }
    const r = await confirmAct(d, oA.id, payA)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('PAYMENT_HELD')
    const oB = h.orders[h.orders.length - 1]
    expect(oB.id).not.toBe(oA.id)
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: oB.id })        // current order intact
    const archiveId = `lic_${d}__sup_${oA.id}`
    extraDocs.add(`licenseOrders/${archiveId}`); extraDocs.add(`failedRefunds/license_hold_${archiveId}`)
    expect((await adminDb.doc(`failedRefunds/license_hold_${archiveId}`).get()).data()).toMatchObject({ reason: 'superseded_paid', paymentId: payA, amountPaise: oA.amount })
    expect((await confirmAct(d, oA.id, payA)).body.code).toBe('PAYMENT_HELD')                  // retry: same hold
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', archiveId).get()).size).toBe(1)
    expect((await json(await publish(req({ draftId: d })))).status).toBe(402)                   // nothing granted
    // the CURRENT order then pays and publishes normally (HIGH-1)
    expect((await pay(oB, d)).status).toBe(200)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 500 })
    const pub = await json(await publish(req({ draftId: d })))
    if (typeof pub.body.slug === 'string') slugs.add(pub.body.slug)
    expect(pub.status).toBe(200)
    expect((await adminDb.doc(`events/${pub.body.slug}`).get()).data()!.totalCapacity).toBe(500)
  }, T)

  it('M4 D1 · WEBHOOK: the same interleaving answers 500; the redelivery holds the payment once; replays are idempotent', async () => {
    const { d, o: oA } = await pendingActivation('m4-d1-wh')
    const payA = `pay_m4_${++h.seq}`
    h.beforeActivate = async () => {
      expect((await json(await purchase(req({ eventId: d, capacity: 500 })))).status).toBe(200)
    }
    expect((await webhookCaptured({ id: payA, order_id: oA.id, amount: oA.amount })).status).toBe(500)   // F3 retry
    const oB = h.orders[h.orders.length - 1]
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: oB.id })
    const archiveId = `lic_${d}__sup_${oA.id}`
    extraDocs.add(`licenseOrders/${archiveId}`); extraDocs.add(`failedRefunds/license_hold_${archiveId}`)
    expect((await webhookCaptured({ id: payA, order_id: oA.id, amount: oA.amount })).status).toBe(200)   // redelivery
    expect((await webhookCaptured({ id: payA, order_id: oA.id, amount: oA.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', archiveId).get()).size).toBe(1)
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: oB.id })
  }, T)

  it('M4 D1 · SELF-HEAL against a stale order id → 409 payment_processing; nothing activated or overwritten', async () => {
    const { d, o: oA } = await pendingActivation('m4-d1-heal')
    h.captured.set(oA.id, { amount: oA.amount })                  // A was captured → self-heal would activate A…
    h.beforeActivate = async () => {                              // …but the order is replaced first
      await adminDb.doc(`licenseOrders/lic_${d}`).update({ razorpayOrderId: 'order_m4_replacement' })
    }
    const r = await json(await purchase(req({ eventId: d, capacity: 437 })))
    expect(r.status).toBe(409)
    expect(r.body.failureReason).toBe('payment_processing')
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: 'order_m4_replacement' })
  }, T)

  it('M4 D2 · published capacity: a confirm that SETTLES the order during the capture lookup is never flipped to superseded', async () => {
    const pd = id('m4-d2'), slug = `c02-m4-d2-${process.pid}`
    await seedPublished(pd, slug, { capacity: 500, sold: 0 })
    const A = await json(await pubPurchase(req({ eventId: pd, capacity: 700 })))
    const oA = h.orders[h.orders.length - 1]
    let payId = ''
    h.onFetch = async () => {                                      // the organizer's confirm lands mid-replacement
      const r = await payCap(oA, pd, A.body.orderId as string)
      expect(r.status).toBe(200)
      payId = [...h.payments.values()].filter(x => x.order_id === oA.id).map(x => x.id as string).pop()!
    }
    const n = h.orders.length
    const B = await json(await pubPurchase(req({ eventId: pd, capacity: 800 })))
    expect(B.status).toBe(409)
    expect(B.body.code).toBe('PAYMENT_PROCESSING')
    expect(h.orders.length).toBe(n)                                // no replacement order
    const a = (await adminDb.doc(`licenseOrders/${A.body.orderId}`).get()).data()!
    expect(a.status).toBe('paid')
    expect(a.failReason).toBeUndefined()
    expect(await capOf(slug)).toBe(700)
    expect((await webhookCaptured({ id: payId, order_id: oA.id, amount: oA.amount })).status).toBe(200)   // replay
    expect(await holdOf(A.body.orderId as string)).toBeUndefined()                                        // no wrong hold
    expect(await capOf(slug)).toBe(700)
    expect(await histFor(slug)).toBe(1)                                                                   // granted once
  }, T)

  it('M4 D3 · add-on: a confirm that SETTLES the add-on during the capture lookup is never flipped to superseded', async () => {
    const d = id('m4-d3'); await seed(d)
    await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect((await pay(h.orders[h.orders.length - 1], d)).status).toBe(200)
    const a1 = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 800 } })))
    const o1 = h.orders[h.orders.length - 1]
    let payId = ''
    h.onFetch = async () => {
      const r = await pay(o1, d, a1.body.orderId as string)
      expect(r.status).toBe(200)
      payId = [...h.payments.values()].filter(x => x.order_id === o1.id).map(x => x.id as string).pop()!
    }
    const r = await json(await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 900 } })))
    expect(r.status).toBe(409)
    expect(r.body.failureReason).toBe('payment_processing')
    const x = (await adminDb.doc(`licenseOrders/${a1.body.orderId}`).get()).data()!
    expect(x.status).toBe('paid')
    expect(x.failReason).toBeUndefined()
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(800)                   // granted once
    expect((await webhookCaptured({ id: payId, order_id: o1.id, amount: o1.amount })).status).toBe(200)
    expect(await holdOf(a1.body.orderId as string)).toBeUndefined()
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(800)
  }, T)

  // ═══ RD-L6 · capacity order reuse, settlement safety and lifecycle at apply ═══════════════
  const capOrderRoute = async (body: Record<string, unknown>) => json(await (await import('@/app/api/licensing/capacity/order/route')).POST(req(body)))
  /** Capacity orders of an event that are payable right now (created, unheld, with a Razorpay order). */
  const payableOf = async (slug: string) => (await adminDb.collection('licenseOrders').where('eventId', '==', slug).where('status', '==', 'created').get())
    .docs.map(x => x.data()).filter(o => o.razorpayOrderId && o.manualRefundHoldId == null)
  const orderDoc = async (orderId: string) => (await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!
  const pubL6 = async (tag: string, capacity = 500) => {
    const d = id(tag), slug = `c02-${tag}-${process.pid}`
    await seedPublished(d, slug, { capacity, sold: 0 })
    return { d, slug }
  }

  it('L6 D1 · CONCURRENT identical wizard requests → the same order, ONE Razorpay order', async () => {
    const { d, slug } = await pubL6('l6-cw')
    const n = h.orders.length
    const rs = await Promise.all([0, 1, 2].map(() => pubPurchase(req({ eventId: d, capacity: 700 })).then(json)))
    for (const r of rs) expect(r.status).toBe(200)
    expect(new Set(rs.map(r => r.body.orderId)).size).toBe(1)
    expect(h.orders.length - n).toBe(1)
    expect(await payableOf(slug)).toHaveLength(1)
  }, T)

  it('L6 D1 · CONCURRENT identical dashboard requests → the same order, ONE Razorpay order', async () => {
    const { d, slug } = await pubL6('l6-cd')
    const n = h.orders.length
    const rs = await Promise.all([0, 1, 2].map(() => capOrderRoute({ eventId: d, capacity: 700 })))
    for (const r of rs) expect(r.status).toBe(200)
    expect(new Set(rs.map(r => r.body.orderId)).size).toBe(1)
    expect(h.orders.length - n).toBe(1)
    expect(await payableOf(slug)).toHaveLength(1)
  }, T)

  it('L6 D1 · CROSS-ROUTE reuse: dashboard reuses a wizard order and the wizard reuses a dashboard order', async () => {
    const a = await pubL6('l6-x1')
    const w = await json(await pubPurchase(req({ eventId: a.d, capacity: 700 })))
    const dsh = await capOrderRoute({ eventId: a.d, capacity: 700 })
    expect(dsh.status).toBe(200); expect(dsh.body).toMatchObject({ orderId: w.body.orderId, reused: true })
    expect((dsh.body.checkout as { razorpayOrderId: string }).razorpayOrderId).toBe((w.body.checkout as { razorpayOrderId: string }).razorpayOrderId)
    const b = await pubL6('l6-x2')
    const dsh2 = await capOrderRoute({ eventId: b.d, capacity: 700 })
    const w2 = await json(await pubPurchase(req({ eventId: b.d, capacity: 700 })))
    expect(w2.status).toBe(200); expect(w2.body).toMatchObject({ orderId: dsh2.body.orderId, reused: true })
    expect(await payableOf(a.slug)).toHaveLength(1); expect(await payableOf(b.slug)).toHaveLength(1)
  }, T)

  it('L6 D1 · a DIFFERENT target while an order is pending: M3 lookup "none" → M4 supersede → one payable order (dashboard)', async () => {
    const { d, slug } = await pubL6('l6-diff')
    const A = await capOrderRoute({ eventId: d, capacity: 700 })
    const B = await capOrderRoute({ eventId: d, capacity: 800 })
    expect(B.status).toBe(200); expect(B.body.orderId).not.toBe(A.body.orderId)
    expect(await orderDoc(A.body.orderId as string)).toMatchObject({ status: 'failed', failReason: 'superseded' })
    expect((await payableOf(slug)).map(o => o.orderId)).toEqual([B.body.orderId])
  }, T)

  it('L6 D1 · a CAPTURED / AUTHORISED / UNKNOWN lookup blocks replacement on the dashboard route too', async () => {
    for (const mode of ['captured', 'authorized', 'malformed', 'throw'] as const) {
      const { d, slug } = await pubL6(`l6-blk-${mode}`)
      const A = await capOrderRoute({ eventId: d, capacity: 700 })
      const oA = h.orders[h.orders.length - 1]
      if (mode === 'captured' || mode === 'authorized') h.captured.set(oA.id, { amount: oA.amount, status: mode })
      else h.fetchPlan = [mode]
      const B = await capOrderRoute({ eventId: d, capacity: 800 })
      expect(B.status, mode).toBe(409); expect(B.body.code, mode).toBe('PAYMENT_PROCESSING')
      expect((await orderDoc(A.body.orderId as string)).status, mode).toBe('created')
      expect((await payableOf(slug)).map(o => o.orderId), mode).toEqual([A.body.orderId])
      h.fetchPlan = []
    }
  }, T)

  it('L6 D1 · Razorpay order creation FAILS → 502, no checkout; a retry within 10 min is "processing", never a competing order', async () => {
    const { d, slug } = await pubL6('l6-rzpfail')
    h.fail.rzpCreate = 1
    const a = await capOrderRoute({ eventId: d, capacity: 700 })
    expect(a.status).toBe(502); expect(a.body.code).toBe('GATEWAY')
    const docs = (await adminDb.collection('licenseOrders').where('eventId', '==', slug).get()).docs.map(x => x.data())
    expect(docs).toHaveLength(1); expect(docs[0]).toMatchObject({ status: 'created', razorpayOrderId: null })
    const n = h.orders.length
    for (const r of [await capOrderRoute({ eventId: d, capacity: 700 }), await json(await pubPurchase(req({ eventId: d, capacity: 900 })))]) {
      expect(r.status).toBe(409); expect(r.body.code).toBe('PAYMENT_PROCESSING')
    }
    expect(h.orders.length).toBe(n)
    expect((await adminDb.collection('licenseOrders').where('eventId', '==', slug).get()).size).toBe(1)
  }, T)

  it('L6 D1 · Razorpay id PERSISTENCE fails → 502, no checkout, and the Razorpay order is never handed out', async () => {
    const { d, slug } = await pubL6('l6-attach')
    const n = h.orders.length
    h.fail.attach = 1
    const a = await json(await pubPurchase(req({ eventId: d, capacity: 700 })))
    expect(a.status).toBe(502); expect(a.body.checkout).toBeUndefined()
    expect(h.orders.length - n).toBe(1)                                  // created at Razorpay, never returned
    expect(await payableOf(slug)).toHaveLength(0)
    const docs = (await adminDb.collection('licenseOrders').where('eventId', '==', slug).get()).docs.map(x => x.data())
    expect(docs).toHaveLength(1); expect(docs[0].razorpayOrderId).toBeNull()
    expect((await json(await pubPurchase(req({ eventId: d, capacity: 700 })))).body.code).toBe('PAYMENT_PROCESSING')
  }, T)

  it('L6 D1 · a no-Razorpay-id order ≥ 10 min old is ABANDONED (re-checked in the transaction) and replaced; paid / held ones never are', async () => {
    const { CAPACITY_ORDER_STARTING_WINDOW_MS } = await import('@/lib/licensing/capacityChange')
    expect(CAPACITY_ORDER_STARTING_WINDOW_MS).toBe(10 * 60 * 1000)
    const old = new Date(Date.now() - CAPACITY_ORDER_STARTING_WINDOW_MS - 60_000)
    const { d, slug } = await pubL6('l6-aband')
    h.fail.rzpCreate = 1
    expect((await capOrderRoute({ eventId: d, capacity: 700 })).status).toBe(502)
    const stuck = (await adminDb.collection('licenseOrders').where('eventId', '==', slug).get()).docs[0].id
    await adminDb.doc(`licenseOrders/${stuck}`).update({ createdAt: old })
    const r = await capOrderRoute({ eventId: d, capacity: 700 })
    expect(r.status).toBe(200); expect(r.body.orderId).not.toBe(stuck)
    expect(await orderDoc(stuck)).toMatchObject({ status: 'failed', failReason: 'abandoned' })
    expect((await payableOf(slug)).map(o => o.orderId)).toEqual([r.body.orderId])
    // an OLD no-id order that is PAID or HELD is not pending at all — never abandoned, a new order is made
    for (const [tag, patch] of [['paid', { status: 'paid' }], ['held', { manualRefundHoldId: 'license_hold_x' }]] as const) {
      const e = await pubL6(`l6-aband-${tag}`)
      h.fail.rzpCreate = 1
      await capOrderRoute({ eventId: e.d, capacity: 700 })
      const oid = (await adminDb.collection('licenseOrders').where('eventId', '==', e.slug).get()).docs[0].id
      await adminDb.doc(`licenseOrders/${oid}`).update({ createdAt: old, ...patch })
      expect((await capOrderRoute({ eventId: e.d, capacity: 700 })).status, tag).toBe(200)
      const after = await orderDoc(oid)
      expect(after.failReason, tag).toBeUndefined()
      if (tag === 'paid') expect(after.status).toBe('paid'); else expect(after.status).toBe('created')
    }
  }, T)

  it('L6 D1 · failed / superseded / held / paid / snapshot-less (legacy) orders are NEVER reused', async () => {
    for (const [tag, patch] of [
      ['failed', { status: 'failed', failReason: 'capacity_stale' }], ['sup', { status: 'failed', failReason: 'superseded' }],
      ['held', { manualRefundHoldId: 'license_hold_x' }], ['paid', { status: 'paid' }], ['legacy', { capacityChange: FieldValue.delete() }],
    ] as const) {
      const { d, slug } = await pubL6(`l6-nr-${tag}`)
      const A = await capOrderRoute({ eventId: d, capacity: 700 })
      await adminDb.doc(`licenseOrders/${A.body.orderId}`).update(patch)
      const B = await capOrderRoute({ eventId: d, capacity: 700 })
      expect(B.status, tag).toBe(200)
      expect(B.body.orderId, tag).not.toBe(A.body.orderId)
      expect(B.body.reused, tag).toBe(false)
      expect((await payableOf(slug)).map(o => o.orderId), tag).toEqual([B.body.orderId])
    }
  }, T)

  it('L6 D2 · WEBHOOK: order superseded between the lookup and the apply → ONE hold, nothing granted; redelivery adds nothing', async () => {
    const { d, slug, orderId, o } = await capacityOrder('l6-d2w')
    h.beforeApply = async () => { expect((await json(await pubPurchase(req({ eventId: d, capacity: 800 })))).status).toBe(200) }
    const payId = `pay_l6_${++h.seq}`
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    extraDocs.add(`failedRefunds/license_hold_${orderId}`)
    expect(await holdOf(orderId)).toMatchObject({ reason: 'superseded_paid', paymentId: payId, amountPaise: o.amount, source: 'license_capacity' })
    expect(await capOf(slug)).toBe(500)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect(await holdsFor(orderId)).toBe(1)
    expect(await capOf(slug)).toBe(500)
  }, T)

  it('L6 D2 · WEBHOOK: the hold write FAILS → 500 (retry); the retry persists exactly ONE hold', async () => {
    const { d, slug, orderId, o } = await capacityOrder('l6-d2f')
    h.beforeApply = async () => { await json(await pubPurchase(req({ eventId: d, capacity: 800 }))) }
    h.fail.holdSuperseded = 1
    const payId = `pay_l6_${++h.seq}`
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(500)
    extraDocs.add(`failedRefunds/license_hold_${orderId}`)
    expect(await holdsFor(orderId)).toBe(0)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect(await holdsFor(orderId)).toBe(1)
    expect(await capOf(slug)).toBe(500)
  }, T)

  it('L6 D2 · CONFIRM: order superseded between confirm’s read and the apply → PAYMENT_HELD, ONE hold; the webhook adds nothing', async () => {
    const { d, slug, orderId, o } = await capacityOrder('l6-d2c')
    const payId = capturedOn(o)
    h.beforeApply = async () => { await json(await pubPurchase(req({ eventId: d, capacity: 800 }))) }
    const r = await confirmCap(d, orderId, o.id, payId)
    expect(r.status).toBe(409); expect(r.body.code).toBe('PAYMENT_HELD')
    extraDocs.add(`failedRefunds/license_hold_${orderId}`)
    expect(await holdsFor(orderId)).toBe(1)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect(await holdsFor(orderId)).toBe(1)
    expect(await capOf(slug)).toBe(500)
  }, T)

  it('L6 D2 · an INELIGIBLE order that was NOT superseded (refunded meanwhile) gets no hold from webhook or confirm', async () => {
    const { d, slug, orderId, o } = await capacityOrder('l6-d2n')
    const payId = capturedOn(o)
    h.beforeApply = async () => { await adminDb.doc(`licenseOrders/${orderId}`).update({ status: 'refunded' }) }
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    await adminDb.doc(`licenseOrders/${orderId}`).update({ status: 'created' })
    h.beforeApply = async () => { await adminDb.doc(`licenseOrders/${orderId}`).update({ status: 'refunded' }) }
    const r = await confirmCap(d, orderId, o.id, payId)
    expect(r.status).toBe(409); expect(r.body.code).toBe('ORDER_NOT_PAYABLE')
    expect(await holdsFor(orderId)).toBe(0)
    expect(await capOf(slug)).toBe(500)
  }, T)

  for (const lifecycle of ['cancelled', 'archived', 'completed'] as const) {
    it(`L6 D3 · event ${lifecycle.toUpperCase()} before settlement: nothing applied, order terminal, ONE hold — confirm and webhook agree`, async () => {
      const { d, slug, orderId, o } = await capacityOrder(`l6-d3-${lifecycle}`)
      await adminDb.doc(`events/${slug}`).update({ lifecycleStatus: lifecycle })
      const payId = capturedOn(o)
      const r = await confirmCap(d, orderId, o.id, payId)
      expect(r.status).toBe(409); expect(r.body.code).toBe('EVENT_NOT_LIVE')
      extraDocs.add(`failedRefunds/license_hold_${orderId}`)
      expect(await orderDoc(orderId)).toMatchObject({ status: 'failed', failReason: 'lifecycle_ineligible', manualRefundHoldId: `license_hold_${orderId}` })
      expect(await holdOf(orderId)).toMatchObject({ reason: 'lifecycle_ineligible', status: 'open', paymentId: payId, amountPaise: o.amount })
      expect(await capOf(slug)).toBe(500)
      expect((await adminDb.doc(`eventLicenses/${slug}`).get()).data()!.capacity).toBe(500)
      expect(await histFor(slug)).toBe(0)
      for (let i = 0; i < 2; i++) expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
      expect((await confirmCap(d, orderId, o.id, payId)).status).toBe(409)
      expect(await holdsFor(orderId)).toBe(1)
      expect(await capOf(slug)).toBe(500)
    }, T)
  }

  it('L6 D3 · WEBHOOK first on a not-live event: ONE hold; a failed hold write → 500 and the retry completes it once', async () => {
    const { slug, orderId, o } = await capacityOrder('l6-d3w')
    await adminDb.doc(`events/${slug}`).update({ lifecycleStatus: 'cancelled' })
    const payId = `pay_l6_${++h.seq}`
    h.fail.recordHold = 1
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(500)
    extraDocs.add(`failedRefunds/license_hold_${orderId}`)
    expect(await orderDoc(orderId)).toMatchObject({ status: 'failed', failReason: 'lifecycle_ineligible' })   // terminal already
    expect(await holdsFor(orderId)).toBe(0)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect((await webhookCaptured({ id: payId, order_id: o.id, amount: o.amount })).status).toBe(200)
    expect(await holdsFor(orderId)).toBe(1)
    expect(await holdOf(orderId)).toMatchObject({ reason: 'lifecycle_ineligible' })
    expect(await capOf(slug)).toBe(500)
  }, T)

  it('L6 D3 · an event that is still purchase-eligible (pending_review) applies normally', async () => {
    const { d, slug, orderId, o } = await capacityOrder('l6-d3ok')
    await adminDb.doc(`events/${slug}`).update({ lifecycleStatus: 'pending_review' })
    const r = await payCap(o, d, orderId)
    expect(r.status).toBe(200)
    expect(await capOf(slug)).toBe(700)
    expect(await holdsFor(orderId)).toBe(0)
  }, T)

  // ═══ RD-M5 · licence coupon per-organizer limit (atomic) + fail-closed usage lookup ═══════
  const M5 = (tag: string) => `M5${tag.toUpperCase()}${process.pid}`
  async function seedCoupon(code: string, over: Record<string, unknown>) {
    await adminDb.doc(`licenseCoupons/${code}`).set({
      code, description: '', type: 'free', value: 0, maxDiscountPaise: null, minPurchasePaise: null, maxPurchasePaise: null,
      activatesAt: null, expiresAt: null, usageLimit: null, perOrganizerLimit: 1, currentUses: 0,
      restrictions: { tiers: [], eventTypes: [] }, enabled: true, paused: false, archived: false, priority: 0, stackable: false,
      visibility: 'private', campaign: 'm5', internalNotes: '', version: 1, createdBy: 'test', createdAt: new Date(), updatedAt: new Date(),
      ...over,
    })
    couponsToWipe.add(code)
  }
  const couponsToWipe = new Set<string>()
  afterAll(async () => { for (const c of couponsToWipe) await adminDb.recursiveDelete(adminDb.doc(`licenseCoupons/${c}`)).catch(() => null) }, T)
  const counterOf = async (code: string, uid = UID) => (await adminDb.doc(`licenseCoupons/${code}/organizerRedemptions/${uid}`).get()).data()?.count as number | undefined
  const usesOf    = async (code: string) => (await adminDb.doc(`licenseCoupons/${code}`).get()).data()!.currentUses as number
  /** A draft with a coupon-bearing activation order (437 capacity); returns the purchase response + Razorpay order (if any). */
  async function couponOrder(tag: string, code: string) {
    const d = id(tag); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    const before = h.orders.length
    const r = await json(await purchase(req({ eventId: d, capacity: 437, couponCode: code })))
    return { d, r, o: h.orders.length > before ? h.orders[h.orders.length - 1] : null }
  }
  const confirmFree = (d: string) => confirm(req({ eventId: d })).then(json)

  it('M5 D1 · FREE coupon, per-organizer limit 1, two drafts ordered first: 1st activates, 2nd refused (coupon_exhausted), no hold', async () => {
    const code = M5('free'); await seedCoupon(code, { type: 'free' })
    const a = await couponOrder('m5-free-a', code), b = await couponOrder('m5-free-b', code)
    expect(a.r.status).toBe(200); expect(b.r.status).toBe(200)           // both passed the purchase pre-check (0 paid yet)
    expect(a.o).toBeNull(); expect(b.o).toBeNull()                        // ₹0 → no Razorpay order
    expect((await confirmFree(a.d)).status).toBe(200)
    const second = await confirmFree(b.d)
    expect(second.status).toBe(409)                                       // refused at REDEMPTION (the D1 gap)
    expect(await licOf(a.d)).toMatchObject({ status: 'paid', couponCode: code })
    expect((await licOf(b.d)).status).toBe('created')                     // not activated
    expect((await adminDb.doc(`failedRefunds/license_hold_lic_${b.d}`).get()).exists).toBe(false)   // ₹0 ⇒ no hold
    expect(await counterOf(code)).toBe(1)
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 D1 · PAID discount coupon, limit 1: the 2nd captured payment is not activated and is HELD exactly once', async () => {
    const code = M5('pct'); await seedCoupon(code, { type: 'percentage', value: 50 })
    const a = await couponOrder('m5-pct-a', code), b = await couponOrder('m5-pct-b', code)
    expect((await pay(a.o!, a.d)).status).toBe(200)
    const r2 = await pay(b.o!, b.d)
    expect(r2.status).toBe(409)
    extraDocs.add(`failedRefunds/license_hold_lic_${b.d}`)
    const hold = (await adminDb.doc(`failedRefunds/license_hold_lic_${b.d}`).get()).data()!
    expect(hold).toMatchObject({ reason: 'coupon_exhausted', status: 'open', amountPaise: b.o!.amount })
    expect(await licOf(b.d)).toMatchObject({ status: 'failed', failReason: 'coupon_exhausted' })
    // retry + webhook redelivery: no second hold, no activation
    await pay(b.o!, b.d)
    const bPay = [...h.payments.values()].filter(x => x.order_id === b.o!.id).map(x => x.id as string)[0]
    expect((await webhookCaptured({ id: bPay, order_id: b.o!.id, amount: b.o!.amount })).status).toBe(200)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', `lic_${b.d}`).get()).size).toBe(1)
    expect(await counterOf(code)).toBe(1)
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 D1 · CONCURRENT confirmations for two drafts: exactly one activation; counters stay exact', async () => {
    const code = M5('race'); await seedCoupon(code, { type: 'free' })
    const a = await couponOrder('m5-race-a', code), b = await couponOrder('m5-race-b', code)
    const rs = await Promise.all([confirmFree(a.d), confirmFree(b.d)])
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect([(await licOf(a.d)).status, (await licOf(b.d)).status].filter(x => x === 'paid')).toHaveLength(1)
    expect(await counterOf(code)).toBe(1)
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 D1 · LEGACY seeding: prior PAID redemptions without a counter are counted, never assumed zero', async () => {
    const code = M5('legacy'); await seedCoupon(code, { type: 'free', perOrganizerLimit: 1 })
    const n = await couponOrder('m5-legacy-new', code)                   // passes the pre-check (no prior paid yet)
    const legacyId = `lic_m5legacy${process.pid}`
    await adminDb.doc(`licenseOrders/${legacyId}`).set({ orderId: legacyId, eventId: `m5legacy${process.pid}`, organizerUid: UID, couponCode: code, status: 'paid', purpose: 'purchase' })
    extraDocs.add(`licenseOrders/${legacyId}`)
    expect(await counterOf(code)).toBeUndefined()                         // no counter yet
    expect((await confirmFree(n.d)).status).toBe(409)                    // seed = 1 ≥ limit 1 ⇒ refused
    expect((await licOf(n.d)).status).toBe('created')
    // limit 2: the same legacy use is seeded, and the new activation brings the counter to 2
    await adminDb.doc(`licenseCoupons/${code}`).update({ perOrganizerLimit: 2 })
    expect((await confirmFree(n.d)).status).toBe(200)
    expect(await counterOf(code)).toBe(2)
  }, T)

  it('M5 D1 · another organizer has their OWN allowance; an UNLIMITED coupon creates no counter', async () => {
    const code = M5('orgs'); await seedCoupon(code, { type: 'free' })
    const a = await couponOrder('m5-orgs-a', code)
    expect((await confirmFree(a.d)).status).toBe(200)
    const B = `c02svc-orgM5-${process.pid}`, dB = id('m5-orgs-b')
    await adminDb.doc(`users/${B}`).set({ uid: B, role: 'organizer', accountStatus: 'active', emailVerified: true }); extraDocs.add(`users/${B}`)
    await adminDb.doc(`users/${B}/eventDrafts/${dB}`).set(draftDoc(dB, { uid: B, serviceSelection: { whatsapp: 0, certificates: 0 } })); extraDocs.add(`users/${B}/eventDrafts/${dB}`)
    h.who = B
    expect((await json(await purchase(req({ eventId: dB, capacity: 437, couponCode: code })))).status).toBe(200)
    expect((await confirmFree(dB)).status).toBe(200)
    h.who = ''
    extraDocs.add(`licenseOrders/lic_${dB}`)
    expect(await counterOf(code, UID)).toBe(1)
    expect(await counterOf(code, B)).toBe(1)
    expect(await usesOf(code)).toBe(2)
    // unlimited
    const un = M5('unl'); await seedCoupon(un, { type: 'free', perOrganizerLimit: null })
    const u1 = await couponOrder('m5-unl-a', un), u2 = await couponOrder('m5-unl-b', un)
    expect((await confirmFree(u1.d)).status).toBe(200)
    expect((await confirmFree(u2.d)).status).toBe(200)
    expect(await counterOf(un)).toBeUndefined()
    expect(await usesOf(un)).toBe(2)
  }, T)

  it('M5 refund · a refunded redemption returns the organizer’s use EXACTLY once (only after the gateway succeeds); global currentUses unchanged; a failed gateway refund never moves the counter', async () => {
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    const code = M5('refund'); await seedCoupon(code, { type: 'percentage', value: 50, perOrganizerLimit: 5 })
    const publishWith = async (tag: string) => {
      const c = await couponOrder(tag, code)
      expect((await pay(c.o!, c.d)).status).toBe(200)
      const pub = await json(await publish(req({ draftId: c.d })))
      expect(pub.status).toBe(200); slugs.add(pub.body.slug as string)
      return { ...c, slug: pub.body.slug as string }
    }
    const e1 = await publishWith('m5-rf-1'), e2 = await publishWith('m5-rf-2')
    extraDocs.add(`walletTransactions/license_refund_${e1.slug}`); extraDocs.add(`walletTransactions/license_refund_${e2.slug}`)
    expect(await counterOf(code)).toBe(2)
    const mid: { counter?: number; status?: string } = {}
    h.onRefund = async () => { mid.counter = await counterOf(code); mid.status = (await licOf(e1.d)).status }
    await applyLicenseAction(e1.slug, { action: 'refund', reason: 'm5 test' } as never, 'admin_m5')
    expect(mid).toEqual({ counter: 2, status: 'refunding' })          // still counted while the gateway call is pending
    expect((await licOf(e1.d)).status).toBe('refunded')
    expect(await counterOf(code)).toBe(1)                                 // released once
    await expect(applyLicenseAction(e1.slug, { action: 'refund', reason: 'again' } as never, 'admin_m5')).rejects.toThrow()
    expect(await counterOf(code)).toBe(1)                                 // duplicate refund: no second release
    expect(await usesOf(code)).toBe(2)                                    // global never decremented
    // gateway refund FAILS → the order is paid again and its use is restored
    h.fail.refund = 1
    h.onRefund = async () => { mid.counter = await counterOf(code) }
    await expect(applyLicenseAction(e2.slug, { action: 'refund', reason: 'fail' } as never, 'admin_m5')).rejects.toThrow()
    expect(mid.counter).toBe(1)
    expect((await licOf(e2.d)).status).toBe('paid')
    expect(await counterOf(code)).toBe(1)
  }, T)

  // ═══ RD-M5 follow-up · refund ⇄ coupon-counter race: a use is released only on a CONFIRMED refund ══
  const paidRedemptions = async (code: string, uid = UID) =>
    (await adminDb.collection('licenseOrders').where('organizerUid', '==', uid).where('couponCode', '==', code).where('status', '==', 'paid').count().get()).data().count
  /** A draft at `capacity` with a coupon-bearing activation order (draft capacity matches, so it can publish). */
  async function couponOrderAt(tag: string, code: string, capacity: number) {
    const d = id(tag); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 }, registrationCapacity: capacity })
    const before = h.orders.length
    const r = await json(await purchase(req({ eventId: d, capacity, couponCode: code })))
    expect(r.status).toBe(200)
    return { d, o: h.orders.length > before ? h.orders[h.orders.length - 1] : null }
  }
  async function publishPaid(c: { d: string; o: { id: string; amount: number } | null }) {
    expect((c.o ? await pay(c.o, c.d) : await confirmFree(c.d)).status).toBe(200)
    const pub = await json(await publish(req({ draftId: c.d })))
    expect(pub.status).toBe(200); slugs.add(pub.body.slug as string)
    extraDocs.add(`walletTransactions/license_refund_${pub.body.slug as string}`)
    return pub.body.slug as string
  }
  /**
   * limit 1 · A = PAID (capacity 1000) and published; B = ₹0 order (capacity 437) created BEFORE A paid (so it
   * passed the pre-check). One FIXED coupon worth exactly the 437 price makes B free and leaves A payable.
   */
  async function raceFreeB(tag: string) {
    const { calculateActivationQuote } = await import('@/lib/licensing/capacityPricing')
    const { getEventCommercialTerms }  = await import('@/lib/licensing/resolveCommercialTerms')
    const code = M5(tag)
    await seedCoupon(code, { type: 'fixed', value: 1 })
    const b = { d: id(`${tag}-b`) }
    await seed(b.d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    const q = calculateActivationQuote({ capacity: 437, terms: await getEventCommercialTerms(b.d) })
    if (!q.ok) throw new Error('quote')
    await adminDb.doc(`licenseCoupons/${code}`).update({ value: q.quote.totalPaise })
    const b2 = await json(await purchase(req({ eventId: b.d, capacity: 437, couponCode: code })))
    expect(b2.status).toBe(200)
    expect((await licOf(b.d)).razorpayAmountPaise ?? 0).toBe(0)
    const a = await couponOrderAt(`${tag}-a`, code, 1000)
    expect(a.o).not.toBeNull()
    const slug = await publishPaid(a)
    expect(await counterOf(code)).toBe(1)
    return { code, a, b, slug }
  }
  const refund = async (slug: string) => {
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    return applyLicenseAction(slug, { action: 'refund', reason: 'm5 race' } as never, 'admin_m5')
  }

  it('M5 race A · gateway refund FAILS while a PAID activation races for the pending allowance: refused + held once; counter stays at the limit', async () => {
    const code = M5('rA'); await seedCoupon(code, { type: 'percentage', value: 50 })
    const a = await couponOrder('m5-ra-a', code), b = await couponOrder('m5-ra-b', code)
    const slug = await publishPaid(a)
    expect(await counterOf(code)).toBe(1)
    const mid: Record<string, unknown> = {}
    h.onRefund = async () => {
      mid.counter = await counterOf(code); mid.a = (await licOf(a.d)).status
      mid.b = (await pay(b.o!, b.d)).status                              // B's captured payment lands mid-refund
    }
    h.fail.refund = 1
    await expect(refund(slug)).rejects.toThrow(/refund failed/i)
    expect(mid).toEqual({ counter: 1, a: 'refunding', b: 409 })
    extraDocs.add(`failedRefunds/license_hold_lic_${b.d}`)
    expect(await licOf(b.d)).toMatchObject({ status: 'failed', failReason: 'coupon_exhausted' })
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', `lic_${b.d}`).get()).size).toBe(1)
    expect((await licOf(a.d)).status).toBe('paid')
    expect(await counterOf(code)).toBe(1)                                 // never above perOrganizerLimit
    expect(await paidRedemptions(code)).toBe(1)
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 race A · gateway refund FAILS while a ₹0 activation races: refused, NO hold; counter stays 1', async () => {
    const { code, a, b, slug } = await raceFreeB('rAz')
    const mid: Record<string, unknown> = {}
    h.onRefund = async () => { mid.counter = await counterOf(code); mid.b = (await confirmFree(b.d)).status }
    h.fail.refund = 1
    await expect(refund(slug)).rejects.toThrow(/refund failed/i)
    expect(mid).toEqual({ counter: 1, b: 409 })
    expect((await licOf(b.d)).status).toBe('created')
    expect((await adminDb.doc(`failedRefunds/license_hold_lic_${b.d}`).get()).exists).toBe(false)
    expect((await licOf(a.d)).status).toBe('paid')
    expect(await counterOf(code)).toBe(1)
    expect(await paidRedemptions(code)).toBe(1)
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 race B · refund SUCCEEDS: B refused while A is refunding; after finalize the use is released once and B activates on retry', async () => {
    const { code, a, b, slug } = await raceFreeB('rB')
    const mid: Record<string, unknown> = {}
    h.onRefund = async () => { mid.counter = await counterOf(code); mid.a = (await licOf(a.d)).status; mid.b = (await confirmFree(b.d)).status }
    await refund(slug)
    expect(mid).toEqual({ counter: 1, a: 'refunding', b: 409 })
    expect((await licOf(a.d)).status).toBe('refunded')
    expect(await counterOf(code)).toBe(0)
    expect((await confirmFree(b.d)).status).toBe(200)                    // retry after the confirmed refund
    expect(await counterOf(code)).toBe(1)
    expect(await usesOf(code)).toBe(2)                                    // global never decremented
  }, T)

  it('M5 race C · LEGACY (no counter): seeding counts the refunding order, B is refused and no counter is created', async () => {
    const { code, a, b, slug } = await raceFreeB('rC')
    await adminDb.doc(`licenseCoupons/${code}/organizerRedemptions/${UID}`).delete()
    const mid: Record<string, unknown> = {}
    h.onRefund = async () => { mid.b = (await confirmFree(b.d)).status; mid.counter = await counterOf(code) }
    h.fail.refund = 1
    await expect(refund(slug)).rejects.toThrow(/refund failed/i)
    expect(mid).toEqual({ b: 409, counter: undefined })
    expect(await counterOf(code)).toBeUndefined()
    expect((await licOf(a.d)).status).toBe('paid')
    expect((await confirmFree(b.d)).status).toBe(409)                    // A is paid again ⇒ still used
    expect(await counterOf(code)).toBeUndefined()
  }, T)

  it('M5 race D/E · counter never moves on claim or on repeated gateway failures; released once on success; duplicates change nothing', async () => {
    const { code, a, slug } = await raceFreeB('rDE')
    for (let i = 0; i < 2; i++) {
      const mid: Record<string, unknown> = {}
      h.onRefund = async () => { mid.counter = await counterOf(code) }
      h.fail.refund = 1
      await expect(refund(slug)).rejects.toThrow(/refund failed/i)
      expect(mid.counter).toBe(1)
      expect((await licOf(a.d)).status).toBe('paid')
      expect(await counterOf(code)).toBe(1)
    }
    await refund(slug)
    expect(await counterOf(code)).toBe(0)
    await expect(refund(slug)).rejects.toThrow()                          // duplicate ⇒ existing 409
    expect(await counterOf(code)).toBe(0)                                 // never decremented twice
    expect((await licOf(a.d)).status).toBe('refunded')
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 race F/H · refund WITHOUT a gateway leg (₹0): a failed finalize leaves it refunding AND counted everywhere; otherwise released exactly once', async () => {
    // F — the ₹0 path: released exactly once, duplicate is a 409 with no change
    const code = M5('rF'); await seedCoupon(code, { type: 'free', perOrganizerLimit: 2 })
    const f1 = await couponOrder('m5-rf-1', code), f2 = await couponOrder('m5-rf-2', code), f3 = await couponOrder('m5-rf-3', code)
    const s1 = await publishPaid(f1), s2 = await publishPaid(f2)
    expect(await counterOf(code)).toBe(2)
    await refund(s1)
    expect((await licOf(f1.d)).status).toBe('refunded')
    expect(await counterOf(code)).toBe(1)
    await expect(refund(s1)).rejects.toThrow()
    expect(await counterOf(code)).toBe(1)
    // H — finalize FAILS (simulated Firestore error): the order stays 'refunding' and its use stays counted
    h.fail.counterRef = 1
    await expect(refund(s2)).rejects.toThrow(/simulated Firestore failure/)
    expect((await licOf(f2.d)).status).toBe('refunding')
    expect(await counterOf(code)).toBe(1)
    await adminDb.doc(`licenseCoupons/${code}`).update({ perOrganizerLimit: 1 })   // f2 (refunding) now fills the allowance
    const { POST: preview } = await import('@/app/api/licensing/coupons/validate/route')
    const pv = await json(await preview(req({ eventId: f3.d, couponCode: code, capacity: 437 })))
    expect(pv.body).toMatchObject({ valid: false, failure: 'per_organizer_limit_reached' })
    const g = id('m5-rf-4'); await seed(g, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    const pr = await json(await purchase(req({ eventId: g, capacity: 437, couponCode: code })))
    expect(pr.status).toBe(422); expect(pr.body.failureReason).toBe('invalid_coupon')
    // legacy seeding (counter removed) counts the refunding order too — f3 cannot take the pending use
    await adminDb.doc(`licenseCoupons/${code}/organizerRedemptions/${UID}`).delete()
    expect((await confirmFree(f3.d)).status).toBe(409)
    expect(await counterOf(code)).toBeUndefined()
    expect(await usesOf(code)).toBe(2)
  }, T)

  it('M5 race G · refunding a NON-paid order never touches the counter or the global uses', async () => {
    const { code, a, slug } = await raceFreeB('rG')
    await adminDb.doc(`licenseOrders/lic_${a.d}`).update({ status: 'failed' })   // not a redemption any more
    await refund(slug)                                                    // gateway leg succeeds
    expect((await licOf(a.d)).status).toBe('refunded')
    expect(await counterOf(code)).toBe(1)
    expect(await usesOf(code)).toBe(1)
  }, T)

  it('M5 D2 · usage lookup UNVERIFIABLE → preview and purchase refuse (503, retryable); no order, archive or state change', async () => {
    const code = M5('d2'); await seedCoupon(code, { type: 'free' })
    const { POST: preview } = await import('@/app/api/licensing/coupons/validate/route')
    const d = id('m5-d2'); await seed(d, { serviceSelection: { whatsapp: 0, certificates: 0 } })
    h.fail.couponCount = 1
    const pv = await json(await preview(req({ eventId: d, couponCode: code, capacity: 437 })))
    expect(pv.status).toBe(503)
    expect(pv.body.message).toMatch(/couldn’t verify this coupon’s usage/)
    // an existing pending order must stay exactly as it is
    expect((await json(await purchase(req({ eventId: d, capacity: 437 })))).status).toBe(200)
    const o = h.orders[h.orders.length - 1]
    const before = await licOf(d)
    const n = h.orders.length
    h.fail.couponCount = 1
    const r = await json(await purchase(req({ eventId: d, capacity: 437, couponCode: code })))
    expect(r.status).toBe(503)
    expect(r.body.failureReason).toBe('coupon_usage_unverified')
    expect(h.orders.length).toBe(n)
    expect(await licOf(d)).toMatchObject({ status: 'created', razorpayOrderId: o.id, razorpayAmountPaise: before.razorpayAmountPaise })
    expect((await adminDb.doc(`licenseOrders/lic_${d}__sup_${o.id}`).get()).exists).toBe(false)
    expect(await counterOf(code)).toBeUndefined()
    expect(await usesOf(code)).toBe(0)
    // healthy lookup again → the normal coupon purchase works
    expect((await json(await purchase(req({ eventId: d, capacity: 437, couponCode: code })))).status).toBe(200)
    extraDocs.add(`licenseOrders/lic_${d}__sup_${o.id}`)
  }, T)

  it('05F · an existing published event: buying more needs no new agreement, and none is fabricated', async () => {
    const d = id('agree-pub'), slug = `c02-agree-pub-${process.pid}`
    await seedPublished(d, slug)
    const p = await json(await pubPurchase(req({ eventId: d, services: { whatsapp: 100 } })))   // no agreement sent
    expect(p.status).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.publishAgreement).toBeUndefined()
    expect((await adminDb.doc(`users/${UID}/eventDrafts/${d}`).get()).data()!.publishAgreement).toBeUndefined()
  }, T)

  it('lifecycle: a submitted draft cannot start a purchase', async () => {
    const d = id('submitted'); await seed(d, { status: 'pending_review', lifecycleStatus: 'pending_review' })
    const r = await purchase(req({ eventId: d, capacity: 437, services: { whatsapp: 500 } }))
    expect(r.status).toBe(409)
    expect(h.orders).toHaveLength(0)
  }, T)

  it('another organizer’s draft cannot be bought for', async () => {
    const d = id('foreign')
    drafts.add(d)
    await adminDb.doc(`users/someone-else-${process.pid}/eventDrafts/${d}`).set(draftDoc(d, { uid: 'someone-else' }))
    extraDocs.add(`users/someone-else-${process.pid}/eventDrafts/${d}`)
    const r = await purchase(req({ eventId: d, capacity: 437 }))
    expect(r.status).toBe(404)
    expect(h.orders).toHaveLength(0)
  }, T)

  it('concurrent consumption never exceeds the allowance; replay and release are exactly-once', async () => {
    const d = id('concurrency'); drafts.add(d)
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      ledgerMod.reserveServiceUnits({ draftId: d, service: 'whatsapp', unitKey: `k${i}`, source: 'test' })))
    expect(results.filter(r => r.mode === 'allowance')).toHaveLength(10)
    expect(results.filter(r => r.mode === 'exhausted')).toHaveLength(15)
    expect(((await ledger(d))!.whatsapp as { consumed: number }).consumed).toBe(10)
    // Replay of a key that WON the race takes nothing (which 10 of the 25 win is up to Firestore).
    const taken = results.findIndex(r => r.mode === 'allowance')
    expect(await ledgerMod.reserveServiceUnits({ draftId: d, service: 'whatsapp', unitKey: `k${taken}`, source: 'test' })).toEqual({ mode: 'allowance', already: true })
    // Release once restores one unit; a second release does nothing.
    expect(await ledgerMod.releaseServiceUnits({ draftId: d, service: 'whatsapp', unitKey: `k${taken}` })).toBe(true)
    expect(await ledgerMod.releaseServiceUnits({ draftId: d, service: 'whatsapp', unitKey: `k${taken}` })).toBe(false)
    expect(((await ledger(d))!.whatsapp as { consumed: number }).consumed).toBe(9)
  }, T)

  it('registration WhatsApp: accepted ⇒ consumed (wallet untouched); rejected ⇒ released; exhausted+block ⇒ skipped and recorded', async () => {
    const d = id('wa'), slug = `c02-wa-ev-${process.pid}`
    drafts.add(d); slugs.add(slug)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, pricing: { whatsappEnabled: true } })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 1, consumed: 0, onExhausted: 'block' } })
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    const reg = async (rid: string) => { extraDocs.add(`registrations/${rid}`); await adminDb.doc(`registrations/${rid}`).set({ attendee: { name: 'A', email: 'a@example.test', phone: '+919876543210' } }) }
    const args = (rid: string) => ({ registrationId: rid, organizerUid: UID, eventSlug: slug, attendeeName: 'A', eventName: 'E', ticketCode: 'T' })

    // Rejected by the provider → nothing consumed.
    h.sendOk = false
    await reg(`r1-${process.pid}`); await sendWa(args(`r1-${process.pid}`))
    expect(((await ledger(d))!.whatsapp as { consumed: number }).consumed).toBe(0)
    // Accepted → one unit consumed, wallet untouched.
    h.sendOk = true
    await reg(`r2-${process.pid}`); await sendWa(args(`r2-${process.pid}`))
    expect(((await ledger(d))!.whatsapp as { consumed: number }).consumed).toBe(1)
    expect((await walletRef().get()).data()!.balancePaise).toBe(10_000)
    // Exhausted + block → not sent, status recorded.
    const sendsBefore = h.sends.length
    await reg(`r3-${process.pid}`); await sendWa(args(`r3-${process.pid}`))
    expect(h.sends.length).toBe(sendsBefore)
    await new Promise(r => setTimeout(r, 300))   // status write is fire-and-forget
    expect((await adminDb.doc(`registrations/r3-${process.pid}`).get()).data()!.whatsappStatus).toBe('skipped_allowance_exhausted')
  }, T)

  it('broadcast: funded from the allowance in the billing transaction; exhausted ⇒ policy', async () => {
    const d = id('bc'), slug = `c02-bc-ev-${process.pid}`
    drafts.add(d); slugs.add(slug)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 100, consumed: 0, onExhausted: 'block' } })
    await walletRef().set({ balancePaise: 100_000, currency: 'INR' })
    const camp = async (cid: string) => { extraDocs.add(`broadcastCampaigns/${cid}`); await adminDb.doc(`broadcastCampaigns/${cid}`).set({ organizerUid: UID, eventSlug: slug, status: 'draft', channel: 'whatsapp' }) }

    await camp(`bc1-${process.pid}`)
    const r1 = await billing.chargeAndStartCampaign({ campaignId: `bc1-${process.pid}`, organizerUid: UID, channel: 'whatsapp', recipientCount: 60 })
    expect(r1).toEqual({ ok: true, costPaise: 0 })
    expect(((await ledger(d))!.whatsapp as { consumed: number }).consumed).toBe(60)
    expect((await walletRef().get()).data()!.balancePaise).toBe(100_000)

    await camp(`bc2-${process.pid}`)
    const r2 = await billing.chargeAndStartCampaign({ campaignId: `bc2-${process.pid}`, organizerUid: UID, channel: 'whatsapp', recipientCount: 60 })
    expect(r2).toEqual({ ok: false, reason: 'allowance_exhausted' })
    expect((await adminDb.doc(`broadcastCampaigns/bc2-${process.pid}`).get()).data()!.failReason).toBe('allowance_exhausted')
    expect(((await ledger(d))!.whatsapp as { consumed: number }).consumed).toBe(60)

    // wallet_payg policy ⇒ the existing wallet path.
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ whatsapp: { onExhausted: 'wallet_payg' } }, { merge: true })
    await camp(`bc3-${process.pid}`)
    const r3 = await billing.chargeAndStartCampaign({ campaignId: `bc3-${process.pid}`, organizerUid: UID, channel: 'whatsapp', recipientCount: 60 })
    expect(r3).toEqual({ ok: true, costPaise: 3_000 })
    expect((await walletRef().get()).data()!.balancePaise).toBe(97_000)
  }, T)

  // ═══ RD-EVENT-COMMERCE-03 · published events buy more IN PLACE ════════════════════
  async function seedPublished(d: string, slug: string, opts: { capacity?: number; sold?: number; lifecycle?: string } = {}) {
    drafts.add(d); slugs.add(slug)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).set({ ...draftDoc(d, { status: 'published', lifecycleStatus: 'published' }), eventDetails: { ...draftDoc(d).eventDetails, seo: { urlSlug: slug } } })
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, totalCapacity: opts.capacity ?? 437, lifecycleStatus: opts.lifecycle ?? 'published', commercial: null })
    await adminDb.doc(`eventLicenses/${slug}`).set({ eventId: slug, organizerUid: UID, commercialModel: 'capacity', capacity: opts.capacity ?? 437 })
    await adminDb.doc(`registrationCounters/${slug}`).set({ eventSlug: slug, totalCount: opts.sold ?? 0 })
  }
  async function payCap(order: { id: string; amount: number }, eventId: string, orderId: string) {
    const paymentId = `pay_c02_${++h.seq}`
    h.payments.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' })
    return json(await capConfirm(req({ eventId, orderId, razorpay_order_id: order.id, razorpay_payment_id: paymentId, razorpay_signature: sign(order.id, paymentId) })))
  }

  it('published: capacity increase + services in ONE order; applied together after verified payment', async () => {
    const d = id('pub-inc'), slug = `c02-pub-inc-${process.pid}`
    await seedPublished(d, slug, { capacity: 437, sold: 120 })
    const p = await json(await pubPurchase(req({ eventId: d, capacity: 600, services: { whatsapp: 200 } })))
    expect(p.status).toBe(200)
    expect(p.body.confirmVia).toBe('capacity')
    // 163 × 150 = 24,450 + 4,401 GST ; 200 × 45 = 9,000 + 1,620
    expect(h.orders[0].amount).toBe(28_851 + 10_620)
    // Not applied before payment.
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity).toBe(437)
    expect(await ledger(d)).toBeUndefined()
    const c = await payCap(h.orders[0], d, p.body.orderId as string)
    expect(c.status).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity).toBe(600)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(200)
    // Replay: nothing applied twice.
    await payCap(h.orders[0], d, p.body.orderId as string)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(200)
  }, T)

  it('published: services only → add-on order, additional units stack on the existing allowance', async () => {
    const d = id('pub-svc'), slug = `c02-pub-svc-${process.pid}`
    await seedPublished(d, slug)
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 100, consumed: 100, onExhausted: 'block' } })
    const p = await json(await pubPurchase(req({ eventId: d, services: { whatsapp: 500 } })))
    expect(p.status).toBe(200)
    expect(p.body.confirmVia).toBe('checkout')
    expect(h.orders[0].amount).toBe(22_500 + 4_050)
    expect((await pay(h.orders[0], d, p.body.orderId as string)).status).toBe(200)
    const l = (await ledger(d))!.whatsapp as { purchased: number; consumed: number }
    expect(l).toMatchObject({ purchased: 600, consumed: 100 })   // Buy More: +500, history kept
  }, T)

  it('RD-EVENT-COMMERCE-05E · awaiting approval: buying more never changes the approval status, and nothing lands before verification', async () => {
    const d = id('pub-pend'), slug = `c02-pub-pend-${process.pid}`
    await seedPublished(d, slug, { capacity: 437, sold: 0, lifecycle: 'pending_review' })
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).set({ status: 'pending_review', lifecycleStatus: 'pending_review' }, { merge: true })
    const p = await json(await pubPurchase(req({ eventId: d, capacity: 600, services: { whatsapp: 200 } })))
    expect(p.status).toBe(200)
    // An unverified confirmation (bad signature) grants nothing.
    const bad = await json(await capConfirm(req({ eventId: d, orderId: p.body.orderId, razorpay_order_id: h.orders[0].id, razorpay_payment_id: 'pay_forged', razorpay_signature: 'nope' })))
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity).toBe(437)
    expect(await ledger(d)).toBeUndefined()
    // Verified → applied once; replay grants nothing twice.
    expect((await payCap(h.orders[0], d, p.body.orderId as string)).status).toBe(200)
    await payCap(h.orders[0], d, p.body.orderId as string)
    const ev = (await adminDb.doc(`events/${slug}`).get()).data()!
    expect(ev.totalCapacity).toBe(600)
    expect(((await ledger(d))!.whatsapp as { purchased: number }).purchased).toBe(200)
    // Still awaiting approval — on the live doc AND the draft; not published, not republished.
    expect(ev.lifecycleStatus).toBe('pending_review')
    expect(ev.publishedAt).toBeUndefined()
    const dr = (await adminDb.doc(`users/${UID}/eventDrafts/${d}`).get()).data()!
    expect(dr.status).toBe('pending_review')
    expect(dr.lifecycleStatus).toBe('pending_review')
  }, T)

  it('published: never below registrations taken; a reduction uses the approved reduction charge', async () => {
    const d = id('pub-dec'), slug = `c02-pub-dec-${process.pid}`
    await seedPublished(d, slug, { capacity: 600, sold: 300 })
    const below = await json(await pubPurchase(req({ eventId: d, capacity: 250 })))
    expect(below.status).toBe(422); expect(below.body.code).toBe('BELOW_SOLD')
    const dec = await json(await pubPurchase(req({ eventId: d, capacity: 400 })))
    expect(dec.status).toBe(200)
    const order = (await adminDb.doc(`licenseOrders/${dec.body.orderId}`).get()).data()!
    expect(order.purpose).toBe('capacity_decrease')
    expect(order.capacityChange.operation).toBe('decrease')
    // A registration lands after pricing and pushes sold above the new capacity: apply refuses.
    await adminDb.doc(`registrationCounters/${slug}`).set({ totalCount: 450 }, { merge: true })
    const c = await payCap(h.orders[0], d, dec.body.orderId as string)
    expect(c.status).toBe(409)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity).toBe(600)
  }, T)

  it('published: a cancelled event cannot buy; an unsubmitted draft must use the draft flow', async () => {
    const d = id('pub-cxl'), slug = `c02-pub-cxl-${process.pid}`
    await seedPublished(d, slug, { lifecycle: 'cancelled' })
    expect((await json(await pubPurchase(req({ eventId: d, capacity: 600 })))).body.code).toBe('LIFECYCLE_INELIGIBLE')
    const dd = id('pub-draft'); await seed(dd)
    expect((await json(await pubPurchase(req({ eventId: dd, capacity: 600 })))).body.code).toBe('NOT_SUBMITTED')
    expect(h.orders).toHaveLength(0)
  }, T)

  it('published: an identical re-request REUSES the unpaid order (no duplicate payable orders)', async () => {
    const d = id('pub-dup'), slug = `c02-pub-dup-${process.pid}`
    await seedPublished(d, slug)
    const a = await json(await pubPurchase(req({ eventId: d, capacity: 500 })))
    const b = await json(await pubPurchase(req({ eventId: d, capacity: 500 })))
    expect(b.body.orderId).toBe(a.body.orderId)
    expect(b.body.reused).toBe(true)
    expect(h.orders).toHaveLength(1)
  }, T)

  it('stale quote: a displayed total that no longer matches is refused before any order', async () => {
    const d = id('stale'), slug = `c02-stale-${process.pid}`
    await seedPublished(d, slug)
    const r = await json(await pubPurchase(req({ eventId: d, capacity: 600, expectedTotalPaise: 1 })))
    expect(r.status).toBe(409); expect(r.body.code).toBe('QUOTE_CHANGED'); expect(r.body.currentTotalPaise).toBe(28_851)
    const dd = id('stale-draft'); await seed(dd)
    const s = await json(await purchase(req({ eventId: dd, capacity: 437, expectedTotalPaise: 59_000 })))
    expect(s.status).toBe(409); expect(s.body.code).toBe('QUOTE_CHANGED')
    expect(h.orders).toHaveLength(0)
    // The matching total goes through.
    expect((await purchase(req({ eventId: dd, capacity: 437, expectedTotalPaise: 59_649 }))).status).toBe(200)
  }, T)

  it('media: bought per event into the ledger (the upload boundary raises the photo cap by it)', async () => {
    h.catalog = { whatsapp: WA, certificates: CERT, media: { ...CERT, unitPricePaise: 100, minQuantity: 50, maxQuantity: 5_000 } }
    const d = id('media'); await seed(d, { registrationCapacity: 100 })
    const p = await json(await purchase(req({ eventId: d, capacity: 100, services: { media: 250 } })))
    expect(p.status).toBe(200)
    expect(h.orders[0].amount).toBe(25_000 + 4_500)
    await pay(h.orders[0], d)
    expect(((await ledger(d))!.media as { purchased: number }).purchased).toBe(250)
  }, T)

  // ═══ RD-PHOTO-01 · PAID event photo capacity, never above 3,000 — enforced on the SERVER ════════
  describe('RD-PHOTO-01 · photo capacity purchases (max 3,000 per event)', () => {
    const MEDIA = { enabled: true, unitPricePaise: 190, gstRatePercent: 18, minQuantity: 1, maxQuantity: null, presets: [], onExhausted: 'block' as const }
    const photosOf = async (d: string) => {
      const m = ((await ledger(d))?.media ?? {}) as { purchased?: number; carriedIn?: number; carriedOut?: number; refunded?: number }
      return (m.purchased ?? 0) + (m.carriedIn ?? 0) - (m.carriedOut ?? 0) - (m.refunded ?? 0)
    }
    const setPhotos = (d: string, purchased: number) =>
      adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, media: { purchased, consumed: 0, onExhausted: 'block' } }, { merge: true })
    const buy = (d: string, media: number, extra: Record<string, unknown> = {}) => pubPurchase(req({ eventId: d, services: { media }, ...extra })).then(json)
    const lastOrder = () => h.orders[h.orders.length - 1]

    it('#3/#4/#8/#23 · 3,000 succeeds; 3,001 refused before any order; at 3,000 nothing more; a replay never duplicates', async () => {
      h.catalog = { whatsapp: WA, certificates: CERT, media: MEDIA }
      const d = id('ph-3000'), slug = `c02-ph3000-${process.pid}`
      await seedPublished(d, slug)
      const over = await buy(d, 3001)
      expect(over.status).toBe(422); expect(over.body.code).toBe('PHOTO_CAPACITY_EXCEEDED'); expect(over.body.maxAdditional).toBe(3000)
      expect(h.orders).toHaveLength(0)
      const p = await buy(d, 3000)
      expect(p.status).toBe(200)
      expect(lastOrder().amount).toBe(3000 * 190 + Math.round(3000 * 190 * 0.18))   // quantity × unit + 18% GST
      expect((await pay(lastOrder(), d, p.body.orderId as string)).status).toBe(200)
      expect(await photosOf(d)).toBe(3000)
      await pay(lastOrder(), d, p.body.orderId as string)                              // replay
      expect(await photosOf(d)).toBe(3000)
      const more = await buy(d, 1)
      expect(more.status).toBe(422); expect(more.body.code).toBe('PHOTO_CAPACITY_EXCEEDED'); expect(more.body.maxAdditional).toBe(0)
      expect(h.orders).toHaveLength(1)
    }, T)

    it('#5/#6/#7 · existing 500 + 2,500 ok, + 2,501 refused; existing 2,999 + 1 ok', async () => {
      h.catalog = { whatsapp: WA, certificates: CERT, media: MEDIA }
      const d = id('ph-500'), slug = `c02-ph500-${process.pid}`
      await seedPublished(d, slug); await setPhotos(d, 500)
      expect((await buy(d, 2501)).body.code).toBe('PHOTO_CAPACITY_EXCEEDED')
      expect((await buy(d, 2500)).status).toBe(200)
      const e = id('ph-2999'), slugE = `c02-ph2999-${process.pid}`
      await seedPublished(e, slugE); await setPhotos(e, 2999)
      expect((await buy(e, 2)).body.code).toBe('PHOTO_CAPACITY_EXCEEDED')
      const ok = await buy(e, 1)
      expect(ok.status).toBe(200)
      await pay(lastOrder(), e, ok.body.orderId as string)
      expect(await photosOf(e)).toBe(3000)
    }, T)

    it('#9/#21 · a direct API call cannot bypass the maximum (draft route counts the TOTAL selection too)', async () => {
      h.catalog = { whatsapp: WA, certificates: CERT, media: MEDIA }
      const d = id('ph-draft'); await seed(d, { registrationCapacity: 100 })
      const r = await json(await purchase(req({ eventId: d, capacity: 100, services: { media: 3001 } })))
      expect(r.status).toBe(422); expect(r.body.code).toBe('PHOTO_CAPACITY_EXCEEDED')
      expect(h.orders).toHaveLength(0)
      // carried-in units count: 1,000 carried in ⇒ the draft may buy at most 2,000 more
      await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, media: { purchased: 0, consumed: 0, carriedIn: 1000, onExhausted: 'block' } })
      expect((await json(await purchase(req({ eventId: d, capacity: 100, services: { media: 2001 } })))).body.code).toBe('PHOTO_CAPACITY_EXCEEDED')
      expect((await purchase(req({ eventId: d, capacity: 100, services: { media: 2000 } }))).status).toBe(200)
    }, T)

    it('#10 · concurrent purchases cannot exceed 3,000: the later settlement is HELD, never granted', async () => {
      h.catalog = { whatsapp: WA, certificates: CERT, media: MEDIA }
      // Order 1 · add-on settles first, then the capacity order (+services) is refused as stale.
      const d = id('ph-race'), slug = `c02-phrace-${process.pid}`
      await seedPublished(d, slug, { capacity: 437 }); await setPhotos(d, 500)
      const a = await buy(d, 2000)
      const oA = lastOrder()
      const b = await json(await pubPurchase(req({ eventId: d, capacity: 600, services: { media: 2000 } })))
      const oB = lastOrder()
      expect(a.status).toBe(200); expect(b.status).toBe(200); expect(b.body.confirmVia).toBe('capacity')
      expect((await pay(oA, d, a.body.orderId as string)).status).toBe(200)
      expect(await photosOf(d)).toBe(2500)
      expect((await payCap(oB, d, b.body.orderId as string)).status).toBe(409)
      expect(await photosOf(d)).toBe(2500)                                     // never 4,500
      expect((await adminDb.doc(`events/${slug}`).get()).data()!.totalCapacity).toBe(437)
      expect((await adminDb.doc(`licenseOrders/${b.body.orderId}`).get()).data()!.status).toBe('failed')
      // Order 2 · the capacity order settles first, then the add-on is refused and its payment HELD.
      const e = id('ph-race2'), slugE = `c02-phrace2-${process.pid}`
      await seedPublished(e, slugE, { capacity: 437 }); await setPhotos(e, 500)
      const a2 = await buy(e, 2000)
      const oA2 = lastOrder()
      const b2 = await json(await pubPurchase(req({ eventId: e, capacity: 600, services: { media: 2000 } })))
      const oB2 = lastOrder()
      expect((await payCap(oB2, e, b2.body.orderId as string)).status).toBe(200)
      expect(await photosOf(e)).toBe(2500)
      const held = await pay(oA2, e, a2.body.orderId as string)
      expect(held.status).toBe(409); expect(held.body.code).toBe('PAYMENT_HELD')
      expect(await photosOf(e)).toBe(2500)
      expect((await adminDb.doc(`licenseOrders/${a2.body.orderId}`).get()).data()).toMatchObject({ status: 'failed', failReason: 'superseded' })
      const holdPath = `failedRefunds/license_hold_${a2.body.orderId}`
      extraDocs.add(holdPath)
      expect((await adminDb.doc(holdPath).get()).exists).toBe(true)
      // the refused add-on releases the single payable add-on slot: later purchases are not blocked
      expect((await ledger(e))!.pendingAddonOrderId ?? null).toBeNull()
      const next = await buy(e, 500)
      expect(next.status).toBe(200)
    }, T)

    it('a paid ACTIVATION whose photos would exceed 3,000 (units carried in after pricing) is HELD — never stuck, never granted', async () => {
      h.catalog = { whatsapp: WA, certificates: CERT, media: MEDIA }
      const d = id('ph-lic'); await seed(d, { registrationCapacity: 100 })
      const p = await json(await purchase(req({ eventId: d, capacity: 100, services: { media: 3000 } })))
      expect(p.status).toBe(200)
      // A Super Admin carry-forward lands 10 photo units on this draft before the payment settles.
      await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, media: { purchased: 0, consumed: 0, carriedIn: 10, onExhausted: 'block' } }, { merge: true })
      const r = await pay(lastOrder(), d)
      expect(r.status).toBe(409); expect(r.body.code).toBe('PAYMENT_HELD')
      expect(await photosOf(d)).toBe(10)                                        // nothing granted
      const order = (await adminDb.doc(`licenseOrders/lic_${d}`).get()).data()!
      expect(order.status).toBe('failed'); expect(order.failReason).toBe('photo_capacity_exceeded')
      const holdPath = `failedRefunds/license_hold_lic_${d}`
      extraDocs.add(holdPath)
      expect((await adminDb.doc(holdPath).get()).data()).toMatchObject({ reason: 'photo_capacity_exceeded', status: 'open' })
      // a replay (webhook / retry) changes nothing and never throws
      expect((await pay(lastOrder(), d)).status).toBeGreaterThanOrEqual(400)
      expect(await photosOf(d)).toBe(10)
    }, T)

    it('#20 · event A cannot purchase against event B (another organizer’s event)', async () => {
      h.catalog = { whatsapp: WA, certificates: CERT, media: MEDIA }
      const d = id('ph-iso'), slug = `c02-phiso-${process.pid}`
      await seedPublished(d, slug)
      h.who = `intruder-${process.pid}`
      const r = await buy(d, 100)
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(h.orders).toHaveLength(0)
      h.who = ''
    }, T)

    it('the ledger write itself refuses to take an event above 3,000 (last line of defence)', async () => {
      const d = id('ph-ledger'); drafts.add(d); await setPhotos(d, 2900)
      const ref = adminDb.doc(`eventServiceAllowances/${d}`)
      const item = { service: 'media' as const, quantity: 101, unitPricePaise: 190, basePaise: 19_190, gstRatePercent: 18, gstPaise: 3_454, totalPaise: 22_644, onExhausted: 'block' as const }
      await expect(adminDb.runTransaction(async txn => {
        const snap = await txn.get(ref)
        ledgerMod.txnApplyServiceItems(txn, snap, { draftId: d, organizerUid: UID, orderId: 'add_x', items: [item] })
      })).rejects.toThrow('PHOTO_CAPACITY_EXCEEDED')
      expect(await photosOf(d)).toBe(2900)
    }, T)
  })

})
