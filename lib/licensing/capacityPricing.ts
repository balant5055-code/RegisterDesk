// RD-CAPACITY-01 · Capacity pricing — the ONE place an activation amount is computed.
// PURE + client-safe: no Firestore, no Razorpay, no config I/O, no clock. Deterministic.
//
// ═══ THE MODEL ═══════════════════════════════════════════════════════════════
// An event's commercial cost is a function of the registration capacity it accepts.
// There are no tiers and no feature packages: every organizer has every feature.
//
//   chargeableCapacity = max(0, capacity − freeRegistrationCapacity)
//   basePaise          = chargeableCapacity × activationRatePaise
//   gstPaise           = round(basePaise × gstRatePercent / 100)
//   totalPaise         = basePaise + gstPaise
//
// ═══ WHY EVERY AMOUNT IS INTEGER PAISE ══════════════════════════════════════
// 1.5 × 337 in rupees is 505.49999999999994. Razorpay is handed paise, the ledger stores
// paise, and a half-paise discrepancy between the quote the organizer saw and the order
// the server created is a failed payment or a reconciliation break. So the rate is DEFINED
// in paise (150, not 1.5) and capacity is an integer, which makes `base` an exact integer
// product — no rounding happens at all on the base. Rounding exists only where a
// percentage is unavoidable (GST, the decrease charge), and it happens through one
// function, `applyPercentPaise`.
//
// ═══ WHY INCREASE AND DECREASE ARE DELTAS OF THE SAME CURVE ═════════════════
// `chargeableFor()` is the single curve. An increase bills
// `chargeableFor(new) − chargeableFor(current)`, so the total ever paid to reach capacity
// C is the same whether the organizer went 100→C in one step or 100→500→C in two. The
// naive `new − current` equals this whenever the current capacity is at or above the free
// allowance (every worked example in the commercial model), and differs only when the
// current capacity sits INSIDE the free allowance — where it would bill the organizer for
// slots that were free. Path-independence is the property that makes the ledger
// explicable, so the curve wins.

import { type CommercialTerms, isCommercialTerms } from './capacityCommercial'

// ─── Rounding policy ───────────────────────────────────────────────────────────

/**
 * THE percentage-of-paise rounding policy for capacity money. Half-up to the nearest
 * paise, matching the platform's existing GST computation in lib/fees/engine.ts
 * (`Math.round(platformFeeBase * config.gstRatePercent / 100)`) so the two money paths
 * never disagree by a paise. Every percentage in this module goes through here.
 */
export function applyPercentPaise(basePaise: number, percent: number): number {
  return Math.round(basePaise * percent / 100)
}

/** The chargeable slots at capacity `c` — the single curve both deltas are taken from. */
export function chargeableFor(capacity: number, terms: CommercialTerms): number {
  return Math.max(0, capacity - terms.freeRegistrationCapacity)
}

// ─── Result shapes ─────────────────────────────────────────────────────────────

/** What a quote is FOR. `unchanged` carries a zero amount and requires no payment. */
export type CapacityQuoteKind = 'activation' | 'increase' | 'decrease' | 'unchanged'

export type CapacityQuoteErrorCode =
  | 'INVALID_TERMS'
  | 'INVALID_CAPACITY'
  | 'CAPACITY_BELOW_MINIMUM'
  | 'CAPACITY_ABOVE_MAXIMUM'
  | 'INVALID_CURRENT_CAPACITY'
  | 'NOT_AN_INCREASE'
  | 'NOT_A_DECREASE'

/**
 * A priced capacity operation. EVERY field an auditor needs is present, because this whole
 * object is what gets snapshotted onto the order — the amounts AND the inputs that
 * produced them, so the arithmetic can be re-derived from the record alone.
 */
export interface CapacityQuote {
  kind:                 CapacityQuoteKind
  /** The capacity the event will have once this operation completes. */
  capacity:             number
  /** The capacity it has now. `null` for a first activation. */
  previousCapacity:     number | null
  /** Slots included at no charge (from the terms; NEVER assumed to be 100). */
  freeCapacity:         number
  /** Price per chargeable slot, in paise. */
  activationRatePaise:  number
  /** Slots actually billed by this operation (removed slots for a decrease). */
  chargeableCapacity:   number
  /** Pre-tax amount, in paise. Exact for activation/increase — no rounding involved. */
  basePaise:            number
  gstRatePercent:       number
  gstPaise:             number
  /** basePaise + gstPaise. The amount to collect. */
  totalPaise:           number
  /** False when totalPaise is 0 — the caller must NOT create a payment order. */
  paymentRequired:      boolean
  /** The exact terms this quote was computed from. Copied onto the order, immutably. */
  terms:                CommercialTerms
  /** Decrease only: the gross value of the capacity removed, before the percentage. */
  removedCapacityValuePaise?: number
  /** Decrease only: the percentage applied to that value. */
  decreaseFeePercent?:  number
}

export type CapacityQuoteResult =
  | { ok: true;  quote: CapacityQuote }
  | { ok: false; code: CapacityQuoteErrorCode; message: string }

