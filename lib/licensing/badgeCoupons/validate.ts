// RD-PRINT-BILL-P3 · Badge-purchase coupons — PURE lifecycle, validation and discount maths.
// No Firebase/SDK. All money is integer paise. One coupon per purchase — no stacking.

import {
  BADGE_COUPON_SCOPE,
  type BadgeCouponDoc, type BadgeCouponLifecycle, type BadgeCouponContext, type BadgeCouponValidation,
  type BadgeCouponFailure, type BadgeCouponSnapshot, type BadgeCouponInput, type BadgeCouponType,
} from './types'

/** Code normalization — the SAME convention as licence coupons (trim + uppercase). */
export function normalizeBadgeCouponCode(code: string): string {
  return code.trim().toUpperCase()
}
export const BADGE_COUPON_CODE_RE = /^[A-Z0-9_-]{3,40}$/
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MAX_RESTRICTION_IDS = 200

// ─── RD-PRINT-BILL-P3.2 · strict timestamps ─────────────────────────────────────

/**
 * ISO 8601 date-time WITH an explicit time zone: `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by `Z` or
 * `±HH:MM`. Anything else — a date only, a local time without an offset, a locale format, or the
 * many strings `Date.parse` happily accepts ("1", "Nov 1 2026") — is refused, because its meaning
 * would depend on the server's time zone.
 */
const STRICT_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/

/**
 * The instant a strict ISO 8601 timestamp denotes (epoch ms), or null when the string is not one.
 * Calendar ranges are checked explicitly — `Date.parse` silently rolls 2026-02-30 to 2 March and
 * accepts hour 24 — so an impossible date is refused, never reinterpreted. Pure.
 */
export function parseStrictIsoTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = STRICT_ISO_RE.exec(v)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, , z, sign, ohs, oms] = m
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), s = ss === undefined ? 0 : Number(ss)
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null
  if (h > 23 || mi > 59 || s > 59) return null
  if (z !== 'Z') {
    const oh = Number(ohs), om = Number(oms)
    if (oh > 14 || om > 59 || (oh === 14 && om > 0) || (sign !== '+' && sign !== '-')) return null
  }
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : ms
}

/** A strict ISO 8601 timestamp normalized to UTC (`toISOString()`), or null when it is not one. */
export function normalizeIsoTimestamp(v: unknown): string | null {
  const ms = parseStrictIsoTimestamp(v)
  return ms === null ? null : new Date(ms).toISOString()
}

/** A STORED date bound: absent ⇒ no bound; a strict timestamp ⇒ its instant; anything else ⇒ corrupt. */
const storedBound = (v: unknown): number | null | 'corrupt' => {
  if (v === null || v === undefined) return null
  const ms = parseStrictIsoTimestamp(v)
  return ms === null ? 'corrupt' : ms
}

/** Whether STORED restrictions have the exact shape the validator relies on. */
export function isValidStoredRestrictions(r: unknown): boolean {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false
  const x = r as Record<string, unknown>
  return [x.eventIds, x.organizerUids].every(list => Array.isArray(list) && list.length <= MAX_RESTRICTION_IDS
    && list.every(id => typeof id === 'string' && ID_RE.test(id)))
}

/**
 * Single source of truth for a coupon's lifecycle — derived from flags + dates.
 * RD-PRINT-BILL-P3.2 — FAIL CLOSED: a stored date that is present but not a strict ISO timestamp,
 * or restrictions of the wrong shape, make the coupon `invalid` (never active, never thrown) until
 * a Super Admin corrects it. Archived still wins (it is final either way).
 */
export function deriveBadgeCouponLifecycle(
  c: Pick<BadgeCouponDoc, 'archived' | 'paused' | 'expiresAt' | 'enabled' | 'activatesAt' | 'restrictions'>, nowMs: number,
): BadgeCouponLifecycle {
  if (c.archived) return 'archived'
  const exp = storedBound(c.expiresAt), act = storedBound(c.activatesAt)
  if (exp === 'corrupt' || act === 'corrupt' || !isValidStoredRestrictions(c.restrictions)) return 'invalid'
  if (c.paused)   return 'paused'
  if (exp !== null && nowMs >= exp) return 'expired'
  if (!c.enabled) return 'draft'
  if (act !== null && nowMs < act) return 'scheduled'
  return 'active'
}

/**
 * A coupon that can make ANY purchase free by itself: a `free` coupon, or an uncapped 100%
 * percentage coupon. Such a coupon can only be issued while free badge coupons are allowed.
 * (A fixed or capped coupon that happens to cover a small purchase is caught at validation time.)
 */
export function isFreeShape(c: { type: BadgeCouponType; value: number; maxDiscountPaise: number | null }): boolean {
  return c.type === 'free' || (c.type === 'percentage' && c.value >= 100 && c.maxDiscountPaise === null)
}

