// RD-PRINT-BILL-P4 · The badge purchase ORDER document. Server-only.
//
// licenseOrders/bdg_<sha256(draftId|ownerUid|requestId)[0:32]>   purpose: 'print_badges'
//
// It lives in licenseOrders so the existing Razorpay webhook lookup (by razorpayOrderId), the
// manual-refund holds (failedRefunds/license_hold_{orderId}) and the duplicate-payment holds
// (failedRefunds/license_dup_{paymentId}) work unchanged — and so firestore.rules' `licenseOrders:
// if false` keeps it server-only. It deliberately has NO `serviceItems`, `servicesTotalPaise`,
// `capacityChange`, `selection`, `couponCode`, `discountPaise`, `commercialModel` or `tier`, so no
// generic licence / add-on / capacity / licence-coupon reader can mistake it for one of theirs.
//
// IMMUTABLE after creation: orderId, eventId, eventSlug, organizerUid, purpose, amountPaise,
// razorpayAmountPaise, currency, badgePurchase (the whole pricing + coupon + tax snapshot),
// requestId, createdByUid, checkoutExpiresAt, createdAt. `razorpayOrderId` is set ONCE (attach).
// Nothing attendee-level, no generated output, no URL is ever stored here.
//
// STATUS
//   created ──attach (once)──► created + razorpayOrderId
//   created ──activation ok──► paid                          (units + coupon, ONE transaction)
//   created ──refused + hold (ONE transaction)──► failed     (failReason badge_<reason>, manualRefundHoldId)
//   created ──replaced, provider confirms no capture──► failed (failReason 'superseded')
//   created ──sweep: expiry + grace, provider confirms none──► expired
//   expired ──late capture──► failed + hold                  (never activated)
//   paid / failed are final.

import { createHash } from 'node:crypto'
import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION } from '../schema'
import { BADGE_ORDER_PREFIX, type BadgePurchaseSnapshot } from './pricing'

export type BadgeOrderStatus = 'created' | 'paid' | 'failed' | 'expired'

export interface BadgeOrderDoc {
  orderId:             string
  purpose:             'print_badges'
  eventId:             string            // the DRAFT id — the allowance-ledger key
  eventSlug:           string            // the live event
  organizerUid:        string            // the workspace owner
  amountPaise:         number            // = badgePurchase.netPaise
  razorpayAmountPaise: number            // = badgePurchase.netPaise (0 ⇒ free order, never sent to Razorpay)
  currency:            'INR'
  status:              BadgeOrderStatus
  razorpayOrderId:     string | null
  razorpayPaymentId:   string | null
  badgePurchase:       BadgePurchaseSnapshot
  requestId:           string
  createdByUid:        string
  checkoutExpiresAt:   FirebaseFirestore.Timestamp
  couponRedemption:    { code: string; discountPaise: number } | null
  failReason?:         string | null
  manualRefundHoldId?: string | null
  expiredAt?:          FirebaseFirestore.Timestamp | null
  /** RD-PRINT-BILL-P4.2 — true from expiry until the sweep retires the late-capture watch. */
  lateCaptureWatch?:   boolean
  lateCaptureWatchEndedAt?: FirebaseFirestore.Timestamp | null
  settledVia?:         'confirm' | 'webhook' | 'sweep' | 'free' | null
  createdAt:           FirebaseFirestore.Timestamp
  updatedAt:           FirebaseFirestore.Timestamp
  paidAt:              FirebaseFirestore.Timestamp | null
}

export const isBadgeOrderId = (id: unknown): id is string =>
  typeof id === 'string' && /^bdg_[a-f0-9]{32}$/.test(id)

export function badgeOrderId(draftId: string, ownerUid: string, requestId: string): string {
  return `${BADGE_ORDER_PREFIX}${createHash('sha256').update(`${draftId}|${ownerUid}|${requestId}`).digest('hex').slice(0, 32)}`
}

export const badgeOrderRef = (orderId: string) => adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId)

/** The refund tracker for one paid badge order (see lib/wallet/serviceRequests badge refunds). */
export const BADGE_ORDER_REFUNDS_COLLECTION = 'badgeOrderRefunds'
export const badgeOrderRefundsRef = (orderId: string) => adminDb.collection(BADGE_ORDER_REFUNDS_COLLECTION).doc(orderId)
/** One record per order whose organizer coupon count was released (create-once ⇒ exactly once). */
export const BADGE_COUPON_RELEASES_SUBCOLLECTION = 'releases'
