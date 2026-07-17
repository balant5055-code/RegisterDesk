// License Coupon domain — Firestore access (EA-4 S2). Server-only (Admin SDK).
//
// Per-organizer usage is derived from paid licenseOrders (the single financial
// source of truth) — there is NO separate redemption collection. The global
// `currentUses` counter lives on the coupon doc and is incremented atomically
// inside the checkout-confirm transaction.

import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import type { LicenseCouponsConfig } from '@/lib/config/businessConfig'
import type { LicenseCouponDoc } from './types'

export const LICENSE_COUPONS_COLLECTION = 'licenseCoupons'

/** Effective license-coupon policy (Business Configuration; default OFF). */
export async function getLicenseCouponsConfig(): Promise<LicenseCouponsConfig> {
  return (await businessConfig.getSection('licensing')).coupons
}

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase()
}

export function licenseCouponRef(code: string) {
  return adminDb.collection(LICENSE_COUPONS_COLLECTION).doc(normalizeCouponCode(code))
}

export async function getLicenseCoupon(code: string): Promise<LicenseCouponDoc | null> {
  const c = normalizeCouponCode(code)
  if (!c) return null
  const snap = await licenseCouponRef(c).get()
  return snap.exists ? (snap.data() as LicenseCouponDoc) : null
}

/** This organizer's prior PAID redemptions of a coupon — counted from licenseOrders. */
export async function countOrganizerCouponRedemptions(code: string, organizerUid: string): Promise<number> {
  try {
    const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION)
      .where('organizerUid', '==', organizerUid)
      .where('couponCode', '==', normalizeCouponCode(code))
      .where('status', '==', 'paid')
      .count().get()
    return snap.data().count
  } catch {
    return 0   // missing-index / transient → treat as no prior redemptions (global cap still guards)
  }
}
