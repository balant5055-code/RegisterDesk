// RD-LICENSE-COUPON-FIX · May an existing UNPAID license order still be reused? PURE.
//
// No SDK, no Firestore, no Razorpay — so the rule is unit-tested directly, which is the
// only way the six scenarios in the brief can be asserted without a live gateway.
//
// ═══ WHY THIS RULE EXISTS ════════════════════════════════════════════════════
// `POST /api/licensing/purchase` reuses a persisted `created` order rather than minting a
// second Razorpay order — correct, and the double-charge protection depends on it. But
// reuse is only safe while the persisted order still represents what the organizer is
// asking to buy. An organizer who reached checkout once and THEN applied a coupon hit the
// reuse branch and was handed the OLD full-price remainder: the screen said ₹0 while
// Razorpay was asked for ₹2,499.
//
// `persistedAmountPaise` is the FINAL charged amount on the stored order, so comparing it
// with the freshly-computed price — together with the coupon identity — detects drift in
// BOTH directions: a coupon newly applied, swapped for another, or removed.
//
// This function decides ONLY reuse-vs-supersede for an unpaid `created` order. Whether the
// old order was actually paid is a Razorpay question the caller answers with
// `findCapturedLicensePayment`; a captured payment always wins over this decision.

export type ExistingOrderDecision = 'reuse' | 'supersede'

export interface ExistingOrderComparison {
  /** FINAL charged amount persisted on the existing order (`amountPaise`). */
  persistedAmountPaise: number
  /** Coupon persisted on the existing order; null when it carried none. */
  persistedCouponCode:  string | null
  /** Price the CURRENT request resolves to, after coupon validation. */
  requestedFinalPricePaise: number
  /** Normalised coupon on the current request; null when none was supplied. */
  requestedCouponCode:  string | null
}

/**
 * `reuse` only when the persisted order matches the current request on BOTH price and
 * coupon identity. Anything else is `supersede`.
 *
 * Both conditions are required. Price alone is not enough: two different coupons can
 * resolve to the same amount, and the stored order must name the coupon that will actually
 * be redeemed — `activateLicenseOrder` increments `currentUses` on whatever code the order
 * carries, so a mismatched code would redeem the wrong coupon.
 */
export function decideCreatedOrderReuse(c: ExistingOrderComparison): ExistingOrderDecision {
  const priceMatches  = c.persistedAmountPaise === c.requestedFinalPricePaise
  const couponMatches = (c.persistedCouponCode ?? null) === (c.requestedCouponCode ?? null)
  return priceMatches && couponMatches ? 'reuse' : 'supersede'
}
