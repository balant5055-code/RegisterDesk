// RD-PRINT-BILL-P4 — pure rules + source contracts for prepaid ID-badge purchases.
//   A. pricing: integer paise, GST-inclusive extraction on the NET, gateway minimum, bounds
//   B. tax approval: fails closed — unset, unapproved, revoked, changed rate or treatment
//   C. coupon binding at settlement: financial terms must match; a description-only edit may not matter
//   D. exact badge valuation (refunds) — and every other service keeps valueUnits unchanged
//   E. gates and exposure: both release gates false; SERVICE_KINDS unchanged; no production override
//   F. source contracts: webhook / confirm dispatch, read-before-write, licence readers exclude badges

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildBadgeSnapshot, isConsistentBadgeSnapshot, couponStillMatches, badgeTaxApprovalProblem, splitInclusiveNet,
  quantityBounds, isBadgePurchaseLifecycle, BADGE_TAX_TREATMENT, BADGE_PURCHASE_MIN_UNITS, BADGE_PURCHASE_MAX_UNITS,
  type BadgeOrderCoupon, type BadgeTaxApprovalRecord,
} from '@/lib/licensing/printBadgePurchase/pricing'
import { valueUnits, valueUnitsExact, valuationFor, REQUESTABLE_SERVICES, CARRYABLE_SERVICES } from '@/lib/wallet/serviceRequestRules'
import { RELEASED_FOR_PURCHASE, SERVICE_KINDS, isServicePurchaseReleased, parseServiceSelection } from '@/lib/licensing/serviceAllowances'
import { PAID_BADGE_GENERATION_RELEASED } from '@/lib/licensing/printBadgeCommercial'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const bounds = { min: 100, max: 100_000 }
const base = { unitPricePaise: 20, priceSource: 'global' as const, configVersion: 3, gstRatePercent: 18, bounds, taxApprovalId: 'gst_v1' }
const coupon = (discountPaise: number, over: Partial<BadgeOrderCoupon['snapshot']> = {}): BadgeOrderCoupon => ({
  code: 'SAVE10', discountPaise, minPurchasePaise: null,
  snapshot: { code: 'SAVE10', scope: 'print_badges', type: 'percentage', value: 10, maxDiscountPaise: null, version: 1, ...over },
})

