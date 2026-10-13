// RD-PRINT-BILL-P7 · Super Admin ID-badge visibility on REAL Firestore + REAL Auth-emulator tokens:
// authorization (anonymous / organizer / legacy admin:true claim / Super Admin in ADMIN_UIDS), the
// order list, search and detail joins, per-event billing with seeded mismatches, the bounded platform
// sweep, unavailable-not-zero, read auditing, and the deletion retention + blocker.
//
// Test-process mocks ONLY: the platform storage (the event-deletion storage step must never reach the
// real object store) and — per test, via a flag — the Phase 5 reconciliation throwing, to prove an
// unreadable section is reported as unavailable. No payment provider is involved anywhere.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const P = `p7a${process.pid}`
const SUPER = `${P}_super`
process.env.ADMIN_UIDS = SUPER

const h = vi.hoisted(() => ({ reconcileThrows: false, storageCalls: 0 }))
vi.mock('@/features/platform-storage', () => ({
  storage: {
    listEvent: async () => { h.storageCalls++; return { objects: [] } },
    delete: async () => { throw new Error('storage must not be reached in this test') },
  },
}))
vi.mock('@/lib/printAssets/badgeBilling/reconcile', async orig => {
  const real = await orig<typeof import('@/lib/printAssets/badgeBilling/reconcile')>()
  return { ...real, reconcilePrintBadgeUsage: async (d: string, n?: number) => { if (h.reconcileThrows) throw new Error('injected'); return real.reconcilePrintBadgeUsage(d, n) } }
})

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
type Rec = Record<string, unknown>
type Handler = (r: NextRequest, c?: unknown) => Promise<Response>

const hex = (k: string) => (Buffer.from(`${P}${k}`).toString('hex') + '0'.repeat(32)).slice(0, 32)
const O = { paid: `bdg_${hex('paid')}`, created: `bdg_${hex('crt')}`, expired: `bdg_${hex('exp')}`, failed: `bdg_${hex('fail')}`, other: `bdg_${hex('oth')}`, many: `bdg_${hex('many')}` }
const ORG = `${P}_org`, ORG2 = `${P}_org2`
const D1 = `${P}-d1`, D2 = `${P}-d2`, DP = `${P}-dpage`, D3 = `${P}-d3`
const SLUG1 = `${P}-ev1`, SLUG3 = `${P}-ev3`
const RZP_ORDER = `order_${P}PAID`, PAY = `pay_${P}PAID`, PAY_BAD = `pay_${P}BAD`
const CODE = `${P}CPN`.toUpperCase()
const J1 = `pgen_${P}j1`, J2 = `pgen_${P}j2`, J3 = `pgen_${P}j3`

async function token(email: string, password: string): Promise<string> {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  return (await r.json() as { idToken: string }).idToken
}

