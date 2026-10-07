// RD-DASH-07 · what would actually happen if someone typed this code right now.
//
// PURE — no Firestore, no clock. Safe to import from client and server.
//
// ═══ WHY THIS EXISTS, AND WHY IT IS NOT A NEW DEFINITION ═════════════════════
// The dashboard reported "16 active coupons" from `active !== false`, which is one of the
// FOUR gates `validateCoupon` applies. On the audited event every coupon carried
// `validUntil: 2026-08-21` and `active: true`, so the card said sixteen were active on a day
// when the validator would have refused all sixteen as expired.
//
// So this does not invent a status vocabulary. It mirrors `lib/coupons/validate.ts` — the
// same gates, in the SAME ORDER, because the order decides the answer: a coupon that is both
// past its window and at its cap is reported "expired", since that is the error the attendee
// would actually be shown. A test pins the two files together; if the validator's order
// changes and this does not, that test fails.
//
// The pass-applicability check in the validator is deliberately NOT mirrored. It depends on
// which pass the attendee picked, so it is a property of an attempt, not of the coupon.

import type { CouponDocument } from './types'

/**
 * A coupon's redeemability, in the validator's own precedence order.
 *
 *   inactive    — switched off by the organizer
 *   scheduled   — its window has not opened yet
 *   expired     — its window has closed
 *   exhausted   — it has reached (or passed) its usage cap
 *   redeemable  — none of the above; the code works today
 */
export type CouponState = 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'redeemable'

export const COUPON_STATE_ORDER: CouponState[] =
  ['redeemable', 'exhausted', 'expired', 'scheduled', 'inactive']

/** Human labels. One place, so a state cannot be worded two ways on two surfaces. */
export const COUPON_STATE_LABEL: Record<CouponState, string> = {
  redeemable: 'Active',
  exhausted:  'Limit reached',
  expired:    'Expired',
  scheduled:  'Scheduled',
  inactive:   'Inactive',
}

/**
 * The date the validator compares against: `new Date().toISOString().slice(0, 10)`.
 *
 * That is a UTC calendar date, and it is used here for one reason only — the validator uses
 * it. A "correct" IST date would make this card disagree with the code an attendee is
 * actually typing, on exactly the coupons that expire tonight. Matching the enforcement is
 * worth more than matching the organizer's calendar, and the difference is one day at the
 * boundary. Taken as a PARAMETER so nothing here reads a clock.
 */
export function couponToday(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Derives the state. `today` is an ISO 'YYYY-MM-DD' string — see couponToday.
 *
 * The comparisons are string comparisons on zero-padded ISO dates, which is what the
 * validator does; for that format lexical order IS chronological order.
 */
export function resolveCouponState(
  c: Pick<CouponDocument, 'active' | 'validFrom' | 'validUntil' | 'maxUses' | 'currentUses'>,
  today: string,
): CouponState {
  if (c.active === false) return 'inactive'
  if (c.validFrom  && today < c.validFrom)  return 'scheduled'
  if (c.validUntil && today > c.validUntil) return 'expired'
  // `>=` not `>`: the validator refuses the redemption that WOULD take it to the cap, so a
  // coupon sitting exactly at its limit is already spent.
  if (typeof c.maxUses === 'number' && c.maxUses > 0 && c.currentUses >= c.maxUses) return 'exhausted'
  return 'redeemable'
}
