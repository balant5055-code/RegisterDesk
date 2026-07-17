// License Coupon domain — types (EA-4 S2). Client-safe: NO Firebase/SDK import.
//
// A DEDICATED domain for EVENT-LICENSE purchase discounts. It is entirely separate
// from registration coupons (events/{slug}/coupons), ticket pricing, donation
// campaigns, and marketplace discounts — different collection, different code path.

import type { EventLicenseTier } from '@/lib/licensing/eventLicense'

export type LicenseCouponType = 'percentage' | 'fixed' | 'free'

// Never permanently deleted — archived instead. Lifecycle is DERIVED from the
// flags + dates (see deriveCouponLifecycle), so there is a single source of truth.
export type LicenseCouponLifecycle =
  | 'draft' | 'scheduled' | 'active' | 'paused' | 'expired' | 'archived'

export interface LicenseCouponRestrictions {
  tiers:       EventLicenseTier[]   // empty ⇒ all tiers
  eventTypes:  string[]             // empty ⇒ all event types
  // Reserved for future expansion (validated as absent-ok today).
  countries?:  string[]
  currencies?: string[]
  workspaces?: string[]
}

/**
 * licenseCoupons/{code}  (doc id = normalized UPPERCASE code)
 *
 * `currentUses` is the global redemption counter, incremented atomically inside the
 * checkout-confirm transaction. Per-organizer usage is derived from paid
 * licenseOrders (no separate redemption collection — the order IS the record).
 */
export interface LicenseCouponDoc {
  code:              string
  description:       string
  type:              LicenseCouponType
  value:             number             // percentage: 0–100 | fixed: paise | free: unused
  maxDiscountPaise:  number | null      // cap for percentage; null = uncapped
  minPurchasePaise:  number | null
  maxPurchasePaise:  number | null
  activatesAt:       string | null      // ISO 8601; null = active immediately
  expiresAt:         string | null      // ISO 8601; null = never expires
  usageLimit:        number | null      // global cap; null = unlimited
  perOrganizerLimit: number | null      // per-organizer cap; null = unlimited
  currentUses:       number
  restrictions:      LicenseCouponRestrictions
  enabled:           boolean
  paused:            boolean
  archived:          boolean
  priority:          number             // reserved for future stacking/selection
  stackable:         boolean            // reserved (stacking NOT supported in S2)
  visibility:        'public' | 'private'
  campaign:          string             // grouping tag for analytics; '' = none
  internalNotes:     string
  version:           number             // bumped on edit — captured in the order snapshot
  createdBy:         string
  createdAt:         unknown            // Firestore Timestamp
  updatedAt:         unknown            // Firestore Timestamp
}

/**
 * Immutable snapshot stored INSIDE every licenseOrder that used a coupon, so the
 * order's history is preserved even if the coupon is later edited/archived. Orders
 * are never recalculated from the live coupon.
 */
export interface LicenseCouponSnapshot {
  code:        string
  type:        LicenseCouponType
  value:       number
  description: string
  campaign:    string
  version:     number
}

export type LicenseCouponFailure =
  | 'coupons_disabled' | 'not_found' | 'not_active' | 'expired' | 'not_started'
  | 'tier_not_allowed' | 'event_type_not_allowed' | 'usage_limit_reached'
  | 'per_organizer_limit_reached' | 'below_minimum' | 'above_maximum'
  | 'free_not_allowed' | 'no_discount'

export type LicenseCouponValidation =
  | { ok: true; discountPaise: number; finalPricePaise: number; snapshot: LicenseCouponSnapshot }
  | { ok: false; failure: LicenseCouponFailure; message: string }

/** Context the pure validator needs — resolved by the caller (route). */
export interface LicenseCouponContext {
  tier:                 EventLicenseTier
  eventType:            string | null
  pricePaise:           number            // effective (config-aware) base price
  organizerRedemptions: number            // this organizer's prior paid redemptions of this code
  // Business-config caps (from LicensingConfig.coupons).
  couponsEnabled:       boolean
  maxPercentageDiscount: number           // 0–100
  maxFixedDiscountPaise: number           // paise; 0 = no cap
  allowFreeLicense:     boolean
}
