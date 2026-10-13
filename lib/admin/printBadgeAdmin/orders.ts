// RD-PRINT-BILL-P7 · Super Admin reader for ID-badge purchase orders. Server-only, READ-ONLY.
//
// licenseOrders where purpose == 'print_badges' (the Phase 4 order), listed in DOCUMENT-ID order
// with a cursor (equality filters only — no composite index), searchable by the internal order id
// or the Razorpay order / payment id. The DETAIL joins every record that can say something about
// the order, each as its own section (unavailable ≠ empty):
//   refund tracker  badgeOrderRefunds/{orderId}
//   coupon          badgeCoupons/{code}/redemptions/{orderId} + releases/{orderId}
//   holds           failedRefunds where licenseOrderId == orderId
//   suspicious      suspiciousPayments where badgeOrderId == orderId, + the doc for its payment id
//   history         licenseHistory where orderId == orderId
//   wallet refunds  walletServiceRequests of its event whose badge allocation names this order
// Every related-record list is BOUNDED and says when its bound was reached (truncated), so a long
// list is never presented as complete. Money stays in PAISE. Nothing is written here; attendee data
// is never read.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION } from '@/lib/licensing/schema'
import { BADGE_ORDER_PURPOSE } from '@/lib/licensing/printBadgePurchase/pricing'
import { badgeOrderRefundsRef, isBadgeOrderId, BADGE_COUPON_RELEASES_SUBCOLLECTION, type BadgeOrderDoc } from '@/lib/licensing/printBadgePurchase/orderDoc'
import { badgeSuspiciousDocId, toBadgeSuspiciousRow, type BadgeSuspiciousRow } from '@/lib/licensing/printBadgePurchase/suspicious'
import { badgeCouponRef } from '@/lib/licensing/badgeCoupons/store'
import { SERVICE_REQUESTS_COLLECTION } from '@/lib/wallet/serviceRequestRules'
import { section, pageByDocId, boundedRead, n, numOrNull, str, iso, maskId, ID_RE, type Section, type Page, type Bounded } from './common'

export const ORDER_PAGE_MAX = 100
export const BADGE_ORDER_STATUSES = ['created', 'paid', 'failed', 'expired'] as const

/** Read bounds of the order-detail sections (each reports `truncated` when reached). */
export const DETAIL_HOLDS_MAX = 20
export const DETAIL_SUSPICIOUS_MAX = 20
export const DETAIL_HISTORY_MAX = 50
export const DETAIL_WALLET_MAX = 200
/** The list's hold lookup: `in` takes at most 30 values; a chunk whose read bound is reached stays unknown. */
const LIST_HOLD_CHUNK = 30
const LIST_HOLD_READ_MAX = 200

const orders = () => adminDb.collection(LICENSE_ORDERS_COLLECTION)
const SUSPICIOUS = 'suspiciousPayments'
const FAILED_REFUNDS = 'failedRefunds'

/** A list row. Gateway ids are MASKED here; the full ids appear only in the order detail. */
export interface BadgeOrderRow {
  orderId: string; status: string
  eventId: string | null; eventSlug: string | null; organizerUid: string | null
  quantity: number | null; grossPaise: number | null; discountPaise: number | null; netPaise: number | null
  couponCode: string | null
  razorpayOrderIdMasked: string | null; paymentIdMasked: string | null
  settledVia: string | null; failReason: string | null
  /**
   * Whether any hold record (failedRefunds, by licenseOrderId) exists for this order — the refusal
   * hold the order names (manualRefundHoldId) or a duplicate-payment hold (license_dup_{paymentId}),
   * which the order does NOT name. null = UNKNOWN (the lookup failed or hit its bound): never "no hold".
   */
  held: boolean | null
  /** Hold records still `open`; null when unknown. */
  openHolds: number | null
  createdAt: string | null; paidAt: string | null
}

/**
 * Folds a hold lookup into a row. `found` is this order's hold tally; `known` says the lookup for it
 * completed (read succeeded, bound not reached). Without it only the order's own hold id is evidence.
 */
