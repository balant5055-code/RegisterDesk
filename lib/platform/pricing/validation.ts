// RD-PRICING-01B — Platform Pricing Engine · validation. PURE.
//
// Validates a fully-resolved PlatformSettings against the RD-PRICING-01B ranges.
// Used (a) to reject invalid stored Firestore data before the resolver trusts it
// (→ falls back to defaults), and (b) to reject an admin PATCH before it is written.

import {
  PRICING_TIER_IDS,
  type PlatformSettings,
  type RegistrationLimit,
  type ValidationResult,
  type AdminEventOverride,
  type OrganizerEventOverride,
  type PricingSummary,
} from './types'

// ─── Ranges (RD-PRICING-01B) ─────────────────────────────────────────────────────

export const PLATFORM_FEE_AMOUNT_MIN = 0        // fixed ₹ platform fee
export const PLATFORM_FEE_AMOUNT_MAX = 99_999   // fixed ₹ platform fee (NOT a percent)
export const GATEWAY_PERCENT_MIN = 0
export const GATEWAY_PERCENT_MAX = 10
export const GST_MIN = 0
export const GST_MAX = 100
export const REGISTRATION_LIMIT_MIN = 1
export const REGISTRATION_LIMIT_MAX = 1_000_000

// ─── Helpers ─────────────────────────────────────────────────────────────────────

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function inRange(errors: string[], label: string, v: unknown, min: number, max: number): void {
  if (!isFiniteNumber(v)) { errors.push(`${label} must be a number`); return }
  if (v < min || v > max) errors.push(`${label} must be between ${min} and ${max} (got ${v})`)
}

/** Registration limit: an integer in [1, 1_000_000], or null (unlimited). */
function validateRegistrationLimit(errors: string[], label: string, v: RegistrationLimit): void {
  if (v === null) return
  if (!isFiniteNumber(v) || !Number.isInteger(v)) { errors.push(`${label} must be an integer or null (unlimited)`); return }
  if (v < REGISTRATION_LIMIT_MIN || v > REGISTRATION_LIMIT_MAX) {
    errors.push(`${label} must be between ${REGISTRATION_LIMIT_MIN} and ${REGISTRATION_LIMIT_MAX}, or null (got ${v})`)
  }
}

// ─── Validator ───────────────────────────────────────────────────────────────────

