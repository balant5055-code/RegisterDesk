// RD-PRINT-BILL-P4 · Badge purchase SETTLEMENT — the one activation transaction, and the captured-
// payment handling shared by /api/licensing/checkout/confirm, the Razorpay webhook and the sweep.
// Server-only.
//
// ═══ THE ACTIVATION TRANSACTION (activateBadgeOrder) ═══════════════════════════
// Reads first (Firestore: every read before the first write): the order, the event's allowance
// ledger, the live event, and — only if the order binds a coupon — THAT coupon, this organizer's
// counter for it and its redemption record for this order. Then every check; then, all or nothing:
//   coupon      currentUses + 1, organizer counter + 1, redemptions/{orderId} created  (bound code only)
//   order       status 'paid', razorpayPaymentId, paidAt, couponRedemption
//   ledger      print_badges.purchased += quantity, appliedOrders[orderId] = true
//   slot        pendingBadgeOrderId → null, ONLY if it still names this order
//   history     licenseHistory 'print_badges_purchased'
// A refusal writes NOTHING (for a free order: only the order's own failed marker — no money exists).
//
// ═══ A CAPTURED PAYMENT THAT CANNOT BE ACTIVATED (settleBadgePayment) ═══════════
// Two transactions, never claimed atomic together:
//   T1  activateBadgeOrder refuses → writes nothing; the order stays `created`/`expired` (payable).
//   T2  recordManualRefundHold → creates failedRefunds/license_hold_{orderId} AND marks the order
//       failed (badge_<reason>, manualRefundHoldId) in ONE transaction, only while the order is
//       still unpaid and unheld on this Razorpay order.
// A crash between T1 and T2 leaves an unpaid, unheld order — exactly the state before T1 — so the
// next delivery (webhook redelivery: the route answers non-2xx on any throw), the client's confirm
// retry or the sweep re-runs both. A captured payment is acknowledged only after T1 succeeded
// (activated / already) or T2's hold exists. If the order became payable-and-valid in between, the
// re-run activates it instead — never both (the hold transaction refuses a paid order).

import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_HISTORY_COLLECTION, type LicenseHistoryDoc } from '../schema'
import { defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION } from '../eventLicense'
import { isServicePurchaseReleased, type ServiceChargeItem } from '../serviceAllowances'
import { ledgerRef, txnApplyServiceItems, type ServiceLedgerDoc } from '../serviceAllowanceLedger'
import { readStoredPrintBadgeOverride } from '../printBadgeCommercial'
import { recordManualRefundHold, holdSupersededPayment, recordDuplicateLicensePayment } from '../manualRefundHold'
import { txnReadBadgeCouponRedemption, txnRedeemBadgeCoupon } from '../badgeCoupons/redeem'
import { validateBadgeCoupon } from '../badgeCoupons/validate'
import { getAllowFreeBadgeCoupons } from '../badgeCoupons/store'
import type { BadgeCouponDoc } from '../badgeCoupons/types'
import { BADGE_ORDER_PURPOSE, isConsistentBadgeSnapshot, couponStillMatches } from './pricing'
import { badgeEventProblem } from './quote'
import { badgeOrderRef, type BadgeOrderDoc } from './orderDoc'
import { recordBadgeSuspiciousPayment } from './suspicious'
import { readPrintBadgePilot } from '../printBadgePilotServer'
import { isPilotOrganizer } from '../printBadgePilot'

const now = () => FieldValue.serverTimestamp()
const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/

export type BadgeRefusalReason =
  | 'expired'                // the sweep closed the checkout (no capture) before this payment arrived
  | 'snapshot_inconsistent'  // the stored pricing snapshot does not re-derive
  | 'amount_mismatch'        // order amounts disagree with the snapshot
  | 'not_released'           // the code purchase gate is closed
  | 'event_ineligible'       // the event is no longer published / owned, or its badges became free
  | 'ledger_owner_mismatch'  // the allowance ledger belongs to another organizer
  | 'already_applied'        // the ledger already holds this order (must never happen)
  | 'coupon_changed'         // the bound coupon's eligibility or financial terms changed
  | 'coupon_conflict'        // a redemption for this order already exists
  | 'not_in_pilot'           // RD-PRINT-P8 — the organizer is not (or no longer) a paid ID-badge pilot organizer

