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

/**
 * RD-M5 — the query that DEFINES a per-organizer redemption: this organizer's licence orders
 * that used this coupon and are currently `paid` — or `refunding`: a use is released only when its
 * refund is CONFIRMED (`refunded`), never while the gateway call is pending (RD-M5 refund race).
 * Shared by the pre-check below and the in-transaction counter seeding in activateLicenseOrder,
 * so the two can never disagree. `in` on the last equality field uses the existing
 * (organizerUid, couponCode, status) composite index.
 */
export const ORGANIZER_REDEMPTION_STATUSES = ['paid', 'refunding'] as const
export function organizerPaidRedemptionsQuery(code: string, organizerUid: string) {
  return adminDb.collection(LICENSE_ORDERS_COLLECTION)
    .where('organizerUid', '==', organizerUid)
    .where('couponCode', '==', normalizeCouponCode(code))
    .where('status', 'in', [...ORGANIZER_REDEMPTION_STATUSES])
}

/** RD-M5 — typed so a failed lookup can never be read as "0 prior uses". */
export type OrganizerRedemptionCount = { ok: true; count: number } | { ok: false }

/** This organizer's prior PAID redemptions of a coupon — counted from licenseOrders. */
export async function countOrganizerCouponRedemptions(code: string, organizerUid: string): Promise<OrganizerRedemptionCount> {
  try {
    const snap = await organizerPaidRedemptionsQuery(code, organizerUid).count().get()
    const count = snap.data().count
    // A result that is not a whole, non-negative number cannot establish usage either.
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return { ok: false }
    return { ok: true, count }
  } catch {
    // RD-M5 D2 — FAIL CLOSED. This used to return 0 ("no prior redemptions"), which silently
    // disabled perOrganizerLimit whenever the read failed. Callers now refuse and ask to retry.
    return { ok: false }
  }
}

/** RD-M5 — the retryable refusal both coupon routes return when usage cannot be verified. */
export const COUPON_USAGE_UNVERIFIED_MESSAGE = 'We couldn’t verify this coupon’s usage. Please try again.'

/**
 * RD-M5 D1 — the per-(coupon, organizer) redemption counter, read and written inside the
 * activation transaction (the contention point that makes perOrganizerLimit atomic):
 *   licenseCoupons/{CODE}/organizerRedemptions/{organizerUid}  →  { count, updatedAt }
 * Created only for coupons WITH a perOrganizerLimit (seeded from paid orders on first use);
 * once it exists it is kept current on every redemption and released on refund.
 */
export const ORGANIZER_REDEMPTIONS_SUBCOLLECTION = 'organizerRedemptions'
export function organizerRedemptionCounterRef(code: string, organizerUid: string) {
  return licenseCouponRef(code).collection(ORGANIZER_REDEMPTIONS_SUBCOLLECTION).doc(organizerUid)
}
