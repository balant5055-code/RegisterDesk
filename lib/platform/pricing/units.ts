// RD-PRICING-01C-PREP — Money-unit reconciliation. PURE, client-safe.
//
// THE single conversion boundary between the engine and the rest of the money stack.
//
//   Pricing Engine  — stores WHOLE RUPEES (₹): TierPricing.regularPrice/offerPrice,
//                     PricingSettings.platformFeeAmount, GatewaySettings.convenienceFee.
//   Fees Engine     — PAISE + basis points (lib/fees, lib/billing/feeEngine).
//   Payments        — PAISE (Razorpay orders/captures).
//
// RULE: rupees and paise must NEVER be mixed. Any value crossing FROM the engine INTO
// the fees/payment layer converts here, exactly once; any paise value surfaced back
// through the engine converts here. There is no other legitimate ₹↔paise site.
//
// Nothing consumes this yet (pricingEngineEnabled is false). It is the contract the
// consumer migration (RD-PRICING-01C) is required to route every engine→paise hop
// through, so the boundary stays single and auditable.

/** Paise per rupee. The one place this constant is defined for the engine. */
export const PAISE_PER_RUPEE = 100

/**
 * Engine rupees → paise (for the fees engine / Razorpay).
 * Rounds to the nearest paise so fractional-rupee config can never emit a
 * non-integer paise amount into the payment layer.
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE)
}

/**
 * Paise → engine rupees (for surfacing a stored paise value through the engine).
 * The inverse of `rupeesToPaise`; may be fractional.
 */
export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE
}