describeEmu('RD-PRINT-BILL-P7 · Super Admin ID-badge visibility (real Firestore + Auth)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  const tok: Record<string, string | null> = { anonymous: null }
  const R: Record<string, Handler> = {}
  const paths: string[] = []   // every seeded document, for cleanup

  const call = async (name: string, url: string, who: string, params?: Rec) => {
    const headers: Record<string, string> = {}
    if (tok[who]) headers.authorization = `Bearer ${tok[who]}`
    const res = await R[name](new NextRequest(`http://localhost${url}`, { method: 'GET', headers }), params ? { params: Promise.resolve(params) } : undefined)
    return { status: res.status, body: await res.json().catch(() => null) as Rec, headers: res.headers }
  }
  const set = async (path: string, data: Rec) => { paths.push(path); await adminDb.doc(path).set(data) }
  const audits = async (entityId: string) => (await adminDb.collection('adminAuditLogs').where('entityId', '==', entityId).get()).docs.map(d => d.data())
  const order = (id: string, over: Rec) => set(`licenseOrders/${id}`, {
    orderId: id, purpose: 'print_badges', eventId: D1, eventSlug: SLUG1, organizerUid: ORG, currency: 'INR', status: 'created',
    amountPaise: 2000, razorpayAmountPaise: 2000, razorpayOrderId: null, razorpayPaymentId: null, requestId: `rq-${id}`, createdByUid: ORG,
    badgePurchase: { quantity: 100, unitPricePaise: 20, grossPaise: 2000, discountPaise: 0, netPaise: 2000, netBasePaise: 1695, netGstPaise: 305, gstRatePercent: 18, priceSource: 'global', coupon: null },
    createdAt: new Date('2026-10-01T10:00:00Z'), updatedAt: new Date(), paidAt: null, checkoutExpiresAt: new Date('2026-10-01T10:30:00Z'), ...over,
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    const mk = async (uid: string, claims?: Rec) => {
      await adminAuth.deleteUser(uid).catch(() => null)
      await adminAuth.createUser({ uid, email: `${uid}@p7.test`, password: 'P7Passw0rd!', emailVerified: true })
      if (claims) await adminAuth.setCustomUserClaims(uid, claims)
      return token(`${uid}@p7.test`, 'P7Passw0rd!')
    }
    tok.organizer = await mk(ORG)
    tok.legacy = await mk(`${P}_claim`, { admin: true, isAdmin: true, role: 'superadmin' })
    tok.super = await mk(SUPER)
    await set(`users/${ORG}`, { uid: ORG, role: 'organizer', accountStatus: 'active', workspaceOwner: true })

    // ── Orders and every related record ─────────────────────────────────────────
    await set(`events/${SLUG1}`, { uid: ORG, draftId: D1, slug: SLUG1, eventName: 'P7 Summit', lifecycleStatus: 'published' })
    await order(O.paid, {
      status: 'paid', razorpayOrderId: RZP_ORDER, razorpayPaymentId: PAY, paidAt: new Date('2026-10-01T10:05:00Z'), settledVia: 'confirm',
      couponRedemption: { code: CODE, discountPaise: 200 },
      badgePurchase: { quantity: 100, unitPricePaise: 20, grossPaise: 2000, discountPaise: 200, netPaise: 1800, netBasePaise: 1525, netGstPaise: 275, gstRatePercent: 18, priceSource: 'global', coupon: { code: CODE, discountPaise: 200 }, taxApprovalId: 'tax-1' },
    })
    await order(O.created, {})
    await order(O.expired, { status: 'expired', lateCaptureWatch: true })
    await order(O.failed, { status: 'failed', failReason: 'badge_amount_mismatch', razorpayOrderId: `order_${P}FAIL`, manualRefundHoldId: `${P}-hold` })
    await order(O.other, { eventId: D2, eventSlug: `${P}-ev2`, organizerUid: ORG2, status: 'paid' })
    for (let i = 0; i < 7; i++) await order(`bdg_${hex(`pg${i}`)}`, { eventId: DP, eventSlug: `${P}-evp` })
    await set(`badgeOrderRefunds/${O.paid}`, { orderId: O.paid, processedUnits: 10, processedPaise: 180, fullyRefunded: false, processed: { [`${P}-wr1`]: { units: 10, paise: 180, externalReference: 'rf-1', at: '2026-10-02T00:00:00Z' } } })
    await set(`badgeCoupons/${CODE}/redemptions/${O.paid}`, { organizerUid: ORG, discountPaise: 200, finalPricePaise: 1800 })
    await set(`badgeCoupons/${CODE}/releases/${O.paid}`, { organizerUid: ORG, counterDecremented: false })
    await set(`failedRefunds/${P}-hold`, { licenseOrderId: O.failed, status: 'open', kind: 'badge_amount_mismatch', amountPaise: 2100, paymentId: PAY_BAD, reason: 'wrong amount' })
    await set(`suspiciousPayments/badge_${PAY_BAD}`, { purpose: 'print_badges', paymentId: PAY_BAD, orderId: `order_${P}FAIL`, badgeOrderId: O.failed, entityId: D1, reason: 'amount_mismatch', expectedAmountPaise: 2000, actualAmountPaise: 2100, detectedBy: ['webhook'], deliveries: 2, reviewed: false })
    await set(`licenseHistory/${P}-h1`, { orderId: O.paid, eventId: D1, organizerUid: ORG, action: 'print_badges_purchased', note: 'ID badges purchased — 100', source: 'self_serve', createdAt: new Date('2026-10-01T10:05:00Z') })
    await set(`walletServiceRequests/${P}-wr1`, { sourceDraftId: D1, service: 'print_badges', kind: 'refund', status: 'processed', organizerUid: ORG, quantity: 10, approvedAmountPaise: 180, refundedAmountPaise: 180, badgeAllocation: [{ orderId: O.paid, units: 10, valuePaise: 180 }] })
    // Approved, not yet processed: an allocation exists, nothing has been refunded to the order.
    await set(`walletServiceRequests/${P}-wr3`, { sourceDraftId: D1, service: 'print_badges', kind: 'refund', status: 'approved', organizerUid: ORG, quantity: 5, approvedAmountPaise: 90, badgeAllocation: [{ orderId: O.paid, units: 5, valuePaise: 90 }] })
    // A duplicate-payment hold the paid order does NOT name (no manualRefundHoldId) — written as manualRefundHold.ts does.
    await set(`failedRefunds/license_dup_${P}DUP`, { kind: 'license_duplicate_payment', status: 'open', licenseOrderId: O.paid, orderId: RZP_ORDER, eventId: D1, organizerUid: ORG, paymentId: `pay_${P}DUP`, amountPaise: 1800, reason: 'duplicate_payment', source: 'license' })
    await set(`walletServiceRequests/${P}-wr2`, { sourceDraftId: D1, service: 'whatsapp', kind: 'refund', status: 'submitted', organizerUid: ORG, quantity: 5 })

    // ── Generation billing for D1, with deliberate mismatches ──────────────────────
    await set(`eventServiceAllowances/${D1}`, { draftId: D1, organizerUid: ORG, print_badges: { purchased: 100, consumed: 12, onExhausted: 'block' } })
    await set(`eventServiceAllowances/${D1}/usage/${J1}_r1`, { service: 'print_badges', quantity: 5, source: `print_generation:${J1}` })     // ≠ ledger 12; ≠ claimed 6
    await set(`eventServiceAllowances/${D1}/usage/pgen_${P}orphan_r1`, { service: 'print_badges', quantity: 1, source: 'x' })            // ORPHAN_USAGE
    await set(`printBadgeRounds/${J1}_r1`, { roundId: `${J1}_r1`, jobId: J1, round: 1, organizerUid: ORG, eventId: D1, eventSlug: SLUG1, unitKey: `${J1}_r1`, status: 'settled', reserved: 5, claimed: 6, keptUnits: 5, releasedUnits: 0, quote: { eligible: 6, previouslyBilled: 0, chargeable: 5, unitPricePaise: 20, quotedChargeable: 5 }, createdAt: new Date(Date.now() - 3600_000), settledAt: new Date() })
    await set(`printBadgeRounds/${J2}_r1`, { roundId: `${J2}_r1`, jobId: J2, round: 1, organizerUid: ORG, eventId: D1, eventSlug: SLUG1, unitKey: `${J2}_r1`, status: 'reserved', reserved: 3, claimed: 0, createdAt: new Date(Date.now() - 3 * 86_400_000) })   // STALE + job ended
    for (let i = 1; i <= 6; i++) await set(`printBadgeClaims/${D1}__${P}-reg${i}`, { claimId: `${D1}__${P}-reg${i}`, organizerUid: ORG, eventId: D1, eventSlug: SLUG1, registrationId: `${P}-reg${i}`, jobId: J1, round: 1, roundId: `${J1}_r1`, mode: 'units', assetType: 'ID_CARD', claimedAt: new Date() })
    for (let i = 7; i <= 8; i++) await set(`printBadgeClaims/${D1}__${P}-reg${i}`, { claimId: `${D1}__${P}-reg${i}`, organizerUid: ORG, eventId: D1, registrationId: `${P}-reg${i}`, jobId: `pgen_${P}gone`, round: 1, roundId: `pgen_${P}gone_r1`, mode: 'units', assetType: 'BADGE', claimedAt: new Date() })   // CLAIMS_WITHOUT_ROUND
    await set(`printBadgeClaims/${D1}__${P}-regc`, { claimId: `${D1}__${P}-regc`, organizerUid: ORG, eventId: D1, registrationId: `${P}-regc`, jobId: J1, round: null, roundId: null, mode: 'complimentary', assetType: 'ID_CARD', claimedAt: new Date() })
    await set(`printGenerationJobs/${J1}`, { jobId: J1, organizerUid: ORG, eventId: D1, eventSlug: SLUG1, assetType: 'ID_CARD', status: 'completed', counts: { total: 3, processed: 3, succeeded: 3, failed: 0 }, billing: { mode: 'paid', round: 1, chargeable: 5 }, createdAt: new Date() })
    await set(`printGenerationJobs/${J1}/items/${P}-reg1`, { registrationId: `${P}-reg1`, rendered: true, billed: 'new' })
    await set(`printGenerationJobs/${J1}/items/${P}-reg99`, { registrationId: `${P}-reg99`, rendered: true, billed: 'new' })   // RENDERED_WITHOUT_CLAIM
    await set(`printGenerationJobs/${J2}`, { jobId: J2, organizerUid: ORG, eventId: D1, eventSlug: SLUG1, assetType: 'BADGE', status: 'completed', counts: { total: 3, processed: 3, succeeded: 0, failed: 3 }, billing: { mode: 'paid', round: 1, chargeable: 3 }, createdAt: new Date() })

    // ── Phase 7 follow-up: an OPEN round's usage, and an order with more holds than the detail reads ──
    await set(`events/${SLUG3}`, { uid: ORG, draftId: D3, slug: SLUG3, eventName: 'P7 Open Round', lifecycleStatus: 'published' })
    await set(`eventServiceAllowances/${D3}`, { draftId: D3, organizerUid: ORG, print_badges: { purchased: 10, consumed: 2, onExhausted: 'block' } })
    await set(`eventServiceAllowances/${D3}/usage/${J3}_r1`, { service: 'print_badges', quantity: 2, source: `print_generation:${J3}` })
    await set(`printBadgeRounds/${J3}_r1`, { roundId: `${J3}_r1`, jobId: J3, round: 1, organizerUid: ORG, eventId: D3, eventSlug: SLUG3, unitKey: `${J3}_r1`, status: 'reserved', reserved: 2, claimed: 0, createdAt: new Date() })
    await order(O.many, { eventId: D3, eventSlug: SLUG3, status: 'failed', failReason: 'badge_amount_mismatch' })
    for (let i = 0; i < 21; i++) await set(`failedRefunds/${P}-many${String(i).padStart(2, '0')}`, { licenseOrderId: O.many, status: i === 0 ? 'open' : 'resolved', kind: 'license_duplicate_payment', amountPaise: 100, paymentId: `pay_${P}M${i}`, reason: 'duplicate_payment' })

    const base = '@/app/api/admin'
    R.orders  = (await import(`${base}/print-badges/orders/route`) as unknown as { GET: Handler }).GET
    R.detail  = (await import(`${base}/print-badges/orders/[orderId]/route`) as unknown as { GET: Handler }).GET
    R.billing = (await import(`${base}/events/[slug]/print-badges/billing/route`) as unknown as { GET: Handler }).GET
    R.sweep   = (await import(`${base}/print-badges/generation-reconciliation/route`) as unknown as { GET: Handler }).GET
    R.recon   = (await import(`${base}/print-badges/reconciliation/route`) as unknown as { GET: Handler }).GET
    R.susp    = (await import(`${base}/print-badges/suspicious-payments/route`) as unknown as { GET: Handler }).GET
  }, T)

  afterAll(async () => {
    for (const p of paths.reverse()) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const id of [O.paid, O.created, O.failed, O.many, D1, D3, SLUG1]) for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs) await d.ref.delete()
    for (const uid of [ORG, `${P}_claim`, SUPER]) await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  // ── Authorization ─────────────────────────────────────────────────────────────────
  it('A · anonymous, an organizer and a legacy admin:true claim are refused by every new route; a Super Admin is allowed', async () => {
    const targets: Array<[string, string, Rec?]> = [
      ['orders', '/api/admin/print-badges/orders'],
      ['detail', `/api/admin/print-badges/orders/${O.paid}`, { orderId: O.paid }],
      ['billing', `/api/admin/events/${SLUG1}/print-badges/billing`, { slug: SLUG1 }],
      ['sweep', '/api/admin/print-badges/generation-reconciliation?reconcile=0'],
    ]
    const before = (await audits(O.paid)).length + (await audits(D1)).length
    for (const [name, url, params] of targets) {
      expect((await call(name, url, 'anonymous', params)).status, `${name} anonymous`).toBe(403)
      expect((await call(name, url, 'organizer', params)).status, `${name} organizer`).toBe(403)
      const legacy = await call(name, url, 'legacy', params)
      expect(legacy.status, `${name} legacy`).toBe(403)
      expect(legacy.body.code).toBe('SUPER_ADMIN_REQUIRED')
      const ok = await call(name, url, 'super', params)
      expect(ok.status, `${name} super`).toBe(200)
      expect(ok.headers.get('cache-control')).toBe('no-store')
    }
    // Refused callers never produced an audit row; the two Super Admin detail reads produced one each.
    expect((await audits(O.paid)).length + (await audits(D1)).length).toBe(before + 2)
  }, T)

  // ── Orders ────────────────────────────────────────────────────────────────────────
  it('B · list filters (event, organizer, status) and document-id cursor paging', async () => {
    const byEvent = await call('orders', `/api/admin/print-badges/orders?draftId=${D1}`, 'super')
    expect((byEvent.body.items as Rec[]).map(r => r.orderId).sort()).toEqual([O.paid, O.created, O.expired, O.failed].sort())
    const paid = await call('orders', `/api/admin/print-badges/orders?draftId=${D1}&status=paid`, 'super')
    expect((paid.body.items as Rec[]).map(r => r.orderId)).toEqual([O.paid])
    expect((paid.body.items as Rec[])[0]).toMatchObject({ netPaise: 1800, couponCode: CODE, paymentIdMasked: `…${PAY.slice(-6)}` })
    expect(JSON.stringify(paid.body)).not.toContain(PAY)               // the full payment id only appears in the detail
    const byOrg = await call('orders', `/api/admin/print-badges/orders?organizerUid=${ORG2}`, 'super')
    expect((byOrg.body.items as Rec[]).map(r => r.orderId)).toEqual([O.other])

    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const page = await call('orders', `/api/admin/print-badges/orders?draftId=${DP}&limit=3${cursor ? `&cursor=${cursor}` : ''}`, 'super')
      const ids = (page.body.items as Rec[]).map(r => String(r.orderId))
      expect(ids.length).toBeLessThanOrEqual(3)
      seen.push(...ids)
      cursor = page.body.nextCursor as string | null
      if (!page.body.hasMore) break
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(seen).toEqual([...seen].sort())
    expect((await call('orders', '/api/admin/print-badges/orders?limit=500', 'super')).status).toBe(200)        // clamped, not refused
    expect((await call('orders', '/api/admin/print-badges/orders?status=bogus', 'super')).status).toBe(400)
  }, T)

  it('C · lookup by internal order id, Razorpay order id and payment id — badge orders only', async () => {
    for (const q of [O.paid, RZP_ORDER, PAY]) {
      const r = await call('orders', `/api/admin/print-badges/orders?q=${q}`, 'super')
      expect((r.body.items as Rec[]).map(x => x.orderId), q).toEqual([O.paid])
    }
    expect((await call('orders', `/api/admin/print-badges/orders?q=pay_${P}NONE`, 'super')).body.items).toEqual([])
    expect((await call('orders', '/api/admin/print-badges/orders?q=hello', 'super')).status).toBe(400)
  }, T)

  it('D · order detail joins every related record; an order without them shows empty sections, not unavailable', async () => {
    const d = await call('detail', `/api/admin/print-badges/orders/${O.paid}`, 'super', { orderId: O.paid })
    expect(d.status).toBe(200)
    expect(d.body.order).toMatchObject({ orderId: O.paid, status: 'paid', razorpayOrderId: RZP_ORDER, razorpayPaymentId: PAY, netPaise: 1800, couponDiscountPaise: 200, taxApprovalId: 'tax-1' })
    expect(d.body.refundTracker).toEqual({ ok: true, data: { exists: true, processedUnits: 10, processedPaise: 180, fullyRefunded: false, couponReleased: false } })
    expect(d.body.coupon).toEqual({ ok: true, data: { code: CODE, redemption: { exists: true, discountPaise: 200, finalPricePaise: 1800 }, release: { exists: true, counterDecremented: false } } })
    expect(d.body.history).toMatchObject({ ok: true, data: { truncated: false, limit: 50, items: [{ action: 'print_badges_purchased' }] } })
    // The approved ALLOCATION and the money ACTUALLY refunded to this order are separate figures.
    const wallet = d.body.walletRequests as { ok: true; data: { items: Rec[]; truncated: boolean } }
    expect(wallet).toMatchObject({ ok: true, data: { truncated: false, limit: 200 } })
    expect(wallet.data.items.map(x => x.id).sort()).toEqual([`${P}-wr1`, `${P}-wr3`])     // the WhatsApp request is not a badge request
    expect(wallet.data.items.find(x => x.id === `${P}-wr1`)).toMatchObject({ status: 'processed', allocation: { basis: 'approved', units: 10, paise: 180 }, refundedToOrder: { units: 10, paise: 180 }, refundedAmountPaise: 180 })
    expect(wallet.data.items.find(x => x.id === `${P}-wr3`)).toMatchObject({ status: 'approved', allocation: { basis: 'approved', units: 5, paise: 90 }, refundedToOrder: null })
    // The paid order names no hold, but a duplicate-payment hold exists for it.
    expect(d.body.order).toMatchObject({ manualRefundHoldId: null, held: true, openHolds: 1 })
    expect(d.body.holds).toMatchObject({ ok: true, data: { truncated: false, items: [{ holdId: `license_dup_${P}DUP`, kind: 'license_duplicate_payment', status: 'open' }] } })
    const f = await call('detail', `/api/admin/print-badges/orders/${O.failed}`, 'super', { orderId: O.failed })
    expect(f.body.holds).toMatchObject({ ok: true, data: { truncated: false, limit: 20, items: [{ holdId: `${P}-hold`, status: 'open', amountPaise: 2100 }] } })
    expect(f.body.suspicious).toMatchObject({ ok: true, data: { truncated: false, limit: 20, items: [{ paymentId: PAY_BAD, reason: 'amount_mismatch', expectedAmountPaise: 2000, actualAmountPaise: 2100 }] } })
    const c = await call('detail', `/api/admin/print-badges/orders/${O.created}`, 'super', { orderId: O.created })
    expect(c.body.coupon).toEqual({ ok: true, data: null })
    for (const [k, limit] of Object.entries({ holds: 20, suspicious: 20, history: 50, walletRequests: 200 })) expect(c.body[k], k).toEqual({ ok: true, data: { items: [], truncated: false, limit } })
    expect(c.body.order).toMatchObject({ held: false, openHolds: 0 })        // complete lookup, no hold: a definite "no"
    expect(c.body.refundTracker).toMatchObject({ ok: true, data: { exists: false } })
    expect((await call('detail', `/api/admin/print-badges/orders/bdg_${'f'.repeat(32)}`, 'super', { orderId: `bdg_${'f'.repeat(32)}` })).status).toBe(404)
    const rows = await audits(O.paid)
    expect(rows.some(r => r.action === 'print_badge_billing.order_viewed' && r.adminUid === SUPER && r.entityType === 'billing')).toBe(true)
  }, T)

  // ── Event billing and reconciliation ──────────────────────────────────────────────
  it('E · per-event billing: ledger, rounds, claims (registration ids only), usage, jobs and every seeded mismatch', async () => {
    const r = await call('billing', `/api/admin/events/${SLUG1}/print-badges/billing`, 'super', { slug: SLUG1 })
    expect(r.status).toBe(200)
    expect(r.body.event).toMatchObject({ slug: SLUG1, draftId: D1, organizerUid: ORG })
    expect(r.body.ledger).toEqual({ ok: true, data: { exists: true, ownerMatches: true, purchased: 100, carriedIn: 0, carriedOut: 0, refunded: 0, consumed: 12, available: 88 } })
    expect(r.body.claimCounts).toEqual({ ok: true, data: { units: 8, complimentary: 1 } })
    const claims = (r.body.claims as { ok: true; data: { items: Rec[] } }).data.items
    expect(claims.length).toBe(9)
    for (const c of claims) expect(Object.keys(c).sort()).toEqual(['assetType', 'claimId', 'claimedAt', 'jobId', 'mode', 'registrationId', 'round'])
    expect((r.body.jobs as { ok: true; data: { items: Rec[] } }).data.items.map(j => j.billing)).toEqual([{ mode: 'paid', round: 1 }, { mode: 'paid', round: 1 }])
    const recon = r.body.reconciliation as { ok: true; data: { ok: boolean; problems: Array<{ code: string }> } }
    expect(recon.ok).toBe(true)
    expect(recon.data.ok).toBe(false)
    const codes = new Set(recon.data.problems.map(p => p.code))
    for (const c of ['LEDGER_USAGE_MISMATCH', 'ROUND_SETTLEMENT_MISMATCH', 'ROUND_OVERCLAIMED', 'STALE_ROUND', 'UNSETTLED_ENDED_JOB', 'ORPHAN_USAGE', 'CLAIMS_WITHOUT_ROUND', 'RENDERED_WITHOUT_CLAIM', 'ROUND_RESERVATION_MISMATCH']) {
      expect(codes, c).toContain(c)
    }
    // Section paging by cursor: claims 4 at a time, no skips or duplicates.
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const pg = await call('billing', `/api/admin/events/${SLUG1}/print-badges/billing?section=claims&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'super', { slug: SLUG1 })
      const sec = pg.body.claims as { ok: true; data: { items: Rec[]; hasMore: boolean; nextCursor: string | null } }
      expect(pg.body.reconciliation).toBeUndefined()            // a section page reads only that section
      seen.push(...sec.data.items.map(c => String(c.claimId)))
      cursor = sec.data.nextCursor
      if (!sec.data.hasMore) break
    }
    expect(seen).toHaveLength(9)
    expect(new Set(seen).size).toBe(9)
    // Usage rows carry their round's lifecycle: J1's round settled (units KEPT); the orphan has no round.
    const usage = (r.body.usage as { ok: true; data: { items: Rec[] } }).data.items
    expect(usage.find(u => u.unitKey === `${J1}_r1`)).toMatchObject({ quantity: 5, roundStatus: 'settled' })
    expect(usage.find(u => u.unitKey === `pgen_${P}orphan_r1`)).toMatchObject({ roundStatus: 'no_round' })
    expect((await call('billing', `/api/admin/events/${P}-nope/print-badges/billing`, 'super', { slug: `${P}-nope` })).status).toBe(404)
    expect((await audits(D1)).filter(a => a.action === 'print_badge_billing.event_billing_viewed').length).toBeGreaterThanOrEqual(3)
  }, T)

  it('F · an injected read failure is reported as UNAVAILABLE — never as a clean or zero result', async () => {
    h.reconcileThrows = true
    try {
      const r = await call('billing', `/api/admin/events/${SLUG1}/print-badges/billing`, 'super', { slug: SLUG1 })
      expect(r.status).toBe(200)
      expect(r.body.reconciliation).toEqual({ ok: false, reason: 'unavailable' })
      expect(r.body.ledger).toMatchObject({ ok: true })                 // the other sections are unaffected
      const s = await call('sweep', '/api/admin/print-badges/generation-reconciliation?open=1&limit=50', 'super')
      for (const e of s.body.events as Array<{ result: Rec }>) expect(e.result).toEqual({ ok: false, reason: 'unavailable' })
    } finally { h.reconcileThrows = false }
  }, T)

  it('G · platform sweep: open rounds flagged STALE / JOB_ENDED, bounded paging, at most 5 events reconciled', async () => {
    // Our open round is somewhere in the open-round pages; walk them (bounded).
    let found: Rec | null = null
    let cursor: string | null = null
    let pages = 0
    for (; pages < 40 && !found; pages++) {
      const r = await call('sweep', `/api/admin/print-badges/generation-reconciliation?open=1&limit=10&reconcile=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'super')
      const sec = r.body.rounds as { ok: true; data: { items: Rec[]; hasMore: boolean; nextCursor: string | null } }
      expect(sec.ok).toBe(true)
      expect(sec.data.items.length).toBeLessThanOrEqual(10)
      for (const it of sec.data.items) expect(it.status).toBe('reserved')
      found = sec.data.items.find(x => x.roundId === `${J2}_r1`) ?? null
      if (!sec.data.hasMore) break
      cursor = sec.data.nextCursor
    }
    expect(found).toMatchObject({ jobStatus: 'completed', flags: ['STALE', 'JOB_ENDED'] })
    // With reconciliation on, never more than 5 events are checked per request; the rest are listed.
    const r = await call('sweep', '/api/admin/print-badges/generation-reconciliation?limit=50', 'super')
    const items = (r.body.rounds as { ok: true; data: { items: Rec[] } }).data.items
    const distinct = new Set(items.map(i => i.eventId).filter(Boolean))
    const events = r.body.events as Rec[], notChecked = r.body.eventsNotChecked as string[]
    expect(events.length).toBeLessThanOrEqual(5)
    expect(events.length + notChecked.length).toBe(distinct.size)
    // The per-request cap, exercised exactly: 7 open rounds of 7 DIFFERENT events, contiguous in
    // document-id order, read as one page (cursor just before them) — 5 reconciled, 2 listed as not checked.
    for (let i = 0; i < 7; i++) await set(`printBadgeRounds/${P}zr${i}`, { roundId: `${P}zr${i}`, jobId: `pgen_${P}zj${i}`, round: 1, organizerUid: ORG, eventId: `${P}-zev${i}`, status: 'reserved', reserved: 1, claimed: 0, createdAt: new Date() })
    const capped = await call('sweep', `/api/admin/print-badges/generation-reconciliation?open=1&limit=7&cursor=${P}zr`, 'super')
    const cappedRounds = (capped.body.rounds as { ok: true; data: { items: Rec[] } }).data.items
    expect(cappedRounds.map(x => x.roundId)).toEqual(Array.from({ length: 7 }, (_, i) => `${P}zr${i}`))
    expect((capped.body.events as Rec[]).length).toBe(5)
    expect(capped.body.eventsNotChecked).toEqual([`${P}-zev5`, `${P}-zev6`])
    for (const e of capped.body.events as Array<{ result: Rec }>) expect(e.result).toMatchObject({ ok: true })
    // Ledger source: D1's ledger shows badge activity.
    const lg = await call('sweep', '/api/admin/print-badges/generation-reconciliation?source=ledgers&reconcile=0', 'super')
    expect(lg.status).toBe(200)
    expect((await call('sweep', '/api/admin/print-badges/generation-reconciliation?source=all', 'super')).status).toBe(400)
  }, T)

  it('H · the Phase 4 purchase reconciliation and suspicious-payment routes surface the seeded records', async () => {
    const rec = await call('recon', `/api/admin/print-badges/reconciliation?draftId=${D1}`, 'super')
    expect(rec.status).toBe(200)
    expect((rec.body.openHolds as Rec[]).some(x => x.orderId === O.failed)).toBe(true)
    let found = false
    let cursor: string | null = null
    for (let i = 0; i < 20 && !found; i++) {
      const s = await call('susp', `/api/admin/print-badges/suspicious-payments?limit=100${cursor ? `&cursor=${cursor}` : ''}`, 'super')
      found = (s.body.items as Rec[]).some(x => x.paymentId === PAY_BAD)
      if (!s.body.hasMore) break
      cursor = s.body.nextCursor as string
    }
    expect(found).toBe(true)
  }, T)

  it('K · follow-up: open-round usage is RESERVED (not kept); the list shows unnamed holds; a capped section says it is incomplete', async () => {
    // An open round's usage record is its reservation — reported with the round still 'reserved'.
    const b = await call('billing', `/api/admin/events/${SLUG3}/print-badges/billing`, 'super', { slug: SLUG3 })
    expect(b.status).toBe(200)
    expect((b.body.usage as { ok: true; data: { items: Rec[] } }).data.items).toEqual([expect.objectContaining({ unitKey: `${J3}_r1`, quantity: 2, roundStatus: 'reserved' })])
    const pg = await call('billing', `/api/admin/events/${SLUG3}/print-badges/billing?section=usage`, 'super', { slug: SLUG3 })
    expect((pg.body.usage as { ok: true; data: { items: Rec[] } }).data.items[0]).toMatchObject({ roundStatus: 'reserved' })   // section paging too

    // The list: a duplicate-payment hold the paid order does not name still marks it held.
    const list = await call('orders', `/api/admin/print-badges/orders?draftId=${D1}`, 'super')
    const row = (id: string) => (list.body.items as Rec[]).find(x => x.orderId === id)
    expect(row(O.paid)).toMatchObject({ held: true, openHolds: 1 })
    expect(row(O.failed)).toMatchObject({ held: true, openHolds: 1 })
    expect(row(O.created)).toMatchObject({ held: false, openHolds: 0 })
    const found = await call('orders', `/api/admin/print-badges/orders?q=${PAY}`, 'super')
    expect((found.body.items as Rec[])[0]).toMatchObject({ orderId: O.paid, held: true, openHolds: 1 })      // search rows too

    // 21 holds on one order: the detail reads 20 and SAYS so; the open count is then unknown, not 0.
    const m = await call('detail', `/api/admin/print-badges/orders/${O.many}`, 'super', { orderId: O.many })
    const holds = m.body.holds as { ok: true; data: { items: Rec[]; truncated: boolean; limit: number } }
    expect(holds.ok).toBe(true)
    expect(holds.data.items).toHaveLength(20)
    expect(holds.data).toMatchObject({ truncated: true, limit: 20 })
    expect(m.body.order).toMatchObject({ held: true, openHolds: null })
    // The list's chunked lookup is complete for it (21 ≤ its bound): one open hold.
    const many = await call('orders', `/api/admin/print-badges/orders?draftId=${D3}`, 'super')
    expect((many.body.items as Rec[])[0]).toMatchObject({ orderId: O.many, held: true, openHolds: 1 })
  }, T)

  // ── Deletion ──────────────────────────────────────────────────────────────────────
  it('I · badge billing evidence BLOCKS organizer deletion and stays intact; an organizer without it is unaffected', async () => {
    const { evaluateDeletionEligibility } = await import('@/lib/admin/organizerDeletion')
    const evidence: Array<[string, (uid: string) => Promise<void>]> = [
      ['a badge purchase order', uid => set(`licenseOrders/bdg_${hex(`del${uid.slice(-2)}`)}`, { purpose: 'print_badges', organizerUid: uid, status: 'paid' })],
      ['a billing claim', uid => set(`printBadgeClaims/${P}-del-${uid.slice(-2)}`, { organizerUid: uid, eventId: 'x', registrationId: 'r', mode: 'units' })],
      ['a billing round', uid => set(`printBadgeRounds/${P}-del-${uid.slice(-2)}_r1`, { organizerUid: uid, eventId: 'x', status: 'settled', reserved: 1, claimed: 1 })],
    ]
    for (const [i, [label, seed]] of evidence.entries()) {
      const uid = `${P}_del${i}`
      await set(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active' })
      expect((await evaluateDeletionEligibility(uid)).deletable, `${label}: clean before`).toBe(true)
      await seed(uid)
      const e = await evaluateDeletionEligibility(uid)
      expect(e.deletable, label).toBe(false)
      expect(e.blockers.map(b => b.code), label).toEqual(['BADGE_BILLING_RECORDS_EXIST'])
    }
    // The evidence is untouched after the refused deletion check.
    expect((await adminDb.doc(`printBadgeClaims/${P}-del-l1`).get()).exists).toBe(true)
    expect((await adminDb.doc(`printBadgeRounds/${P}-del-l2_r1`).get()).exists).toBe(true)
    // An organizer holding only another organizer's evidence nearby is still deletable.
    await set(`users/${P}_clean`, { uid: `${P}_clean`, role: 'organizer', accountStatus: 'active' })
    expect((await evaluateDeletionEligibility(`${P}_clean`)).deletable).toBe(true)
  }, T)

  it('J · event deletion removes the event but RETAINS claims, rounds, refund trackers, orders and the ledger', async () => {
    const { runEventDeletion } = await import('@/lib/events/eventDeletion')
    const slug = `${P}-evdel`, draft = `${P}-dDel`, oid = `bdg_${hex('evdel')}`
    await set(`events/${slug}`, { uid: ORG, draftId: draft, slug, lifecycleStatus: 'cancelled' })
    await set(`printBadgeClaims/${draft}__r1`, { organizerUid: ORG, eventId: draft, eventSlug: slug, registrationId: 'r1', mode: 'units' })
    await set(`printBadgeRounds/pgen_${P}del_r1`, { organizerUid: ORG, eventId: draft, eventSlug: slug, status: 'settled', reserved: 1, claimed: 1 })
    await set(`licenseOrders/${oid}`, { purpose: 'print_badges', eventId: draft, eventSlug: slug, organizerUid: ORG, status: 'paid' })
    await set(`badgeOrderRefunds/${oid}`, { orderId: oid, eventId: draft, processedUnits: 0, processedPaise: 0 })
    await set(`eventServiceAllowances/${draft}`, { draftId: draft, organizerUid: ORG, print_badges: { purchased: 1, consumed: 1 } })
    const r = await runEventDeletion({ eventSlug: slug, eventId: draft, organizerUid: ORG })
    expect(r.finished).toBe(true)
    expect(h.storageCalls).toBeGreaterThan(0)                       // the (mocked) storage step ran
    expect((await adminDb.doc(`events/${slug}`).get()).exists).toBe(false)
    for (const p of [`printBadgeClaims/${draft}__r1`, `printBadgeRounds/pgen_${P}del_r1`, `licenseOrders/${oid}`, `badgeOrderRefunds/${oid}`, `eventServiceAllowances/${draft}`]) {
      expect((await adminDb.doc(p).get()).exists, p).toBe(true)
    }
  }, T)
})
