// RD-PRINT-BILL-P4.2 · DURABLE suspicious-payment records for ID-badge purchases. Server-only.
//
// The shared flagSuspiciousPayment (lib/payments/flagSuspicious.ts) deliberately never throws and
// writes with an auto id — right for its callers, wrong for a captured badge payment that is about to
// be ACKNOWLEDGED: if its write failed, the only trace would be a Sentry event. This path:
//
//   suspiciousPayments/badge_{paymentId}     (the same collection the operations runbook reviews;
//                                             keyed by the PAYMENT, like topup `mismatch_{paymentId}`
//                                             and licence holds `license_dup_{paymentId}`)
//
//   • one transaction: CREATED once with the evidence (expected vs observed amount / currency / order,
//     the badge order, the reason, firstSeenAt); a redelivery only adds `deliveries + 1`,
//     `lastDeliveryAt` and the detecting path — the original evidence is never overwritten;
//   • a write failure THROWS: the webhook answers non-2xx and Razorpay redelivers; confirm answers 503;
//   • no attendee data, no output, no URL — payment and order identifiers and amounts only.
// Nothing here grants units, redeems a coupon or marks an order paid.

import { createHash } from 'node:crypto'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'

export const SUSPICIOUS_PAYMENTS_COLLECTION = 'suspiciousPayments'
const RAZORPAY_ID_RE = /^[A-Za-z0-9_]{1,64}$/

/** Deterministic id: `badge_{paymentId}` — or a hash of it when the id is not a plain Razorpay id. */
export function badgeSuspiciousDocId(paymentId: string): string {
  return RAZORPAY_ID_RE.test(paymentId)
    ? `badge_${paymentId}`
    : `badge_h_${createHash('sha256').update(paymentId).digest('hex').slice(0, 40)}`
}

export interface BadgeSuspiciousInput {
  reason:               'amount_mismatch' | 'amount_or_order_mismatch' | 'badge_order_not_payable' | 'badge_payment_unmatched'
  paymentId:            string
  razorpayOrderId:      string | null
  badgeOrderId:         string | null
  eventId:              string | null
  expectedAmountPaise:  number | null
  actualAmountPaise:    number | null
  expectedCurrency:     string | null
  actualCurrency:       string | null
  expectedOrderId?:     string | null
  actualOrderId?:       string | null
  detectedBy:           'webhook' | 'confirm' | 'sweep'
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** Records (or re-touches) the durable record. THROWS if it cannot be committed. */
export async function recordBadgeSuspiciousPayment(input: BadgeSuspiciousInput): Promise<{ id: string; created: boolean }> {
  const id = badgeSuspiciousDocId(input.paymentId)
  const ref = adminDb.collection(SUSPICIOUS_PAYMENTS_COLLECTION).doc(id)
  const created = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      tx.update(ref, {
        deliveries: FieldValue.increment(1), lastDeliveryAt: FieldValue.serverTimestamp(),
        detectedBy: FieldValue.arrayUnion(input.detectedBy),
      })
      return false
    }
    tx.create(ref, {
      source: 'license', purpose: 'print_badges', reason: input.reason,
      paymentId: input.paymentId, orderId: str(input.razorpayOrderId), badgeOrderId: str(input.badgeOrderId), entityId: str(input.eventId),
      expectedAmountPaise: num(input.expectedAmountPaise), actualAmountPaise: num(input.actualAmountPaise),
      expectedCurrency: str(input.expectedCurrency), actualCurrency: str(input.actualCurrency),
      expectedOrderId: str(input.expectedOrderId ?? null), actualOrderId: str(input.actualOrderId ?? null),
      detectedBy: [input.detectedBy], deliveries: 1, reviewed: false,
      createdAt: FieldValue.serverTimestamp(), firstSeenAt: FieldValue.serverTimestamp(), lastDeliveryAt: FieldValue.serverTimestamp(),
    })
    return true
  })
  if (created) {
    captureFinancialError(`suspicious_payment:${input.reason}`, {
      scope: 'badge.suspicious_payment', detail: 'BADGE PAYMENT FLAGGED — manual review needed',
      paymentId: input.paymentId, orderId: input.razorpayOrderId, badgeOrderId: input.badgeOrderId,
    })
  }
  return { id, created }
}

// ─── RD-PRINT-BILL-P4.4 · Super Admin visibility (READ-ONLY) ─────────────────────────────────────
//
// Badge records are exactly the `badge_…` ids, so they are listed by a DOCUMENT-ID range in id order —
// the built-in id index; no composite index, no full-collection read. Bounded pages with an explicit
// `hasMore` + `nextCursor`. Only payment/order identifiers, the reason, the financial evidence, the
// review status and timestamps are returned. Nothing is written, refunded, activated or released.

const ID_LO = 'badge_', ID_HI = 'badge`'                       // '`' sorts immediately after '_'
const CURSOR_RE = /^badge_[A-Za-z0-9_]{1,80}$/
export const SUSPICIOUS_PAGE_MAX = 100

export interface BadgeSuspiciousRow {
  id: string; paymentId: string | null; razorpayOrderId: string | null; badgeOrderId: string | null; eventId: string | null
  reason: string | null
  expectedAmountPaise: number | null; actualAmountPaise: number | null
  expectedCurrency: string | null; actualCurrency: string | null
  expectedOrderId: string | null; actualOrderId: string | null
  detectedBy: string[]; deliveries: number | null; reviewed: boolean
  createdAt: string | null; lastDeliveryAt: string | null
}

const iso = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

export function toBadgeSuspiciousRow(id: string, d: Record<string, unknown>): BadgeSuspiciousRow {
  return {
    id, paymentId: str(d.paymentId), razorpayOrderId: str(d.orderId), badgeOrderId: str(d.badgeOrderId), eventId: str(d.entityId),
    reason: str(d.reason),
    expectedAmountPaise: num(d.expectedAmountPaise), actualAmountPaise: num(d.actualAmountPaise),
    expectedCurrency: str(d.expectedCurrency), actualCurrency: str(d.actualCurrency),
    expectedOrderId: str(d.expectedOrderId), actualOrderId: str(d.actualOrderId),
    detectedBy: Array.isArray(d.detectedBy) ? d.detectedBy.filter((x): x is string => typeof x === 'string') : [],
    deliveries: num(d.deliveries), reviewed: d.reviewed === true,
    createdAt: iso(d.createdAt), lastDeliveryAt: iso(d.lastDeliveryAt),
  }
}

export async function listBadgeSuspiciousPayments(opts: { cursor?: string | null; limit?: number } = {}): Promise<{
  items: BadgeSuspiciousRow[]; hasMore: boolean; nextCursor: string | null
}> {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 50), SUSPICIOUS_PAGE_MAX))
  if (opts.cursor && !CURSOR_RE.test(opts.cursor)) throw new Error('INVALID_CURSOR')
  let q = adminDb.collection(SUSPICIOUS_PAYMENTS_COLLECTION)
    .where(FieldPath.documentId(), '>=', ID_LO).where(FieldPath.documentId(), '<', ID_HI)
    .orderBy(FieldPath.documentId())
  if (opts.cursor) q = q.startAfter(opts.cursor)
  const snap = await q.limit(limit + 1).get()
  const docs = snap.docs.slice(0, limit)
  const items = docs.filter(d => (d.data() as { purpose?: unknown }).purpose === 'print_badges').map(d => toBadgeSuspiciousRow(d.id, d.data() as Record<string, unknown>))
  const hasMore = snap.size > limit
  return { items, hasMore, nextCursor: hasMore && docs.length ? docs[docs.length - 1].id : null }
}