export function snapshotOfBadgeCoupon(c: BadgeCouponDoc): BadgeCouponSnapshot {
  return { code: c.code, scope: BADGE_COUPON_SCOPE, type: c.type, value: c.value, maxDiscountPaise: c.maxDiscountPaise, version: c.version }
}

const fail = (failure: BadgeCouponFailure, message: string): BadgeCouponValidation => ({ ok: false, failure, message })
const isWholePaise = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/**
 * Validates ONE coupon against a purchase and computes the discount. Never trusts a client value:
 * every field of `ctx` is resolved server-side. Pure; never throws. Validation never consumes usage
 * — only a redemption inside the purchase-activation transaction does (see ./redeem.ts).
 */
export function validateBadgeCoupon(coupon: BadgeCouponDoc | null, ctx: BadgeCouponContext, nowMs: number): BadgeCouponValidation {
  if (!coupon) return fail('not_found', 'This coupon code is not valid.')
  if (coupon.scope !== BADGE_COUPON_SCOPE) return fail('wrong_scope', 'This coupon code is not valid for ID badge purchases.')

  const lifecycle = deriveBadgeCouponLifecycle(coupon, nowMs)
  if (lifecycle === 'invalid')   return fail('invalid_configuration', 'This coupon can’t be used right now.')
  if (lifecycle === 'expired')   return fail('expired', 'This coupon has expired.')
  if (lifecycle === 'scheduled') return fail('not_started', 'This coupon is not active yet.')
  if (lifecycle !== 'active')    return fail('not_active', 'This coupon is not active.')

  if (!isWholePaise(ctx.purchasePaise) || ctx.purchasePaise <= 0) return fail('invalid_purchase', 'There is nothing to discount.')
  if (!ctx.eventCouponsAllowed) return fail('event_coupons_disabled', 'Coupons cannot be used for this event’s badges.')

  // Shape guaranteed by the lifecycle check above (malformed ⇒ 'invalid' ⇒ refused).
  const r = coupon.restrictions
  if (r.eventIds.length > 0 && !r.eventIds.includes(ctx.eventId)) return fail('event_not_allowed', 'This coupon does not apply to this event.')
  if (r.organizerUids.length > 0 && !r.organizerUids.includes(ctx.organizerUid)) return fail('organizer_not_allowed', 'This coupon does not apply to your account.')

  if (coupon.minPurchasePaise != null && ctx.purchasePaise < coupon.minPurchasePaise) {
    return fail('below_minimum', 'This purchase is below the coupon’s minimum amount.')
  }

  // Usage caps — the pre-gate; re-checked atomically at redemption.
  if (coupon.usageLimit != null && coupon.currentUses >= coupon.usageLimit) return fail('usage_limit_reached', 'This coupon has reached its usage limit.')
  if (coupon.perOrganizerLimit != null && ctx.organizerRedemptions >= coupon.perOrganizerLimit) {
    return fail('per_organizer_limit_reached', 'You have already used this coupon the maximum number of times.')
  }

  // Discount (integer paise), on the GST-inclusive purchase amount.
  let discount: number
  if (coupon.type === 'percentage') {
    const pct = Math.max(0, Math.min(coupon.value, 100))
    discount = Math.floor((ctx.purchasePaise * pct) / 100)
    if (coupon.maxDiscountPaise != null) discount = Math.min(discount, coupon.maxDiscountPaise)
  } else if (coupon.type === 'fixed') {
    discount = coupon.value
  } else {
    discount = ctx.purchasePaise
  }
  discount = Math.max(0, Math.min(discount, ctx.purchasePaise))
  if (discount <= 0) return fail('no_discount', 'This coupon does not reduce the price.')
  const finalPricePaise = ctx.purchasePaise - discount
  // A coupon that makes the purchase FREE (any type) is only valid while free coupons are allowed.
  if (finalPricePaise === 0 && !ctx.allowFreeCoupons) return fail('free_not_allowed', 'Free badge coupons are not currently allowed.')

  return { ok: true, discountPaise: discount, finalPricePaise, free: finalPricePaise === 0, snapshot: snapshotOfBadgeCoupon(coupon) }
}

// ─── Admin input validation (create / edit) ─────────────────────────────────────

const INPUT_KEYS: readonly (keyof BadgeCouponInput)[] = [
  'code', 'description', 'type', 'value', 'maxDiscountPaise', 'minPurchasePaise', 'activatesAt', 'expiresAt',
  'usageLimit', 'perOrganizerLimit', 'eventIds', 'organizerUids', 'enabled', 'campaign', 'internalNotes',
]
// RD-PRINT-BILL-P3.2 — null ⇒ no bound (unchanged); otherwise a STRICT ISO 8601 timestamp with a
// time zone. An empty or permissive string is refused — never silently read as null.
const isStrictIsoOrNull = (v: unknown): boolean => v === null || parseStrictIsoTimestamp(v) !== null
const DATE_FORMAT_HINT = 'an ISO 8601 date-time with a time zone, e.g. 2026-11-01T09:00:00+05:30'
const isPosIntOrNull = (v: unknown): boolean => v === null || (isWholePaise(v) && v >= 1)
const isNonNegIntOrNull = (v: unknown): boolean => v === null || (isWholePaise(v) && v >= 0)