export function applyHoldLookup(row: BadgeOrderRow, found: { total: number; open: number } | undefined, known: boolean): BadgeOrderRow {
  if (!known) return { ...row, held: row.held === true ? true : null, openHolds: null }
  const total = found?.total ?? 0
  return { ...row, held: row.held === true || total > 0, openHolds: found?.open ?? 0 }
}

/** Every hold on these orders, read in bounded `in` chunks. Rows whose chunk could not be read stay unknown. */
async function attachHolds(rows: BadgeOrderRow[]): Promise<BadgeOrderRow[]> {
  const chunks: string[][] = []
  for (let i = 0; i < rows.length; i += LIST_HOLD_CHUNK) chunks.push(rows.slice(i, i + LIST_HOLD_CHUNK).map(r => r.orderId))
  const tally = new Map<string, { total: number; open: number }>()
  const complete: string[][] = []   // chunks whose lookup completed
  await Promise.all(chunks.map(async ids => {
    try {
      const s = await adminDb.collection(FAILED_REFUNDS).where('licenseOrderId', 'in', ids).select('licenseOrderId', 'status').limit(LIST_HOLD_READ_MAX + 1).get()
      if (s.size > LIST_HOLD_READ_MAX) return
      for (const h of s.docs) {
        const id = h.get('licenseOrderId') as string
        const t = tally.get(id) ?? { total: 0, open: 0 }
        t.total += 1
        if (h.get('status') === 'open') t.open += 1
        tally.set(id, t)
      }
      complete.push(ids)
    } catch (e) {
      console.error('[admin/print-badges] order hold lookup unavailable', { type: e instanceof Error ? e.name : typeof e })
    }
  }))
  const known = new Set(complete.flat())
  return rows.map(r => applyHoldLookup(r, tally.get(r.orderId), known.has(r.orderId)))
}

export function toBadgeOrderRow(id: string, d: Record<string, unknown>): BadgeOrderRow {
  const bp = (d.badgePurchase ?? {}) as Record<string, unknown>
  const coupon = (bp.coupon ?? null) as { code?: unknown } | null
  return {
    orderId: id, status: str(d.status) ?? 'unknown',
    eventId: str(d.eventId), eventSlug: str(d.eventSlug), organizerUid: str(d.organizerUid),
    quantity: numOrNull(bp.quantity), grossPaise: numOrNull(bp.grossPaise), discountPaise: numOrNull(bp.discountPaise), netPaise: numOrNull(bp.netPaise),
    couponCode: str(coupon?.code),
    razorpayOrderIdMasked: maskId(str(d.razorpayOrderId)), paymentIdMasked: maskId(str(d.razorpayPaymentId)),
    settledVia: str(d.settledVia), failReason: str(d.failReason),
    // The order's own hold id proves a hold; its absence proves nothing (see applyHoldLookup).
    held: str(d.manualRefundHoldId) ? true : null, openHolds: null,
    createdAt: iso(d.createdAt), paidAt: iso(d.paidAt),
  }
}

export interface BadgeOrderFilters { status?: string | null; draftId?: string | null; organizerUid?: string | null }

/** Validates list filters; null when one is malformed (the route answers 400). */
export function parseOrderFilters(p: { get(k: string): string | null }): BadgeOrderFilters | null {
  const status = p.get('status')?.trim() || null
  const draftId = p.get('draftId')?.trim() || null
  const organizerUid = p.get('organizerUid')?.trim() || null
  if (status && !(BADGE_ORDER_STATUSES as readonly string[]).includes(status)) return null
  if (draftId && !ID_RE.test(draftId)) return null
  if (organizerUid && !ID_RE.test(organizerUid)) return null
  return { status, draftId, organizerUid }
}

export async function listBadgeOrders(f: BadgeOrderFilters, cursor: string | null, limit: number): Promise<Page<BadgeOrderRow>> {
  let q: FirebaseFirestore.Query = orders().where('purpose', '==', BADGE_ORDER_PURPOSE)
  if (f.status) q = q.where('status', '==', f.status)
  if (f.draftId) q = q.where('eventId', '==', f.draftId)
  if (f.organizerUid) q = q.where('organizerUid', '==', f.organizerUid)
  const page = await pageByDocId(q, cursor, Math.min(limit, ORDER_PAGE_MAX), d => toBadgeOrderRow(d.id, d.data()), FieldPath.documentId())
  return { ...page, items: await attachHolds(page.items) }
}