export type BadgeActivation =
  | { kind: 'ok' }
  | { kind: 'already' }
  | { kind: 'duplicate'; creditedPaymentId: string | null }
  | { kind: 'superseded' }
  | { kind: 'held'; holdId: string }
  | { kind: 'refused'; reason: BadgeRefusalReason }
  | { kind: 'not_payable' }

export type BadgePayment =
  | { kind: 'razorpay'; razorpayOrderId: string; paymentId: string }
  | { kind: 'free' }

export type SettleVia = 'confirm' | 'webhook' | 'sweep' | 'free'

/** The ledger line built from the snapshot (txnApplyServiceItems reads service, quantity, onExhausted). */
function ledgerLineOf(o: BadgeOrderDoc): ServiceChargeItem {
  const s = o.badgePurchase
  return {
    service: BADGE_ORDER_PURPOSE, quantity: s.quantity, unitPricePaise: s.unitPricePaise,
    basePaise: s.netBasePaise, gstRatePercent: s.gstRatePercent, gstPaise: s.netGstPaise, totalPaise: s.netPaise,
    onExhausted: s.onExhausted,
  } as unknown as ServiceChargeItem
}

/**
 * RD-PRINT-P8 — thrown when the pilot setting cannot be read (or is malformed) at activation. An
 * infrastructure outcome, NOT a refusal: nothing is activated and nothing is held, so the webhook
 * answers non-2xx (Razorpay redelivers), confirm answers 5xx and the sweep retries next run. A
 * passing configuration outage therefore never turns a pilot's payment into a manual refund.
 */
export class BadgePilotUnavailableError extends Error {
  constructor(public readonly reason: 'unavailable' | 'invalid') {
    super('BADGE_PILOT_UNAVAILABLE')
    this.name = 'BadgePilotUnavailableError'
  }
}

