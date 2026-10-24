// RD-PRINT-BILL-P4 — prepaid ID-badge purchases on REAL Firestore, through the real purchase / quote /
// confirm / webhook / admin routes, the real activation + hold + sweep + refund code.
//
// Mocked: the Razorpay client (no real gateway, no real money), the webhook secret, the workspace
// authorization context (switchable owner / staff), and — TEST PROCESS ONLY — the code purchase gate
// for 'print_badges' (approved 2026-10-10: a test-only module mock; the source constants stay false and
// tests/unit/printBadgePurchaseP4.test.ts pins them). Every other service keeps the real gate.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { NextRequest } from 'next/server'

const SECRET = 'rd_p4_badges_secret'
const WHSEC = 'whsec_rd_p4_badges'
const PID = process.pid
const UID = `p4b-org-${PID}`

const h = vi.hoisted(() => ({
  gateOpen: true,
  seq: 0,
  created: [] as Array<{ id: string; amount: number; receipt: string }>,
  captures: new Map<string, Array<Record<string, unknown>> | 'throw'>(),
  payments: new Map<string, Record<string, unknown>>(),
  ctx: { owner: true },
  /** RD-PRINT-BILL-P4.4 — awaited on every fetchPayments call (a test clock / an interleaved run). */
  onFetch: null as null | ((orderId: string) => Promise<void>),
}))

vi.mock('@/lib/licensing/serviceAllowances', async orig => {
  const real = await orig<typeof import('@/lib/licensing/serviceAllowances')>()
  return { ...real, isServicePurchaseReleased: (k: unknown) => (k === 'print_badges' ? h.gateOpen : real.isServicePurchaseReleased(k)) }
})
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p4', RAZORPAY_KEY_SECRET: 'rd_p4_badges_secret',
  razorpay: {
    orders: {
      create: async (o: { amount: number; receipt: string }) => { const id = `order_p4b_${++h.seq}`; h.created.push({ id, amount: o.amount, receipt: o.receipt }); return { id, amount: o.amount } },
      fetchPayments: async (orderId: string) => { if (h.onFetch) await h.onFetch(orderId); const c = h.captures.get(orderId); if (c === 'throw') throw new Error('razorpay unavailable'); return { items: c ?? [] } },
    },
    payments: {
      fetch: async (id: string) => { const p = h.payments.get(id); if (!p) throw new Error('payment not found'); return p },
      refund: async () => { throw new Error('no automatic refunds') },
    },
  },
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: 'whsec_rd_p4_badges' }))
vi.mock('@/lib/team/workspace', async orig => {
  const UIDm = `p4b-org-${process.pid}`
  const ctx = () => h.ctx.owner
    ? { callerUid: UIDm, workspaceUid: UIDm, role: 'owner', permissions: ['events'], isOwner: true, eventIds: [], isStaffCredential: false }
    : { callerUid: `${UIDm}-staff`, workspaceUid: UIDm, role: 'manager', permissions: ['events'], isOwner: false, eventIds: [], isStaffCredential: false }
  return { ...(await orig<typeof import('@/lib/team/workspace')>()), resolveWorkspaceUid: async () => ctx(), authorizeWorkspace: async () => ({ ...ctx(), ok: true, status: 200, error: '' }) }
})
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/notifications/servicePurchase', () => ({ scheduleServicePurchaseNotification: () => undefined }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
type Rec = Record<string, unknown>