/** Unknown keys in a request body — refused, so a payload cannot smuggle fields onto a coupon. */
export function unknownBadgeCouponKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  return Object.keys(raw).filter(k => !(INPUT_KEYS as readonly string[]).includes(k))
}

/**
 * Validates a COMPLETE coupon definition (the merge of the stored coupon and an edit, or a new
 * coupon). Returns plain-language errors; empty ⇒ valid. `allowFreeCoupons` gates free shapes.
 */
export function badgeCouponDefinitionErrors(d: {
  type: unknown; value: unknown; maxDiscountPaise: unknown; minPurchasePaise: unknown
  activatesAt: unknown; expiresAt: unknown; usageLimit: unknown; perOrganizerLimit: unknown
  eventIds: unknown; organizerUids: unknown; enabled: unknown
  description: unknown; campaign: unknown; internalNotes: unknown
}, opts: { allowFreeCoupons: boolean }): string[] {
  const e: string[] = []
  const t = d.type
  if (t !== 'percentage' && t !== 'fixed' && t !== 'free') { e.push('Choose a discount type: percentage, fixed amount or free.'); return e }
  if (t === 'percentage' && !(isWholePaise(d.value) && d.value >= 1 && d.value <= 100)) e.push('A percentage discount must be a whole number from 1 to 100.')
  if (t === 'fixed' && !(isWholePaise(d.value) && d.value >= 1)) e.push('A fixed discount must be at least ₹0.01 (whole paise).')
  if (t === 'free' && d.value !== 0) e.push('A free coupon has no discount value.')
  if (!isPosIntOrNull(d.maxDiscountPaise)) e.push('The maximum discount must be at least ₹0.01, or blank for no cap.')
  if (t !== 'percentage' && d.maxDiscountPaise !== null) e.push('A maximum discount applies only to percentage coupons.')
  if (!isNonNegIntOrNull(d.minPurchasePaise)) e.push('The minimum purchase must be ₹0 or more, or blank for none.')
  if (!isStrictIsoOrNull(d.activatesAt)) e.push(`The start date must be ${DATE_FORMAT_HINT}.`)
  if (!isStrictIsoOrNull(d.expiresAt)) e.push(`The expiry date must be ${DATE_FORMAT_HINT}.`)
  const startMs = parseStrictIsoTimestamp(d.activatesAt), endMs = parseStrictIsoTimestamp(d.expiresAt)
  if (startMs !== null && endMs !== null && endMs <= startMs) e.push('The expiry date must be after the start date.')
  if (!isPosIntOrNull(d.usageLimit)) e.push('The total-use limit must be a whole number of at least 1, or blank for unlimited.')
  if (!isPosIntOrNull(d.perOrganizerLimit)) e.push('The per-organizer limit must be a whole number of at least 1, or blank for unlimited.')
  if (isWholePaise(d.usageLimit) && isWholePaise(d.perOrganizerLimit) && d.perOrganizerLimit > d.usageLimit) {
    e.push('The per-organizer limit cannot exceed the total-use limit.')
  }
  for (const [label, list] of [['event', d.eventIds], ['organizer', d.organizerUids]] as const) {
    if (!Array.isArray(list) || list.length > MAX_RESTRICTION_IDS || !list.every(x => typeof x === 'string' && ID_RE.test(x))) {
      e.push(`The ${label} restriction must be a list of up to ${MAX_RESTRICTION_IDS} valid ${label} ids.`)
    }
  }
  if (typeof d.enabled !== 'boolean') e.push('Enabled must be on or off.')
  if (typeof d.description !== 'string' || d.description.length > 200) e.push('The description must be at most 200 characters.')
  if (typeof d.campaign !== 'string' || d.campaign.length > 60) e.push('The campaign tag must be at most 60 characters.')
  if (typeof d.internalNotes !== 'string' || d.internalNotes.length > 1000) e.push('Internal notes must be at most 1,000 characters.')
  if (e.length === 0 && isFreeShape({ type: t, value: d.value as number, maxDiscountPaise: d.maxDiscountPaise as number | null }) && !opts.allowFreeCoupons) {
    e.push('Free (100%) badge coupons are not allowed. Enable “Allow free (100%) badge coupons” in Business Configuration first.')
  }
  return e
}

/** De-duplicated, order-preserving id list (restrictions). */
export function uniqueIds(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === 'string'))] : []
}
