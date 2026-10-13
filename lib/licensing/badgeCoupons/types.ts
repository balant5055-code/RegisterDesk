// RD-PRINT-BILL-P3 · Badge-purchase coupons — types. Client-safe: NO Firebase/SDK import.
//
// A DEDICATED domain for discounts on PREPAID ID-BADGE UNIT purchases. Entirely separate from
// licence coupons (licenseCoupons/*), registration coupons (events/{slug}/coupons), ticket pricing
// and every other discount: its own collection (badgeCoupons/{CODE}), its own validator, its own
// redemption records. A licence coupon is never read here and a badge coupon is never read by
// licence checkout. The two collections share ONE code namespace — a code exists in at most one of
// them — enforced inside each side's create transaction (see lib/licensing/badgeCoupons/store.ts).
//
// Approved (2026-10-10): coupons discount the unit PURCHASE, never generation; one coupon per
// purchase (no stacking); a coupon that makes a purchase free needs the global switch
// licensing.printBadgeBilling.allowFreeCoupons; a refunded purchase releases the ORGANIZER's
// redemption count but never the global count (Phase 4 — purchase flows).

export const BADGE_COUPON_SCOPE = 'print_badges' as const
/** The collection (dependency-free here so licence-coupon code can read the shared namespace). */
export const BADGE_COUPONS_COLLECTION = 'badgeCoupons'

export type BadgeCouponType = 'percentage' | 'fixed' | 'free'

/** Never deleted — archived instead. DERIVED from the flags + dates (one source of truth). */
export type BadgeCouponLifecycle = 'draft' | 'scheduled' | 'active' | 'paused' | 'expired' | 'archived'
  // RD-PRINT-BILL-P3.2 — a stored date or restriction is corrupt: never applied until corrected.
  | 'invalid'

export interface BadgeCouponRestrictions {
  /** Event ids (= event slugs) the coupon applies to. Empty ⇒ every event. */
  eventIds:      string[]
  /** Organizer (workspace) uids the coupon applies to. Empty ⇒ every organizer. */
  organizerUids: string[]
}

/**
 * badgeCoupons/{CODE}   (doc id = normalized UPPERCASE code)
 *   └ organizerRedemptions/{organizerUid}  { count }        ← the per-organizer counter (atomic)
 *   └ redemptions/{orderId}                { … snapshot }   ← one immutable record per redeemed order
 *
 * `currentUses` is the GLOBAL redemption count — incremented only by a successful redemption inside
 * the (future) purchase-activation transaction; never by create, preview or validation, and never
 * decremented (a refund releases only the organizer's count).
 */
export interface BadgeCouponDoc {
  code:              string
  scope:             typeof BADGE_COUPON_SCOPE
  description:       string
  type:              BadgeCouponType
  /** percentage: 1–100 (whole percent) · fixed: paise ≥ 1 · free: 0 */
  value:             number
  /** Cap on a percentage discount, paise. null ⇒ uncapped. Only for percentage coupons. */
  maxDiscountPaise:  number | null
  /** Minimum GST-inclusive purchase amount, paise. null ⇒ none. */
  minPurchasePaise:  number | null
  activatesAt:       string | null      // ISO 8601; null ⇒ immediately
  expiresAt:         string | null      // ISO 8601; null ⇒ never
  usageLimit:        number | null      // global cap; null ⇒ unlimited
  perOrganizerLimit: number | null      // per-organizer cap; null ⇒ unlimited
  currentUses:       number
  restrictions:      BadgeCouponRestrictions
  enabled:           boolean
  paused:            boolean
  archived:          boolean
  campaign:          string
  internalNotes:     string
  version:           number             // bumped on every edit; captured in each redemption snapshot
  createdBy:         string
  createdAt:         unknown
  updatedAt:         unknown
}

/** Immutable snapshot stored on every redemption (history survives later edits/archival). */
export interface BadgeCouponSnapshot {
  code:             string
  scope:            typeof BADGE_COUPON_SCOPE
  type:             BadgeCouponType
  value:            number
  maxDiscountPaise: number | null
  version:          number
}

export type BadgeCouponFailure =
  | 'not_found' | 'wrong_scope' | 'not_active' | 'expired' | 'not_started'
  | 'event_coupons_disabled' | 'event_not_allowed' | 'organizer_not_allowed'
  | 'usage_limit_reached' | 'per_organizer_limit_reached'
  | 'below_minimum' | 'free_not_allowed' | 'no_discount' | 'invalid_purchase'
  // RD-PRINT-BILL-P3.2
  | 'invalid_configuration'   // the stored coupon is corrupt (dates / restrictions) — fails closed
  | 'usage_unverified'        // the organizer's redemption counter could not be read safely — fails closed

export type BadgeCouponValidation =
  | { ok: true; discountPaise: number; finalPricePaise: number; free: boolean; snapshot: BadgeCouponSnapshot }
  | { ok: false; failure: BadgeCouponFailure; message: string }

/** Everything the pure validator needs — resolved by the caller, NEVER taken from a client. */
export interface BadgeCouponContext {
  organizerUid:         string
  eventId:              string
  /** The GST-inclusive purchase amount (quantity × effective unit price), whole paise. */
  purchasePaise:        number
  /** This organizer's prior redemptions of this code (the counter, read server-side). */
  organizerRedemptions: number
  /** The event's effective `couponsAllowed` (events/{slug}.printBadgeCommercial ⟶ default true). */
  eventCouponsAllowed:  boolean
  /** licensing.printBadgeBilling.allowFreeCoupons */
  allowFreeCoupons:     boolean
}

/** A Super Admin's create / edit request (server-validated field by field). */
export interface BadgeCouponInput {
  code?:              string
  description?:       string
  type?:              BadgeCouponType
  value?:             number
  maxDiscountPaise?:  number | null
  minPurchasePaise?:  number | null
  activatesAt?:       string | null
  expiresAt?:         string | null
  usageLimit?:        number | null
  perOrganizerLimit?: number | null
  eventIds?:          string[]
  organizerUids?:     string[]
  enabled?:           boolean
  campaign?:          string
  internalNotes?:     string
}

export interface BadgeCouponRow extends BadgeCouponDoc { lifecycle: BadgeCouponLifecycle; freeShape: boolean }