const fail = (code: CapacityQuoteErrorCode, message: string): CapacityQuoteResult =>
  ({ ok: false, code, message })

// ─── Capacity input validation ─────────────────────────────────────────────────

/**
 * Accept a capacity ONLY if it is a real, whole, in-range count.
 *
 * Rejects, explicitly: NaN, ±Infinity, negatives, zero, decimals, numeric strings,
 * booleans, null/undefined, and anything above the configured maximum. A capacity is a
 * money input — `Number('437abc')` is NaN and `Number(true)` is 1 — so nothing is coerced
 * here; a non-number is a rejection, not a conversion.
 */
export function validateCapacity(
  value: unknown,
  terms: CommercialTerms,
): { ok: true; capacity: number } | { ok: false; code: CapacityQuoteErrorCode; message: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, code: 'INVALID_CAPACITY', message: 'Registration capacity must be a number.' }
  }
  if (!Number.isInteger(value)) {
    return { ok: false, code: 'INVALID_CAPACITY', message: 'Registration capacity must be a whole number.' }
  }
  if (value < 1) {
    return { ok: false, code: 'CAPACITY_BELOW_MINIMUM', message: 'Registration capacity must be at least 1.' }
  }
  if (value > terms.maximumEventCapacity) {
    return {
      ok: false, code: 'CAPACITY_ABOVE_MAXIMUM',
      message: `Registration capacity cannot exceed ${terms.maximumEventCapacity.toLocaleString('en-IN')}.`,
    }
  }
  return { ok: true, capacity: value }
}

// ─── Quotes ────────────────────────────────────────────────────────────────────

/** Shared tail: turn a chargeable slot count into the taxed amounts. */
function priced(chargeable: number, terms: CommercialTerms): { basePaise: number; gstPaise: number; totalPaise: number } {
  const basePaise = chargeable * terms.activationRatePaise
  const gstPaise  = applyPercentPaise(basePaise, terms.gstRatePercent)
  return { basePaise, gstPaise, totalPaise: basePaise + gstPaise }
}

/**
 * Price the FIRST activation of an event at `capacity`.
 *
 * A capacity at or below the free allowance costs nothing and returns
 * `paymentRequired: false` — the caller must activate directly and create no Razorpay
 * order, because a ₹0 order is not payable.
 */
export function calculateActivationQuote(input: {
  capacity: unknown
  terms:    CommercialTerms
}): CapacityQuoteResult {
  const { terms } = input
  if (!isCommercialTerms(terms)) return fail('INVALID_TERMS', 'Commercial configuration is invalid.')

  const v = validateCapacity(input.capacity, terms)
  if (!v.ok) return fail(v.code, v.message)

  const chargeable = chargeableFor(v.capacity, terms)
  const { basePaise, gstPaise, totalPaise } = priced(chargeable, terms)

  return {
    ok: true,
    quote: {
      kind:                'activation',
      capacity:            v.capacity,
      previousCapacity:    null,
      freeCapacity:        terms.freeRegistrationCapacity,
      activationRatePaise: terms.activationRatePaise,
      chargeableCapacity:  chargeable,
      basePaise,
      gstRatePercent:      terms.gstRatePercent,
      gstPaise,
      totalPaise,
      paymentRequired:     totalPaise > 0,
      terms:               { ...terms },
    },
  }
}

/**
 * Price an INCREASE from `currentCapacity` to `newCapacity`.
 *
 * Bills only the additional chargeable slots (see the module header on path-independence).
 * Refuses anything that is not strictly an increase — an equal or lower capacity is a
 * different operation with different accounting, and silently treating it as an increase
 * would bill ₹0 for a decrease that owes a fee.
 */
export function calculateCapacityIncreaseQuote(input: {
  currentCapacity: unknown
  newCapacity:     unknown
  terms:           CommercialTerms
}): CapacityQuoteResult {
  const { terms } = input
  if (!isCommercialTerms(terms)) return fail('INVALID_TERMS', 'Commercial configuration is invalid.')

  const cur = validateCapacity(input.currentCapacity, terms)
  if (!cur.ok) return fail('INVALID_CURRENT_CAPACITY', `Current capacity is invalid: ${cur.message}`)
  const next = validateCapacity(input.newCapacity, terms)
  if (!next.ok) return fail(next.code, next.message)

  if (next.capacity <= cur.capacity) {
    return fail('NOT_AN_INCREASE', 'The new capacity must be higher than the current capacity.')
  }

  const chargeable = chargeableFor(next.capacity, terms) - chargeableFor(cur.capacity, terms)
  const { basePaise, gstPaise, totalPaise } = priced(chargeable, terms)

  return {
    ok: true,
    quote: {
      kind:                'increase',
      capacity:            next.capacity,
      previousCapacity:    cur.capacity,
      freeCapacity:        terms.freeRegistrationCapacity,
      activationRatePaise: terms.activationRatePaise,
      chargeableCapacity:  chargeable,
      basePaise,
      gstRatePercent:      terms.gstRatePercent,
      gstPaise,
      totalPaise,
      paymentRequired:     totalPaise > 0,
      terms:               { ...terms },
    },
  }
}