describe('A · pricing', () => {
  it('100 badges at ₹0.20 incl. 18% GST = ₹20.00 → base 1695 + GST 305 (rounded half-up on the order net)', () => {
    const r = buildBadgeSnapshot({ ...base, quantity: 100, coupon: null })
    expect(r.ok && r.snapshot).toMatchObject({ grossPaise: 2000, discountPaise: 0, netPaise: 2000, netBasePaise: 1695, netGstPaise: 305, currency: 'INR' })
  })
  it('a coupon reduces the GST-inclusive consideration BEFORE tax is extracted', () => {
    const r = buildBadgeSnapshot({ ...base, quantity: 150, coupon: coupon(300) })
    expect(r.ok && r.snapshot).toMatchObject({ grossPaise: 3000, discountPaise: 300, netPaise: 2700, netBasePaise: 2288, netGstPaise: 412 })
  })
  it('splitInclusiveNet: base + GST = net exactly for every net and several rates; never adds tax on top', () => {
    for (const rate of [0, 5, 12, 18, 28]) for (let net = 0; net <= 5000; net += 37) {
      const s = splitInclusiveNet(net, rate)
      expect(s.basePaise + s.gstPaise).toBe(net)
      expect(Number.isInteger(s.basePaise) && s.basePaise <= net).toBe(true)
    }
  })
  it('refuses a net between 1 and 99 paise (cannot be charged); allows exactly 0 (free) and ≥ 100', () => {
    expect(buildBadgeSnapshot({ ...base, quantity: 100, coupon: coupon(1950) })).toMatchObject({ ok: false, code: 'AMOUNT_BELOW_GATEWAY_MIN' })
    expect(buildBadgeSnapshot({ ...base, quantity: 100, coupon: coupon(2000) })).toMatchObject({ ok: true })
    expect(buildBadgeSnapshot({ ...base, quantity: 100, coupon: coupon(1900) })).toMatchObject({ ok: true })
  })
  it('quantity: 100 – 100,000 whole badges; a stricter configured bound wins; a looser one never does', () => {
    for (const q of [99, 100_001, 150.5, NaN, -100]) expect(buildBadgeSnapshot({ ...base, quantity: q, coupon: null })).toMatchObject({ ok: false, code: 'QUANTITY_INVALID' })
    expect(quantityBounds({ minQuantity: 1, maxQuantity: null })).toEqual({ min: BADGE_PURCHASE_MIN_UNITS, max: BADGE_PURCHASE_MAX_UNITS })
    expect(quantityBounds({ minQuantity: 500, maxQuantity: 2_000 })).toEqual({ min: 500, max: 2_000 })
    expect(quantityBounds({ minQuantity: 10, maxQuantity: 900_000 })).toEqual({ min: 100, max: 100_000 })
  })
  it('PRICE_NOT_CONFIGURED without a unit price or a rate — no rate is ever assumed', () => {
    expect(buildBadgeSnapshot({ ...base, gstRatePercent: null, quantity: 100, coupon: null })).toMatchObject({ ok: false, code: 'PRICE_NOT_CONFIGURED' })
    expect(buildBadgeSnapshot({ ...base, unitPricePaise: null, quantity: 100, coupon: null })).toMatchObject({ ok: false, code: 'PRICE_NOT_CONFIGURED' })
  })
  it('isConsistentBadgeSnapshot: re-derives every figure; any tampered field is refused', () => {
    const r = buildBadgeSnapshot({ ...base, quantity: 150, coupon: coupon(300) })
    if (!r.ok) throw new Error('fixture')
    expect(isConsistentBadgeSnapshot(r.snapshot)).toBe(true)
    const bad: Array<Record<string, unknown>> = [
      { grossPaise: 2999 }, { netPaise: 2701 }, { netBasePaise: 2289 }, { netGstPaise: 411 }, { discountPaise: 0 },
      { quantity: 99 }, { currency: 'USD' }, { gstRatePercent: -1 }, { taxApprovalId: '' },
      { taxTreatment: { ...BADGE_TAX_TREATMENT, roundingMethod: 'floor' } }, { coupon: { ...r.snapshot.coupon, code: 'OTHER' } },
    ]
    for (const b of bad) expect(isConsistentBadgeSnapshot({ ...r.snapshot, ...b }), JSON.stringify(b)).toBe(false)
  })
  it('published, non-cancelled events only', () => {
    expect(['published', 'registration_closed'].every(isBadgePurchaseLifecycle)).toBe(true)
    expect(['draft', 'pending_review', 'changes_requested', 'cancelled', 'completed', 'archived', undefined].some(isBadgePurchaseLifecycle)).toBe(false)
  })
})

describe('B · the recorded GST approval', () => {
  const ok: BadgeTaxApprovalRecord = {
    status: 'approved', approvalId: 'gst_v1', gstRatePercent: 18, taxTreatment: { ...BADGE_TAX_TREATMENT },
    accountantName: 'A. Accountant', accountantReference: 'REF', accountantApprovedOn: null, recordedByUid: 'super', reason: 'r', version: 1,
  }
  it('fails closed: unset rate, no record, revoked, other rate, other treatment', () => {
    expect(badgeTaxApprovalProblem(ok, null)).toBe('GST_NOT_CONFIGURED')
    expect(badgeTaxApprovalProblem(null, 18)).toBe('TAX_NOT_APPROVED')
    expect(badgeTaxApprovalProblem({ ...ok, status: 'revoked' }, 18)).toBe('TAX_NOT_APPROVED')
    expect(badgeTaxApprovalProblem(ok, 12)).toBe('TAX_APPROVAL_MISMATCH')
    expect(badgeTaxApprovalProblem({ ...ok, taxTreatment: { ...BADGE_TAX_TREATMENT, discountTreatment: 'x' } }, 18)).toBe('TAX_APPROVAL_MISMATCH')
    expect(badgeTaxApprovalProblem({ ...ok, taxTreatment: { ...BADGE_TAX_TREATMENT, id: 'badge-inclusive-v2' } }, 18)).toBe('TAX_APPROVAL_MISMATCH')
    expect(badgeTaxApprovalProblem(ok, 18)).toBeNull()
  })
  it('no 18% (or any) default anywhere in the badge purchase code', () => {
    for (const f of ['pricing.ts', 'quote.ts', 'taxApproval.ts', 'settle.ts', 'orders.ts']) {
      expect(read(`lib/licensing/printBadgePurchase/${f}`), f).not.toMatch(/\?\?\s*18\b|gstRatePercent:\s*18\b|\|\|\s*18\b/)
    }
  })
})