/** The one activation transaction. Never throws for a business outcome; infrastructure errors throw. */
export async function activateBadgeOrder(input: {
  orderId: string; payment: BadgePayment; via: SettleVia; nowMs?: number
}): Promise<BadgeActivation> {
  const nowMs = input.nowMs ?? Date.now()
  const allowFree = await getAllowFreeBadgeCoupons()
  // RD-PRINT-P8 — pilot membership, read FRESH (bypassing the config cache) so removing an organizer
  // stops activations at once. Evaluated below only for an order that would otherwise activate, so a
  // replay of an already-paid order is never blocked by a configuration outage.
  const pilot = await readPrintBadgePilot({ fresh: true })
  const orderRef = badgeOrderRef(input.orderId)
  const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
  return adminDb.runTransaction<BadgeActivation>(async (txn: Transaction) => {
    // ── reads ──
    const snap = await txn.get(orderRef)
    const o = snap.exists ? snap.data() as BadgeOrderDoc : undefined
    if (!o || o.purpose !== BADGE_ORDER_PURPOSE) return { kind: 'not_payable' }
    const pay = input.payment
    if (o.status === 'paid') {
      if (pay.kind === 'free') return o.razorpayOrderId === null ? { kind: 'already' } : { kind: 'not_payable' }
      return pay.paymentId === o.razorpayPaymentId ? { kind: 'already' } : { kind: 'duplicate', creditedPaymentId: o.razorpayPaymentId ?? null }
    }
    if (typeof o.manualRefundHoldId === 'string' && o.manualRefundHoldId) return { kind: 'held', holdId: o.manualRefundHoldId }
    if (o.status === 'failed') return o.failReason === 'superseded' ? { kind: 'superseded' } : { kind: 'not_payable' }
    if (o.status !== 'created' && o.status !== 'expired') return { kind: 'not_payable' }
    // The payment must be the one this order was created for: its own Razorpay order, or none (free).
    if (pay.kind === 'razorpay' ? o.razorpayOrderId !== pay.razorpayOrderId : (o.razorpayOrderId !== null || o.status !== 'created')) return { kind: 'not_payable' }
    if (!SLUG_RE.test(String(o.eventSlug)) || !SLUG_RE.test(String(o.eventId))) return { kind: 'not_payable' }

    const s = o.badgePurchase
    const [ledgerSnap, evSnap] = await Promise.all([txn.get(ledgerRef(o.eventId)), txn.get(adminDb.collection('events').doc(o.eventSlug))])
    const bound = s?.coupon ?? null
    const couponRead = bound ? await txnReadBadgeCouponRedemption(txn, bound.code, o.organizerUid, o.orderId) : null
    // ── every read is done; refusals below write nothing (a free order records its own failure) ──
    const refuse = (reason: BadgeRefusalReason): BadgeActivation => {
      if (pay.kind === 'free') txn.update(orderRef, { status: 'failed', failReason: `badge_${reason}`, updatedAt: now() })
      return { kind: 'refused', reason }
    }

    if (o.status === 'expired') return refuse('expired')
    if (!isConsistentBadgeSnapshot(s)) return refuse('snapshot_inconsistent')
    if (o.currency !== 'INR' || o.amountPaise !== s.netPaise || o.razorpayAmountPaise !== s.netPaise) return refuse('amount_mismatch')
    if ((pay.kind === 'free') !== (s.netPaise === 0)) return refuse('amount_mismatch')
    if (!isServicePurchaseReleased(BADGE_ORDER_PURPOSE)) return refuse('not_released')
    // RD-PRINT-P8 — the order's organizer must still be a pilot organizer. Unreadable / malformed ⇒
    // throw (retry, no hold); definitely not listed ⇒ a refusal (a captured payment is durably held).
    if (!pilot.ok) throw new BadgePilotUnavailableError(pilot.reason)
    if (!isPilotOrganizer(pilot, o.organizerUid)) return refuse('not_in_pilot')
    const ev = evSnap.exists ? evSnap.data() as Record<string, unknown> : undefined
    if (badgeEventProblem(ev, o.organizerUid, o.eventId)) return refuse('event_ineligible')
    const ov = readStoredPrintBadgeOverride(ev?.printBadgeCommercial)
    if (!ov.ok || ov.override?.enabled === false || ov.override?.complimentary === true) return refuse('event_ineligible')
    const ledger = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
    if (ledger && ledger.organizerUid !== o.organizerUid) return refuse('ledger_owner_mismatch')
    if (ledger?.appliedOrders?.[o.orderId]) return refuse('already_applied')
    if (o.couponRedemption) return refuse('coupon_conflict')

    // The bound coupon only — revalidated as read in THIS transaction and compared with the snapshot.
    if (bound && couponRead) {
      if (couponRead.redemption.exists) return refuse('coupon_conflict')
      const couponDoc = couponRead.coupon.exists ? couponRead.coupon.data() as BadgeCouponDoc : null
      const counted = couponRead.counter.exists ? (couponRead.counter.data() as { count?: unknown }).count : 0
      if (!(typeof counted === 'number' && Number.isInteger(counted) && counted >= 0)) return refuse('coupon_changed')
      const eventCouponsAllowed = ov.override?.couponsAllowed ?? true
      const v = validateBadgeCoupon(couponDoc, {
        organizerUid: o.organizerUid, eventId: o.eventSlug, purchasePaise: s.grossPaise,
        organizerRedemptions: counted, eventCouponsAllowed, allowFreeCoupons: allowFree,
      }, nowMs)
      if (!v.ok || !couponStillMatches(bound, { ...v, minPurchasePaise: couponDoc?.minPurchasePaise ?? null }, s.netPaise)) return refuse('coupon_changed')
      const r = txnRedeemBadgeCoupon(txn, couponRead, {
        orderId: o.orderId, organizerUid: o.organizerUid, eventId: o.eventSlug, purchasePaise: s.grossPaise,
        eventCouponsAllowed, allowFreeCoupons: allowFree, nowMs,
      })
      // Same inputs as the check above, so this cannot differ; if it ever did, it wrote nothing.
      if (!r.ok || r.already || r.discountPaise !== bound.discountPaise) return refuse('coupon_changed')
    }

    // ── writes (all or nothing) ──
    txn.update(orderRef, {
      status: 'paid', razorpayPaymentId: pay.kind === 'razorpay' ? pay.paymentId : null, paidAt: now(),
      couponRedemption: bound ? { code: bound.code, discountPaise: bound.discountPaise } : null,
      settledVia: input.via, updatedAt: now(),
    })
    txnApplyServiceItems(txn, ledgerSnap, { draftId: o.eventId, organizerUid: o.organizerUid, orderId: o.orderId, items: [ledgerLineOf(o)] })
    if (ledger?.pendingBadgeOrderId === o.orderId) {
      txn.set(ledgerRef(o.eventId), { pendingBadgeOrderId: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
    const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`
    const history: Omit<LicenseHistoryDoc, 'createdAt'> & { createdAt: unknown } = {
      id: historyRef.id, eventId: o.eventId, organizerUid: o.organizerUid, action: 'print_badges_purchased',
      fromTier: null, toTier: defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),   // compatibility stamp only
      source: 'self_serve', orderId: o.orderId, actorUid: o.createdByUid,
      note: `ID badges purchased — ${s.quantity} badges · ${rupees(s.netPaise)} incl. GST${bound ? ` (coupon ${bound.code}: −${rupees(bound.discountPaise)})` : ''}${pay.kind === 'free' ? ' · free coupon, no payment' : ''}`,
      after: {
        quantity: s.quantity, unitPricePaise: s.unitPricePaise, grossPaise: s.grossPaise, discountPaise: s.discountPaise,
        netPaise: s.netPaise, netBasePaise: s.netBasePaise, netGstPaise: s.netGstPaise, gstRatePercent: s.gstRatePercent,
        couponCode: bound?.code ?? null, taxApprovalId: s.taxApprovalId,
      },
      createdAt: now(),
    }
    txn.create(historyRef, history)
    return { kind: 'ok' }
  })
}

// ─── Captured payments ────────────────────────────────────────────────────────

/**
 * T2's precondition, read INSIDE the hold transaction: the order is still an unpaid (created or
 * expired), unheld badge order on THIS Razorpay order. A paid order is never marked held.
 */
export const unpaidUnheldBadgeOrder = (razorpayOrderId: string) => (o: Record<string, unknown> | undefined): boolean =>
  !!o && o.purpose === BADGE_ORDER_PURPOSE && (o.status === 'created' || o.status === 'expired')
    && o.manualRefundHoldId == null && o.razorpayOrderId === razorpayOrderId

export type BadgeSettleOutcome =
  | { kind: 'activated' }
  | { kind: 'already' }
  | { kind: 'held'; holdId: string; reason: string }
  | { kind: 'duplicate_held'; holdId: string }
  | { kind: 'mismatch_flagged' }
  | { kind: 'not_payable' }

/**
 * A payment ALREADY VERIFIED by the caller as captured on `razorpayOrderId` (signature + fetched payment
 * on confirm; the signed payment.captured event on the webhook; a fetched captured payment in the
 * sweep). Returns only once the payment is activated, already applied, durably held, or durably recorded
 * as suspicious (RD-PRINT-BILL-P4.2). Throws on an infrastructure failure — including a failed suspicious
 * record — so the webhook answers non-2xx and Razorpay redelivers.
 */
export async function settleBadgePayment(input: {
  orderId: string; razorpayOrderId: string; paymentId: string
  amountPaise: number | undefined; currency: string | undefined; via: Exclude<SettleVia, 'free'>
}): Promise<BadgeSettleOutcome> {
  const preSnap = await badgeOrderRef(input.orderId).get()
  const pre = preSnap.exists ? preSnap.data() as BadgeOrderDoc : undefined
  // RD-PRINT-BILL-P4.2 — every captured payment that cannot be settled or held is recorded DURABLY
  // (suspiciousPayments/badge_{paymentId}, idempotent) BEFORE this returns; a failed write throws, so the
  // webhook answers non-2xx and Razorpay redelivers. Nothing below grants units or redeems a coupon.
  const via = input.via
  if (!pre || pre.purpose !== BADGE_ORDER_PURPOSE || pre.razorpayOrderId !== input.razorpayOrderId) {
    await recordBadgeSuspiciousPayment({
      reason: 'badge_payment_unmatched', paymentId: input.paymentId, razorpayOrderId: input.razorpayOrderId, badgeOrderId: input.orderId,
      eventId: pre?.eventId ?? null, expectedAmountPaise: pre?.razorpayAmountPaise ?? null, actualAmountPaise: input.amountPaise ?? null,
      expectedCurrency: 'INR', actualCurrency: input.currency ?? null, expectedOrderId: pre?.razorpayOrderId ?? null, actualOrderId: input.razorpayOrderId, detectedBy: via,
    })
    return { kind: 'not_payable' }
  }
  const expected = pre.razorpayAmountPaise
  if (input.currency !== 'INR' || input.amountPaise !== expected || !(expected > 0)) {
    await recordBadgeSuspiciousPayment({
      reason: 'amount_mismatch', paymentId: input.paymentId, razorpayOrderId: input.razorpayOrderId, badgeOrderId: pre.orderId, eventId: pre.eventId,
      expectedAmountPaise: expected, actualAmountPaise: input.amountPaise ?? null, expectedCurrency: 'INR', actualCurrency: input.currency ?? null, detectedBy: via,
    })
    return { kind: 'mismatch_flagged' }
  }
  const dup = async (credited: string | null) => {
    const h = await recordDuplicateLicensePayment({
      orderDocId: pre.orderId, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId, creditedPaymentId: credited,
      amountPaise: expected, eventId: pre.eventId, organizerUid: pre.organizerUid, detectedBy: input.via,
    })
    return { kind: 'duplicate_held' as const, holdId: h.holdId }
  }
  /** An existing hold on this order: for THIS payment it is the answer; for another payment, this one is a duplicate. */
  const existingHold = async (holdId: string): Promise<BadgeSettleOutcome> => {
    const h = await adminDb.collection('failedRefunds').doc(holdId).get()
    const heldPayment = h.exists ? (h.data() as { paymentId?: unknown }).paymentId : null
    if (heldPayment === input.paymentId) return { kind: 'held', holdId, reason: String((h.data() as { reason?: unknown }).reason ?? '') }
    return dup(typeof heldPayment === 'string' ? heldPayment : null)
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await activateBadgeOrder({ orderId: input.orderId, payment: { kind: 'razorpay', razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId }, via: input.via })
    if (a.kind === 'ok') return { kind: 'activated' }
    if (a.kind === 'already') return { kind: 'already' }
    if (a.kind === 'duplicate') return dup(a.creditedPaymentId)
    if (a.kind === 'held') return existingHold(a.holdId)
    if (a.kind === 'not_payable') {
      await recordBadgeSuspiciousPayment({
        reason: 'badge_order_not_payable', paymentId: input.paymentId, razorpayOrderId: input.razorpayOrderId, badgeOrderId: pre.orderId, eventId: pre.eventId,
        expectedAmountPaise: expected, actualAmountPaise: input.amountPaise ?? null, expectedCurrency: 'INR', actualCurrency: input.currency ?? null, detectedBy: via,
      })
      return { kind: 'not_payable' }
    }
    if (a.kind === 'superseded') {
      const h = await holdSupersededPayment({
        orderDocId: pre.orderId, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId, amountPaise: expected,
        eventId: pre.eventId, organizerUid: pre.organizerUid, source: 'license',
      })
      if (h.skipped) continue
      return h.created ? { kind: 'held', holdId: h.holdId, reason: 'superseded_paid' } : existingHold(h.holdId)
    }
    // refused — T2: the hold and the order's failed marker, together, only while still unpaid + unheld.
    const failReason = `badge_${a.reason}`
    const h = await recordManualRefundHold({
      orderDocId: pre.orderId, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId, amountPaise: expected,
      eventId: pre.eventId, organizerUid: pre.organizerUid, reason: 'badge_purchase_refused', source: 'license', failReason,
      onlyIfOrder: unpaidUnheldBadgeOrder(input.razorpayOrderId),
    })
    if (h.skipped) continue                 // the order changed (paid / held meanwhile) — decide again
    if (h.created) {
      console.warn('[badge] captured payment HELD for review — nothing activated:', { orderId: pre.orderId, paymentId: input.paymentId, reason: a.reason })
      return { kind: 'held', holdId: h.holdId, reason: failReason }
    }
    return existingHold(h.holdId)
  }
  throw new Error('BADGE_SETTLEMENT_UNSTABLE')
}
