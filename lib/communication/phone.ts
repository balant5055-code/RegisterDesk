// Single source of truth for phone-number handling across ALL communication
// channels (WhatsApp / Meta today; future SMS / other providers). No other module
// should parse, strip, or normalize phone numbers for sending — import from here.
//
// India-first today, but country-AGNOSTIC by design: the default calling code is a
// single configurable value, and every function accepts an override. A future
// `organizer.country` can drive normalization WITHOUT changing any business or
// communication code — callers just pass `{ defaultCallingCode }`.

// ── Configuration — the ONLY place country defaults live ──────────────────────
export const DEFAULT_COUNTRY              = 'IN'
export const DEFAULT_COUNTRY_CALLING_CODE = '91'

// E.164: total length is [country code + national number], max 15 digits. We
// require a country code to be present after normalization (≥ 11: e.g. US 1+10).
const MIN_E164_DIGITS = 11
const MAX_E164_DIGITS = 15

export interface NormalizeOptions {
  /**
   * Calling code prepended to a BARE national number (one with no country code).
   * Defaults to DEFAULT_COUNTRY_CALLING_CODE. Future international expansion:
   * pass the code for `organizer.country` here — nothing else changes.
   */
  defaultCallingCode?: string
}

export interface PhoneValidationResult {
  valid:            boolean
  reason?:          string
  normalizedPhone?: string   // digits only, E.164 form WITHOUT a leading '+'
}

/**
 * Normalize any organizer/attendee-entered phone into digits-only E.164 (no '+').
 *
 *   9363935055        → 919363935055   (bare 10-digit national ⇒ prepend default code)
 *   +91 93639 35055   → 919363935055   (already has code ⇒ kept)
 *   91 93639 35055    → 919363935055   (already has code ⇒ kept)
 *   09363935055       → 919363935055   (trunk '0' dropped, then prepend)
 *   919363935055      → 919363935055   (unchanged)
 *   971501234567      → 971501234567   (UAE — country code present ⇒ kept)
 *   16505551234       → 16505551234    (US — country code present ⇒ kept)
 *
 * Idempotent: normalizing an already-normalized number returns the same value.
 */
export function normalizePhoneNumber(raw: string, opts: NormalizeOptions = {}): string {
  if (!raw || !raw.trim()) return ''
  const callingCode = (opts.defaultCallingCode ?? DEFAULT_COUNTRY_CALLING_CODE).replace(/\D/g, '')

  const trimmed = raw.trim()
  const hadPlus = trimmed.startsWith('+')
  const digits  = trimmed.replace(/\D/g, '')   // strip +, spaces, -, (), ., etc.
  if (!digits) return ''

  // An explicit leading '+' means the country code is already present — keep as-is.
  if (hadPlus) return digits

  // No '+': a leading trunk '0' (or an intl '00' prefix) is not part of the number.
  const national = digits.replace(/^0+/, '')

  // Exactly 10 digits ⇒ a bare national number ⇒ prepend the default calling code.
  if (national.length === 10) return `${callingCode}${national}`

  // Otherwise assume a country code is already present — keep as-is.
  return national
}

/**
 * Validate a raw phone. Returns { valid, reason?, normalizedPhone }. When invalid,
 * callers MUST NOT send to the provider. `normalizedPhone` is always the best-effort
 * normalized form (useful for diagnostics even when invalid).
 */
export function validatePhoneNumber(raw: string, opts: NormalizeOptions = {}): PhoneValidationResult {
  if (!raw || !raw.trim()) return { valid: false, reason: 'Phone number is empty' }

  // Only digits and common formatting characters are acceptable input.
  if (/[^\d+\s().\-]/.test(raw.trim())) {
    return { valid: false, reason: 'Phone number contains invalid characters' }
  }

  const normalizedPhone = normalizePhoneNumber(raw, opts)

  if (normalizedPhone.length < MIN_E164_DIGITS) {
    return { valid: false, reason: 'Phone number is too short or missing a country code', normalizedPhone }
  }
  if (normalizedPhone.length > MAX_E164_DIGITS) {
    return { valid: false, reason: 'Phone number is too long (max 15 digits, E.164)', normalizedPhone }
  }
  return { valid: true, normalizedPhone }
}

/** Canonical display form (E.164 with '+'), e.g. "+919363935055". "" when empty/invalid input. */
export function formatPhoneNumber(raw: string, opts: NormalizeOptions = {}): string {
  const digits = normalizePhoneNumber(raw, opts)
  return digits ? `+${digits}` : ''
}