describe('C · coupon binding at settlement', () => {
  const bound = coupon(200)
  const now = (o: Partial<{ discountPaise: number; finalPricePaise: number; minPurchasePaise: number | null }> = {}, snap: Partial<BadgeOrderCoupon['snapshot']> = {}) => ({
    discountPaise: 200, finalPricePaise: 1800, minPurchasePaise: null, snapshot: { ...bound.snapshot, ...snap }, ...o,
  })
  it('matches when only the version moved (a description-only edit)', () => {
    expect(couponStillMatches(bound, now({}, { version: 7 }), 1800)).toBe(true)
  })
  it('refuses a changed discount, value, type, cap, minimum, code or final price', () => {
    expect(couponStillMatches(bound, now({ discountPaise: 300, finalPricePaise: 1700 }), 1800)).toBe(false)
    expect(couponStillMatches(bound, now({}, { value: 20 }), 1800)).toBe(false)
    expect(couponStillMatches(bound, now({}, { type: 'fixed' }), 1800)).toBe(false)
    expect(couponStillMatches(bound, now({}, { maxDiscountPaise: 150 }), 1800)).toBe(false)
    expect(couponStillMatches(bound, now({ minPurchasePaise: 1000 }), 1800)).toBe(false)
    expect(couponStillMatches(bound, now({}, { code: 'OTHER' }), 1800)).toBe(false)
    expect(couponStillMatches(bound, now(), 1700)).toBe(false)
  })
  it('the activation reads ONLY the order’s bound code, and refuses before any write', () => {
    const src = read('lib/licensing/printBadgePurchase/settle.ts')
    expect(src).toContain('txnReadBadgeCouponRedemption(txn, bound.code, o.organizerUid, o.orderId)')
    expect(src.split('txnReadBadgeCouponRedemption(').length - 1).toBe(1)        // one coupon read: the bound code
    expect(src).toContain('const bound = s?.coupon ?? null')                     // the code comes from the ORDER only
    // between the last read and the writes: refusals only (no set/create/ledger write)
    const body = src.slice(src.indexOf('// ── every read is done'), src.indexOf('// ── writes (all or nothing)'))
    expect(body).not.toMatch(/txn\.(set|create)\(|txnApplyServiceItems/)
    expect(body.indexOf('couponStillMatches(')).toBeLessThan(body.indexOf('txnRedeemBadgeCoupon('))
  })
})

describe('D · exact badge valuation (refunds)', () => {
  const lot = (q: number, total: number, id = 'bdg_a', at = 1) => ({ orderId: id, at, quantity: q, totalPaise: total })
  it('separate partial refunds of one lot always add up to its net exactly', () => {
    for (const [q, total] of [[101, 1818], [100, 2001], [3, 100], [7, 9], [100_000, 1_999_999]] as const) {
      for (const k of [1, 2, Math.floor(q / 3), Math.floor(q / 2)]) {
        if (k <= 0 || k >= q) continue
        const first = valueUnitsExact([lot(q, total)], 0, 0, k)!
        const rest = valueUnitsExact([lot(q, total)], 0, k, q - k)!
        expect(first.valuePaise + rest.valuePaise, `${q}/${total}/${k}`).toBe(total)
      }
    }
  })
  it('the shared floor valuation can lose paise on the same split (why badges use the exact one)', () => {
    const a = valueUnits([lot(100, 2001)], 0, 0, 50)!, b = valueUnits([lot(100, 2001)], 0, 50, 50)!
    expect(a.valuePaise + b.valuePaise).toBe(2000)
  })
  it('positions, parts and the inconsistency null match valueUnits; full lots are valued identically', () => {
    const lots = [lot(100, 2000, 'bdg_old', 1), lot(50, 900, 'bdg_new', 2)]
    expect(valueUnitsExact(lots, 0, 0, 150)).toEqual(valueUnits(lots, 0, 0, 150))
    expect(valueUnitsExact(lots, 10, 0, 141)).toBeNull()
    expect(valueUnitsExact(lots, 20, 30, 40)!.parts.map(p => [p.orderId, p.units])).toEqual(valueUnits(lots, 20, 30, 40)!.parts.map(p => [p.orderId, p.units]))
  })
  it('valuationFor: exact for print_badges ONLY; every other service keeps valueUnits', () => {
    expect(valuationFor('print_badges')).toBe(valueUnitsExact)
    for (const s of REQUESTABLE_SERVICES.filter(x => x !== 'print_badges')) expect(valuationFor(s), s).toBe(valueUnits)
  })
})

describe('E · gates and exposure', () => {
  it('both badge release gates are false in source', () => {
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
    expect(isServicePurchaseReleased('print_badges')).toBe(false)
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(read('lib/licensing/serviceAllowances.ts')).toMatch(/print_badges:\s*false,/)
    expect(read('lib/licensing/printBadgeCommercial.ts')).toContain('export const PAID_BADGE_GENERATION_RELEASED = false')
  })
  it('SERVICE_KINDS is unchanged and the generic add-on selection still refuses badges', () => {
    expect([...SERVICE_KINDS]).toEqual(['whatsapp', 'certificates', 'media'])
    expect(parseServiceSelection({ print_badges: 100 })).toMatchObject({ ok: false })
  })
  it('badges are requestable for refunds / carry-forward, never purchasable through the add-on paths', () => {
    expect(REQUESTABLE_SERVICES).toContain('print_badges')
    expect(CARRYABLE_SERVICES).toContain('print_badges')
    for (const f of ['lib/licensing/draftCommerce.ts', 'lib/licensing/draftCoverage.ts', 'app/api/licensing/published/purchase/route.ts']) {
      expect(read(f), f).not.toContain('printBadgePurchase')
    }
  })
  it('no non-test source overrides the gate or mocks isServicePurchaseReleased', () => {
    const files: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) { if (e !== 'node_modules' && !e.startsWith('.')) walk(p) } else if (/\.(ts|tsx)$/.test(e)) files.push(p) } }
    walk('lib'); walk('app')
    for (const f of files) {
      const s = read(f)
      expect(s, f).not.toMatch(/RELEASED_FOR_PURCHASE\s*(\.\s*print_badges|\[['"]print_badges['"]\])\s*=[^=]/)
      expect(s, f).not.toMatch(/PAID_BADGE_GENERATION_RELEASED\s*=\s*true/)
    }
  })
})

describe('G · RD-PRINT-BILL-P4.2 — durable suspicious records and the late-capture walk (source contracts)', () => {
  it('deterministic id: badge_{paymentId}; a non-Razorpay-shaped id is hashed, never used raw in a path', async () => {
    vi.resetModules()
    vi.doMock('@/lib/firebase/admin', () => ({ adminDb: {} }))
    const { badgeSuspiciousDocId } = await import('@/lib/licensing/printBadgePurchase/suspicious')
    expect(badgeSuspiciousDocId('pay_ABC123')).toBe('badge_pay_ABC123')
    expect(badgeSuspiciousDocId('pay_ABC123')).toBe(badgeSuspiciousDocId('pay_ABC123'))
    const odd = badgeSuspiciousDocId('pay/../x')
    expect(odd).toMatch(/^badge_h_[a-f0-9]{40}$/)
    expect(odd).toBe(badgeSuspiciousDocId('pay/../x'))
    vi.doUnmock('@/lib/firebase/admin')
  })
  it('the recorder creates once, then only counts deliveries — and does NOT swallow a failed write', () => {
    const src = read('lib/licensing/printBadgePurchase/suspicious.ts')
    expect(src).toContain('tx.create(ref,')
    const update = src.slice(src.indexOf('if (snap.exists)'), src.indexOf('tx.create(ref,'))
    expect(update).toContain('deliveries: FieldValue.increment(1)')
    expect(update).not.toMatch(/actualAmountPaise|expectedAmountPaise|reason:|createdAt/)
    expect(src).not.toMatch(/catch\s*[({]/)                                      // no swallowed failure
  })
  it('badge settlement and confirm use the durable recorder — never the swallowing flagSuspiciousPayment', () => {
    for (const f of ['settle.ts', 'confirm.ts']) {
      const s = read(`lib/licensing/printBadgePurchase/${f}`)
      expect(s, f).not.toContain('flagSuspiciousPayment')
      expect(s, f).toContain('recordBadgeSuspiciousPayment(')
    }
    expect(read('lib/payments/flagSuspicious.ts')).toContain("await adminDb.collection('suspiciousPayments').add(")   // shared path unchanged
  })
  it('the late-capture walk: watched expired orders, document-id order from a stored cursor, wraps; retires only a confirmed-unpaid past-window order', () => {
    const s = read('lib/licensing/printBadgePurchase/sweep.ts')
    expect(s).toContain(".where('lateCaptureWatch', '==', true)")
    expect(s).toContain('.orderBy(FieldPath.documentId())')
    expect(s).toContain('q = q.startAfter(start.cursor)')
    const late = s.slice(s.indexOf("await walkPage('expired'"))
    expect(late).toContain("if (found.state === 'unknown') { r.unknown++; return }")
    expect(late).toContain('if (pastWindow && await retireLateCaptureWatch(')
    expect(late.indexOf("if (found.state === 'none')")).toBeGreaterThan(late.indexOf("found.paymentStatus !== 'captured') { r.waitingAuthorized++"))
    expect(late.indexOf("if (found.state === 'none')")).toBeGreaterThan(late.indexOf("if (found.state === 'timeout')"))   // a timeout is never 'none'
    expect(read('lib/licensing/printBadgePurchase/orders.ts')).toContain("status: 'expired', expiredAt: now(), lateCaptureWatch: true")
  })
})

describe('H · RD-PRINT-BILL-P4.4 — sweep progress, analytics fail-closed, suspicious visibility (contracts + fakes)', () => {
  it('the sweep checkpoints with compare-and-set, at the last PROCESSED order, within a time budget; walks keep separate cursors', () => {
    const s = read('lib/licensing/printBadgePurchase/sweep.ts')
    expect(s).toContain('if (cur.version !== expectedVersion) return null')            // CAS
    expect(s).toContain("if (o.clock() >= o.deadline) { stoppedBy = 'deadline'; break }") // budget checked BEFORE an order starts
    const loop = s.slice(s.indexOf('for (const d of page.docs)'), s.indexOf('const wrapped ='))
    expect(loop.indexOf('await processOne(d)')).toBeLessThan(loop.indexOf('last = d.id'))  // recorded only after processing
    expect(s).toContain("const wrapped = stoppedBy === null && page.size < o.limit")
    expect(s).toContain("await walkPage('pending'")
    expect(s).toContain("await walkPage('expired'")
    expect(s).toContain('deadline: startedAt + Math.max(0, Math.floor(budget / 2) - lookupMs)')   // pending cannot consume the expired walk's time
    // RD-PRINT-BILL-P4.6 — every sweep lookup is time-boxed; the raw lookup is never awaited directly
    expect(s).toContain('export const LOOKUP_TIMEOUT_MS = 8_000')
    expect(s.split('findCapturedLicensePayment(').length - 1).toBe(1)
    expect(s).toContain('lookupWithTimeout(() => findCapturedLicensePayment(razorpayOrderId, amountPaise), lookupMs)')
    expect(s.split("if (found.state === 'timeout') { r.unknown++; return gatewayHalted ? 'halt' : undefined }").length - 1).toBe(2)
    expect(read('app/api/cron/badge-orders-reconcile/route.ts')).toContain('export const maxDuration = 60')
    expect(s).toContain('export const SWEEP_BUDGET_MS = 40_000')
  })

  it('analytics: a failed badge-exclusion query makes licence count/revenue UNAVAILABLE (null) — never a total that includes badge money', async () => {
    type F = { field: string; value: unknown }
    const mk = (failBadge: boolean) => {
      const query = (name: string, filters: F[] = []): Record<string, unknown> => ({
        where: (field: string, _op: string, value: unknown) => query(name, [...filters, { field, value }]),
        orderBy: () => query(name, filters), limit: () => query(name, filters),
        get: async () => ({ docs: [], size: 0, empty: true }),
        count: () => ({ get: async () => {
          if (name === 'licenseOrders' && filters.some(f => f.field === 'purpose')) { if (failBadge) throw new Error('index'); return { data: () => ({ count: 2 }) } }
          if (name === 'licenseOrders' && filters.some(f => f.value === 'paid')) return { data: () => ({ count: 10 }) }
          return { data: () => ({ count: 1 }) }
        } }),
        aggregate: () => ({ get: async () => {
          if (name === 'licenseOrders' && filters.some(f => f.field === 'purpose')) { if (failBadge) throw new Error('index'); return { data: () => ({ s: 5_000 }) } }
          if (name === 'licenseOrders' && filters.some(f => f.value === 'paid')) return { data: () => ({ s: 50_000 }) }
          return { data: () => ({ s: 0 }) }
        } }),
      })
      return { collection: (name: string) => query(name), doc: () => ({ get: async () => ({ exists: false }) }), getAll: async () => [] }
    }
    const run = async (failBadge: boolean) => {
      vi.resetModules()
      vi.doMock('@/lib/firebase/admin', () => ({ adminDb: mk(failBadge) }))
      vi.doMock('@/lib/organizer/identity', () => ({ organizersQuery: (db: { collection: (n: string) => unknown }) => db.collection('users') }))
      const { getAdminAnalytics } = await import('@/lib/analytics/adminAnalytics')
      const a = await getAdminAnalytics()
      vi.doUnmock('@/lib/firebase/admin'); vi.doUnmock('@/lib/organizer/identity')
      return a.licenseSales
    }
    const ok = await run(false)
    expect(ok).toMatchObject({ paidCount: 8, revenuePaise: 45_000, badgeExclusion: 'applied' })
    const failed = await run(true)
    expect(failed).toMatchObject({ paidCount: null, revenuePaise: null, badgeExclusion: 'unavailable' })
    expect(failed.refundedCount).toBe(1)                                       // unrelated licence figures unchanged
  })

  it('callers never present a missing licence total as a number (no `?? 0`, explicit Unavailable)', () => {
    const svc = read('lib/admin/licenseCenterService.ts')
    expect(svc).toContain('licenseRevenuePaise: sales ? sales.revenuePaise : 0')
    expect(svc).not.toMatch(/sales\?\.revenuePaise \?\? 0|sales\?\.paidCount \?\? 0/)
    expect(svc).toContain("'Unavailable — licence revenue could not be read (or ID-badge purchases could not be excluded)'")   // RD-ANALYTICS-FAILCLOSED wording
    expect(read('lib/admin/platformMonitorService.ts')).toContain('const lsT = ls && ls.paidCount !== null && ls.revenuePaise !== null')
    expect(read('app/(admin)/admin/analytics/PageClient.tsx')).toContain("data.licenseSales.revenuePaise === null ? 'Unavailable'")
    expect(read('app/(admin)/admin/license-center/PageClient.tsx')).toContain("ls.revenuePaise === null ? 'Unavailable'")
    expect(read('app/(admin)/admin/license-center/PageClient.tsx')).toContain("o.revenue.licenseRevenuePaise === null ? 'Unavailable'")
  })

  it('suspicious listing: Super Admin route, id-range query (no collection scan), bounded page with hasMore, field whitelist, read-only', () => {
    const r = read('app/api/admin/print-badges/suspicious-payments/route.ts')
    expect(r).toContain('const gate = await requireSuperAdmin(req)')
    const s = read('lib/licensing/printBadgePurchase/suspicious.ts')
    const list = s.slice(s.indexOf('export async function listBadgeSuspiciousPayments'))
    expect(list).toContain(".where(FieldPath.documentId(), '>=', ID_LO).where(FieldPath.documentId(), '<', ID_HI)")
    expect(list).toContain('q.limit(limit + 1)')
    expect(list).toContain('const hasMore = snap.size > limit')
    expect(list).not.toMatch(/\.(set|update|create|delete)\(/)
    expect(s).toContain('export const SUSPICIOUS_PAGE_MAX = 100')
  })
})

describe('F · source contracts', () => {
  it('the webhook settles a print_badges order through settleBadgePayment, BEFORE the generic licence branches', () => {
    const src = read('app/api/webhooks/razorpay/route.ts')
    const at = src.indexOf("if (persisted.purpose === 'print_badges')")
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(src.indexOf("if (persisted.status === 'paid')"))
    expect(src.slice(at, at + 600)).toContain('settleBadgePayment(')
  })
  it('confirm routes bdg_ orders to the badge confirmation BEFORE the add-on branch; owner only', () => {
    const src = read('app/api/licensing/checkout/confirm/route.ts')
    expect(src.indexOf("startsWith('bdg_')")).toBeLessThan(src.indexOf('const addonOrderId'))
    expect(read('lib/licensing/printBadgePurchase/confirm.ts')).toContain("if (!a.isOwner) return json({ error: 'Only the event owner")
  })
  it('the purchase routes require the OWNER (isOwner), not just the events permission', () => {
    expect(read('lib/licensing/printBadgePurchase/quote.ts')).toContain("if (!args.isOwner) return no(403, 'OWNER_REQUIRED'")
    for (const r of ['quote', 'purchase']) expect(read(`app/api/organizer/events/[eventId]/print-badges/${r}/route.ts`)).toContain('isOwner: authz.isOwner')
  })
  it('the internal order is created (tx.create) before any Razorpay order', () => {
    const src = read('lib/licensing/printBadgePurchase/orders.ts')
    const create = src.slice(src.indexOf('export async function createBadgePurchase'), src.indexOf('async function continueOrder'))
    const cont = src.slice(src.indexOf('async function continueOrder'), src.indexOf('// ─── The sweep'))
    expect(create).toContain('txn.create(ref, order)')
    expect(create).not.toContain('razorpay.')                                      // no gateway call before the order exists
    expect(create.indexOf('txn.create(ref, order)')).toBeLessThan(create.lastIndexOf('return continueOrder('))
    expect(cont).toContain('razorpay.orders.create(')                              // only from a STORED order…
    expect(cont).toContain('async function continueOrder(o: BadgeOrderDoc')
    const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    expect(code.split('razorpay.orders.create(').length - 1).toBe(1)
    expect(cont).toContain('receipt: o.orderId')                                   // …named by the internal order id
  })
  it('licence readers exclude badge orders: analytics, purchase history, capacity history; wallet labels them', () => {
    expect(read('lib/analytics/adminAnalytics.ts')).toContain("if (o.purpose === 'print_badges') continue")
    expect(read('lib/analytics/adminAnalytics.ts')).toContain('allRevenue.ok && badge.ok ? Math.max(0, allRevenue.v - badge.revenue) : null')   // RD-ANALYTICS-FAILCLOSED
    expect(read('lib/licensing/purchaseHistory.ts')).toContain("if (o.purpose === 'print_badges') continue")
    // capacity payment history selects commercialModel === 'capacity'; badge orders never carry it (P2 contract: route untouched)
    expect(read('lib/licensing/printBadgePurchase/orders.ts')).not.toContain('commercialModel')
    expect(read('lib/wallet/eventWalletView.ts')).toContain("case 'print_badges':      return 'ID badges'")
  })
  it('badge orders carry no generic service/capacity/licence-coupon fields', () => {
    const src = read('lib/licensing/printBadgePurchase/orders.ts')
    const create = src.slice(src.indexOf('const order: Omit<BadgeOrderDoc'), src.indexOf('const created = await'))
    for (const k of ['serviceItems', 'servicesTotalPaise', 'capacityChange', 'selection', 'couponCode', 'commercialModel', 'tier:']) expect(create, k).not.toContain(k)
  })
})