/**
 * Price a DECREASE from `currentCapacity` to `newCapacity`.
 *
 * Removing capacity is not a refund. The organizer bought capacity; giving it back costs
 * `capacityDecreaseFeePercent` of the VALUE of the slots removed, plus GST:
 *
 *   removedCapacityValuePaise = removedChargeableSlots × activationRatePaise
 *   basePaise                 = round(removedCapacityValuePaise × decreasePercent / 100)
 *   gstPaise                  = round(basePaise × gstRatePercent / 100)
 *
 * Nothing about the ORIGINAL activation payment is touched: no refund is computed and no
 * historical amount is altered. This function only prices the new charge.
 */
export function calculateCapacityDecreaseQuote(input: {
  currentCapacity: unknown
  newCapacity:     unknown
  terms:           CommercialTerms
}): CapacityQuoteResult {
  const { terms } = input
  if (!isCommercialTerms(terms)) return fail('INVALID_TERMS', 'Commercial configuration is invalid.')

  const cur = validateCapacity(input.currentCapacity, terms)
  if (!cur.ok) return fail('INVALID_CURRENT_CAPACITY', `Current capacity is invalid: ${cur.message}`)
  const next = validateCapacity(input.newCapacity, terms)
  if (!next.ok) return fail(next.code, next.message)

  if (next.capacity >= cur.capacity) {
    return fail('NOT_A_DECREASE', 'The new capacity must be lower than the current capacity.')
  }

  const removedChargeable         = chargeableFor(cur.capacity, terms) - chargeableFor(next.capacity, terms)
  const removedCapacityValuePaise = removedChargeable * terms.activationRatePaise
  const basePaise = applyPercentPaise(removedCapacityValuePaise, terms.capacityDecreaseFeePercent)
  const gstPaise  = applyPercentPaise(basePaise, terms.gstRatePercent)

  return {
    ok: true,
    quote: {
      kind:                'decrease',
      capacity:            next.capacity,
      previousCapacity:    cur.capacity,
      freeCapacity:        terms.freeRegistrationCapacity,
      activationRatePaise: terms.activationRatePaise,
      chargeableCapacity:  removedChargeable,
      basePaise,
      gstRatePercent:      terms.gstRatePercent,
      gstPaise,
      totalPaise:          basePaise + gstPaise,
      paymentRequired:     basePaise + gstPaise > 0,
      terms:               { ...terms },
      removedCapacityValuePaise,
      decreaseFeePercent:  terms.capacityDecreaseFeePercent,
    },
  }
}

/**
 * Dispatch a capacity CHANGE to the right quote by comparing the two capacities, so
 * callers never have to decide "is this an increase or a decrease" themselves — a decision
 * that, made in two places, is how a decrease ends up priced as an increase.
 *
 * An unchanged capacity is a legitimate no-op: it returns an `unchanged` quote with a zero
 * amount rather than an error, so a form resubmitted without a change is harmless.
 */
export function quoteCapacityChange(input: {
  currentCapacity: unknown
  newCapacity:     unknown
  terms:           CommercialTerms
}): CapacityQuoteResult {
  const { terms } = input
  if (!isCommercialTerms(terms)) return fail('INVALID_TERMS', 'Commercial configuration is invalid.')

  const cur = validateCapacity(input.currentCapacity, terms)
  if (!cur.ok) return fail('INVALID_CURRENT_CAPACITY', `Current capacity is invalid: ${cur.message}`)
  const next = validateCapacity(input.newCapacity, terms)
  if (!next.ok) return fail(next.code, next.message)

  if (next.capacity === cur.capacity) {
    return {
      ok: true,
      quote: {
        kind: 'unchanged', capacity: cur.capacity, previousCapacity: cur.capacity,
        freeCapacity: terms.freeRegistrationCapacity, activationRatePaise: terms.activationRatePaise,
        chargeableCapacity: 0, basePaise: 0, gstRatePercent: terms.gstRatePercent, gstPaise: 0,
        totalPaise: 0, paymentRequired: false, terms: { ...terms },
      },
    }
  }
  return next.capacity > cur.capacity
    ? calculateCapacityIncreaseQuote(input)
    : calculateCapacityDecreaseQuote(input)
}

// ─── Display helper ────────────────────────────────────────────────────────────

/**
 * Paise → a rupee string for UI and email copy (`59649` → `₹596.49`). Kept here so the
 * quote and every surface that renders it share one formatting rule; it is presentation
 * only and is never fed back into a calculation.
 */
export function formatPaise(paise: number): string {
  const sign  = paise < 0 ? '-' : ''
  const abs   = Math.abs(Math.round(paise))
  const whole = Math.floor(abs / 100)
  const cents = abs % 100
  return `${sign}₹${whole.toLocaleString('en-IN')}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`
}