export type OrderSearchKind = 'order' | 'razorpay_order' | 'payment'
const RZP_ORDER_RE = /^order_[A-Za-z0-9]{6,40}$/
const RZP_PAYMENT_RE = /^pay_[A-Za-z0-9]{6,40}$/

/** What a search term is — or null when it is none of the three id shapes. */
export function classifyOrderSearch(term: string): OrderSearchKind | null {
  if (isBadgeOrderId(term)) return 'order'
  if (RZP_ORDER_RE.test(term)) return 'razorpay_order'
  if (RZP_PAYMENT_RE.test(term)) return 'payment'
  return null
}

/** Exact lookup by one of the three ids. Only badge orders are ever returned. */
export async function searchBadgeOrders(term: string): Promise<BadgeOrderRow[]> {
  const kind = classifyOrderSearch(term)
  if (!kind) return []
  if (kind === 'order') {
    const s = await orders().doc(term).get()
    return s.exists && s.get('purpose') === BADGE_ORDER_PURPOSE ? attachHolds([toBadgeOrderRow(s.id, s.data()!)]) : []
  }
  const field = kind === 'razorpay_order' ? 'razorpayOrderId' : 'razorpayPaymentId'
  const snap = await orders().where(field, '==', term).limit(10).get()
  return attachHolds(snap.docs.filter(d => d.get('purpose') === BADGE_ORDER_PURPOSE).map(d => toBadgeOrderRow(d.id, d.data())))
}

// ─── Detail ────────────────────────────────────────────────────────────────────────

export interface HoldRow { holdId: string; kind: string | null; status: string | null; amountPaise: number | null; paymentId: string | null; reason: string | null; createdAt: string | null }
export interface HistoryRow { id: string; action: string | null; note: string | null; source: string | null; actorUid: string | null; createdAt: string | null }

/**
 * One Wallet badge-refund request, as it bears on THIS order. Two different figures, never merged:
 *   allocation      this order's part of the request — 'approved': the exact part fixed at approval
 *                   (`badgeAllocation`, the cap the approved amount was valued from — NOT money paid);
 *                   'requested': the valuation estimated at submission (nothing approved yet).
 *   refundedToOrder the money ACTUALLY attributed to this order when the request was processed
 *                   (badgeOrderRefunds/{orderId}.processed[requestId] — a short refund is attributed
 *                   proportionally, so it can be less than the allocation). null = none recorded.
 * approvedAmountPaise / refundedAmountPaise are the WHOLE request's figures (every order it covers).
 */
export interface WalletRefundRow {
  id: string; kind: string | null; status: string | null; quantity: number
  approvedAmountPaise: number | null; refundedAmountPaise: number | null
  allocation: { basis: 'approved' | 'requested'; units: number; paise: number }
  refundedToOrder: { units: number; paise: number } | null
}

/** Pure. The row for one request doc, or null when the request does not cover `orderId`. */
export function toWalletRefundRow(id: string, x: Record<string, unknown>, orderId: string, processed: Record<string, unknown>): WalletRefundRow | null {
  const parts = (v: unknown) => (Array.isArray(v) ? v : []).filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (p as Record<string, unknown>).orderId === orderId)
  const approved = parts(x.badgeAllocation), requested = parts(x.valuation)
  const basis = Array.isArray(x.badgeAllocation) ? 'approved' as const : 'requested' as const
  const mine = basis === 'approved' ? approved : requested
  if (!mine.length) return null
  const p = processed[id]
  const done = p && typeof p === 'object' ? p as Record<string, unknown> : null
  return {
    id, kind: str(x.kind), status: str(x.status), quantity: n(x.quantity),
    approvedAmountPaise: numOrNull(x.approvedAmountPaise), refundedAmountPaise: numOrNull(x.refundedAmountPaise),
    allocation: { basis, units: mine.reduce((t, q) => t + n(q.units), 0), paise: mine.reduce((t, q) => t + n(q.valuePaise), 0) },
    refundedToOrder: done ? { units: n(done.units), paise: n(done.paise) } : null,
  }
}

