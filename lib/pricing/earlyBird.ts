import { nowLocalInTz, windowKey } from '@/lib/registrations/salesWindow'
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
export function isEarlyBirdActive(pass: EarlyBirdPricingFields, nowMs: number, tz?: string): boolean {
  if (pass.earlyBirdEnabled !== true) return false

  const eb = pass.earlyBirdPrice
  if (typeof eb !== 'number' || !Number.isFinite(eb) || eb <= 0) return false

  // Never charge more than the regular price via "early bird".
  if (eb > pass.price) return false

  const end = pass.earlyBirdEndDate?.trim()
  // RD-CE-FIX (early-bird timezone) — the cutoff is the organizer's naive datetime-local value, i.e. a
  // time in the EVENT's timezone. Parsed bare it was read in the server's zone (UTC), so an IST early
  // bird ran 5h30m late. With the event timezone it is compared as a local date-time there (a
  // date-only cutoff ends at the START of that day, exactly as before). Without one: unchanged.
  if (end && tz && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(end)) {
    return nowLocalInTz(tz, new Date(nowMs)) < windowKey(end, 'start')
  }
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
export function resolveEffectivePriceRupees(pass: EarlyBirdPricingFields, nowMs: number, tz?: string): number {
  return isEarlyBirdActive(pass, nowMs, tz) ? (pass.earlyBirdPrice as number) : pass.price
}

/**
 * Effective price in integer PAISE for a raw stored pass record (the Firestore
 * shape, unknown-typed) at `nowMs`. This is the ONE place the charge / coupon-preview
 * boundaries turn a stored pass into the integer-paise base amount — early-bird while
 * active, otherwise regular. Every server surface that needs the base amount (create-
 * order, submit, validate-coupon) MUST call this instead of re-reading pass.price /
 * earlyBird* fields inline, so the coupon preview and the charge can never diverge.
 *
 * Backward-compatible: a pass without early bird resolves to `Math.round(price*100)`,
 * exactly the value these routes computed before.
 */
export function resolveEffectivePassPricePaise(pass: Record<string, unknown>, nowMs: number, tz?: string): number {
  const rupees = resolveEffectivePriceRupees(
    {
      price:            typeof pass.price          === 'number' ? pass.price          : 0,
      earlyBirdEnabled: pass.earlyBirdEnabled === true,
      earlyBirdPrice:   typeof pass.earlyBirdPrice === 'number' ? pass.earlyBirdPrice : null,
      earlyBirdEndDate: typeof pass.earlyBirdEndDate === 'string' ? pass.earlyBirdEndDate : undefined,
    },
    nowMs,
    tz,
  )
  return Math.round(rupees * 100)
}

/** RD-CE-FIX — the event's IANA timezone from a published event document (undefined when absent). */
export function eventTimezone(event: { eventDetails?: unknown } | null | undefined): string | undefined {
  const tz = ((event?.eventDetails as { schedule?: { timezone?: unknown } } | null | undefined)?.schedule)?.timezone
  return typeof tz === 'string' && tz.trim() ? tz.trim() : undefined
}
