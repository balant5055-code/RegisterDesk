// Shared license-purchase finalization (GA-8 P1-1). Server-only.
//
// Extracted VERBATIM from app/api/licensing/checkout/confirm/route.ts so the
// activation transaction has ONE implementation shared by every recovery path:
//   • /api/licensing/checkout/confirm      — the client-driven happy path
//   • /api/webhooks/razorpay               — captured-payment backstop (no intent)
//   • /api/licensing/purchase (self-heal)  — retry after a captured-but-unconfirmed pay
//
// A single implementation is deliberate: divergent activation logic across paths is
// exactly how a payments platform ends up double-settling. Every write is keyed by a
// deterministic id (`lic_<eventId>`, `license_<eventId>`), so a replay is idempotent —
// the transaction short-circuits when the order is already `paid`.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import { txnDeductWallet }       from '@/lib/firebase/firestore/wallet'
import { razorpay }              from '@/lib/razorpay/client'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { getWalletConfig }       from '@/lib/wallet/resolveWalletConfig'
import { licenseCouponRef }      from '@/lib/licensing/coupons'
import {
  LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION,
  licenseOrderConverter, licenseHistoryConverter,
  type LicenseOrderDoc, type LicenseHistoryDoc,
} from '@/lib/licensing/schema'
import type { EventLicenseTier } from '@/lib/licensing/eventLicense'
import type { OrganizerWallet } from '@/types/events'

const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

export type LicenseActivationKind = 'ok' | 'already' | 'insufficient' | 'coupon_exhausted'

/** Pure derivation of the wallet/remainder split from the persisted order — the
 *  SINGLE source both the pre-txn verification (confirm route) and the activation
 *  transaction read from, so they can never disagree. */
export function deriveLicenseCharge(
  persisted: LicenseOrderDoc | null,
  basePricePaise: number,
): {
  alreadyPaid: boolean
  finalPricePaise: number
  couponCode: string | null
  remainderPaise: number
  walletUsePaise: number
  expectedOrderId: string | null
} {
  const alreadyPaid     = persisted?.status === 'paid'
  const finalPricePaise = typeof persisted?.finalPricePaise === 'number' ? persisted.finalPricePaise : basePricePaise
  const couponCode      = typeof persisted?.couponCode === 'string' ? persisted.couponCode : null
  const remainderPaise  = alreadyPaid ? 0 : Math.max(0, persisted?.razorpayAmountPaise ?? 0)
  const expectedOrderId = persisted?.razorpayOrderId ?? null
  const walletUsePaise  = Math.max(0, Math.min(finalPricePaise - remainderPaise, finalPricePaise))
  return { alreadyPaid, finalPricePaise, couponCode, remainderPaise, walletUsePaise, expectedOrderId }
}

export interface ActivateLicenseOrderInput {
  eventId:           string
  uid:               string
  tier:              EventLicenseTier
  licenseName:       string             // def.name — ledger/history description
  basePricePaise:    number             // def.licensePricePaise — coupon-free fallback
  persisted:         LicenseOrderDoc | null
  razorpayOrderId:   string | null      // stamped onto the paid order
  razorpayPaymentId: string | null      // stamped onto the paid order
}

export interface ActivateLicenseOrderResult {
  kind:            LicenseActivationKind
  walletUsePaise:  number
  remainderPaise:  number
  finalPricePaise: number
  couponCode:      string | null
}

/**
 * The license activation transaction — deducts the wallet portion, redeems the
 * coupon, flips the order to `paid`, and appends immutable history, all atomically.
 * Idempotent: a re-run on an already-`paid` order returns `already` and writes
 * nothing. Never throws for business outcomes (insufficient / coupon_exhausted);
 * the caller maps those to its own response + refund handling.
 */