/** Pure. Whether the order has a hold: its own hold id proves one; the holds section can prove none only if complete. */
export function detailHoldState(manualRefundHoldId: string | null, holds: Section<Bounded<HoldRow>>): { held: boolean | null; openHolds: number | null } {
  if (!holds.ok) return { held: manualRefundHoldId ? true : null, openHolds: null }
  const open = holds.data.items.filter(h => h.status === 'open').length
  if (holds.data.truncated) return { held: true, openHolds: null }
  return { held: !!manualRefundHoldId || holds.data.items.length > 0, openHolds: open }
}

export interface BadgeOrderDetail {
  order: BadgeOrderRow & {
    razorpayOrderId: string | null; razorpayPaymentId: string | null
    unitPricePaise: number | null; netBasePaise: number | null; netGstPaise: number | null; gstRatePercent: number | null
    priceSource: string | null; taxApprovalId: string | null; couponDiscountPaise: number | null
    requestId: string | null; createdByUid: string | null; manualRefundHoldId: string | null
    checkoutExpiresAt: string | null; expiredAt: string | null; lateCaptureWatch: boolean
  }
  refundTracker: Section<{ exists: boolean; processedUnits: number; processedPaise: number; fullyRefunded: boolean; couponReleased: boolean }>
  coupon: Section<{ code: string; redemption: { exists: boolean; discountPaise: number | null; finalPricePaise: number | null }; release: { exists: boolean; counterDecremented: boolean } } | null>
  holds: Section<Bounded<HoldRow>>
  suspicious: Section<Bounded<BadgeSuspiciousRow>>
  history: Section<Bounded<HistoryRow>>
  walletRequests: Section<Bounded<WalletRefundRow>>
}

