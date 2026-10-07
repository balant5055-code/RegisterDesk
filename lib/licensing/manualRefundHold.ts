// RD-EVENT-COMMERCE-04B · manual-refund HOLDS for licensing.
//
// Confirmed business rule: RegisterDesk never refunds automatically. When licensing captures money
// for something it then refuses (a coupon exhausted before activation, a capacity change gone
// stale), the amount is recorded here as an OPEN item in the Failed Refunds queue and nothing is
// sent to the gateway. A Super Admin refunds it explicitly (POST /api/admin/failed-refunds/[id]/retry,
// resolveSuperAdminUid) or closes it (PATCH …/[id]: resolved / ignored).
//
// Its own module so the activation module keeps exactly ONE transaction (the activation), and so
// the capacity module can use it without importing activation code.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION } from './schema'
import { flagSuspiciousPayment } from '@/lib/payments/flagSuspicious'

const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

/**
 * RD-EVENT-COMMERCE-04B — the ONE way licensing records money it must not keep but may not
 * refund on its own. Creates the hold and marks the order in a single transaction; an
 * existing hold (a replay or a racing caller) is left untouched. Moves no money.
 * Shared with capacityChange.ts.
 */
export async function recordManualRefundHold(input: {
  orderDocId:      string
  razorpayOrderId: string | null
  paymentId:       string
  amountPaise:     number
  eventId:         string
  reason:          'coupon_exhausted' | 'capacity_stale' | 'superseded_paid' | 'lifecycle_ineligible' | 'photo_capacity_exceeded'
  source:          'license' | 'license_capacity'
  failReason:      string
  /** RD-F2 — the organizer the order belongs to (recorded on the hold when known). */
  organizerUid?:   string
  /**
   * RD-F2 — optional precondition on the ORDER, read INSIDE the hold's transaction. When it
   * returns false nothing is written (`skipped: true`). Existing callers pass none — unchanged.
   */
  onlyIfOrder?:    (order: Record<string, unknown> | undefined, holdId: string) => boolean
}): Promise<{ holdId: string; created: boolean; skipped?: boolean }> {
  const holdId   = `license_hold_${input.orderDocId}`
  const holdRef  = adminDb.collection('failedRefunds').doc(holdId)
  const orderRef = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(input.orderDocId)
  let skipped = false
  const created = await adminDb.runTransaction(async txn => {
    skipped = false
    const holdSnap  = await txn.get(holdRef)
    const orderSnap = input.onlyIfOrder ? await txn.get(orderRef) : null
    if (holdSnap.exists) return false
    if (input.onlyIfOrder && !input.onlyIfOrder(orderSnap?.exists ? orderSnap.data() : undefined, holdId)) {
      skipped = true
      return false
    }
    txn.create(holdRef, {
      kind:        'license_remainder_hold',
      status:      'open',
      orderId:     input.razorpayOrderId ?? input.orderDocId,
      licenseOrderId: input.orderDocId,
      eventId:     input.eventId,
      ...(input.organizerUid ? { organizerUid: input.organizerUid } : {}),
      paymentId:   input.paymentId,
      amountPaise: input.amountPaise,
      reason:      input.reason,
      source:      input.source,
      note:        'Captured for a licence/capacity change that was refused. Nothing was refunded automatically — a Super Admin must refund or resolve this explicitly.',
      createdAt:   now(),
    })
    txn.set(orderRef, {
      status: 'failed', failReason: input.failReason, manualRefundHoldId: holdId, updatedAt: now(),
    }, { merge: true })
    return true
  })
  return { holdId, created, ...(skipped ? { skipped: true } : {}) }
}

// ─── RD-F2 · a CAPTURED payment on a SUPERSEDED order ─────────────────────────────────────────
//
// An order is superseded (marked `failed` / `superseded`) when the organizer changes the selection
// and a new order replaces it. Its Razorpay order stays payable, so a payment can still be captured
// on it afterwards (e.g. a UPI approval that arrives late). F1 refuses to apply such an order; this
// records the captured money as the SAME manual-refund hold the other refusals use, so it is never
// silently lost. Nothing is granted, refunded, credited or re-applied — Super Admin review only.

/**
 * RD-F2A — a NEW-EVENT activation order lives at the single document `lic_{draftId}`, which a
 * supersede OVERWRITES. Before that overwrite (in the same transaction) the replaced order is
 * archived here, keyed by its OWN Razorpay order id, so a payment captured on it later can still be
 * found (webhook: by razorpayOrderId; confirm: by this id) and held. Razorpay order ids are
 * `[A-Za-z0-9_]`; anything else is never used to build a document id.
 */
