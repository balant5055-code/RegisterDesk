// RD-CAPACITY-01 · The commercial terms that price an event's registration capacity.
// PURE + client-safe: types, defaults, validation and normalisation only. No Firestore,
// no Razorpay, no config I/O.
//
// ═══ WHY THIS IS ITS OWN MODULE ══════════════════════════════════════════════
// The same six values live in three places that must agree byte-for-byte:
//
//   1. the GLOBAL defaults          — lib/config/businessConfig.ts (Super Admin editable)
//   2. the PER-EVENT override       — events/{slug}.commercial (admin, authorised)
//   3. the IMMUTABLE snapshot       — on every licenseOrders doc, for ever
//
// (3) is the reason this is a standalone shape rather than a field group on the config
// section. A payment must remain explicable years later: "why was this organizer charged
// ₹708?" is answerable only if the terms that produced it were copied onto the order at
// the moment it was created. A later Super Admin rate change must never be able to rewrite
// what a historical order says it charged — so the snapshot is a VALUE, never a reference.
//
// Every amount is INTEGER PAISE. Percentages are plain numbers (18 means 18%).

/** The commercial terms that price one event's capacity. */
export interface CommercialTerms {
  /** Registrations included at no charge. NOT assumed to be 100 anywhere. */
  freeRegistrationCapacity:      number
  /** Price of ONE chargeable registration slot, in paise (150 = ₹1.50). */
  activationRatePaise:           number
  /** GST on the activation fee, as a percent (18 = 18%). */
  gstRatePercent:                number
  /** Platform fee on money the organizer collects from attendees, as a percent. */
  attendeeTransactionFeePercent: number
  /** Charge for removing capacity, as a percent of the removed capacity's value. */
  capacityDecreaseFeePercent:    number
  /** Hard ceiling on the capacity an organizer may select. */
  maximumEventCapacity:          number
}

/**
 * Platform defaults. DEFAULTS ONLY — every consumer resolves the effective terms through
 * the config layer (global ⊕ per-event), never by reading this object directly. The
 * values are the approved commercial model:
 *
 *   first 100 registrations free · ₹1.50 per additional registration · 18% GST
 *   2.5% attendee transaction fee · 1% charge to remove capacity · 200,000 ceiling
 */
export const DEFAULT_COMMERCIAL_TERMS: CommercialTerms = {
  freeRegistrationCapacity:      100,
  activationRatePaise:           150,
  gstRatePercent:                18,
  attendeeTransactionFeePercent: 2.5,
  capacityDecreaseFeePercent:    1,
  maximumEventCapacity:          200_000,
}

/** The keys of CommercialTerms, in a stable order — used by validation and admin UI. */
export const COMMERCIAL_TERM_KEYS: (keyof CommercialTerms)[] = [
  'freeRegistrationCapacity', 'activationRatePaise', 'gstRatePercent',
  'attendeeTransactionFeePercent', 'capacityDecreaseFeePercent', 'maximumEventCapacity',
]

// ─── Predicates ────────────────────────────────────────────────────────────────
//
// Deliberately strict. A NaN or Infinity that reaches the pricing engine produces a
// NaN amount, and a NaN amount handed to Razorpay is an outage; a negative rate is a
// credit nobody authorised. Both are rejected here, at the edge.

const isCountable = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && v >= 0

const isPercent = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100

/**
 * Validate a candidate terms object. Returns every problem, not just the first, so an
 * admin editing six fields sees all of them at once.
 *
 * `path` prefixes each message (e.g. `licensing.commercial`) so the same validator
 * serves the global config section and a per-event override.
 */
export function validateCommercialTerms(v: unknown, path = 'commercial'): string[] {
  const errors: string[] = []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return [`${path} must be an object`]
  }
  const c = v as Partial<CommercialTerms>

  if (!isCountable(c.freeRegistrationCapacity)) {
    errors.push(`${path}.freeRegistrationCapacity must be a non-negative integer`)
  }
  if (!isCountable(c.activationRatePaise)) {
    errors.push(`${path}.activationRatePaise must be a non-negative integer number of paise`)
  }
  if (!isPercent(c.gstRatePercent)) {
    errors.push(`${path}.gstRatePercent must be a number 0..100`)
  }
  if (!isPercent(c.attendeeTransactionFeePercent)) {
    errors.push(`${path}.attendeeTransactionFeePercent must be a number 0..100`)
  }
  if (!isPercent(c.capacityDecreaseFeePercent)) {
    errors.push(`${path}.capacityDecreaseFeePercent must be a number 0..100`)
  }
  if (!isCountable(c.maximumEventCapacity) || (c.maximumEventCapacity ?? 0) < 1) {
    errors.push(`${path}.maximumEventCapacity must be an integer >= 1`)
  }
  // A maximum below the free allowance makes the free tier unreachable, which would
  // reject every capacity an organizer could legally pick.
  if (isCountable(c.maximumEventCapacity) && isCountable(c.freeRegistrationCapacity)
      && c.maximumEventCapacity < c.freeRegistrationCapacity) {
    errors.push(`${path}.maximumEventCapacity must be >= ${path}.freeRegistrationCapacity`)
  }
  return errors
}

/** True when `v` is a complete, valid CommercialTerms. */
export function isCommercialTerms(v: unknown): v is CommercialTerms {
  return validateCommercialTerms(v).length === 0
}

/**
 * Coerce a STORED value into usable terms: valid fields are kept, invalid or absent
 * fields fall back to `fallback` (the global effective terms, or the platform defaults).
 *
 * This exists because a per-event override is a PARTIAL by design — an admin who changes
 * only the rate for one event should not have to restate the other five values, and a
 * corrupt single field must not take the whole event's pricing down with it.
 */
export function normalizeCommercialTerms(
  stored:   unknown,
  fallback: CommercialTerms = DEFAULT_COMMERCIAL_TERMS,
): CommercialTerms {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return { ...fallback }
  const s = stored as Partial<Record<keyof CommercialTerms, unknown>>
  const out = { ...fallback }
  for (const key of COMMERCIAL_TERM_KEYS) {
    const candidate = { ...out, [key]: s[key] }
    // Field-by-field: accept the stored value only if the RESULT still validates.
    if (s[key] !== undefined && validateCommercialTerms(candidate).length === 0) {
      out[key] = s[key] as number
    }
  }
  return out
}

// ─── RD-EVENT-COMMERCE-04A · stored-group integrity ────────────────────────────

export type StoredCommercialIntegrity =
  | { state: 'absent' }                      // never configured → the approved code defaults apply
  | { state: 'valid' }
  | { state: 'invalid'; errors: string[] }   // configured, but a PRESENT value is unusable

/**
 * Judge the RAW stored `licensing.commercial` group — before any fallback. Absent keys are a
 * legitimate partial configuration (they inherit the approved default); a PRESENT key that is
 * null, the wrong type or out of range is corruption. Deliberately a plain spread, not the
 * config layer's deepMerge (which treats a stored `null` as absent and would hide it).
 *
 * A zero rate is VALID here: it is an explicit, validated promotional value, not corruption.
 */
export function assessStoredCommercialTerms(stored: unknown): StoredCommercialIntegrity {
  if (stored === undefined) return { state: 'absent' }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { state: 'invalid', errors: ['licensing.commercial must be an object'] }
  }
  const errors = validateCommercialTerms({ ...DEFAULT_COMMERCIAL_TERMS, ...(stored as Partial<CommercialTerms>) }, 'licensing.commercial')
  return errors.length === 0 ? { state: 'valid' } : { state: 'invalid', errors }
}