export async function getBadgeOrderDetail(orderId: string): Promise<BadgeOrderDetail | null> {
  if (!isBadgeOrderId(orderId)) return null
  const snap = await orders().doc(orderId).get()
  if (!snap.exists || snap.get('purpose') !== BADGE_ORDER_PURPOSE) return null
  const d = snap.data() as Record<string, unknown>
  const o = d as unknown as BadgeOrderDoc
  const bp = (o.badgePurchase ?? {}) as unknown as Record<string, unknown>
  const coupon = (bp.coupon ?? null) as { code?: unknown; discountPaise?: unknown } | null
  const couponCode = str(coupon?.code)
  const paymentId = str(d.razorpayPaymentId)
  const draftId = str(d.eventId)
  // Read once: the tracker's totals AND its per-request entries (what each request actually refunded).
  const tracker = badgeOrderRefundsRef(orderId).get()

  const [refundTracker, couponSec, holds, suspicious, history, walletRequests] = await Promise.all([
    section('refund tracker', async () => {
      const t = await tracker
      const x = (t.data() ?? {}) as Record<string, unknown>
      return { exists: t.exists, processedUnits: n(x.processedUnits), processedPaise: n(x.processedPaise), fullyRefunded: x.fullyRefunded === true, couponReleased: x.couponReleased === true }
    }),
    section('coupon', async () => {
      if (!couponCode) return null
      const [red, rel] = await Promise.all([
        badgeCouponRef(couponCode).collection('redemptions').doc(orderId).get(),
        badgeCouponRef(couponCode).collection(BADGE_COUPON_RELEASES_SUBCOLLECTION).doc(orderId).get(),
      ])
      const r = (red.data() ?? {}) as Record<string, unknown>
      return {
        code: couponCode,
        redemption: { exists: red.exists, discountPaise: numOrNull(r.discountPaise), finalPricePaise: numOrNull(r.finalPricePaise) },
        release: { exists: rel.exists, counterDecremented: rel.get('counterDecremented') === true },
      }
    }),
    section('holds', () => boundedRead(adminDb.collection(FAILED_REFUNDS).where('licenseOrderId', '==', orderId), DETAIL_HOLDS_MAX, (h): HoldRow => {
      const x = h.data() as Record<string, unknown>
      return { holdId: h.id, kind: str(x.kind), status: str(x.status), amountPaise: numOrNull(x.amountPaise), paymentId: str(x.paymentId), reason: str(x.reason), createdAt: iso(x.createdAt) }
    })),
    section('suspicious payments', async () => {
      const [byOrder, byPayment] = await Promise.all([
        boundedRead(adminDb.collection(SUSPICIOUS).where('badgeOrderId', '==', orderId), DETAIL_SUSPICIOUS_MAX, s => toBadgeSuspiciousRow(s.id, s.data())),
        paymentId ? adminDb.collection(SUSPICIOUS).doc(badgeSuspiciousDocId(paymentId)).get() : Promise.resolve(null),
      ])
      const rows = new Map<string, BadgeSuspiciousRow>()
      for (const s of byOrder.items) rows.set(s.id, s)
      if (byPayment?.exists) rows.set(byPayment.id, toBadgeSuspiciousRow(byPayment.id, byPayment.data()!))
      return { items: [...rows.values()], truncated: byOrder.truncated, limit: byOrder.limit }
    }),
    section('history', async () => {
      const b = await boundedRead(adminDb.collection(LICENSE_HISTORY_COLLECTION).where('orderId', '==', orderId), DETAIL_HISTORY_MAX, (h): HistoryRow => {
        const x = h.data() as Record<string, unknown>
        return { id: h.id, action: str(x.action), note: str(x.note), source: str(x.source), actorUid: str(x.actorUid), createdAt: iso(x.createdAt) }
      })
      return { ...b, items: b.items.sort((a, c) => (a.createdAt ?? '').localeCompare(c.createdAt ?? '')) }
    }),
    section('wallet requests', async (): Promise<Bounded<WalletRefundRow>> => {
      if (!draftId) return { items: [], truncated: false, limit: DETAIL_WALLET_MAX }
      // Badge requests of this event only (equality filters — no composite index); bounded.
      const [b, t] = await Promise.all([
        boundedRead(adminDb.collection(SERVICE_REQUESTS_COLLECTION).where('sourceDraftId', '==', draftId).where('service', '==', 'print_badges'), DETAIL_WALLET_MAX, r => ({ id: r.id, x: r.data() as Record<string, unknown> })),
        tracker,
      ])
      const tx = (t.data() ?? {}) as Record<string, unknown>
      const processed = (tx.processed && typeof tx.processed === 'object' ? tx.processed : {}) as Record<string, unknown>
      const items = b.items.map(({ id, x }) => toWalletRefundRow(id, x, orderId, processed)).filter((r): r is WalletRefundRow => r !== null)
      return { items, truncated: b.truncated, limit: b.limit }
    }),
  ])

  return {
    order: {
      ...toBadgeOrderRow(orderId, d),
      ...detailHoldState(str(d.manualRefundHoldId), holds),
      razorpayOrderId: str(d.razorpayOrderId), razorpayPaymentId: paymentId,
      unitPricePaise: numOrNull(bp.unitPricePaise), netBasePaise: numOrNull(bp.netBasePaise), netGstPaise: numOrNull(bp.netGstPaise),
      gstRatePercent: typeof bp.gstRatePercent === 'number' ? bp.gstRatePercent : null,
      priceSource: str(bp.priceSource), taxApprovalId: str(bp.taxApprovalId), couponDiscountPaise: numOrNull(coupon?.discountPaise),
      requestId: str(d.requestId), createdByUid: str(d.createdByUid), manualRefundHoldId: str(d.manualRefundHoldId),
      checkoutExpiresAt: iso(d.checkoutExpiresAt), expiredAt: iso(d.expiredAt), lateCaptureWatch: d.lateCaptureWatch === true,
    },
    refundTracker, coupon: couponSec, holds, suspicious, history, walletRequests,
  }
}
