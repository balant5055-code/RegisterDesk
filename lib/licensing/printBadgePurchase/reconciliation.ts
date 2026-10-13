// RD-PRINT-BILL-P4 · Badge purchase RECONCILIATION — READ-ONLY. Server-only.
//
// Reports; never writes. Every repair goes through the established audited paths (the Failed
// Refunds queue for held money, Super Admin decisions for refunds). Badge orders are selected by
// PURPOSE ('print_badges'), so no licence, add-on or capacity order is ever counted here — and the
// licence figures elsewhere exclude badge orders by the same purpose.
//
// Money figures (paid orders): gross, coupon discount, net charged, taxable base, GST — each from the
// immutable snapshot. Checks:
//   SNAPSHOT_INCONSISTENT          a stored snapshot does not re-derive
//   ACTIVATION_MISSING             a paid order is not in its ledger's appliedOrders
//   ACTIVATION_UNEXPECTED          a ledger lists an order that is not paid
//   LEDGER_PURCHASED_MISMATCH      ledger print_badges.purchased ≠ Σ paid badge-order quantities
//   COUPON_REDEMPTION_MISSING      a paid order with a bound coupon has no matching redemption record
//   COUPON_REDEMPTION_UNPAID       a redemption exists for an order that is not paid
//   COUPON_COUNTER_MISMATCH        organizer counter ≠ redemptions − releases (per coupon + organizer)
//   RELEASE_TRACKER_MISMATCH       a release record and the order's refund tracker disagree
//   REFUND_TRACKER_EXCEEDS         processed refund units/money above what the order bought/paid
//   DUPLICATE_PAYMENT_ID           one payment id on two paid badge orders
//   HOLD_MISSING                   a failed (refused) order without its hold
//   STALE_PENDING                  a created order past expiry + grace (sweep not yet resolved it)
//   OPEN_HOLD                      captured money awaiting a Super Admin decision (listed, not an error)
//   SUSPICIOUS (RD-PRINT-BILL-P4.4) captured badge payments recorded as suspicious (first page; the rest
//                                  via GET /api/admin/print-badges/suspicious-payments?cursor=…)

import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION } from '../schema'
import { ledgerRef, ledgerLine, type ServiceLedgerDoc } from '../serviceAllowanceLedger'
import { badgeCouponRef, badgeCouponOrganizerCounterRef } from '../badgeCoupons/store'
import { BADGE_ORDER_PURPOSE, BADGE_ORDER_GRACE_MS, isConsistentBadgeSnapshot } from './pricing'
import { badgeOrderRefundsRef, BADGE_COUPON_RELEASES_SUBCOLLECTION, type BadgeOrderDoc } from './orderDoc'
import { listBadgeSuspiciousPayments, type BadgeSuspiciousRow } from './suspicious'

export type BadgeReconCode =
  | 'SNAPSHOT_INCONSISTENT' | 'ACTIVATION_MISSING' | 'ACTIVATION_UNEXPECTED' | 'LEDGER_PURCHASED_MISMATCH'
  | 'COUPON_REDEMPTION_MISSING' | 'COUPON_REDEMPTION_UNPAID' | 'COUPON_COUNTER_MISMATCH'
  | 'RELEASE_TRACKER_MISMATCH' | 'REFUND_TRACKER_EXCEEDS' | 'DUPLICATE_PAYMENT_ID' | 'HOLD_MISSING' | 'STALE_PENDING'

export interface BadgeReconFinding { code: BadgeReconCode; orderId: string | null; draftId: string | null; detail: Record<string, string | number | boolean | null> }
export interface BadgeMoney { orders: number; units: number; grossPaise: number; discountPaise: number; netPaise: number; netBasePaise: number; netGstPaise: number }
export interface BadgeReconReport {
  scannedOrders: number; truncated: boolean
  byStatus: Record<string, number>
  paid: BadgeMoney
  findings: BadgeReconFinding[]
  openHolds: Array<{ holdId: string; kind: string; orderId: string; paymentId: string | null; amountPaise: number; reason: string | null }>
  /** RD-PRINT-BILL-P4.4 — the first page of badge suspicious-payment records; `hasMore` ⇒ page on. */
  suspicious: { items: BadgeSuspiciousRow[]; hasMore: boolean; nextCursor: string | null }
}