export const RAZORPAY_ORDER_ID_RE = /^[A-Za-z0-9_]{1,64}$/
export function supersededActivationOrderId(draftId: string, razorpayOrderId: string): string {
  return `lic_${draftId}__sup_${razorpayOrderId}`
}

/** An order that was superseded and has no hold yet (or already has THIS hold — idempotent). */
export function isSupersededUnheld(
  order: { status?: unknown; failReason?: unknown; manualRefundHoldId?: unknown } | undefined,
  holdId?: string,
): boolean {
  if (!order || order.status !== 'failed' || order.failReason !== 'superseded') return false
  return order.manualRefundHoldId == null || (holdId !== undefined && order.manualRefundHoldId === holdId)
}

/**
 * Records the hold for a payment ALREADY VERIFIED as captured + matching (the caller's job: the
 * confirm routes' signature + fetched-payment checks, or the webhook's payment.captured with amount
 * and currency checks). Re-checked INSIDE the transaction: still superseded, same Razorpay order,
 * same amount. Idempotent: one deterministic hold per order, whoever arrives first.
 */
export async function holdSupersededPayment(input: {
  orderDocId:      string
  razorpayOrderId: string
  paymentId:       string
  amountPaise:     number
  eventId:         string
  organizerUid:    string
  source:          'license' | 'license_capacity'
}): Promise<{ holdId: string; created: boolean; skipped?: boolean }> {
  return recordManualRefundHold({
    orderDocId: input.orderDocId, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId,
    amountPaise: input.amountPaise, eventId: input.eventId, organizerUid: input.organizerUid,
    reason: 'superseded_paid', source: input.source,
    failReason: 'superseded',   // history preserved: the order stays "superseded", now with a hold
    onlyIfOrder: (o, holdId) => isSupersededUnheld(o, holdId)
      && o?.razorpayOrderId === input.razorpayOrderId
      && o?.razorpayAmountPaise === input.amountPaise,
  })
}

/**
 * RD-CE-FIX M4 — a SECOND captured payment on a licence order that is already PAID (a double tap
 * across two tabs, a retried UPI collect, a Razorpay replay with a new payment). It used to be
 * acknowledged and dropped: the money was captured and nothing recorded it. Following the top-up
 * duplicate pattern (lib/wallet/topupReconciliation recordDuplicateTopupPayment), it is recorded as
 * an idempotent hold — keyed by the PAYMENT, so a replay of the same payment changes nothing — in the
 * same Super Admin refund queue the other licence holds use (`failedRefunds`), and flagged as a
 * suspicious payment. The order, its entitlement and its ledger lines are NOT touched: nothing is
 * granted twice, revoked, or refunded automatically.
 */
export async function recordDuplicateLicensePayment(input: {
  orderDocId:        string
  razorpayOrderId:   string | null
  paymentId:         string
  creditedPaymentId: string | null
  amountPaise:       number
  eventId:           string
  organizerUid:      string
  detectedBy:        'webhook' | 'confirm'
}): Promise<{ holdId: string; created: boolean }> {
  const holdId  = `license_dup_${input.paymentId}`
  const holdRef = adminDb.collection('failedRefunds').doc(holdId)
  const created = await adminDb.runTransaction(async txn => {
    const snap = await txn.get(holdRef)
    if (snap.exists) {
      txn.update(holdRef, { detectedBy: FieldValue.arrayUnion(input.detectedBy), updatedAt: now() })
      return false
    }
    txn.create(holdRef, {
      kind:              'license_duplicate_payment',
      status:            'open',
      orderId:           input.razorpayOrderId ?? input.orderDocId,
      licenseOrderId:    input.orderDocId,
      eventId:           input.eventId,
      organizerUid:      input.organizerUid,
      paymentId:         input.paymentId,
      creditedPaymentId: input.creditedPaymentId,
      amountPaise:       input.amountPaise,
      reason:            'duplicate_payment',
      source:            'license',
      detectedBy:        [input.detectedBy],
      note:              'Second captured payment on a licence order that was already paid. Nothing was granted for it and nothing was refunded automatically — a Super Admin must refund or resolve this explicitly.',
      createdAt:         now(),
      updatedAt:         now(),
    })
    return true
  })
  if (created) {
    await flagSuspiciousPayment({
      source: 'license', reason: 'duplicate_payment', paymentId: input.paymentId, orderId: input.razorpayOrderId ?? input.orderDocId,
      entityId: input.eventId, expectedAmountPaise: input.amountPaise, actualAmountPaise: input.amountPaise,
      expectedCurrency: 'INR', actualCurrency: 'INR',
    })
  }
  return { holdId, created }
}
