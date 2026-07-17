// Coupon / promo-code types.
// Safe to import from both client and server — no SDK dependencies.

export type CouponType = 'percentage' | 'fixed' | 'free'

/**
 * events/{slug}/coupons/{couponId}
 *
 * Coupons belong to a specific event.  currentUses is incremented atomically
 * inside the Firestore registration transaction to prevent double-spend.
 */
export interface CouponDocument {
  id:                string
  code:              string      // normalized UPPERCASE
  description:       string
  type:              CouponType
  /** percentage: 0–100 | fixed: discount in paise | free: unused (always 100%) */
  value:             number
  active:            boolean
  validFrom?:        string      // ISO date 'YYYY-MM-DD' — inclusive
  validUntil?:       string      // ISO date 'YYYY-MM-DD' — inclusive
  maxUses?:          number      // undefined/null = unlimited
  currentUses:       number
  /** Empty array means the coupon applies to all passes for this event. */
  applicablePassIds: string[]
  createdAt:         unknown     // Firestore Timestamp
  updatedAt:         unknown     // Firestore Timestamp
}

export interface CouponValidationResult {
  valid:          boolean
  couponDocId?:   string          // Firestore doc ID — needed for atomic increment
  coupon?:        CouponDocument
  discountPaise?: number
  finalPaise?:    number
  error?:         string
}
