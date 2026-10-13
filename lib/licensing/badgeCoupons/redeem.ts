// RD-PRINT-BILL-P3 · Badge-purchase coupon REDEMPTION — the primitive the future purchase-activation
// transaction (Phase 4) calls. Server-only. NOTHING in Phase 3 calls it outside tests: badge
// purchases are not released (RELEASED_FOR_PURCHASE.print_badges === false).
//
// Two halves, because Firestore requires every read in a transaction before its first write:
//   1. txnReadBadgeCouponRedemption(tx, code, organizerUid, orderId)   — reads only
//   2. txnRedeemBadgeCoupon(tx, read, args)                            — revalidates, then writes
// The caller performs its own reads between (or before) these, then calls (2) before its own writes.
//
// Guarantees, inside the caller's transaction:
//   • revalidation against the coupon AS READ in this transaction — lifecycle, dates, event and
//     organizer restrictions, minimum, the free-coupon gate, and BOTH usage limits;
//   • a refusal writes NOTHING — the caller must then abort its activation (no units applied);
//   • success writes, all or nothing with the caller's own writes: currentUses + 1, the organizer
//     counter + 1, and ONE immutable redemption record keyed by the order id;
//   • idempotent per order: a replay finds the order's record and returns it without writing;
//   • concurrency: every redemption reads the coupon document and the organizer counter, so
//     concurrent redemptions serialize on them and can never exceed either limit.
//
// ═══ PHASE 4 DESIGN REQUIREMENT — ONE COUPON PER ORDER (RD-PRINT-BILL-P3.2; NOT implemented here) ═══
// Redemption records live under EACH coupon (badgeCoupons/{CODE}/redemptions/{orderId}), so this
// helper alone cannot stop one order from redeeming two DIFFERENT codes. The purchase flow MUST:
//   1. bind AT MOST ONE coupon code to the purchase order when the order is created (stored on the
//      order, normalized), and never change it afterwards;
//   2. in the activation transaction, READ the order, and redeem ONLY the code bound to it — refusing
//      (and activating nothing) if the requested code differs, or if the order already records a
//      redemption of any other code;
//   3. record on the order which code was redeemed, in the same transaction.
// Two different codes must never be redeemable against the same order. Phase 3.2 adds no caller.

import { FieldValue, type Transaction, type DocumentSnapshot } from 'firebase-admin/firestore'
import {
  badgeCouponRef, badgeCouponOrganizerCounterRef, badgeCouponRedemptionRef,
} from './store'
import { normalizeBadgeCouponCode, validateBadgeCoupon } from './validate'
import type { BadgeCouponDoc, BadgeCouponFailure, BadgeCouponSnapshot } from './types'

export interface BadgeCouponRedemptionRead {
  code:       string
  coupon:     DocumentSnapshot
  counter:    DocumentSnapshot
  redemption: DocumentSnapshot
}

export async function txnReadBadgeCouponRedemption(
  tx: Transaction, code: string, organizerUid: string, orderId: string,
): Promise<BadgeCouponRedemptionRead> {
  const c = normalizeBadgeCouponCode(code)
  const [coupon, counter, redemption] = await Promise.all([
    tx.get(badgeCouponRef(c)), tx.get(badgeCouponOrganizerCounterRef(c, organizerUid)), tx.get(badgeCouponRedemptionRef(c, orderId)),
  ])
  return { code: c, coupon, counter, redemption }
}

export interface RedeemBadgeCouponArgs {
  orderId:             string
  organizerUid:        string
  eventId:             string
  /** GST-inclusive purchase amount, paise — computed server-side by the purchase. */
  purchasePaise:       number
  eventCouponsAllowed: boolean
  allowFreeCoupons:    boolean
  nowMs:               number
}

export type RedeemBadgeCouponResult =
  | { ok: true; already: boolean; discountPaise: number; finalPricePaise: number; snapshot: BadgeCouponSnapshot }
  | { ok: false; failure: BadgeCouponFailure | 'redemption_conflict'; message: string }

export function txnRedeemBadgeCoupon(tx: Transaction, read: BadgeCouponRedemptionRead, a: RedeemBadgeCouponArgs): RedeemBadgeCouponResult {
  // Idempotent replay of THIS order's redemption: return what was recorded; write nothing.
  if (read.redemption.exists) {
    const r = read.redemption.data() as { organizerUid?: string; discountPaise?: number; finalPricePaise?: number; snapshot?: BadgeCouponSnapshot }
    if (r.organizerUid !== a.organizerUid || typeof r.discountPaise !== 'number' || typeof r.finalPricePaise !== 'number' || !r.snapshot) {
      return { ok: false, failure: 'redemption_conflict', message: 'This order’s coupon redemption does not match.' }
    }
    return { ok: true, already: true, discountPaise: r.discountPaise, finalPricePaise: r.finalPricePaise, snapshot: r.snapshot }
  }

  const coupon = read.coupon.exists ? read.coupon.data() as BadgeCouponDoc : null
  const counted = read.counter.exists ? (read.counter.data() as { count?: unknown }).count : 0
  // An unreadable counter is never "0 prior uses": refuse, with its own code (RD-PRINT-BILL-P3.2),
  // BEFORE any write — so no redemption, counter or caller activation can follow.
  if (!(typeof counted === 'number' && Number.isInteger(counted) && counted >= 0)) {
    return { ok: false, failure: 'usage_unverified', message: 'This coupon’s usage could not be verified. Please try again.' }
  }
  const v = validateBadgeCoupon(coupon, {
    organizerUid: a.organizerUid, eventId: a.eventId, purchasePaise: a.purchasePaise, organizerRedemptions: counted,
    eventCouponsAllowed: a.eventCouponsAllowed, allowFreeCoupons: a.allowFreeCoupons,
  }, a.nowMs)
  if (!v.ok) return v                                                   // refused — nothing written

  tx.update(read.coupon.ref, { currentUses: FieldValue.increment(1) })
  tx.set(read.counter.ref, { organizerUid: a.organizerUid, count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  tx.create(read.redemption.ref, {
    orderId: a.orderId, organizerUid: a.organizerUid, eventId: a.eventId,
    purchasePaise: a.purchasePaise, discountPaise: v.discountPaise, finalPricePaise: v.finalPricePaise,
    snapshot: v.snapshot, status: 'redeemed', redeemedAt: FieldValue.serverTimestamp(),
  })
  return { ok: true, already: false, discountPaise: v.discountPaise, finalPricePaise: v.finalPricePaise, snapshot: v.snapshot }
}