const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

export async function reconcileBadgePurchases(opts: { limit?: number; draftId?: string | null; nowMs?: number } = {}): Promise<BadgeReconReport> {
  const nowMs = opts.nowMs ?? Date.now()
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 2000))
  let q = adminDb.collection(LICENSE_ORDERS_COLLECTION).where('purpose', '==', BADGE_ORDER_PURPOSE)
  if (opts.draftId) q = q.where('eventId', '==', opts.draftId)
  const snap = await q.limit(limit + 1).get()
  const docs = snap.docs.slice(0, limit)
  const orders = docs.map(d => ({ ...(d.data() as BadgeOrderDoc), orderId: d.id }))
  const findings: BadgeReconFinding[] = []
  const f = (code: BadgeReconCode, orderId: string | null, draftId: string | null, detail: BadgeReconFinding['detail'] = {}) => findings.push({ code, orderId, draftId, detail })

  const byStatus: Record<string, number> = {}
  const paid: BadgeMoney = { orders: 0, units: 0, grossPaise: 0, discountPaise: 0, netPaise: 0, netBasePaise: 0, netGstPaise: 0 }
  const paymentIds = new Map<string, string>()
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
    if (!isConsistentBadgeSnapshot(o.badgePurchase)) f('SNAPSHOT_INCONSISTENT', o.orderId, o.eventId)
    if (o.status === 'paid' && o.badgePurchase) {
      const s = o.badgePurchase
      paid.orders++; paid.units += int(s.quantity); paid.grossPaise += int(s.grossPaise); paid.discountPaise += int(s.discountPaise)
      paid.netPaise += int(s.netPaise); paid.netBasePaise += int(s.netBasePaise); paid.netGstPaise += int(s.netGstPaise)
      if (o.razorpayPaymentId) {
        const other = paymentIds.get(o.razorpayPaymentId)
        if (other) f('DUPLICATE_PAYMENT_ID', o.orderId, o.eventId, { paymentId: o.razorpayPaymentId, otherOrderId: other })
        else paymentIds.set(o.razorpayPaymentId, o.orderId)
      }
    }
    if (o.status === 'failed' && typeof o.failReason === 'string' && o.failReason.startsWith('badge_') && !o.manualRefundHoldId && o.razorpayOrderId) {
      f('HOLD_MISSING', o.orderId, o.eventId, { failReason: o.failReason })
    }
    const exp = tsMs(o.checkoutExpiresAt)
    if (o.status === 'created' && exp !== null && exp + BADGE_ORDER_GRACE_MS < nowMs) f('STALE_PENDING', o.orderId, o.eventId, { razorpayOrderId: o.razorpayOrderId ?? null })
  }

  // ── ledgers: activation markers and purchased units ──
  const drafts = [...new Set(orders.map(o => o.eventId).filter(Boolean))]
  for (const draftId of drafts) {
    const [lSnap, all] = await Promise.all([
      ledgerRef(draftId).get(),
      adminDb.collection(LICENSE_ORDERS_COLLECTION).where('purpose', '==', BADGE_ORDER_PURPOSE).where('eventId', '==', draftId).limit(500).get(),
    ])
    const ledger = lSnap.exists ? lSnap.data() as ServiceLedgerDoc : undefined
    const mine = all.docs.map(d => ({ ...(d.data() as BadgeOrderDoc), orderId: d.id }))
    const paidQty = mine.filter(o => o.status === 'paid').reduce((n, o) => n + int(o.badgePurchase?.quantity), 0)
    for (const o of mine) {
      const applied = ledger?.appliedOrders?.[o.orderId] === true
      if (o.status === 'paid' && !applied) f('ACTIVATION_MISSING', o.orderId, draftId)
      if (o.status !== 'paid' && applied) f('ACTIVATION_UNEXPECTED', o.orderId, draftId, { status: o.status })
    }
    const purchased = ledgerLine(ledger, 'print_badges').purchased
    if (purchased !== paidQty) f('LEDGER_PURCHASED_MISMATCH', null, draftId, { ledgerPurchased: purchased, paidOrderUnits: paidQty, ordersTruncated: all.size >= 500 })
  }

  // ── coupons: redemption per bound order, release ↔ tracker, organizer counters ──
  const pairs = new Map<string, { code: string; organizerUid: string }>()
  for (const o of orders) {
    const c = o.badgePurchase?.coupon
    if (!c) continue
    pairs.set(`${c.code}__${o.organizerUid}`, { code: c.code, organizerUid: o.organizerUid })
    const [red, rel, trk] = await Promise.all([
      badgeCouponRef(c.code).collection('redemptions').doc(o.orderId).get(),
      badgeCouponRef(c.code).collection(BADGE_COUPON_RELEASES_SUBCOLLECTION).doc(o.orderId).get(),
      badgeOrderRefundsRef(o.orderId).get(),
    ])
    const r = red.exists ? red.data() as { discountPaise?: unknown; finalPricePaise?: unknown } : null
    if (o.status === 'paid' && (!r || r.discountPaise !== c.discountPaise || r.finalPricePaise !== o.badgePurchase.netPaise)) {
      f('COUPON_REDEMPTION_MISSING', o.orderId, o.eventId, { code: c.code, found: !!r })
    }
    if (o.status !== 'paid' && r) f('COUPON_REDEMPTION_UNPAID', o.orderId, o.eventId, { code: c.code, status: o.status })
    const trackerReleased = trk.exists && (trk.data() as { couponReleased?: unknown }).couponReleased === true
    if (rel.exists !== trackerReleased) f('RELEASE_TRACKER_MISMATCH', o.orderId, o.eventId, { code: c.code, releaseRecord: rel.exists, trackerReleased })
  }
  for (const o of orders.filter(x => x.status === 'paid')) {
    const t = await badgeOrderRefundsRef(o.orderId).get()
    if (!t.exists) continue
    const d = t.data() as { processedUnits?: unknown; processedPaise?: unknown }
    if (int(d.processedUnits) > int(o.badgePurchase?.quantity) || int(d.processedPaise) > int(o.badgePurchase?.netPaise)) {
      f('REFUND_TRACKER_EXCEEDS', o.orderId, o.eventId, { processedUnits: int(d.processedUnits), processedPaise: int(d.processedPaise) })
    }
  }
  for (const { code, organizerUid } of pairs.values()) {
    const [counter, reds, rels] = await Promise.all([
      badgeCouponOrganizerCounterRef(code, organizerUid).get(),
      badgeCouponRef(code).collection('redemptions').where('organizerUid', '==', organizerUid).count().get(),
      badgeCouponRef(code).collection(BADGE_COUPON_RELEASES_SUBCOLLECTION).where('organizerUid', '==', organizerUid).where('counterDecremented', '==', true).count().get(),
    ])
    const count = counter.exists ? (counter.data() as { count?: unknown }).count : 0
    const expected = reds.data().count - rels.data().count
    if (count !== expected) f('COUPON_COUNTER_MISMATCH', null, null, { code, organizerUid, counter: typeof count === 'number' ? count : null, redemptions: reds.data().count, releases: rels.data().count })
  }

  // ── open holds on badge orders (captured money awaiting a decision) ──
  const holdsSnap = await adminDb.collection('failedRefunds').where('status', '==', 'open').limit(1000).get()
  const openHolds = holdsSnap.docs
    .map(d => ({ id: d.id, ...(d.data() as { kind?: string; licenseOrderId?: string; paymentId?: string; amountPaise?: number; reason?: string }) }))
    .filter(h => typeof h.licenseOrderId === 'string' && h.licenseOrderId.startsWith('bdg_'))
    .map(h => ({ holdId: h.id, kind: String(h.kind ?? ''), orderId: h.licenseOrderId as string, paymentId: h.paymentId ?? null, amountPaise: int(h.amountPaise), reason: h.reason ?? null }))

  const suspicious = await listBadgeSuspiciousPayments({ limit: 50 })
  return { scannedOrders: orders.length, truncated: snap.size > limit, byStatus, paid, findings, openHolds, suspicious }
}