export async function activateLicenseOrder(input: ActivateLicenseOrderInput): Promise<ActivateLicenseOrderResult> {
  const { eventId, uid, tier, licenseName, basePricePaise, persisted } = input
  const { finalPricePaise, couponCode, remainderPaise, walletUsePaise } = deriveLicenseCharge(persisted, basePricePaise)
  const couponRef = couponCode ? licenseCouponRef(couponCode) : null

  const orderRef   = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).withConverter(licenseOrderConverter)
  const walletRef  = adminDb.doc(`organizerWallets/${uid}`)
  const ledgerRef  = adminDb.collection('walletTransactions').doc(`license_${eventId}`)
  const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc().withConverter(licenseHistoryConverter)

  // Wallet policy (Business Configuration): the insufficient-balance guard is
  // skipped only when negative balances are explicitly allowed.
  const walletCfg = await getWalletConfig()

  const kind = await adminDb.runTransaction<LicenseActivationKind>(async (txn) => {
    // READS first.
    const orderSnap = await txn.get(orderRef)
    if (orderSnap.exists && orderSnap.data()?.status === 'paid') return 'already'
    // EA-4 S2 / GA-7B: include the coupon in the read set AND re-check its usage
    // cap INSIDE the txn, so concurrent confirms can't push currentUses past
    // usageLimit. The loser of a race for the last use is rejected here (txn rolls
    // back → no increment, no activation) and its remainder refunded by the caller.
    if (couponRef) {
      const couponSnap = await txn.get(couponRef)
      if (couponSnap.exists) {
        const c = couponSnap.data() as { usageLimit?: number | null; currentUses?: number }
        if (c.usageLimit != null && (c.currentUses ?? 0) >= c.usageLimit) {
          return 'coupon_exhausted'
        }
      }
    }

    let newBalance = 0
    if (walletUsePaise > 0) {
      const walletSnap = await txn.get(walletRef)
      const balance    = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
      if (!walletCfg.allowNegativeBalance && balance < walletUsePaise) return 'insufficient'
      newBalance = balance - walletUsePaise
    }

    // WRITES.
    if (walletUsePaise > 0) {
      txnDeductWallet(txn, uid, walletUsePaise)   // reuse existing wallet primitive
      txn.set(ledgerRef, {
        organizerUid:  uid,
        type:          'license_charge',
        amountPaise:   walletUsePaise,
        balancePaise:  newBalance,
        status:        'completed',
        referenceType: 'razorpay',
        referenceId:   `lic_${eventId}`,
        description:   `Event License payment — ${licenseName}`,
        metadata:      { eventId },
        createdAt:     FieldValue.serverTimestamp(),
      })
    }

    const orderDoc: LicenseOrderDoc = {
      orderId:           `lic_${eventId}`,
      eventId,
      organizerUid:      uid,
      tier,
      fromTier:          null,
      purpose:           'purchase',
      amountPaise:       finalPricePaise,   // FINAL charged (revenue-correct)
      currency:          'INR',
      status:            'paid',
      razorpayOrderId:   input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      createdAt:         now(),
      updatedAt:         now(),
      paidAt:            now(),
      // EA-4 S2: carry the coupon accounting + immutable snapshot onto the paid order.
      ...(couponCode ? {
        couponCode,
        campaign:           persisted?.campaign ?? null,
        originalPricePaise: persisted?.originalPricePaise ?? basePricePaise,
        discountPaise:      persisted?.discountPaise ?? (basePricePaise - finalPricePaise),
        finalPricePaise,
        couponSnapshot:     persisted?.couponSnapshot ?? null,
      } : {}),
    }
    txn.set(orderRef, orderDoc)

    // EA-4 S2: redeem the coupon (global counter) atomically with activation.
    if (couponRef) {
      txn.set(couponRef, { currentUses: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }

    const historyDoc: LicenseHistoryDoc = {
      id:           historyRef.id,
      eventId,
      organizerUid: uid,
      action:       'purchased',
      fromTier:     null,
      toTier:       tier,
      source:       'self_serve',
      orderId:      `lic_${eventId}`,
      actorUid:     uid,
      note:         couponCode
        ? `License purchased — coupon ${couponCode} (−${persisted?.discountPaise ?? 0}), wallet ${walletUsePaise}, razorpay ${remainderPaise}`
        : `License purchased — wallet ${walletUsePaise}, razorpay ${remainderPaise}`,
      createdAt:    now(),
    }
    txn.set(historyRef, historyDoc)

    return 'ok'
  })

  return { kind, walletUsePaise, remainderPaise, finalPricePaise, couponCode }
}

/**
 * Refund the captured Razorpay remainder when activation was rejected because the
 * coupon hit its usage limit between checkout and confirm. Idempotent: gated by
 * `persisted.couponExhaustedRefundId` so a replay cannot double-refund; a refund API
 * failure is recorded to `failedRefunds` for manual retry. Never throws.
 */
export async function refundExhaustedCouponRemainder(input: {
  eventId:        string
  orderId:        string | null
  paymentId:      string | null
  remainderPaise: number
  persisted:      LicenseOrderDoc | null
}): Promise<void> {
  const { eventId, orderId, paymentId, remainderPaise, persisted } = input
  const priorRefundId = (persisted as { couponExhaustedRefundId?: string } | null)?.couponExhaustedRefundId
  if (remainderPaise <= 0 || !paymentId || priorRefundId != null) return
  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount:  remainderPaise,
      speed:   'optimum',
      notes:   { reason: 'coupon_exhausted', eventId },
      receipt: `lic_ce_${eventId}`.slice(0, 40),
    })
    await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).set(
      { status: 'failed', failReason: 'coupon_exhausted', couponExhaustedRefundId: refund.id, updatedAt: now() },
      { merge: true },
    )
  } catch (refundErr) {
    captureFinancialError(refundErr, { scope: 'license.coupon_exhausted_refund', eventId, paymentId, orderId, amount: remainderPaise })
    await adminDb.collection('failedRefunds').add({
      orderId: orderId ?? `lic_${eventId}`, paymentId, amountPaise: remainderPaise,
      reason: 'coupon_exhausted', source: 'license', createdAt: now(), status: 'pending',
    }).catch(() => {})
  }
}