/** Validate a fully-resolved settings object. Returns all errors at once. */
export function validatePlatformSettings(s: PlatformSettings): ValidationResult {
  const errors: string[] = []

  // pricing (platform) — platformFeeAmount is a FIXED ₹ amount, not a percent.
  inRange(errors, 'pricing.platformFeeAmount', s.pricing?.platformFeeAmount, PLATFORM_FEE_AMOUNT_MIN, PLATFORM_FEE_AMOUNT_MAX)
  inRange(errors, 'pricing.platformGstPercent', s.pricing?.platformGstPercent, GST_MIN, GST_MAX)

  // gateway
  if (s.gateway?.provider !== 'razorpay') errors.push("gateway.provider must be 'razorpay'")
  inRange(errors, 'gateway.gatewayPercent',    s.gateway?.gatewayPercent,    GATEWAY_PERCENT_MIN, GATEWAY_PERCENT_MAX)
  inRange(errors, 'gateway.gatewayGstPercent', s.gateway?.gatewayGstPercent, GST_MIN, GST_MAX)
  if (!isFiniteNumber(s.gateway?.convenienceFee) || s.gateway.convenienceFee < 0) {
    errors.push('gateway.convenienceFee must be a number ≥ 0')
  }

  // licensing tiers
  const tiers = s.licensing?.tiers
  if (!tiers || typeof tiers !== 'object') {
    errors.push('licensing.tiers is required')
  } else {
    for (const id of PRICING_TIER_IDS) {
      const t = tiers[id]
      if (!t) { errors.push(`licensing.tiers.${id} is required`); continue }
      validateRegistrationLimit(errors, `licensing.tiers.${id}.registrationLimit`, t.registrationLimit)
      const p = t.pricing
      if (!p) { errors.push(`licensing.tiers.${id}.pricing is required`); continue }
      if (!isFiniteNumber(p.regularPrice) || p.regularPrice < 0 || !Number.isInteger(p.regularPrice)) {
        errors.push(`licensing.tiers.${id}.pricing.regularPrice must be an integer ≥ 0`)
      }
      if (!isFiniteNumber(p.offerPrice) || p.offerPrice < 0 || !Number.isInteger(p.offerPrice)) {
        errors.push(`licensing.tiers.${id}.pricing.offerPrice must be an integer ≥ 0`)
      }
      if (isFiniteNumber(p.regularPrice) && isFiniteNumber(p.offerPrice) && p.offerPrice > p.regularPrice) {
        errors.push(`licensing.tiers.${id}.pricing.offerPrice (${p.offerPrice}) cannot exceed regularPrice (${p.regularPrice})`)
      }
    }
  }

  // commercial model (RD-PRICING-02A)
  const c = s.commercial
  if (!c || typeof c !== 'object') {
    errors.push('commercial is required')
  } else {
    if (c.platformFeePaidBy !== 'organizer' && c.platformFeePaidBy !== 'attendee') errors.push("commercial.platformFeePaidBy must be 'organizer' or 'attendee'")
    if (c.gatewayFeePaidBy  !== 'organizer' && c.gatewayFeePaidBy  !== 'attendee') errors.push("commercial.gatewayFeePaidBy must be 'organizer' or 'attendee'")
    if (typeof c.convenienceFeeEnabled !== 'boolean') errors.push('commercial.convenienceFeeEnabled must be a boolean')
    if (typeof c.gatewayGstEnabled     !== 'boolean') errors.push('commercial.gatewayGstEnabled must be a boolean')
    if (typeof c.platformGstEnabled    !== 'boolean') errors.push('commercial.platformGstEnabled must be a boolean')
  }

  // features
  if (typeof s.features?.pricingEngineEnabled !== 'boolean') {
    errors.push('features.pricingEngineEnabled must be a boolean')
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}

// ─── RD-PRICING-01D — override validators ──────────────────────────────────────────
//
// Both validate only the fields PRESENT (partial patches). Ranges reuse the platform
// ranges above so an override can never encode a value the global settings couldn't.

/** Validate a per-event ADMIN override. Admin may set any configurable field. */
export function validateAdminEventOverride(o: AdminEventOverride): ValidationResult {
  const errors: string[] = []
  if (o.registrationLimit !== undefined) {
    validateRegistrationLimit(errors, 'registrationLimit', o.registrationLimit)
  }
  if (o.platformFeeAmount !== undefined) {
    inRange(errors, 'platformFeeAmount', o.platformFeeAmount, PLATFORM_FEE_AMOUNT_MIN, PLATFORM_FEE_AMOUNT_MAX)
  }
  if (o.platformGstPercent !== undefined) inRange(errors, 'platformGstPercent', o.platformGstPercent, GST_MIN, GST_MAX)
  if (o.gatewayPercent     !== undefined) inRange(errors, 'gatewayPercent',     o.gatewayPercent,     GATEWAY_PERCENT_MIN, GATEWAY_PERCENT_MAX)
  if (o.gatewayGstPercent  !== undefined) inRange(errors, 'gatewayGstPercent',  o.gatewayGstPercent,  GST_MIN, GST_MAX)
  if (o.convenienceFee !== undefined && (!isFiniteNumber(o.convenienceFee) || o.convenienceFee < 0)) {
    errors.push('convenienceFee must be a number ≥ 0')
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}

/**
 * Validate a per-event ORGANIZER override against the allow-list + rules (Phase 8):
 * registration limit is DOWNWARD only (finite integer, 1 ≤ v ≤ licensedMax) and
 * convenience fee ≥ 0. `licensedMax` is the event's licensed ceiling (Infinity =
 * unlimited license → any finite limit is "downward").
 */
export function validateOrganizerEventOverride(
  o: OrganizerEventOverride,
  licensedMax: number,
): ValidationResult {
  const errors: string[] = []
  if (o.registrationLimit !== undefined) {
    if (!isFiniteNumber(o.registrationLimit) || !Number.isInteger(o.registrationLimit) || o.registrationLimit < 1) {
      errors.push('registrationLimit must be an integer ≥ 1')
    } else if (o.registrationLimit > licensedMax) {
      errors.push(`registrationLimit (${o.registrationLimit}) may not exceed the licensed maximum (${Number.isFinite(licensedMax) ? licensedMax : 'unlimited'})`)
    }
  }
  if (o.convenienceFee !== undefined && (!isFiniteNumber(o.convenienceFee) || o.convenienceFee < 0)) {
    errors.push('convenienceFee must be a number ≥ 0')
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}

// ─── RD-PRICING-01E-PREP — pricing summary invariants (Phase 6) ────────────────────
//
// Re-verifies the money arithmetic of a resolved PricingSummary. Pure — no config
// read. Given the resolver builds the summary to satisfy these, this is a defensive
// guard (rounding, future refactors) and a contract consumers can assert against.

/** Assert `rupees === paise / 100` for a money field (units.ts boundary check). */
function checkMoney(errors: string[], label: string, m: { paise: number; rupees: number }): void {
  if (!Number.isInteger(m.paise)) errors.push(`${label}.paise must be an integer (got ${m.paise})`)
  if (m.rupees !== m.paise / 100) errors.push(`${label}.rupees (${m.rupees}) must equal paise/100 (${m.paise / 100})`)
}

export function validatePricingSummary(s: PricingSummary): ValidationResult {
  const errors: string[] = []

  for (const [label, m] of [
    ['ticketPrice', s.ticketPrice], ['platformFee', s.platformFee], ['platformGst', s.platformGst],
    ['platformFeeTotal', s.platformFeeTotal], ['convenienceFee', s.convenienceFee],
    ['gatewayFee', s.gatewayFee], ['gatewayGst', s.gatewayGst], ['gatewayCost', s.gatewayCost],
    ['attendeePays', s.attendeePays], ['organizerReceives', s.organizerReceives],
    ['platformRevenue', s.platformRevenue],
  ] as const) {
    checkMoney(errors, label, m)
  }

  // Component sums.
  if (s.platformFeeTotal.paise !== s.platformFee.paise + s.platformGst.paise) {
    errors.push('platformFeeTotal must equal platformFee + platformGst')
  }
  if (s.gatewayCost.paise !== s.gatewayFee.paise + s.gatewayGst.paise) {
    errors.push('gatewayCost must equal gatewayFee + gatewayGst')
  }

  // Model-agnostic outcome invariants (hold for organizer_pays, customer_pays, hybrid).
  if (s.attendeePays.paise < s.ticketPrice.paise) {
    errors.push(`attendeePays (${s.attendeePays.paise}) must be ≥ ticketPrice (${s.ticketPrice.paise})`)
  }
  if (s.organizerReceives.paise > s.ticketPrice.paise) {
    errors.push(`organizerReceives (${s.organizerReceives.paise}) must not exceed ticketPrice (${s.ticketPrice.paise})`)
  }
  if (s.organizerReceives.paise > s.attendeePays.paise) {
    errors.push(`organizerReceives (${s.organizerReceives.paise}) must not exceed attendeePays (${s.attendeePays.paise})`)
  }
  if (s.platformRevenue.paise < 0) {
    errors.push(`platformRevenue must not be negative (got ${s.platformRevenue.paise})`)
  }

  // RD-PRODUCT-01E — ticket-tax invariants (only when a tax breakdown is present).
  const t = s.tax
  if (t) {
    for (const [label, v] of [
      ['tax.taxableAmountPaise', t.taxableAmountPaise], ['tax.taxAmountPaise', t.taxAmountPaise],
      ['tax.cgstPaise', t.cgstPaise], ['tax.sgstPaise', t.sgstPaise], ['tax.igstPaise', t.igstPaise],
      ['tax.grossWithTaxPaise', t.grossWithTaxPaise],
    ] as const) {
      if (!Number.isInteger(v) || v < 0) errors.push(`${label} must be a non-negative integer (got ${v})`)
    }
    if (t.cgstPaise + t.sgstPaise + t.igstPaise !== t.taxAmountPaise) {
      errors.push('tax component split (cgst + sgst + igst) must equal taxAmountPaise')
    }
    // Inclusive: gross already contains tax (taxable + tax = gross-with-tax = the ticket gross).
    // Exclusive: tax rides on top (taxable + tax = gross-with-tax).
    if (t.taxableAmountPaise + t.taxAmountPaise !== t.grossWithTaxPaise) {
      errors.push('tax taxableAmount + taxAmount must equal grossWithTaxPaise')
    }
    if (t.exempt && t.taxAmountPaise !== 0) errors.push('exempt tax must have zero taxAmount')
    if (t.interState && (t.cgstPaise !== 0 || t.sgstPaise !== 0)) errors.push('inter-state tax must use IGST only (no CGST/SGST)')
    if (!t.interState && t.igstPaise !== 0) errors.push('intra-state tax must use CGST/SGST only (no IGST)')
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}
