// RD-PRINT-BILL-P3 · Badge-purchase coupons — Firestore access. Server-only (Admin SDK).
//
//   badgeCoupons/{CODE}                               the coupon (doc id = normalized code)
//   badgeCoupons/{CODE}/organizerRedemptions/{uid}    { count } — per-organizer counter (atomic)
//   badgeCoupons/{CODE}/redemptions/{orderId}         one immutable record per redeemed order
//
// ONE code namespace with licence coupons: a code exists in at most one of licenseCoupons/{CODE}
// and badgeCoupons/{CODE}. Each side's create (and clone) transaction READS BOTH documents before
// it writes, so two concurrent creates of one code serialize on those reads and only one commits.
// No firestore.rules entry: the collection is server-only (default deny), like licenseCoupons.

import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import { normalizeBadgeCouponCode } from './validate'
import { BADGE_COUPONS_COLLECTION, type BadgeCouponDoc } from './types'

export { BADGE_COUPONS_COLLECTION }
export const BADGE_COUPON_ORGANIZER_SUBCOLLECTION = 'organizerRedemptions'
export const BADGE_COUPON_REDEMPTIONS_SUBCOLLECTION = 'redemptions'
/** The licence-coupon collection, read (never written) to keep the code namespace shared. */
export const LICENSE_COUPONS_NAMESPACE_COLLECTION = 'licenseCoupons'

export const badgeCouponRef = (code: string) => adminDb.collection(BADGE_COUPONS_COLLECTION).doc(normalizeBadgeCouponCode(code))
export const licenseCouponNamespaceRef = (code: string) => adminDb.collection(LICENSE_COUPONS_NAMESPACE_COLLECTION).doc(normalizeBadgeCouponCode(code))
export const badgeCouponOrganizerCounterRef = (code: string, organizerUid: string) =>
  badgeCouponRef(code).collection(BADGE_COUPON_ORGANIZER_SUBCOLLECTION).doc(organizerUid)
export const badgeCouponRedemptionRef = (code: string, orderId: string) =>
  badgeCouponRef(code).collection(BADGE_COUPON_REDEMPTIONS_SUBCOLLECTION).doc(orderId)

export async function getBadgeCoupon(code: string): Promise<BadgeCouponDoc | null> {
  const c = normalizeBadgeCouponCode(code)
  if (!c) return null
  const snap = await badgeCouponRef(c).get()
  return snap.exists ? snap.data() as BadgeCouponDoc : null
}

/** This organizer's redemptions of a coupon (the counter). A failed read is NEVER read as 0. */
export async function getBadgeCouponOrganizerCount(code: string, organizerUid: string): Promise<{ ok: true; count: number } | { ok: false }> {
  try {
    const snap = await badgeCouponOrganizerCounterRef(code, organizerUid).get()
    const n = snap.exists ? (snap.data() as { count?: unknown }).count : 0
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? { ok: true, count: n } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** licensing.printBadgeBilling.allowFreeCoupons — absent ⇒ false. */
export async function getAllowFreeBadgeCoupons(): Promise<boolean> {
  const licensing = await businessConfig.getSection('licensing')
  return licensing.printBadgeBilling?.allowFreeCoupons === true
}
