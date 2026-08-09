// Payment presentation rules for a registration. PURE — no Firebase, no React.
//
// Extracted because the same two decisions were about to exist in two places: the export
// (refund wording) and the registrations drawer (whether to render a payment block at
// all, and the same refund wording). A reconciliation UI and a reconciliation export
// disagreeing about whether something is "Refunded" is exactly the class of bug this
// sprint set out to remove.

/** Registration fields these rules read. Kept structural so both the raw Firestore record
 *  and the serialized API shape satisfy it without casting gymnastics. */
export interface PaymentDisplayInput {
  amount?:        number | null
  paymentStatus?: string | null
  paymentId?:     string | null
  refundId?:      string | null
}

/**
 * Is there an actual payment to show?
 *
 * True when money changed hands OR a gateway payment id exists. The second clause matters:
 * a 100%-discount coupon can produce a ₹0 registration that still went through Razorpay
 * and still has a payment id worth displaying for reconciliation.
 *
 * False ⇒ the surface should say "No payment required" rather than render a payment block
 * full of blanks, which would imply a ₹0 transaction that never happened.
 */
export function hasPaymentRecord(reg: PaymentDisplayInput): boolean {
  return (typeof reg.amount === 'number' && reg.amount > 0) || Boolean(reg.paymentId)
}

/**
 * The refund state as a human label, or null when nothing was refunded.
 *
 * `refundId` is checked last and independently: a refund can be issued at the gateway
 * before the local paymentStatus catches up, and an export that showed nothing in that
 * window would hide real money movement.
 */
export function refundLabel(reg: PaymentDisplayInput): string | null {
  if (reg.paymentStatus === 'refunded')       return 'Refunded'
  if (reg.paymentStatus === 'refund_pending') return 'Refund pending'
  if (reg.refundId)                           return 'Refund issued'
  return null
}
