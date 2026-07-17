// Server-only — uses Firebase Admin SDK.
// Validates a coupon code against an event pass.  Never increments currentUses;
// that happens atomically inside the Firestore registration transaction.

import { adminDb }  from '@/lib/firebase/admin'
import type { CouponDocument, CouponValidationResult } from './types'

export function computeDiscount(coupon: CouponDocument, originalPaise: number): number {
  switch (coupon.type) {
    case 'percentage':
      return Math.floor(originalPaise * coupon.value / 100)
    case 'fixed':
      return Math.min(coupon.value, originalPaise)
    case 'free':
      return originalPaise
    default:
      return 0
  }
}

/**
 * Validates a coupon code for a given event, pass, and pass price.
 *
 * @param eventSlug     The published event slug (used to locate the coupons subcollection).
 * @param couponCode    Raw code as entered by the user (will be normalized to uppercase).
 * @param passId        The pass the attendee selected.
 * @param originalPaise Full pass price in paise before any discount.
 */
export async function validateCoupon(
  eventSlug:     string,
  couponCode:    string,
  passId:        string,
  originalPaise: number,
): Promise<CouponValidationResult> {
  const normalized = couponCode.trim().toUpperCase()
  if (!normalized) return { valid: false, error: 'Please enter a coupon code.' }

  const snap = await adminDb
    .collection('events').doc(eventSlug)
    .collection('coupons')
    .where('code', '==', normalized)
    .limit(1)
    .get()

  if (snap.empty) return { valid: false, error: 'Invalid coupon code.' }

  const doc    = snap.docs[0]
  const coupon = doc.data() as CouponDocument

  if (!coupon.active) return { valid: false, error: 'This coupon is no longer active.' }

  const today = new Date().toISOString().slice(0, 10)
  if (coupon.validFrom && today < coupon.validFrom) {
    return { valid: false, error: 'This coupon is not yet valid.' }
  }
  if (coupon.validUntil && today > coupon.validUntil) {
    return { valid: false, error: 'This coupon has expired.' }
  }

  if (coupon.applicablePassIds.length > 0 && !coupon.applicablePassIds.includes(passId)) {
    return { valid: false, error: 'This coupon is not valid for the selected pass.' }
  }

  if (typeof coupon.maxUses === 'number' && coupon.currentUses >= coupon.maxUses) {
    return { valid: false, error: 'This coupon has reached its usage limit.' }
  }

  const discountPaise = computeDiscount(coupon, originalPaise)
  const finalPaise    = Math.max(0, originalPaise - discountPaise)

  return {
    valid: true,
    couponDocId: doc.id,
    coupon,
    discountPaise,
    finalPaise,
  }
}