describeEmu('RD-PRINT-BILL-P4 · prepaid badge purchases (real Firestore)', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let businessConfig: typeof import('@/lib/config/businessConfigService').businessConfig
  let quoteRoute: (r: NextRequest, c: unknown) => Promise<Response>
  let purchaseRoute: (r: NextRequest, c: unknown) => Promise<Response>
  let confirmRoute: (r: NextRequest) => Promise<Response>
  let webhook: (r: NextRequest) => Promise<Response>
  let tax: typeof import('@/lib/licensing/printBadgePurchase/taxApproval')
  let settleMod: typeof import('@/lib/licensing/printBadgePurchase/settle')
  let sweepMod: typeof import('@/lib/licensing/printBadgePurchase/sweep')
  let recon: typeof import('@/lib/licensing/printBadgePurchase/reconciliation')
  let wallet: typeof import('@/lib/wallet/serviceRequests')
  let cfgBackup: Rec | null = null
  let approvalBackup: Rec | null = null
  const events: Array<{ slug: string; draft: string }> = []
  const coupons = new Set<string>()
  let n = 0

  const sign = (o: string, p: string) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex')
  const post = (url: string, body: unknown) => new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const quote = async (slug: string, body: Rec) => {
    const r = await quoteRoute(post(`http://x/api/organizer/events/${slug}/print-badges/quote`, body), { params: Promise.resolve({ eventId: slug }) })
    return { status: r.status, body: await r.json() as Rec }
  }
  const purchase = async (slug: string, body: Rec) => {
    const r = await purchaseRoute(post(`http://x/api/organizer/events/${slug}/print-badges/purchase`, body), { params: Promise.resolve({ eventId: slug }) })
    return { status: r.status, body: await r.json() as Rec }
  }
  /** Quote, then purchase at the quoted net. */
  const buy = async (slug: string, quantity: number, couponCode?: string, requestId = `req-${PID}-${++n}`) => {
    const q = await quote(slug, { quantity, couponCode })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    const net = (q.body.quote as Rec).netPaise as number
    const p = await purchase(slug, { quantity, couponCode, requestId, expectedNetPaise: net })
    return { ...p, requestId, net }
  }
  const capture = (rzpOrderId: string, amount: number, status = 'captured') => {
    const id = `pay_p4b_${++h.seq}`
    h.payments.set(id, { id, amount, currency: 'INR', status, order_id: rzpOrderId })
    const list = (h.captures.get(rzpOrderId) as Array<Rec> | undefined) ?? []
    h.captures.set(rzpOrderId, [...list, { id, amount, currency: 'INR', status }])
    return id
  }
  const confirm = async (slug: string, orderId: string, rzpOrderId: string, paymentId: string) => {
    const r = await confirmRoute(post('http://x/api/licensing/checkout/confirm', { eventId: slug, orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sign(rzpOrderId, paymentId) }))
    return { status: r.status, body: await r.json() as Rec }
  }
  const webhookCaptured = async (rzpOrderId: string, paymentId: string, amount: number) => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId, amount, status: 'captured', currency: 'INR' } } } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    const r = await webhook(new NextRequest('http://localhost/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }))
    return r.status
  }
  const order = async (id: string) => (await adminDb.doc(`licenseOrders/${id}`).get()).data() as Rec
  const ledger = async (draft: string) => ((await adminDb.doc(`eventServiceAllowances/${draft}`).get()).data() ?? {}) as Rec
  const purchased = async (draft: string) => Number(((await ledger(draft)).print_badges as Rec | undefined)?.purchased ?? 0)
  const couponDoc = async (code: string) => (await adminDb.doc(`badgeCoupons/${code}`).get()).data() as Rec
  const counter = async (code: string) => Number(((await adminDb.doc(`badgeCoupons/${code}/organizerRedemptions/${UID}`).get()).data() as Rec | undefined)?.count ?? 0)
  const hold = async (id: string) => (await adminDb.doc(`failedRefunds/${id}`).get()).data() as Rec | undefined

  async function newEvent(lifecycleStatus = 'published', extra: Rec = {}): Promise<{ slug: string; draft: string }> {
    const k = ++n
    const slug = `p4b-ev-${PID}-${k}`, draft = `p4b-dr-${PID}-${k}`
    await adminDb.doc(`users/${UID}/eventDrafts/${draft}`).set({ status: 'published', eventDetails: { seo: { urlSlug: slug }, info: { name: `Badge Event ${k}` } } })
    await adminDb.doc(`events/${slug}`).set({ lifecycleStatus, uid: UID, draftId: draft, ...extra })
    events.push({ slug, draft })
    return { slug, draft }
  }
  async function newCoupon(over: Rec = {}): Promise<string> {
    const code = `P4B${PID}X${++n}`.toUpperCase()
    await adminDb.doc(`badgeCoupons/${code}`).set({
      code, scope: 'print_badges', description: 'p4', type: 'percentage', value: 10, maxDiscountPaise: null, minPurchasePaise: null,
      activatesAt: null, expiresAt: null, usageLimit: null, perOrganizerLimit: null, currentUses: 0,
      restrictions: { eventIds: [], organizerUids: [] }, enabled: true, paused: false, archived: false,
      campaign: '', internalNotes: '', version: 1, createdBy: 'test', createdAt: new Date(), updatedAt: new Date(), ...over,
    })
    coupons.add(code)
    return code
  }
  async function setBadgeConfig(over: Rec = {}, billing: Rec = {}) {
    await adminDb.doc('system/businessConfiguration').set({
      licensing: {
        serviceAllowances: { print_badges: { enabled: true, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block', ...over } },
        printBadgeBilling: { paidGenerationEnabled: false, allowFreeCoupons: false, ...billing },
        // RD-PRINT-P8 — this suite's organizer is a pilot organizer (the real, stored-config pilot read).
        printBadgePilot: { enforced: true, organizerUids: [UID] },
      },
    }, { merge: true })
    businessConfig.invalidateCache()
  }
  const approve = (rate = 18) => tax.recordBadgeTaxApproval({
    adminUid: 'p4-super', reason: 'Accountant approved the badge GST treatment', configuredGstRate: rate,
    input: { gstRatePercent: rate, taxTreatmentId: 'badge-inclusive-v1', accountantName: 'A. Accountant & Co', accountantReference: 'AC/2026/77', accountantApprovedOn: '2026-10-01' },
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    adminDb = (await import('@/lib/firebase/admin')).adminDb
    businessConfig = (await import('@/lib/config/businessConfigService')).businessConfig
    const cfg = await adminDb.doc('system/businessConfiguration').get()
    cfgBackup = cfg.exists ? cfg.data() as Rec : null
    const ap = await adminDb.doc('platformApprovals/print_badges_gst').get()
    approvalBackup = ap.exists ? ap.data() as Rec : null
    tax = await import('@/lib/licensing/printBadgePurchase/taxApproval')
    settleMod = await import('@/lib/licensing/printBadgePurchase/settle')
    sweepMod = await import('@/lib/licensing/printBadgePurchase/sweep')
    recon = await import('@/lib/licensing/printBadgePurchase/reconciliation')
    wallet = await import('@/lib/wallet/serviceRequests')
    ;({ POST: quoteRoute } = await import('@/app/api/organizer/events/[eventId]/print-badges/quote/route') as never)
    ;({ POST: purchaseRoute } = await import('@/app/api/organizer/events/[eventId]/print-badges/purchase/route') as never)
    ;({ POST: confirmRoute } = await import('@/app/api/licensing/checkout/confirm/route') as never)
    ;({ POST: webhook } = await import('@/app/api/webhooks/razorpay/route') as never)
    await setBadgeConfig()
    await approve()
  }, T)

  afterAll(async () => {
    h.gateOpen = false
    if (cfgBackup) await adminDb.doc('system/businessConfiguration').set(cfgBackup); else await adminDb.doc('system/businessConfiguration').delete().catch(() => null)
    businessConfig?.invalidateCache()
    await adminDb.recursiveDelete(adminDb.doc('platformApprovals/print_badges_gst')).catch(() => null)
    if (approvalBackup) await adminDb.doc('platformApprovals/print_badges_gst').set(approvalBackup)
    for (const { slug, draft } of events) {
      for (const d of (await adminDb.collection('licenseOrders').where('eventId', '==', draft).get()).docs) {
        await adminDb.doc(`badgeOrderRefunds/${d.id}`).delete().catch(() => null)
        for (const f of (await adminDb.collection('failedRefunds').where('licenseOrderId', '==', d.id).get()).docs) await f.ref.delete()
        await d.ref.delete()
      }
      for (const x of (await adminDb.collection('licenseHistory').where('eventId', '==', draft).get()).docs) await x.ref.delete()
      for (const x of (await adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', draft).get()).docs) await x.ref.delete()
      await adminDb.doc(`walletServiceRequestsLocks/${draft}__print_badges`).delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${draft}`)).catch(() => null)
      await adminDb.doc(`events/${slug}`).delete().catch(() => null)
      await adminDb.doc(`users/${UID}/eventDrafts/${draft}`).delete().catch(() => null)
    }
    for (const x of (await adminDb.collection('failedRefunds').where('organizerUid', '==', UID).get()).docs) await x.ref.delete()
    for (const c of coupons) await adminDb.recursiveDelete(adminDb.doc(`badgeCoupons/${c}`)).catch(() => null)
    for (const d of (await adminDb.collection('suspiciousPayments').where('paymentId', '>=', 'pay_p4b_').where('paymentId', '<', 'pay_p4b`').get()).docs) await d.ref.delete()
  }, T)

  // ── A · quotes fail closed ───────────────────────────────────────────────────────────────────
  it('A1 · the release gate is authoritative; owner only; published, non-cancelled events only; quantity bounds', async () => {
    const { slug } = await newEvent()
    h.gateOpen = false
    expect((await quote(slug, { quantity: 100 })).body.code).toBe('NOT_RELEASED')
    h.gateOpen = true
    h.ctx.owner = false
    expect((await quote(slug, { quantity: 100 })).body.code).toBe('OWNER_REQUIRED')
    expect((await purchase(slug, { quantity: 100, requestId: `req-${PID}-staff`, expectedNetPaise: 2000 })).body.code).toBe('OWNER_REQUIRED')
    h.ctx.owner = true
    for (const lc of ['cancelled', 'completed', 'archived', 'draft', 'pending_review']) {
      const ev = await newEvent(lc)
      expect((await quote(ev.slug, { quantity: 100 })).body.code, lc).toMatch(/EVENT_NOT/)
    }
    const closedReg = await newEvent('registration_closed')
    expect((await quote(closedReg.slug, { quantity: 100 })).status).toBe(200)
    for (const q of [99, 100_001, 100.5, '100']) expect((await quote(slug, { quantity: q })).body.code, String(q)).toBe('QUANTITY_INVALID')
    const ok = await quote(slug, { quantity: 100 })
    expect(ok.body.quote).toMatchObject({ quantity: 100, unitPricePaise: 20, grossPaise: 2000, netPaise: 2000, gstRatePercent: 18, netBasePaise: 1695, netGstPaise: 305, priceSource: 'global' })
  }, T)

  it('A2 · GST unset, unapproved, revoked or changed rate ⇒ paid quotes refused; never an assumed rate', async () => {
    const { slug } = await newEvent()
    await setBadgeConfig({ gstRatePercent: null })
    expect((await quote(slug, { quantity: 100 })).body.code).toMatch(/PRICE_NOT_CONFIGURED|GST_NOT_CONFIGURED/)
    await setBadgeConfig({ gstRatePercent: 12 })
    expect((await quote(slug, { quantity: 100 })).body.code).toBe('TAX_APPROVAL_MISMATCH')
    await setBadgeConfig({ gstRatePercent: 18 })
    await tax.revokeBadgeTaxApproval({ adminUid: 'p4-super', reason: 'Accountant withdrew approval' })
    expect((await quote(slug, { quantity: 100 })).body.code).toBe('TAX_NOT_APPROVED')
    await approve()
    expect((await quote(slug, { quantity: 100 })).status).toBe(200)
    // A changed tax-treatment basis on record stops matching.
    await adminDb.doc('platformApprovals/print_badges_gst').update({ 'taxTreatment.roundingMethod': 'something else' })
    expect((await quote(slug, { quantity: 100 })).body.code).toBe('TAX_APPROVAL_MISMATCH')
    await approve()
  }, T)

  it('A3 · tax approval record: supplied accountant reference + who recorded it; history and audit in one transaction; rate must match', async () => {
    await expect(tax.recordBadgeTaxApproval({ adminUid: 'p4-super', reason: 'Wrong rate attempt', configuredGstRate: 18, input: { gstRatePercent: 5, taxTreatmentId: 'badge-inclusive-v1', accountantName: 'A. Accountant', accountantReference: 'REF-1' } })).rejects.toMatchObject({ code: 'RATE_MISMATCH' })
    await expect(tax.recordBadgeTaxApproval({ adminUid: 'p4-super', reason: 'Future date attempt', configuredGstRate: 18, input: { gstRatePercent: 18, taxTreatmentId: 'badge-inclusive-v1', accountantName: 'A. Accountant', accountantReference: 'REF-1', accountantApprovedOn: '2999-01-01' } })).rejects.toMatchObject({ code: 'DATE_INVALID' })
    await expect(tax.recordBadgeTaxApproval({ adminUid: 'p4-super', reason: 'No accountant', configuredGstRate: 18, input: { gstRatePercent: 18, taxTreatmentId: 'badge-inclusive-v1', accountantName: '', accountantReference: 'REF-1' } })).rejects.toMatchObject({ code: 'ACCOUNTANT_REQUIRED' })
    const rec = await approve()
    const stored = (await adminDb.doc('platformApprovals/print_badges_gst').get()).data() as Rec
    expect(stored).toMatchObject({ status: 'approved', gstRatePercent: 18, accountantName: 'A. Accountant & Co', accountantReference: 'AC/2026/77', recordedByUid: 'p4-super', approvalId: rec.approvalId })
    const audit = (await adminDb.collection('adminAuditLogs').where('action', '==', 'print_badge_tax.approval_recorded').get()).docs.map(d => d.data() as Rec).find(a => (a.metadata as Rec).approvalId === rec.approvalId)
    expect(audit).toMatchObject({ adminUid: 'p4-super', reason: 'Accountant approved the badge GST treatment', after: { recordedByUid: 'p4-super', accountantName: 'A. Accountant & Co' } })
    expect((await adminDb.collection('platformApprovals/print_badges_gst/history').get()).size).toBeGreaterThan(0)
  }, T)

  // ── B · order creation ───────────────────────────────────────────────────────────────────────
  it('B1 · one immutable order per request id; the internal order exists before Razorpay; no attendee/output data', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const before = h.created.length
    const a = await buy(slug, 150, code)
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    const orderId = a.body.orderId as string
    const again = await purchase(slug, { quantity: 150, couponCode: code, requestId: a.requestId, expectedNetPaise: a.net })
    expect(again.body).toMatchObject({ orderId, reused: true })
    expect(((again.body.checkout as Rec).razorpayOrderId)).toBe((a.body.checkout as Rec).razorpayOrderId)
    expect(h.created.length - before).toBe(1)                                   // one Razorpay order for both calls
    expect(h.created.at(-1)!.receipt).toBe(orderId)
    const o = await order(orderId)
    expect(Object.keys(o).sort()).toEqual([
      'amountPaise', 'badgePurchase', 'checkoutExpiresAt', 'couponRedemption', 'createdAt', 'createdByUid', 'currency', 'eventId', 'eventSlug',
      'expiredAt', 'failReason', 'manualRefundHoldId', 'orderId', 'organizerUid', 'paidAt', 'purpose', 'razorpayAmountPaise', 'razorpayOrderId',
      'razorpayPaymentId', 'requestId', 'settledVia', 'status', 'updatedAt',
    ])
    expect(JSON.stringify(o)).not.toMatch(/attendee|registration|pdf|https?:\/\//i)
    expect(o.badgePurchase).toMatchObject({ quantity: 150, unitPricePaise: 20, grossPaise: 3000, discountPaise: 300, netPaise: 2700, gstRatePercent: 18, netBasePaise: 2288, netGstPaise: 412, coupon: { code, discountPaise: 300 } })
    expect(o).toMatchObject({ purpose: 'print_badges', status: 'created', eventId: draft, amountPaise: 2700, razorpayAmountPaise: 2700 })
    expect(await counter(code)).toBe(0)                                         // quote / order never consume
    expect((await couponDoc(code)).currentUses).toBe(0)
    // a reused request id with different terms is refused
    expect((await purchase(slug, { quantity: 200, couponCode: code, requestId: a.requestId, expectedNetPaise: 3600 })).body.code).toBe('REQUEST_REUSED')
    // a stale price is refused before any order exists
    expect((await purchase(slug, { quantity: 100, requestId: `req-${PID}-stale`, expectedNetPaise: 1 })).body.code).toBe('QUOTE_CHANGED')
  }, T)

  it('B2 · one payable order per event: replaced only when Razorpay confirms no capture; captured / unknown ⇒ refused', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const rzpA = (a.body.checkout as Rec).razorpayOrderId as string
    capture(rzpA, 2000)
    expect((await buy(slug, 200)).body.code).toBe('PAYMENT_PROCESSING')       // money on A
    h.captures.set(rzpA, 'throw')
    expect((await buy(slug, 200)).body.code).toBe('PAYMENT_PROCESSING')       // unknown
    h.captures.set(rzpA, [])
    const b = await buy(slug, 200)
    expect(b.status).toBe(200)
    expect(await order(a.body.orderId as string)).toMatchObject({ status: 'failed', failReason: 'superseded' })
    expect((await ledger(draft)).pendingBadgeOrderId).toBe(b.body.orderId)
    // a late capture on the replaced order is HELD, never applied
    const pay = capture(rzpA, 2000)
    expect(await webhookCaptured(rzpA, pay, 2000)).toBe(200)
    expect(await hold(`license_hold_${a.body.orderId}`)).toMatchObject({ paymentId: pay, reason: 'superseded_paid' })
    expect(await purchased(draft)).toBe(0)
  }, T)

  it('B3 · concurrent purchases with DIFFERENT request ids for one event ⇒ exactly one payable order', async () => {
    const { slug, draft } = await newEvent()
    const q = await quote(slug, { quantity: 100 })
    const net = (q.body.quote as Rec).netPaise as number
    const before = h.created.length
    const rs = await Promise.all([1, 2, 3, 4].map(i => purchase(slug, { quantity: 100, requestId: `req-${PID}-race-${i}`, expectedNetPaise: net })))
    const ok = rs.filter(r => r.status === 200)
    expect(ok).toHaveLength(1)
    expect(rs.filter(r => r.body.code === 'PAYMENT_PROCESSING')).toHaveLength(3)
    expect(h.created.length - before).toBe(1)
    const orders = (await adminDb.collection('licenseOrders').where('eventId', '==', draft).get()).docs
    expect(orders).toHaveLength(1)
    expect((await ledger(draft)).pendingBadgeOrderId).toBe(ok[0].body.orderId)
  }, T)

  // ── C · settlement ──
  it('C9 · two paid orders racing for a coupon’s LAST use ⇒ one activated, the other held; uses never exceed the limit', async () => {
    const e1 = await newEvent(), e2 = await newEvent()
    const code = await newCoupon({ usageLimit: 1 })
    const a = await buy(e1.slug, 100, code), b = await buy(e2.slug, 100, code)
    const ra = (a.body.checkout as Rec).razorpayOrderId as string, rb = (b.body.checkout as Rec).razorpayOrderId as string
    const pa = capture(ra, a.net), pb = capture(rb, b.net)
    await Promise.all([webhookCaptured(ra, pa, a.net), webhookCaptured(rb, pb, b.net)])
    const statuses = [(await order(a.body.orderId as string)).status, (await order(b.body.orderId as string)).status].sort()
    expect(statuses).toEqual(['failed', 'paid'])
    expect((await couponDoc(code)).currentUses).toBe(1)
    expect((await purchased(e1.draft)) + (await purchased(e2.draft))).toBe(100)
    expect((await adminDb.collection('failedRefunds').where('licenseOrderId', 'in', [a.body.orderId, b.body.orderId]).get()).size).toBe(1)
  }, T)

  it('C1 · confirm activates once: units, coupon (bound code only), history, slot; replays change nothing', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const a = await buy(slug, 100, code)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = capture(rzp, a.net)
    h.ctx.owner = false
    try { expect((await confirm(slug, orderId, rzp, pay)).body.code).toBe('OWNER_REQUIRED') } finally { h.ctx.owner = true }
    expect(await purchased(draft)).toBe(0)
    const c = await confirm(slug, orderId, rzp, pay)
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect(await order(orderId)).toMatchObject({ status: 'paid', razorpayPaymentId: pay, couponRedemption: { code, discountPaise: 200 }, settledVia: 'confirm' })
    const l = await ledger(draft)
    expect(l).toMatchObject({ print_badges: { purchased: 100 }, appliedOrders: { [orderId]: true }, pendingBadgeOrderId: null })
    expect((await couponDoc(code)).currentUses).toBe(1)
    expect(await counter(code)).toBe(1)
    expect((await adminDb.doc(`badgeCoupons/${code}/redemptions/${orderId}`).get()).data()).toMatchObject({ discountPaise: 200, finalPricePaise: 1800 })
    const hist = (await adminDb.collection('licenseHistory').where('orderId', '==', orderId).get()).docs.map(d => d.data() as Rec)
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ action: 'print_badges_purchased', after: { quantity: 100, netPaise: 1800, couponCode: code } })
    // replays: confirm again, the webhook, the sweep
    expect((await confirm(slug, orderId, rzp, pay)).body).toMatchObject({ success: true, alreadyPaid: true })
    expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)
    expect(await purchased(draft)).toBe(100)
    expect((await couponDoc(code)).currentUses).toBe(1)
    expect((await adminDb.collection('licenseHistory').where('orderId', '==', orderId).get()).size).toBe(1)
  }, T)

  it('C2 · concurrent confirm + webhook + direct settlements ⇒ exactly one activation and one redemption', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const a = await buy(slug, 300, code)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = capture(rzp, a.net)
    const results = await Promise.all([
      confirm(slug, orderId, rzp, pay), webhookCaptured(rzp, pay, a.net), webhookCaptured(rzp, pay, a.net),
      settleMod.settleBadgePayment({ orderId, razorpayOrderId: rzp, paymentId: pay, amountPaise: a.net, currency: 'INR', via: 'sweep' }),
    ])
    expect(results[0].status).toBe(200)
    expect(await purchased(draft)).toBe(300)
    expect((await couponDoc(code)).currentUses).toBe(1)
    expect(await counter(code)).toBe(1)
    expect((await adminDb.collection('licenseHistory').where('orderId', '==', orderId).get()).size).toBe(1)
  }, T)

  it('C3 · a second payment on a paid order is held (webhook and confirm), never granted', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const p1 = capture(rzp, 2000)
    expect((await confirm(slug, orderId, rzp, p1)).status).toBe(200)
    const p2 = capture(rzp, 2000)
    expect(await webhookCaptured(rzp, p2, 2000)).toBe(200)
    expect(await hold(`license_dup_${p2}`)).toMatchObject({ kind: 'license_duplicate_payment', paymentId: p2, creditedPaymentId: p1 })
    const p3 = capture(rzp, 2000)
    expect((await confirm(slug, orderId, rzp, p3)).body.code).toBe('PAYMENT_HELD')
    expect(await hold(`license_dup_${p3}`)).toBeTruthy()
    expect(await purchased(draft)).toBe(100)
  }, T)

  it('C4 · release gate closed at settlement ⇒ durable hold, nothing activated, coupon unused; replays keep ONE hold', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const a = await buy(slug, 100, code)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    h.gateOpen = false
    try {
      const pay = capture(rzp, a.net)
      expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)                  // acknowledged ONLY because the hold exists
      expect(await hold(`license_hold_${orderId}`)).toMatchObject({ status: 'open', paymentId: pay, reason: 'badge_purchase_refused', amountPaise: a.net })
      expect(await order(orderId)).toMatchObject({ status: 'failed', failReason: 'badge_not_released', manualRefundHoldId: `license_hold_${orderId}` })
      expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)
      expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', orderId).get()).size).toBe(1)
      expect(await purchased(draft)).toBe(0)
      expect((await couponDoc(code)).currentUses).toBe(0)
      expect(await counter(code)).toBe(0)
      // nothing can be quoted while the gate is closed — a free coupon included
      const free = await newCoupon({ type: 'free', value: 0 })
      expect((await quote(slug, { quantity: 100, couponCode: free })).body.code).toBe('NOT_RELEASED')
    } finally { h.gateOpen = true }
  }, T)

  it('C5 · crash between refusal and hold: the refusal wrote nothing; a redelivery creates the hold', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = capture(rzp, 2000)
    h.gateOpen = false
    try {
      // T1 alone (the process "crashes" before T2): no order change, no hold, no units.
      const t1 = await settleMod.activateBadgeOrder({ orderId, payment: { kind: 'razorpay', razorpayOrderId: rzp, paymentId: pay }, via: 'webhook' })
      expect(t1).toEqual({ kind: 'refused', reason: 'not_released' })
      expect(await order(orderId)).toMatchObject({ status: 'created', manualRefundHoldId: null })
      expect(await hold(`license_hold_${orderId}`)).toBeUndefined()
      // Razorpay redelivers: T1 + T2 complete.
      expect(await webhookCaptured(rzp, pay, 2000)).toBe(200)
      expect(await hold(`license_hold_${orderId}`)).toMatchObject({ paymentId: pay })
      expect(await purchased(draft)).toBe(0)
    } finally { h.gateOpen = true }
  }, T)

  it('C5b · the hold transaction never marks a PAID order held (an activation that won the race stands)', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = capture(rzp, 2000)
    expect((await confirm(slug, orderId, rzp, pay)).status).toBe(200)
    const { recordManualRefundHold } = await import('@/lib/licensing/manualRefundHold')
    // A T2 that lost the race to a T1 activation arrives late:
    const late = await recordManualRefundHold({
      orderDocId: orderId, razorpayOrderId: rzp, paymentId: pay, amountPaise: 2000, eventId: draft, organizerUid: UID,
      reason: 'badge_purchase_refused', source: 'license', failReason: 'badge_not_released', onlyIfOrder: settleMod.unpaidUnheldBadgeOrder(rzp),
    })
    expect(late).toMatchObject({ created: false, skipped: true })
    expect(await order(orderId)).toMatchObject({ status: 'paid', manualRefundHoldId: null })
    expect(await hold(`license_hold_${orderId}`)).toBeUndefined()
    expect(await purchased(draft)).toBe(100)
  }, T)

  it('C6 · coupon financial change between quote and capture ⇒ held; a description-only edit still activates', async () => {
    const { slug, draft } = await newEvent()
    const changed = await newCoupon()
    const a = await buy(slug, 100, changed)
    await adminDb.doc(`badgeCoupons/${changed}`).update({ value: 50, version: 2 })
    const pay = capture((a.body.checkout as Rec).razorpayOrderId as string, a.net)
    expect(await webhookCaptured((a.body.checkout as Rec).razorpayOrderId as string, pay, a.net)).toBe(200)
    expect(await order(a.body.orderId as string)).toMatchObject({ status: 'failed', failReason: 'badge_coupon_changed' })
    expect((await couponDoc(changed)).currentUses).toBe(0)
    expect(await purchased(draft)).toBe(0)

    const ev2 = await newEvent()
    const cosmetic = await newCoupon()
    const b = await buy(ev2.slug, 100, cosmetic)
    await adminDb.doc(`badgeCoupons/${cosmetic}`).update({ description: 'renamed', version: 2 })
    const pay2 = capture((b.body.checkout as Rec).razorpayOrderId as string, b.net)
    expect((await confirm(ev2.slug, b.body.orderId as string, (b.body.checkout as Rec).razorpayOrderId as string, pay2)).status).toBe(200)
    expect(await purchased(ev2.draft)).toBe(100)
    expect((await couponDoc(cosmetic)).currentUses).toBe(1)
  }, T)

  it('C7 · free (100%) coupon: needs the free-coupon switch; no Razorpay; same activation and binding', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon({ type: 'free', value: 0 })
    expect((await quote(slug, { quantity: 100, couponCode: code })).body.code).toBe('COUPON_REFUSED')
    await setBadgeConfig({}, { allowFreeCoupons: true })
    try {
      const before = h.created.length
      const a = await buy(slug, 100, code)
      expect(a.body).toMatchObject({ applied: true, checkout: null })
      expect(h.created.length).toBe(before)
      expect(await order(a.body.orderId as string)).toMatchObject({ status: 'paid', amountPaise: 0, razorpayOrderId: null, settledVia: 'free', couponRedemption: { code } })
      expect(await purchased(draft)).toBe(100)
      expect((await couponDoc(code)).currentUses).toBe(1)
      const again = await purchase(slug, { quantity: 100, couponCode: code, requestId: a.requestId, expectedNetPaise: 0 })
      expect(again.body).toMatchObject({ alreadyPaid: true })
      expect(await purchased(draft)).toBe(100)
    } finally { await setBadgeConfig({}, { allowFreeCoupons: false }) }
  }, T)

  it('C8 · activation clears the pending slot ONLY when it still names this order', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    await adminDb.doc(`eventServiceAllowances/${draft}`).update({ pendingBadgeOrderId: 'bdg_someone_else' })
    expect((await confirm(slug, orderId, rzp, capture(rzp, 2000))).status).toBe(200)
    expect(await ledger(draft)).toMatchObject({ pendingBadgeOrderId: 'bdg_someone_else', print_badges: { purchased: 100 } })
  }, T)

  // ── D · expiry and the sweep ─────────────────────────────────────────────────────────────────
  it('D1 · sweep: unknown / authorised never expire; none ⇒ expired + slot freed; a late capture is HELD (no units, no coupon)', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const a = await buy(slug, 100, code)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const later = Date.now() + 2 * 3_600_000
    h.captures.set(rzp, 'throw')
    expect((await sweepMod.sweepBadgeOrders({ nowMs: later })).unknown).toBeGreaterThan(0)
    expect((await order(orderId)).status).toBe('created')
    h.captures.set(rzp, [{ id: 'pay_auth', amount: a.net, currency: 'INR', status: 'authorized' }])
    await sweepMod.sweepBadgeOrders({ nowMs: later })
    expect((await order(orderId)).status).toBe('created')
    h.captures.set(rzp, [])
    await sweepMod.sweepBadgeOrders({ nowMs: later })
    expect(await order(orderId)).toMatchObject({ status: 'expired' })
    expect((await ledger(draft)).pendingBadgeOrderId).toBeNull()
    const pay = capture(rzp, a.net)
    expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)
    expect(await order(orderId)).toMatchObject({ status: 'failed', failReason: 'badge_expired' })
    expect(await hold(`license_hold_${orderId}`)).toMatchObject({ paymentId: pay })
    expect(await purchased(draft)).toBe(0)
    expect((await couponDoc(code)).currentUses).toBe(0)
  }, T)

  it('D2 · sweep settles a captured payment the client and webhook missed (once), and re-runs safely', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const rzp = (a.body.checkout as Rec).razorpayOrderId as string
    capture(rzp, 2000)
    const later = Date.now() + 2 * 3_600_000
    await sweepMod.sweepBadgeOrders({ nowMs: later })
    await sweepMod.sweepBadgeOrders({ nowMs: later })
    expect(await order(a.body.orderId as string)).toMatchObject({ status: 'paid', settledVia: 'sweep' })
    expect(await purchased(draft)).toBe(100)
  }, T)

  // ── E · refunds and coupon release ───────────────────────────────────────────────────────────
  async function paidOrder(slug: string, qty: number, code?: string) {
    const a = await buy(slug, qty, code)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    expect((await confirm(slug, orderId, rzp, capture(rzp, a.net))).status).toBe(200)
    return { orderId, net: a.net }
  }
  const closeEvent = (slug: string) => adminDb.doc(`events/${slug}`).update({ lifecycleStatus: 'completed', completedAt: new Date() })

  it('E1 · full refund (net paid after coupon) releases the ORGANIZER count once; global uses unchanged; replay changes nothing', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const { orderId, net } = await paidOrder(slug, 100, code)
    await closeEvent(slug)
    const [req] = await wallet.submitServiceRequests({ uid: UID, callerUid: UID, kind: 'refund', draftId: draft, services: ['print_badges'], note: 'Unused badges' })
    expect(req.refundUpperBoundPaise).toBe(net)                                  // the NET paid, not the gross
    await wallet.decideServiceRequest({ adminUid: 'p4-super', id: req.id, action: 'approve', reason: 'Unused badges refund', approvedAmountPaise: net })
    const done = await wallet.decideServiceRequest({ adminUid: 'p4-super', id: req.id, action: 'mark_processed', reason: 'Refunded via bank', externalReference: 'NEFT-1', refundedAmountPaise: net })
    expect(done.already).toBe(false)
    expect(await counter(code)).toBe(0)
    expect((await couponDoc(code)).currentUses).toBe(1)                          // global never decremented
    expect((await adminDb.doc(`badgeCoupons/${code}/releases/${orderId}`).get()).data()).toMatchObject({ counterDecremented: true, requestId: req.id })
    expect((await adminDb.doc(`badgeOrderRefunds/${orderId}`).get()).data()).toMatchObject({ processedUnits: 100, processedPaise: net, fullyRefunded: true, couponReleased: true })
    const replay = await wallet.decideServiceRequest({ adminUid: 'p4-super', id: req.id, action: 'mark_processed', reason: 'Refunded via bank', externalReference: 'NEFT-1', refundedAmountPaise: net })
    expect(replay.already).toBe(true)
    expect(await counter(code)).toBe(0)
    expect((await adminDb.collection('adminAuditLogs').where('action', '==', 'badge_coupon.organizer_usage_released').where('entityId', '==', code).get()).size).toBe(1)
  }, T)

  it('E2 · a short refund releases nothing; cumulative processed refunds release exactly once when they complete the order', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const { orderId, net } = await paidOrder(slug, 101, code)                  // 101 × 20 = 2020 − 10% = 1818
    await closeEvent(slug)
    // A real request processed SHORT: no release.
    const [short] = await wallet.submitServiceRequests({ uid: UID, callerUid: UID, kind: 'refund', draftId: draft, services: ['print_badges'], note: 'x' })
    await wallet.decideServiceRequest({ adminUid: 'p4-super', id: short.id, action: 'approve', reason: 'Approve in full', approvedAmountPaise: net })
    await wallet.decideServiceRequest({ adminUid: 'p4-super', id: short.id, action: 'mark_processed', reason: 'Bank paid less', externalReference: 'NEFT-S', refundedAmountPaise: net - 1 })
    expect(await counter(code)).toBe(1)
    expect((await adminDb.doc(`badgeOrderRefunds/${orderId}`).get()).data()).toMatchObject({ fullyRefunded: false })
    expect((await adminDb.doc(`badgeCoupons/${code}/releases/${orderId}`).get()).exists).toBe(false)

    // Cumulative: two separately processed requests of 50 + 51 units on a fresh order.
    const ev2 = await newEvent()
    const code2 = await newCoupon()
    const o2 = await paidOrder(ev2.slug, 101, code2)
    const { valueUnitsExact } = await import('@/lib/wallet/serviceRequestRules')
    const lot = [{ orderId: o2.orderId, at: 1, quantity: 101, totalPaise: o2.net }]
    const first = valueUnitsExact(lot, 0, 0, 51)!, second = valueUnitsExact(lot, 0, 51, 50)!
    expect(first.valuePaise + second.valuePaise).toBe(o2.net)                   // exact: no paisa lost
    const mk = async (id: string, part: { units: number; valuePaise: number }) => adminDb.doc(`walletServiceRequests/${id}`).set({
      kind: 'refund', status: 'approved', organizerUid: UID, submittedBy: UID, service: 'print_badges', quantity: part.units,
      sourceDraftId: ev2.draft, sourceName: 'x', destinationDraftId: null, destinationName: null,
      refundUpperBoundPaise: part.valuePaise, approvedAmountPaise: part.valuePaise, externalReference: null, organizerNote: '', history: [],
      badgeAllocation: [{ orderId: o2.orderId, units: part.units, valuePaise: part.valuePaise }], badgeCapPaise: part.valuePaise,
    })
    const r1 = `p4b-req1-${PID}`, r2 = `p4b-req2-${PID}`
    await mk(r1, { units: 51, valuePaise: first.valuePaise }); await mk(r2, { units: 50, valuePaise: second.valuePaise })
    await wallet.decideServiceRequest({ adminUid: 'p4-super', id: r1, action: 'mark_processed', reason: 'Part one', externalReference: 'NEFT-A', refundedAmountPaise: first.valuePaise })
    expect(await counter(code2)).toBe(1)                                        // partial ⇒ nothing released
    await wallet.decideServiceRequest({ adminUid: 'p4-super', id: r2, action: 'mark_processed', reason: 'Part two', externalReference: 'NEFT-B', refundedAmountPaise: second.valuePaise })
    expect(await counter(code2)).toBe(0)                                        // aggregate qualifies ⇒ released once
    expect((await adminDb.doc(`badgeOrderRefunds/${o2.orderId}`).get()).data()).toMatchObject({ processedUnits: 101, processedPaise: o2.net, couponReleased: true })
    expect((await couponDoc(code2)).currentUses).toBe(1)
    await wallet.decideServiceRequest({ adminUid: 'p4-super', id: r2, action: 'mark_processed', reason: 'Part two', externalReference: 'NEFT-B', refundedAmountPaise: second.valuePaise })
    expect(await counter(code2)).toBe(0)
    for (const id of [r1, r2]) await adminDb.doc(`walletServiceRequests/${id}`).delete()
  }, T)

  // ── F · reconciliation ───────────────────────────────────────────────────────────────────────
  // ── RD-PRINT-P8 (W5) · the paid ID-badge PILOT (real stored configuration) ─────────────────────────
  const PILOT_ON = { enforced: true, organizerUids: [UID] }
  /** Writes licensing.printBadgePilot (undefined ⇒ removed). invalidate=false leaves the 60 s cache STALE. */
  const setPilot = async (v: unknown, invalidate = true) => {
    // update() with a field path REPLACES the whole value (a merge set would keep stale keys).
    await adminDb.doc('system/businessConfiguration').update({ 'licensing.printBadgePilot': v === undefined ? FieldValue.delete() : v })
    if (invalidate) businessConfig.invalidateCache()
  }
  /** Makes ONLY the pilot reads fail (they pass an options object; the catalog read passes none). */
  const failPilotReads = (which: 'all' | 'fresh') => {
    const real = businessConfig.getStoredLayer.bind(businessConfig)
    return vi.spyOn(businessConfig, 'getStoredLayer').mockImplementation(async (opts?: { fresh?: boolean }) =>
      (opts !== undefined && (which === 'all' || opts.fresh === true)) ? { stored: {}, loadFailed: true } : real(opts))
  }
  const ordersFor = async (requestId: string) => (await adminDb.collection('licenseOrders').where('requestId', '==', requestId).get()).size

  it('P8-P1 · outside the pilot: quote, purchase and a free coupon are refused (PILOT_ONLY); nothing is written; the gate still answers first', async () => {
    const { slug } = await newEvent()
    await setPilot({ enforced: true, organizerUids: [`${UID}-someone-else`] })
    try {
      expect(await quote(slug, { quantity: 100 })).toMatchObject({ status: 403, body: { code: 'PILOT_ONLY' } })
      const rq = `req-${PID}-p8-1`
      expect(await purchase(slug, { quantity: 100, requestId: rq, expectedNetPaise: 2000 })).toMatchObject({ status: 403, body: { code: 'PILOT_ONLY' } })
      expect(await ordersFor(rq)).toBe(0)
      await setBadgeConfig({}, { allowFreeCoupons: true })
      await setPilot({ enforced: true, organizerUids: [`${UID}-someone-else`] })      // setBadgeConfig re-lists this suite's organizer
      const free = await newCoupon({ type: 'free', value: 0 })
      expect((await quote(slug, { quantity: 100, couponCode: free })).body.code).toBe('PILOT_ONLY')
      expect((await purchase(slug, { quantity: 100, couponCode: free, requestId: `${rq}-free`, expectedNetPaise: 0 })).body.code).toBe('PILOT_ONLY')
      expect((await couponDoc(free)).currentUses).toBe(0)
      h.gateOpen = false
      expect((await quote(slug, { quantity: 100 })).body.code).toBe('NOT_RELEASED')
    } finally { h.gateOpen = true; await setBadgeConfig({}, { allowFreeCoupons: false }); await setPilot(PILOT_ON) }
  }, T)

  it('P8-P2 · missing ⇒ nobody (PILOT_ONLY); malformed or enforcement switched off ⇒ refused (PILOT_CONFIG_INVALID)', async () => {
    const { slug } = await newEvent()
    try {
      await setPilot(undefined)
      expect((await quote(slug, { quantity: 100 })).body.code).toBe('PILOT_ONLY')
      for (const bad of [{ enforced: true, organizerUids: UID }, { enforced: true, organizerUids: [UID, UID] }, { organizerUids: [UID] }, { enforced: true, organizerUids: [UID], extra: 1 }, { enforced: false, organizerUids: [UID] }]) {
        await setPilot(bad)
        expect(await quote(slug, { quantity: 100 }), JSON.stringify(bad)).toMatchObject({ status: 409, body: { code: 'PILOT_CONFIG_INVALID' } })
      }
    } finally { await setPilot(PILOT_ON) }
  }, T)

  it('P8-P3 · the pilot read failing at quote / order creation ⇒ 503 CONFIG_UNAVAILABLE; no order', async () => {
    const { slug } = await newEvent()
    const spy = failPilotReads('all')
    try {
      expect(await quote(slug, { quantity: 100 })).toMatchObject({ status: 503, body: { code: 'CONFIG_UNAVAILABLE' } })
      const rq = `req-${PID}-p8-3`
      expect((await purchase(slug, { quantity: 100, requestId: rq, expectedNetPaise: 2000 })).status).toBe(503)
      expect(await ordersFor(rq)).toBe(0)
    } finally { spy.mockRestore(); businessConfig.invalidateCache() }
  }, T)

  it('P8-P4 · removal between quote and order creation: the cached quote still answers, order creation reads FRESH and refuses', async () => {
    const { slug } = await newEvent()
    expect((await quote(slug, { quantity: 100 })).status).toBe(200)
    await setPilot({ enforced: true, organizerUids: [] }, false)               // cache left stale on purpose
    try {
      expect((await quote(slug, { quantity: 100 })).status).toBe(200)           // a preview: cached (≤ 60 s)
      const rq = `req-${PID}-p8-4`
      expect(await purchase(slug, { quantity: 100, requestId: rq, expectedNetPaise: 2000 })).toMatchObject({ status: 403, body: { code: 'PILOT_ONLY' } })
      expect(await ordersFor(rq)).toBe(0)
    } finally { await setPilot(PILOT_ON) }
  }, T)

  it('P8-P5 · removal after the order exists: activation reads FRESH ⇒ the capture is durably HELD (badge_not_in_pilot); nothing granted', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    await setPilot({ enforced: true, organizerUids: [] }, false)               // stale cache: only a fresh read sees it
    try {
      const pay = capture(rzp, a.net)
      expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)                  // acknowledged because the hold exists
      expect(await order(orderId)).toMatchObject({ status: 'failed', failReason: 'badge_not_in_pilot', manualRefundHoldId: `license_hold_${orderId}` })
      expect(await hold(`license_hold_${orderId}`)).toMatchObject({ status: 'open', paymentId: pay, reason: 'badge_purchase_refused', amountPaise: a.net })
      expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)                  // a replay keeps ONE hold
      expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', orderId).get()).size).toBe(1)
      expect(await purchased(draft)).toBe(0)
    } finally { await setPilot(PILOT_ON) }
  }, T)

  it('P8-P6 · an unreadable or malformed pilot at activation is NOT a refusal: no hold, the webhook is retried, a later delivery activates', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = capture(rzp, a.net)
    const spy = failPilotReads('fresh')
    try {
      expect(await webhookCaptured(rzp, pay, a.net)).not.toBe(200)
    } finally { spy.mockRestore() }
    await setPilot({ enforced: true, organizerUids: 'broken' })
    expect(await webhookCaptured(rzp, pay, a.net)).not.toBe(200)
    expect(await hold(`license_hold_${orderId}`)).toBeUndefined()
    expect(await order(orderId)).toMatchObject({ status: 'created' })
    expect(await purchased(draft)).toBe(0)
    await setPilot(PILOT_ON)
    expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)
    expect(await order(orderId)).toMatchObject({ status: 'paid' })
    expect(await purchased(draft)).toBe(100)
  }, T)

  it('P8-P7 · refunds stay possible after the organizer leaves the pilot AND the purchase gate is rolled back', async () => {
    const { slug, draft } = await newEvent()
    const { orderId, net } = await paidOrder(slug, 100)
    await setPilot({ enforced: true, organizerUids: [] })
    h.gateOpen = false
    try {
      await closeEvent(slug)
      const [req] = await wallet.submitServiceRequests({ uid: UID, callerUid: UID, kind: 'refund', draftId: draft, services: ['print_badges'], note: 'Unused badges after the pilot' })
      expect(req.refundUpperBoundPaise).toBe(net)
      await wallet.decideServiceRequest({ adminUid: 'p4-super', id: req.id, action: 'approve', reason: 'Pilot ended — unused badges', approvedAmountPaise: net })
      const done = await wallet.decideServiceRequest({ adminUid: 'p4-super', id: req.id, action: 'mark_processed', reason: 'Refunded via bank', externalReference: 'NEFT-P8', refundedAmountPaise: net })
      expect(done.already).toBe(false)
      expect((await adminDb.doc(`badgeOrderRefunds/${orderId}`).get()).data()).toMatchObject({ processedUnits: 100, processedPaise: net, fullyRefunded: true })
    } finally { h.gateOpen = true; await setPilot(PILOT_ON) }
  }, T)

  // ── SA-P1 · RD-SA-COMMERCE-P1: no new paid entitlements on an inactive licence ───────────────
  const setLicence = (slug: string, data: Rec) => adminDb.doc(`eventLicenses/${slug}`).set({ eventId: slug, organizerUid: UID, status: 'active', ...data })
  const dropLicence = (slug: string) => adminDb.doc(`eventLicenses/${slug}`).delete().catch(() => null)

  it('SA-P1a · badges: an inactive licence refuses the quote; an order opened before it ⇒ capture HELD (badge_licence_inactive), nothing granted', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    try {
      for (const lic of [{ admin: { lifecycle: 'suspended' } }, { admin: { lifecycle: 'cancelled' } }, { refundedAt: new Date() }, { refundHold: { orderId: 'x' } }]) {
        await setLicence(slug, lic)
        expect((await quote(slug, { quantity: 100 })).body.code).toBe('LICENCE_INACTIVE')
      }
      await setLicence(slug, { admin: { lifecycle: 'suspended' } })
      const pay = capture(rzp, a.net)
      expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)                  // acknowledged because the hold exists
      expect(await order(orderId)).toMatchObject({ status: 'failed', failReason: 'badge_licence_inactive', manualRefundHoldId: `license_hold_${orderId}` })
      expect(await hold(`license_hold_${orderId}`)).toMatchObject({ status: 'open', paymentId: pay, reason: 'badge_purchase_refused', amountPaise: a.net })
      expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)                  // a replay keeps ONE hold
      expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', orderId).get()).size).toBe(1)
      expect(await purchased(draft)).toBe(0)
      // A restored entitlement sells again.
      await setLicence(slug, { refundedAt: new Date(), entitlementRestoredAt: new Date() })
      expect((await quote(slug, { quantity: 100 })).status).toBe(200)
    } finally { await dropLicence(slug) }
  }, T)

  it('SA-P1b · add-ons: no checkout on an inactive licence; a captured add-on is refused + HELD once via confirm or webhook; a crash before the hold is completed on retry; pre-publish drafts unaffected', async () => {
    const dc = await import('@/lib/licensing/draftCommerce')
    const { priceServiceItem } = await import('@/lib/licensing/serviceAllowances')
    const cfg = { enabled: true, unitPricePaise: 100, gstRatePercent: 18, onExhausted: 'block' } as never
    const item = priceServiceItem('whatsapp', 10, cfg)
    const none = { whatsapp: 0, certificates: 0, media: 0, print_badges: 0 }
    const addon = async (draft: string, k: string) => {
      const orderId = `add_${draft}_${k}`, rzp = `order_p4b_add_${k}_${PID}`
      await adminDb.doc(`licenseOrders/${orderId}`).set({
        orderId, eventId: draft, organizerUid: UID, tier: 'free', fromTier: null, purpose: 'addon', status: 'created',
        amountPaise: item.totalPaise, currency: 'INR', razorpayOrderId: rzp, razorpayPaymentId: null, razorpayAmountPaise: item.totalPaise,
        serviceItems: [item], servicesTotalPaise: item.totalPaise, selection: { capacity: 0, services: { ...none, whatsapp: 10 } },
        createdAt: new Date(), updatedAt: new Date(), paidAt: null,
      })
      await adminDb.doc(`eventServiceAllowances/${draft}`).set({ draftId: draft, organizerUid: UID, pendingAddonOrderId: orderId }, { merge: true })
      return { orderId, rzp }
    }
    const wa = async (draft: string) => Number(((await ledger(draft)).whatsapp as Rec | undefined)?.purchased ?? 0)

    const { slug, draft } = await newEvent()
    await setLicence(slug, { admin: { lifecycle: 'suspended' } })
    try {
      // 1 — no checkout is opened (no Razorpay order) for a published event with an inactive licence.
      const before = h.created.length
      const r = await dc.purchaseAddon({
        draftId: draft, organizerUid: UID, tier: 'free' as never, capacity: 0, services: { ...none, whatsapp: 20 },
        catalog: { whatsapp: cfg, certificates: cfg, media: cfg } as never,
        coverage: { activation: null, paidCapacity: null, purchased: { ...none, whatsapp: 10 }, pendingAddon: null } as never,
      })
      expect(r).toMatchObject({ kind: 'error' })
      expect(h.created.length).toBe(before)

      // 2 — confirm: an add-on opened before the suspension, captured after it ⇒ refused, held, nothing granted.
      const c = await addon(draft, 'c')
      const payC = capture(c.rzp, item.totalPaise)
      const res = await confirm(draft, c.orderId, c.rzp, payC)
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PAYMENT_HELD')
      expect(await order(c.orderId)).toMatchObject({ status: 'failed', failReason: 'licence_inactive', manualRefundHoldId: `license_hold_${c.orderId}` })
      expect(await hold(`license_hold_${c.orderId}`)).toMatchObject({ status: 'open', paymentId: payC, reason: 'lifecycle_ineligible', amountPaise: item.totalPaise })
      expect((await ledger(draft)).pendingAddonOrderId).toBeNull()
      expect(await wa(draft)).toBe(0)
      expect((await confirm(draft, c.orderId, c.rzp, payC)).body.code).toBe('PAYMENT_HELD')   // replay: same ONE hold
      expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', c.orderId).get()).size).toBe(1)
      // A SECOND captured payment on the same refused order is recorded separately (never absorbed, never granted).
      const payC2 = capture(c.rzp, item.totalPaise)
      expect(await webhookCaptured(c.rzp, payC2, item.totalPaise)).toBe(200)
      expect(await hold(`license_dup_${payC2}`)).toMatchObject({ paymentId: payC2 })
      expect(await wa(draft)).toBe(0)

      // 3 — webhook, with a "crash" between the refusal transaction and the hold: the redelivery completes it.
      const w = await addon(draft, 'w')
      const payW = capture(w.rzp, item.totalPaise)
      expect(await dc.activateAddonOrder({ orderId: w.orderId, razorpayOrderId: w.rzp, razorpayPaymentId: payW })).toBe('licence_inactive')
      expect(await order(w.orderId)).toMatchObject({ status: 'failed', failReason: 'licence_inactive' })
      expect(await hold(`license_hold_${w.orderId}`)).toBeUndefined()
      expect(await webhookCaptured(w.rzp, payW, item.totalPaise)).toBe(200)
      expect(await hold(`license_hold_${w.orderId}`)).toMatchObject({ status: 'open', paymentId: payW, reason: 'lifecycle_ineligible' })
      expect(await webhookCaptured(w.rzp, payW, item.totalPaise)).toBe(200)
      expect((await adminDb.collection('failedRefunds').where('licenseOrderId', '==', w.orderId).get()).size).toBe(1)
      expect(await wa(draft)).toBe(0)
    } finally { await dropLicence(slug) }

    // 4 — a draft that was never published has no live event and no licence: its add-on settles normally.
    const k = ++n
    const pre = `p4b-dr-${PID}-${k}`
    events.push({ slug: `p4b-ev-${PID}-${k}`, draft: pre })
    const p = await addon(pre, 'p')
    expect(await dc.activateAddonOrder({ orderId: p.orderId, razorpayOrderId: p.rzp, razorpayPaymentId: `pay_p4b_pre_${k}` })).toBe('ok')
    expect(await wa(pre)).toBe(10)
  }, T)

  it('F1 · reconciliation is clean for consistent data and names each injected mismatch; it writes nothing', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const { orderId, net } = await paidOrder(slug, 100, code)
    const clean = await recon.reconcileBadgePurchases({ draftId: draft })
    expect(clean.findings).toEqual([])
    expect(clean.paid).toMatchObject({ orders: 1, units: 100, grossPaise: 2000, discountPaise: 200, netPaise: net, netBasePaise: 1525, netGstPaise: 275 })
    await adminDb.doc(`eventServiceAllowances/${draft}`).update({ [`appliedOrders.${orderId}`]: false, 'print_badges.purchased': 90 })
    await adminDb.doc(`badgeCoupons/${code}/organizerRedemptions/${UID}`).set({ count: 7 }, { merge: true })
    const bad = await recon.reconcileBadgePurchases({ draftId: draft })
    expect(bad.findings.map(f => f.code).sort()).toEqual(['ACTIVATION_MISSING', 'COUPON_COUNTER_MISMATCH', 'LEDGER_PURCHASED_MISMATCH'])
    expect((await ledger(draft)).print_badges).toMatchObject({ purchased: 90 })  // untouched by the report
  }, T)

  // ── G · RD-PRINT-BILL-P4.2 — durable suspicious-payment records ──────────────────────────────
  const suspicious = async (paymentId: string) => (await adminDb.doc(`suspiciousPayments/badge_${paymentId}`).get()).data() as Rec | undefined
  /** Fail the next `n`-th adminDb.runTransaction call (1-based) once, then behave normally. */
  const failTransaction = (nth: number) => {
    const orig = adminDb.runTransaction.bind(adminDb)
    let calls = 0
    return vi.spyOn(adminDb, 'runTransaction').mockImplementation(((fn: never, opts?: never) => (++calls === nth
      ? Promise.reject(new Error('injected write failure'))
      : orig(fn, opts))) as never)
  }

  it('G1 · webhook wrong-amount capture ⇒ deterministic durable record; redelivery adds nothing but a delivery count; nothing granted', async () => {
    const { slug, draft } = await newEvent()
    const code = await newCoupon()
    const a = await buy(slug, 100, code)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = `pay_p4b_mm_${PID}`
    expect(await webhookCaptured(rzp, pay, a.net + 1)).toBe(200)
    const first = await suspicious(pay)
    expect(first).toMatchObject({
      source: 'license', purpose: 'print_badges', reason: 'amount_mismatch', paymentId: pay, orderId: rzp, badgeOrderId: orderId,
      expectedAmountPaise: a.net, actualAmountPaise: a.net + 1, expectedCurrency: 'INR', actualCurrency: 'INR',
      deliveries: 1, detectedBy: ['webhook'], reviewed: false,
    })
    // a redelivery (even one reporting a different amount) never overwrites the original evidence
    expect(await webhookCaptured(rzp, pay, a.net + 7)).toBe(200)
    const again = await suspicious(pay)
    expect(again).toMatchObject({ actualAmountPaise: a.net + 1, deliveries: 2, detectedBy: ['webhook'] })
    expect((again!.createdAt as { toMillis(): number }).toMillis()).toBe((first!.createdAt as { toMillis(): number }).toMillis())
    expect((await adminDb.collection('suspiciousPayments').where('paymentId', '==', pay).get()).size).toBe(1)
    expect(await order(orderId)).toMatchObject({ status: 'created', razorpayPaymentId: null, couponRedemption: null })
    expect(await purchased(draft)).toBe(0)
    expect((await couponDoc(code)).currentUses).toBe(0)
  }, T)

  it('G2 · a FAILED suspicious write is never acknowledged (webhook 500); the redelivery records it once', async () => {
    const { slug } = await newEvent()
    const a = await buy(slug, 100)
    const rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = `pay_p4b_fail_${PID}`
    const spy = failTransaction(1)                                              // the mismatch path's first transaction IS the record
    try { expect(await webhookCaptured(rzp, pay, a.net + 5)).toBe(500) } finally { spy.mockRestore() }
    expect(await suspicious(pay)).toBeUndefined()
    expect(await webhookCaptured(rzp, pay, a.net + 5)).toBe(200)
    expect(await suspicious(pay)).toMatchObject({ deliveries: 1, reason: 'amount_mismatch' })
  }, T)

  it('G3 · a not-payable captured payment ⇒ durable record; its write failure ⇒ 500, then recorded on retry', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    // An order that is failed WITHOUT a hold (not a state the code produces — the not-payable path).
    await adminDb.doc(`licenseOrders/${orderId}`).update({ status: 'failed', failReason: 'badge_test_fixture' })
    const pay = `pay_p4b_np_${PID}`
    const spy = failTransaction(2)                                              // 1st = the activation read, 2nd = the record
    try { expect(await webhookCaptured(rzp, pay, a.net)).toBe(500) } finally { spy.mockRestore() }
    expect(await suspicious(pay)).toBeUndefined()
    expect(await webhookCaptured(rzp, pay, a.net)).toBe(200)
    expect(await suspicious(pay)).toMatchObject({ reason: 'badge_order_not_payable', badgeOrderId: orderId, deliveries: 1 })
    expect(await order(orderId)).toMatchObject({ status: 'failed', razorpayPaymentId: null })
    expect(await purchased(draft)).toBe(0)
  }, T)

  it('G4 · confirm with a mismatching fetched payment ⇒ durable record (400); its write failure ⇒ 503, never a final 400', async () => {
    const { slug, draft } = await newEvent()
    const a = await buy(slug, 100)
    const orderId = a.body.orderId as string, rzp = (a.body.checkout as Rec).razorpayOrderId as string
    const pay = `pay_p4b_cmm_${PID}`
    h.payments.set(pay, { id: pay, amount: a.net - 1, currency: 'INR', status: 'captured', order_id: rzp })
    const spy = failTransaction(1)
    try { expect((await confirm(slug, orderId, rzp, pay)).status).toBe(503) } finally { spy.mockRestore() }
    expect(await suspicious(pay)).toBeUndefined()
    expect((await confirm(slug, orderId, rzp, pay)).status).toBe(400)
    expect(await suspicious(pay)).toMatchObject({ reason: 'amount_or_order_mismatch', detectedBy: ['confirm'], actualAmountPaise: a.net - 1, deliveries: 1 })
    expect((await confirm(slug, orderId, rzp, pay)).status).toBe(400)
    expect(await suspicious(pay)).toMatchObject({ deliveries: 2 })
    expect(await purchased(draft)).toBe(0)
  }, T)

  // ── H · RD-PRINT-BILL-P4.2 — the late-capture walk reaches every watched expired order ───────
  it('H1 · more than 200 expired orders: cursor pages progress run by run; a capture beyond the first page is HELD; unknown/authorised stay watched; old unpaid retire', async () => {
    const N = 250
    const ids = Array.from({ length: N }, (_, i) => `bdg_q42_${PID}_${String(i).padStart(3, '0')}`)
    const rz = (i: number) => `order_q42_${PID}_${i}`
    const recent = new Date(Date.now() - 3_600_000), old = new Date(Date.now() - 8 * 24 * 3_600_000)
    for (let i = 0; i < N; i += 50) {
      const b = adminDb.batch()
      for (let j = i; j < Math.min(N, i + 50); j++) b.set(adminDb.doc(`licenseOrders/${ids[j]}`), {
        orderId: ids[j], purpose: 'print_badges', status: 'expired', eventId: `q42-dr-${PID}`, eventSlug: `q42-ev-${PID}`, organizerUid: UID,
        amountPaise: 2000, razorpayAmountPaise: 2000, currency: 'INR', razorpayOrderId: rz(j), razorpayPaymentId: null,
        badgePurchase: { coupon: null }, couponRedemption: null, manualRefundHoldId: null,
        expiredAt: j < 3 ? old : recent, lateCaptureWatch: true,
      })
      await b.commit()
    }
    // 0: old + unpaid ⇒ retire · 1: old + authorised ⇒ keep · 2: old + unknown ⇒ keep
    h.captures.set(rz(1), [{ id: 'pay_q42_auth_old', amount: 2000, currency: 'INR', status: 'authorized' }])
    h.captures.set(rz(2), 'throw')
    h.captures.set(rz(247), [{ id: 'pay_q42_auth', amount: 2000, currency: 'INR', status: 'authorized' }])
    h.captures.set(rz(248), 'throw')
    const latePay = capture(rz(249), 2000)                                     // the LAST id — beyond any first page
    await adminDb.doc('system/printBadgeOrderSweep').set({})                     // both walks from the start
    try {
      const cursors: Array<string | null> = []
      const results: Awaited<ReturnType<typeof sweepMod.sweepBadgeOrders>>[] = []
      const first = await sweepMod.sweepBadgeOrders({ limit: 200 })
      results.push(first); cursors.push(first.lateCursor)
      expect(first.lateWrapped).toBe(false)
      expect((await order(ids[249])).status).toBe('expired')                    // not reached on run 1
      let runs = 1
      while (!cursors.includes(null) && runs < 10) { const r = await sweepMod.sweepBadgeOrders({ limit: 200 }); results.push(r); cursors.push(r.lateCursor); runs++ }
      // unknown and authorised were RECOGNISED as such (not errors, not settled, not retired)
      expect(results.reduce((n, r) => n + r.errors, 0)).toBe(0)
      expect(results.reduce((n, r) => n + r.unknown, 0)).toBeGreaterThanOrEqual(2)
      expect(results.reduce((n, r) => n + r.waitingAuthorized, 0)).toBeGreaterThanOrEqual(2)
      expect(results.reduce((n, r) => n + r.watchRetired, 0)).toBeGreaterThanOrEqual(1)
      expect(cursors.at(-1)).toBeNull()                                         // wrapped: the whole watched set was walked
      const progressed = cursors.filter((c): c is string => c !== null)
      expect([...progressed].sort()).toEqual(progressed)                         // strictly forward, never stuck
      expect(new Set(progressed).size).toBe(progressed.length)
      expect(await order(ids[249])).toMatchObject({ status: 'failed', failReason: 'badge_expired', manualRefundHoldId: `license_hold_${ids[249]}` })
      expect(await hold(`license_hold_${ids[249]}`)).toMatchObject({ paymentId: latePay, status: 'open' })
      expect(await purchased(`q42-dr-${PID}`)).toBe(0)                           // held, never activated
      expect(await order(ids[0])).toMatchObject({ status: 'expired', lateCaptureWatch: false })
      for (const i of [1, 2, 247, 248]) expect(await order(ids[i]), String(i)).toMatchObject({ status: 'expired', lateCaptureWatch: true })
      // the next cycle starts from the beginning again, without the retired order
      const next = await sweepMod.sweepBadgeOrders({ limit: 200 })
      expect(next.lateCursor).not.toBeNull()
    } finally {
      for (let i = 0; i < N; i += 100) {
        const b = adminDb.batch()
        for (const id of ids.slice(i, i + 100)) { b.delete(adminDb.doc(`licenseOrders/${id}`)); b.delete(adminDb.doc(`failedRefunds/license_hold_${id}`)) }
        await b.commit()
      }
      await adminDb.doc('system/printBadgeOrderSweep').delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/q42-dr-${PID}`)).catch(() => null)
    }
  }, T)

  // ── K · RD-PRINT-BILL-P4.4 — sweep budget, checkpoints, compare-and-set, pending starvation ────
  // Fixture ids start with 'bdg_!' — '!' sorts before every hex digit, so (cursor reset) these are the
  // first documents each walk visits, whatever other orders this suite left behind.
  const mkExpiredFixtures = async (tag: string, n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `bdg_!${tag}_${PID}_${String(i).padStart(3, '0')}`)
    for (let i = 0; i < n; i += 100) {
      const b = adminDb.batch()
      for (const id of ids.slice(i, i + 100)) b.set(adminDb.doc(`licenseOrders/${id}`), {
        orderId: id, purpose: 'print_badges', status: 'expired', eventId: `k-dr-${PID}`, eventSlug: `k-ev-${PID}`, organizerUid: UID,
        amountPaise: 2000, razorpayAmountPaise: 2000, currency: 'INR', razorpayOrderId: `order_${id.slice(5)}`, razorpayPaymentId: null,
        badgePurchase: { coupon: null }, couponRedemption: null, manualRefundHoldId: null, expiredAt: new Date(), lateCaptureWatch: true,
      })
      await b.commit()
    }
    return ids
  }
  const dropFixtures = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += 200) { const b = adminDb.batch(); for (const id of ids.slice(i, i + 200)) b.delete(adminDb.doc(`licenseOrders/${id}`)); await b.commit() }
  }
  const sweepState = async () => (await adminDb.doc('system/printBadgeOrderSweep').get()).data() as Rec | undefined

  it('K1 · the time budget stops the walk; progress is saved at the last order PROCESSED; a kill keeps only checkpointed progress; repeated runs cover everything', async () => {
    const ids = await mkExpiredFixtures('k1', 120)
    const fetched: string[] = []
    let t = 0
    h.onFetch = async rz => { fetched.push(rz); t += 1000 }                    // 1 s of "work" per order
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      // Run 1 — 61 s budget ⇒ the expired walk's deadline is at 61 s: 61 orders, then it stops.
      const r1 = await sweepMod.sweepBadgeOrders({ budgetMs: 61_000, checkpointEvery: 10, clock: () => t })
      expect(r1.late).toMatchObject({ processed: 61, stoppedBy: 'deadline', wrapped: false, cursor: ids[60] })
      expect(((await sweepState())!.expired as Rec).cursor).toBe(ids[60])
      // Run 2 — "killed" by the platform after 25 orders: the clock throws mid-page.
      const before = fetched.length
      await expect(sweepMod.sweepBadgeOrders({ budgetMs: 1e9, checkpointEvery: 10, clock: () => { if (fetched.length - before >= 25) throw new Error('killed'); return 0 } })).rejects.toThrow('killed')
      expect(((await sweepState())!.expired as Rec).cursor).toBe(ids[80])        // checkpoint at 20 — the 5 after it are NOT recorded
      // Run 3 resumes right after the last checkpoint (re-visits 81–85: idempotent) and finishes the set.
      const resumeAt = fetched.length
      const r3 = await sweepMod.sweepBadgeOrders({ budgetMs: 1e9, checkpointEvery: 10, limit: 500 })
      expect(fetched[resumeAt]).toBe(`order_${ids[81].slice(5)}`)
      expect(r3.late.wrapped).toBe(true)
      expect(((await sweepState())!.expired as Rec).cursor).toBeNull()
      const seen = new Set(fetched)
      for (const id of ids) expect(seen.has(`order_${id.slice(5)}`), id).toBe(true)  // eventual coverage
    } finally { h.onFetch = null; await dropFixtures(ids) }
  }, T)

  it('K2 · compare-and-set: a stale run never overwrites a newer checkpoint — it stops and writes nothing', async () => {
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    expect(await sweepMod.commitSweepCheckpoint('expired', 0, 'bdg_a')).toBe(1)
    expect(await sweepMod.commitSweepCheckpoint('expired', 0, 'bdg_old')).toBeNull()   // stale version
    expect((await sweepState())!.expired as Rec).toMatchObject({ cursor: 'bdg_a', version: 1 })
    expect(await sweepMod.commitSweepCheckpoint('pending', 0, 'bdg_p')).toBe(1)        // the walks are independent
    expect((await sweepState())!.expired as Rec).toMatchObject({ cursor: 'bdg_a', version: 1 })

    // In a real run: a NEWER run checkpoints while this one is mid-page ⇒ this one stops; the newer cursor stays.
    const ids = await mkExpiredFixtures('k2', 30)
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    let n = 0
    h.onFetch = async () => { if (++n === 3) await sweepMod.commitSweepCheckpoint('expired', 0, 'bdg_~newer') }
    try {
      const r = await sweepMod.sweepBadgeOrders({ budgetMs: 1e9, checkpointEvery: 5 })
      expect(r.late.stoppedBy).toBe('stale')
      expect(r.late.processed).toBe(5)                                         // stopped at its first checkpoint
      expect((await sweepState())!.expired as Rec).toMatchObject({ cursor: 'bdg_~newer', version: 1 })
    } finally { h.onFetch = null; await dropFixtures(ids) }
  }, T)

  it('K3 · more than 200 pending orders: stuck unknown/authorised ones cannot starve later ones — reached on a later run', async () => {
    const N = 230
    const ids = Array.from({ length: N }, (_, i) => `bdg_!k3_${PID}_${String(i).padStart(3, '0')}`)
    const past = new Date(Date.now() - 3 * 3_600_000)
    for (let i = 0; i < N; i += 100) {
      const b = adminDb.batch()
      for (const id of ids.slice(i, i + 100)) b.set(adminDb.doc(`licenseOrders/${id}`), {
        orderId: id, purpose: 'print_badges', status: 'created', eventId: `k3-dr-${PID}`, eventSlug: `k3-ev-${PID}`, organizerUid: UID,
        amountPaise: 2000, razorpayAmountPaise: 2000, currency: 'INR', razorpayOrderId: `order_${id.slice(5)}`, razorpayPaymentId: null,
        badgePurchase: { coupon: null }, couponRedemption: null, manualRefundHoldId: null, checkoutExpiresAt: past,
      })
      await b.commit()
    }
    // the first 205 are stuck — Razorpay unknown (203) or authorised (2); the last 25 are unpaid
    ids.slice(0, 203).forEach(id => h.captures.set(`order_${id.slice(5)}`, 'throw'))
    ids.slice(203, 205).forEach(id => h.captures.set(`order_${id.slice(5)}`, [{ id: `pay_${id.slice(5)}`, amount: 2000, currency: 'INR', status: 'authorized' }]))
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      const r1 = await sweepMod.sweepBadgeOrders({ limit: 200 })
      expect(r1.pending.processed).toBe(200)
      expect((await order(ids[229])).status).toBe('created')                   // not reached on run 1
      let runs = 1
      while ((await order(ids[229])).status !== 'expired' && runs < 6) { await sweepMod.sweepBadgeOrders({ limit: 200 }); runs++ }
      expect(runs).toBeLessThanOrEqual(3)
      for (const id of ids.slice(205)) expect((await order(id)).status, id).toBe('expired')
      for (const id of [ids[0], ids[202], ids[203], ids[204]]) expect((await order(id)).status, id).toBe('created')   // never assumed unpaid
    } finally { await dropFixtures(ids) }
  }, T)

  // ── L · RD-PRINT-BILL-P4.6 — time-boxed Razorpay lookups in the sweep ────────────────────────
  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))
  const rzOf = (id: string) => `order_${id.slice(5)}`
  const mkPendingFixtures = async (tag: string, n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `bdg_!${tag}_${PID}_${String(i).padStart(3, '0')}`)
    const b = adminDb.batch()
    for (const id of ids) b.set(adminDb.doc(`licenseOrders/${id}`), {
      orderId: id, purpose: 'print_badges', status: 'created', eventId: `l-dr-${PID}`, eventSlug: `l-ev-${PID}`, organizerUid: UID,
      amountPaise: 2000, razorpayAmountPaise: 2000, currency: 'INR', razorpayOrderId: rzOf(id), razorpayPaymentId: null,
      badgePurchase: { coupon: null }, couponRedemption: null, manualRefundHoldId: null, checkoutExpiresAt: new Date(Date.now() - 3 * 3_600_000),
    })
    await b.commit()
    return ids
  }
  const oldExpired = async (id: string) => adminDb.doc(`licenseOrders/${id}`).update({ expiredAt: new Date(Date.now() - 8 * 24 * 3_600_000) })

  it('L0 · lookupWithTimeout: never resolves ⇒ timeout; resolves just before ⇒ its result; rejects ⇒ unknown', async () => {
    const t0 = Date.now()
    expect(await sweepMod.lookupWithTimeout(() => new Promise(() => undefined), 150)).toEqual({ state: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(await sweepMod.lookupWithTimeout(async () => { await sleep(100); return { state: 'none' } }, 300)).toEqual({ state: 'none' })
    expect(await sweepMod.lookupWithTimeout(() => Promise.reject(new Error('socket hang up')), 300)).toEqual({ state: 'unknown' })
  }, T)

  it('L1 · in a sweep: a hung lookup is UNKNOWN (no hold, no retire) and the walk moves on; a slow-but-in-time capture is HELD; a rejected lookup is unknown', async () => {
    const ids = await mkExpiredFixtures('l1', 4)
    const pay = capture(rzOf(ids[1]), 2000)                                   // e1 has a real (late) capture
    h.captures.set(rzOf(ids[2]), 'throw')                                      // e2 rejects
    h.onFetch = async rz => {
      if (rz === rzOf(ids[0])) return new Promise<void>(() => undefined)        // e0 never answers
      if (rz === rzOf(ids[1])) await sleep(100)                                // e1 answers just inside the timeout
    }
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      const r = await sweepMod.sweepBadgeOrders({ lookupTimeoutMs: 400 })
      expect(r.lookupTimeouts).toBe(1)
      expect(r.gatewayHalted).toBe(false)
      expect(r.late.stoppedBy).not.toBe('gateway')
      expect(await order(ids[0])).toMatchObject({ status: 'expired', lateCaptureWatch: true, manualRefundHoldId: null })
      expect(await hold(`license_hold_${ids[0]}`)).toBeUndefined()
      expect(await order(ids[1])).toMatchObject({ status: 'failed', failReason: 'badge_expired' })
      expect(await hold(`license_hold_${ids[1]}`)).toMatchObject({ paymentId: pay })
      expect(await order(ids[2])).toMatchObject({ status: 'expired', lateCaptureWatch: true })
      expect(await purchased(`k-dr-${PID}`)).toBe(0)
    } finally {
      h.onFetch = null; await dropFixtures(ids)
      await adminDb.doc(`failedRefunds/license_hold_${ids[1]}`).delete().catch(() => null)
    }
  }, T)

  it('L2 · a timed-out lookup never counts as unpaid: an unpaid pending order is NOT expired and a past-window expired order is NOT retired', async () => {
    const pend = await mkPendingFixtures('l2p', 1)
    const exp = await mkExpiredFixtures('l2e', 2)
    await oldExpired(exp[0]); await oldExpired(exp[1])
    h.captures.set(rzOf(exp[1]), [{ id: 'pay_l2_auth', amount: 2000, currency: 'INR', status: 'authorized' }])
    const hangs = new Set([rzOf(pend[0]), rzOf(exp[0]), rzOf(exp[1])])
    h.onFetch = async rz => { if (hangs.has(rz)) return new Promise<void>(() => undefined) }
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      await sweepMod.sweepBadgeOrders({ lookupTimeoutMs: 150 })
      await sweepMod.sweepBadgeOrders({ lookupTimeoutMs: 150 })                // the breaker may skip a walk once; run again
      expect((await order(pend[0])).status).toBe('created')                   // Razorpay says "none", but we never heard it
      for (const id of exp) expect(await order(id), id).toMatchObject({ status: 'expired', lateCaptureWatch: true })
    } finally { h.onFetch = null; await dropFixtures([...pend, ...exp]) }
  }, T)

  it('L3 · consecutive timeouts trip the breaker: at most 2 lookups left in flight, pending halts with its progress saved, the expired walk is skipped; the next run resumes', async () => {
    const pend = await mkPendingFixtures('l3', 4)
    const seen: string[] = []
    let hang = true
    h.onFetch = async rz => { if (pend.some(id => rzOf(id) === rz)) { seen.push(rz); if (hang) return new Promise<void>(() => undefined) } }
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      const before = (await sweepMod.readSweepWalk('expired'))
      const r = await sweepMod.sweepBadgeOrders({ lookupTimeoutMs: 150 })
      expect(r.gatewayHalted).toBe(true)
      expect(r.pending).toMatchObject({ stoppedBy: 'gateway', cursor: pend[1] })   // halted AT the 2nd timeout, progress saved
      expect(seen).toEqual([rzOf(pend[0]), rzOf(pend[1])])                        // no third request
      expect(r.late).toMatchObject({ processed: 0, stoppedBy: 'gateway' })
      expect(await sweepMod.readSweepWalk('expired')).toEqual(before)              // expired cursor untouched
      for (const id of pend) expect((await order(id)).status).toBe('created')
      hang = false
      seen.length = 0
      await sweepMod.sweepBadgeOrders({ lookupTimeoutMs: 150 })
      expect(seen[0]).toBe(rzOf(pend[2]))                                          // resumes after the saved cursor
      expect((await order(pend[3])).status).toBe('expired')
    } finally { h.onFetch = null; await dropFixtures(pend) }
  }, T)

  it('L4 · slow pending lookups cannot eat the expired walk’s time: pending stops early with progress saved; expired still runs', async () => {
    const pend = await mkPendingFixtures('l4', 10)
    const exp = await mkExpiredFixtures('l4e', 5)
    h.onFetch = async rz => { if (pend.some(id => rzOf(id) === rz)) await sleep(300) }   // slow, but under the timeout
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      // budget 3 s ⇒ pending starts orders only until 3000/2 − 1000 = 500 ms; expired keeps until 3 s
      const r = await sweepMod.sweepBadgeOrders({ budgetMs: 3_000, lookupTimeoutMs: 1_000, checkpointEvery: 1 })
      expect(r.pending.stoppedBy).toBe('deadline')
      expect(r.pending.processed).toBeGreaterThanOrEqual(1)
      expect(r.pending.processed).toBeLessThanOrEqual(2)                      // stops STARTING lookups one timeout before budget/2
      expect(r.pending.cursor).toBe(pend[r.pending.processed - 1])
      expect(r.late.processed).toBeGreaterThanOrEqual(5)
      expect(r.lookupTimeouts).toBe(0)
    } finally { h.onFetch = null; await dropFixtures([...pend, ...exp]) }
  }, T)

  it('L5 · a timed-out lookup that answers LATER changes nothing — no hold, no settlement, no checkpoint', async () => {
    const exp = await mkExpiredFixtures('l5', 1)
    capture(rzOf(exp[0]), 2000)                                               // the answer, when it comes, says "captured"
    h.onFetch = async rz => { if (rz === rzOf(exp[0])) await sleep(700) }
    await adminDb.doc('system/printBadgeOrderSweep').set({})
    try {
      const r = await sweepMod.sweepBadgeOrders({ lookupTimeoutMs: 150 })
      expect(r.lookupTimeouts).toBe(1)
      const stateAfter = await sweepState()
      await sleep(1_000)                                                       // let the late answer arrive
      expect(await order(exp[0])).toMatchObject({ status: 'expired', lateCaptureWatch: true, manualRefundHoldId: null })
      expect(await hold(`license_hold_${exp[0]}`)).toBeUndefined()
      const stateLater = await sweepState()
      expect(JSON.stringify(stateLater ?? null)).toBe(JSON.stringify(stateAfter ?? null))   // no checkpoint moved afterwards
    } finally { h.onFetch = null; await dropFixtures(exp) }
  }, T)

  // ── S · RD-PRINT-BILL-P4.4 — suspicious-payment visibility (Super Admin, paginated, read-only) ──
  describe('S · suspicious payments are visible to Super Admins only', () => {
    let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
    let listRoute: (r: NextRequest) => Promise<Response>
    const PW = 'SuspiciousP44Passw0rd!'
    const who = { superAdmin: `p44-super-${PID}@registerdesk.test`, legacy: `p44-legacy-${PID}@registerdesk.test`, organizer: `p44-org-${PID}@registerdesk.test` }
    const tok: Record<string, string> = {}, uids: Record<string, string> = {}
    const savedAdminUids = process.env.ADMIN_UIDS
    const signIn = async (email: string) => {
      const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW, returnSecureToken: true }),
      })
      return (await r.json() as { idToken: string }).idToken
    }
    const get = async (as: string | null, qs = '') => {
      const r = await listRoute(new NextRequest(`http://x/api/admin/print-badges/suspicious-payments${qs}`, { headers: as ? { Authorization: `Bearer ${tok[as]}` } : {} }))
      return { status: r.status, body: await r.json() as Rec }
    }
    const made: string[] = []

    beforeAll(async () => {
      adminAuth = (await import('@/lib/firebase/admin')).adminAuth
      for (const [k, email] of Object.entries(who)) {
        const u = await adminAuth.getUserByEmail(email).catch(() => null) ?? await adminAuth.createUser({ email, password: PW, emailVerified: true })
        uids[k] = u.uid
        await adminAuth.setCustomUserClaims(u.uid, k === 'organizer' ? null : { admin: true })
      }
      process.env.ADMIN_UIDS = uids.superAdmin
      for (const [k, email] of Object.entries(who)) tok[k] = await signIn(email)
      ;({ GET: listRoute } = await import('@/app/api/admin/print-badges/suspicious-payments/route') as never)
      const { recordBadgeSuspiciousPayment } = await import('@/lib/licensing/printBadgePurchase/suspicious')
      for (let i = 0; i < 7; i++) {
        const paymentId = `pay_p4b_s${PID}_${i}`
        made.push(paymentId)
        await recordBadgeSuspiciousPayment({
          reason: 'amount_mismatch', paymentId, razorpayOrderId: `order_s${i}`, badgeOrderId: `bdg_s${i}`, eventId: 'ev-s',
          expectedAmountPaise: 2000, actualAmountPaise: 2001, expectedCurrency: 'INR', actualCurrency: 'INR', detectedBy: 'webhook',
        })
      }
      await adminDb.collection('suspiciousPayments').add({ source: 'registration', reason: 'amount_mismatch', paymentId: `pay_p4b_nonbadge_${PID}` })
    }, T)
    afterAll(async () => {
      if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
      for (const k of Object.keys(uids)) await adminAuth.deleteUser(uids[k]).catch(() => null)
    }, T)

    it('S1 · unauthenticated, organizer and legacy admin:true all refused (403, the requireSuperAdmin convention); Super Admin allowed; a bad cursor is a 400', async () => {
      expect((await get(null)).status).toBe(403)
      expect((await get('organizer')).status).toBe(403)
      const legacy = await get('legacy')
      expect([legacy.status, legacy.body.code]).toEqual([403, 'SUPER_ADMIN_REQUIRED'])
      expect((await get('superAdmin')).status).toBe(200)
      expect((await get('superAdmin', '?cursor=../etc')).status).toBe(400)
    }, T)

    it('S2 · bounded pages with hasMore/nextCursor reach every badge record exactly once; non-badge records excluded; only whitelisted fields', async () => {
      const seen: string[] = []
      let cursor: string | null = null, pages = 0
      do {
        const { status, body }: { status: number; body: Rec } = await get('superAdmin', `?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
        expect(status).toBe(200)
        const items = body.items as Rec[]
        expect(items.length).toBeLessThanOrEqual(3)
        for (const it of items) {
          expect(Object.keys(it).sort()).toEqual(['actualAmountPaise', 'actualCurrency', 'actualOrderId', 'badgeOrderId', 'createdAt', 'deliveries', 'detectedBy',
            'eventId', 'expectedAmountPaise', 'expectedCurrency', 'expectedOrderId', 'id', 'lastDeliveryAt', 'paymentId', 'razorpayOrderId', 'reason', 'reviewed'])
          seen.push(String(it.paymentId))
        }
        expect(body.hasMore).toBe(body.nextCursor !== null)
        cursor = body.nextCursor as string | null
        pages++
      } while (cursor && pages < 50)
      for (const p of made) expect(seen.filter(x => x === p), p).toHaveLength(1)
      expect(seen).not.toContain(`pay_p4b_nonbadge_${PID}`)
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toContain(`pay_p4b_mm_${PID}`)                               // the Phase 4.2 record (G1) is visible
      const report = await recon.reconcileBadgePurchases({ limit: 10 })          // and the report shows the first page
      expect(report.suspicious.items.length).toBeGreaterThan(0)
      expect(typeof report.suspicious.hasMore).toBe('boolean')
    }, T)
  })
})
