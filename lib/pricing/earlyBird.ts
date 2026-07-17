// Single source of truth for early-bird price resolution.
//
// A pass's *effective* price is its early-bird price when ALL hold:
//   1. early bird is enabled,
//   2. the early-bird price is a valid discount (0 < ebPrice <= regular price),
//   3. the cutoff (if set) has not passed.
// Otherwise the effective price is the regular price.
//
// Backward-compatible by construction: any pass with `earlyBirdEnabled` falsy —
// which is every pass created before the builder UI was restored — resolves to
// its regular `price`, so no existing event changes behaviour.
//
// This module is deliberately dependency-free and pure so the same rule can be
// reused everywhere a price is charged or displayed (create-order, submit, the
// public event page, the register/checkout screen). Do NOT re-implement this
// logic elsewhere — import from here.

export interface EarlyBirdPricingFields {
  /** Regular price in rupees. */
  price:             number
  earlyBirdEnabled?: boolean | null
  earlyBirdPrice?:   number | null
  /** datetime-local string ('YYYY-MM-DDTHH:mm'); empty/absent means no expiry. */
  earlyBirdEndDate?: string | null
}

/**
 * Whether the early-bird price is currently in effect for `pass` at `nowMs`.
 *
 * `nowMs` is an epoch-millisecond timestamp (`Date.now()`). The cutoff string is
 * a naive datetime-local value; it is compared via `Date.parse`, matching the
 * tolerance the rest of the app already accepts for sales-window checks.
 */
export function isEarlyBirdActive(pass: EarlyBirdPricingFields, nowMs: number): boolean {
  if (pass.earlyBirdEnabled !== true) return false

  const eb = pass.earlyBirdPrice
  if (typeof eb !== 'number' || !Number.isFinite(eb) || eb <= 0) return false

  // Never charge more than the regular price via "early bird".
  if (eb > pass.price) return false

  const end = pass.earlyBirdEndDate?.trim()
  if (end) {
    const endMs = Date.parse(end)
    // Expired cutoff → fall back to regular price. An unparseable date is treated
    // as "no expiry" so a malformed value never silently disables the discount.
    if (Number.isFinite(endMs) && nowMs >= endMs) return false
  }

  return true
}

/**
 * The price (in rupees) that should actually be charged/displayed for `pass`
 * at `nowMs` — the early-bird price while active, otherwise the regular price.
 */
export function resolveEffectivePriceRupees(pass: EarlyBirdPricingFields, nowMs: number): number {
  return isEarlyBirdActive(pass, nowMs) ? (pass.earlyBirdPrice as number) : pass.price
}
