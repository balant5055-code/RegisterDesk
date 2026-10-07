// RD-EVENT-14 · ONE definition of what a valid coupon is.
//
// PURE — no Firestore, no clock. Imported by BOTH organizer write routes and by the
// Coupons workspace, so the form cannot accept something the API would refuse and the
// API cannot accept something the form would never produce.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// POST validated `value` (percentage 1–100, fixed > 0). PATCH did not:
//
//     if (body.value !== undefined) updates.value = body.value
//
// so the same authenticated organizer could PATCH a percentage coupon to 500, or to a
// NEGATIVE number. `computeDiscount` has no clamp, and `finalPaise = max(0, original -
// discount)` protects the floor only — a negative discount makes the final price HIGHER
// than the ticket. That is an overcharge reachable through a normal session.
//
// PATCH also let `type` change without re-checking `value` against the new type, so a
// `20`% coupon silently became a ₹0.20 fixed discount.
//
// The fix is not another guard in PATCH. Both routes now merge their body over the
// stored document and validate the WHOLE coupon, so every field is checked against the
// values it will actually be stored beside.

import type { CouponType } from './types'

/** Uppercase, digits, hyphen, underscore. 2–30. Mirrors what POST always enforced. */
export const COUPON_CODE_RE = /^[A-Z0-9_-]{2,30}$/

/** The validator compares dates as strings, so the format is load-bearing, not cosmetic. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const MAX_DESCRIPTION = 140

/** The shape a coupon document holds, before Firestore-specific encoding. */
export interface CouponInput {
  code:              string
  description:       string
  type:              CouponType
  /** percentage: 1–100 · fixed: paise > 0 · free: always 100, never read. */
  value:             number
  active:            boolean
  validFrom:         string | null
  validUntil:        string | null
  maxUses:           number | null
  applicablePassIds: string[]
}

export type CouponInputResult =
  | { ok: true;  value: CouponInput }
  | { ok: false; error: string; field: keyof CouponInput }

export function normalizeCouponCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : ''
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v)
}

/**
 * The value rule for one type. Exported because the form shows it as help text, and a rule
 * worded differently in two places is a rule that will drift.
 */
export function couponValueRule(type: CouponType): string {
  if (type === 'percentage') return 'A whole percentage between 1 and 100.'
  if (type === 'fixed')      return 'An amount greater than ₹0.'
  return 'Free coupons always take the full ticket price.'
}

/**
 * Validates a COMPLETE coupon. Callers merge a PATCH body over the stored document first,
 * so a partial edit is still checked as a whole.
 *
 * `passIds` is the event's real pass list. Passing it rejects a coupon restricted to a pass
 * that does not exist — a coupon nobody can ever redeem, which used to be creatable and then
 * looked identical to a working one. Omit it to skip that check (callers without the list).
 */
export function validateCouponInput(
  raw: Partial<CouponInput>,
  passIds?: string[],
): CouponInputResult {
  const bad = (error: string, field: keyof CouponInput): CouponInputResult =>
    ({ ok: false, error, field })

  const code = normalizeCouponCode(raw.code)
  if (!code) return bad('Enter a coupon code.', 'code')
  if (!COUPON_CODE_RE.test(code)) {
    return bad('Codes use 2–30 letters, digits, hyphens or underscores.', 'code')
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!description) return bad('Add a short description so your team knows what this is for.', 'description')
  if (description.length > MAX_DESCRIPTION) {
    return bad(`Keep the description under ${MAX_DESCRIPTION} characters.`, 'description')
  }

  const type = raw.type as CouponType
  if (type !== 'percentage' && type !== 'fixed' && type !== 'free') {
    return bad('Choose a discount type.', 'type')
  }

  // `free` carries no organizer-chosen amount. It is stored as 100 for historical
  // compatibility and computeDiscount never reads it, so it is normalised here rather
  // than validated — an inherited 500 on a coupon switched to `free` cannot survive.
  let value = 100
  if (type !== 'free') {
    const n = typeof raw.value === 'number' ? raw.value : NaN
    if (!Number.isFinite(n)) return bad('Enter a discount amount.', 'value')
    if (type === 'percentage') {
      // Not required to be whole. A 12.5% discount is legitimate, POST always allowed it,
      // and `computeDiscount` floors the paise — so rejecting one here would lock an
      // organizer out of editing a coupon that has been working for months.
      if (n < 1 || n > 100) {
        return bad('Percentage discounts must be between 1 and 100.', 'value')
      }
    } else {
      // Paise. Fractional paise are not money.
      if (!Number.isInteger(n) || n <= 0) return bad('The discount amount must be more than ₹0.', 'value')
    }
    value = n
  }

  const validFrom  = raw.validFrom  == null || raw.validFrom  === '' ? null : raw.validFrom
  const validUntil = raw.validUntil == null || raw.validUntil === '' ? null : raw.validUntil
  if (validFrom  !== null && !isIsoDate(validFrom))  return bad('Start date must be a calendar date.', 'validFrom')
  if (validUntil !== null && !isIsoDate(validUntil)) return bad('End date must be a calendar date.', 'validUntil')
  // ISO dates compare lexically, which is how the validator compares them too.
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) {
    return bad('The end date is before the start date.', 'validUntil')
  }

  let maxUses: number | null = null
  if (raw.maxUses != null) {
    const n = raw.maxUses
    if (!Number.isInteger(n) || n <= 0) return bad('A usage limit must be a whole number above zero.', 'maxUses')
    maxUses = n
  }

  const ids = Array.isArray(raw.applicablePassIds) ? raw.applicablePassIds.filter(x => typeof x === 'string') : []
  const applicablePassIds = [...new Set(ids)]
  if (passIds && applicablePassIds.length > 0) {
    const unknown = applicablePassIds.find(id => !passIds.includes(id))
    if (unknown) return bad('This coupon is restricted to a pass that no longer exists.', 'applicablePassIds')
  }

  return {
    ok: true,
    value: {
      code, description, type, value,
      active: raw.active !== false,
      validFrom, validUntil, maxUses, applicablePassIds,
    },
  }
}
