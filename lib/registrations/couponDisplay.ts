// How a registration's price came to be. PURE — no Firebase, no React.
//
// ═══ THE DEFECT THIS EXISTS TO FIX ═══════════════════════════════════════════
// The drawer rendered its whole payment block behind `hasPaymentRecord(reg)`, which is
// `amount > 0 || paymentId`. A coupon that takes a registration to ₹0 produces neither: the
// amount is zero and the registration never reaches Razorpay, so it has no payment id. Every
// coupon row — code, original amount, discount — therefore collapsed into the single string
// "No payment required", in precisely the case where the organizer most needs to see them.
//
// `hasPaymentRecord` is NOT wrong and is deliberately left alone: it answers "is there a
// gateway transaction to reconcile?", which the CSV export also depends on. This module
// answers a different question — "how was this price arrived at?" — and the drawer now asks
// both.
//
// ═══ HISTORICAL VALUES ONLY ══════════════════════════════════════════════════
// Everything here is derived from fields the registration stored AT REGISTRATION TIME
// (`originalAmount`, `discountAmount`, `couponCode`, `amount`). The coupon document is never
// read. A coupon edited or deleted after the fact therefore cannot change what an old
// registration displays — reconstructing yesterday's transaction from today's configuration
// is the one thing this must never do.
//
// Note what is NOT available: the registration does not persist the coupon's `type`
// (percentage/fixed) or `description`, only the resulting money. So the discount is reported
// as an amount ("₹250 off"), never as "10% off", which could only be recovered from the live
// coupon document.

/** The registration fields these rules read. Structural, so both the raw Firestore document
 *  and the serialized API row satisfy it without casting. */
export interface PricingInput {
  amount?:         number | null
  originalAmount?: number | null
  discountAmount?: number | null
  couponCode?:     string | null
  paymentStatus?:  string | null
}

/**
 * Which of the four cases this registration is.
 *
 *   paid           — money was due and no coupon reduced it
 *   discounted     — a coupon reduced the price, money was still due
 *   free_by_coupon — a coupon took the price to zero
 *   free_event     — nothing was ever charged; no coupon involved
 *
 * `free_by_coupon` and `free_event` both end at ₹0 and were previously indistinguishable on
 * screen. They are operationally different facts and are now separate values.
 */
export type PricingKind = 'paid' | 'discounted' | 'free_by_coupon' | 'free_event'

export interface PricingSummary {
  kind:          PricingKind
  /** Price before any discount, in paise. Falls back to the final amount when the
   *  registration predates `originalAmount` or no discount applied. */
  originalPaise: number
  discountPaise: number
  finalPaise:    number
  couponCode:    string | null
  /** True when a coupon demonstrably participated in this registration's price. */
  hasCoupon:     boolean
  /** Short human summary for a badge or a table cell. */
  label:         string
}

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

/** Paise → "₹1,500" (or "₹1,500.50" when the amount is not a whole rupee). */
export function formatPaise(paise: number): string {
  const rupees = paise / 100
  const fractional = paise % 100 !== 0
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}

export function summarizePricing(reg: PricingInput): PricingSummary {
  const finalPaise    = num(reg.amount)
  const discountPaise = Math.max(0, num(reg.discountAmount))
  const code          = typeof reg.couponCode === 'string' && reg.couponCode.trim()
    ? reg.couponCode.trim()
    : null

  // A coupon counts as applied when it left EITHER a code or a discount behind. Requiring
  // both would hide a legacy row that recorded only one of them.
  const hasCoupon = Boolean(code) || discountPaise > 0

  // `originalAmount` is only written when a discount applied, so its absence is normal, not
  // missing data. Reconstructing it as final + discount keeps older rows consistent.
  const storedOriginal = num(reg.originalAmount)
  const originalPaise  = storedOriginal > 0
    ? storedOriginal
    : finalPaise + discountPaise

  let kind: PricingKind
  if (finalPaise > 0)      kind = hasCoupon ? 'discounted' : 'paid'
  else if (hasCoupon)      kind = 'free_by_coupon'
  else                     kind = 'free_event'

  const label =
    kind === 'free_by_coupon' ? 'Free after coupon'
    : kind === 'free_event'   ? 'Free registration'
    : kind === 'discounted'   ? `${formatPaise(discountPaise)} off`
    : 'No discount'

  return { kind, originalPaise, discountPaise, finalPaise, couponCode: code, hasCoupon, label }
}

/**
 * The compact cell for the registrations table.
 *
 * Deliberately terse — the table is already dense on mobile and this column exists to let an
 * organizer SCAN for coupon use, not to reconcile a single row (that is the drawer's job).
 * Returns null when there is nothing worth a badge, so the column stays quiet for the
 * ordinary paid registration rather than repeating "No discount" down the page.
 */
export function couponCellText(reg: PricingInput): { code: string | null; note: string } | null {
  const s = summarizePricing(reg)
  if (s.kind === 'paid') return null
  if (s.kind === 'free_event') return { code: null, note: 'Free' }
  return { code: s.couponCode, note: s.kind === 'free_by_coupon' ? 'Free' : `${formatPaise(s.discountPaise)} off` }
}
