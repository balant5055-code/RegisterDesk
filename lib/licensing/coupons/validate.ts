// License Coupon domain — pure lifecycle + validation + discount math (EA-4 S2).
// PURE: no Firebase/SDK. All money is integer paise. Designed so a future
// "stacking" evaluator can wrap this per-coupon function without redesign.

import type {
  LicenseCouponDoc, LicenseCouponLifecycle, LicenseCouponContext,
  LicenseCouponValidation, LicenseCouponSnapshot, LicenseCouponFailure,
} from './types'

/** Single source of truth for a coupon's lifecycle — derived from flags + dates. */
export function deriveCouponLifecycle(c: LicenseCouponDoc, nowMs: number): LicenseCouponLifecycle {
  if (c.archived) return 'archived'
  if (c.paused)   return 'paused'
  const exp = c.expiresAt ? Date.parse(c.expiresAt) : NaN
  if (!Number.isNaN(exp) && nowMs > exp) return 'expired'
  if (!c.enabled) return 'draft'
  const act = c.activatesAt ? Date.parse(c.activatesAt) : NaN
  if (!Number.isNaN(act) && nowMs < act) return 'scheduled'
  return 'active'
}

function snapshotOf(c: LicenseCouponDoc): LicenseCouponSnapshot {
  return { code: c.code, type: c.type, value: c.value, description: c.description, campaign: c.campaign, version: c.version }
}

const fail = (failure: LicenseCouponFailure, message: string): LicenseCouponValidation =>
  ({ ok: false, failure, message })

/**
 * Validate a single coupon against a purchase context and compute the discount.
 * Only ONE coupon per purchase (no stacking). Returns discount + final price +
 * the immutable snapshot to persist on the order.
 */
export function validateLicenseCoupon(
  coupon: LicenseCouponDoc | null,
  ctx:    LicenseCouponContext,
  nowMs:  number,
): LicenseCouponValidation {
  if (!ctx.couponsEnabled)  return fail('coupons_disabled', 'License coupons are not currently available.')
  if (!coupon)              return fail('not_found', 'This coupon code is not valid.')

  const lifecycle = deriveCouponLifecycle(coupon, nowMs)
  if (lifecycle === 'expired')                                  return fail('expired', 'This coupon has expired.')
  if (lifecycle === 'scheduled')                               return fail('not_started', 'This coupon is not active yet.')
  if (lifecycle !== 'active')                                   return fail('not_active', 'This coupon is not active.')

  // Restrictions.
  const r = coupon.restrictions
  if (r.tiers.length > 0 && !r.tiers.includes(ctx.tier))       return fail('tier_not_allowed', 'This coupon does not apply to the selected license.')
  if (r.eventTypes.length > 0 && (!ctx.eventType || !r.eventTypes.includes(ctx.eventType)))
    return fail('event_type_not_allowed', 'This coupon does not apply to this event type.')

  // Purchase bounds.
  if (coupon.minPurchasePaise != null && ctx.pricePaise < coupon.minPurchasePaise)
    return fail('below_minimum', 'The license price is below this coupon’s minimum.')
  if (coupon.maxPurchasePaise != null && ctx.pricePaise > coupon.maxPurchasePaise)
    return fail('above_maximum', 'The license price is above this coupon’s maximum.')

  // Usage caps (global re-checked atomically at redemption; this is the pre-gate).
  if (coupon.usageLimit != null && coupon.currentUses >= coupon.usageLimit)
    return fail('usage_limit_reached', 'This coupon has reached its usage limit.')
  if (coupon.perOrganizerLimit != null && ctx.organizerRedemptions >= coupon.perOrganizerLimit)
    return fail('per_organizer_limit_reached', 'You have already used this coupon the maximum number of times.')

  // Discount computation (integer paise), clamped by coupon + business-config caps.
  let discount = 0
  if (coupon.type === 'percentage') {
    const pct = Math.max(0, Math.min(coupon.value, ctx.maxPercentageDiscount))
    discount = Math.floor((ctx.pricePaise * pct) / 100)
    if (coupon.maxDiscountPaise != null) discount = Math.min(discount, coupon.maxDiscountPaise)
  } else if (coupon.type === 'fixed') {
    discount = coupon.value
    if (ctx.maxFixedDiscountPaise > 0) discount = Math.min(discount, ctx.maxFixedDiscountPaise)
    discount = Math.min(discount, ctx.pricePaise)
  } else { // free
    if (!ctx.allowFreeLicense) return fail('free_not_allowed', 'Free-license coupons are not currently allowed.')
    discount = ctx.pricePaise
  }

  discount = Math.max(0, Math.min(discount, ctx.pricePaise))
  if (discount <= 0) return fail('no_discount', 'This coupon does not reduce the price.')

  return { ok: true, discountPaise: discount, finalPricePaise: ctx.pricePaise - discount, snapshot: snapshotOf(coupon) }
}
