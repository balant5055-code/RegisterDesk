// Validation + normalization for organizer-edited attendee fields.
// Normalization MUST match registration submission (lib stores
// email = trim+lowercase, phone = trim) so duplicate-uniqueness queries keep
// matching across created and edited registrations.

export const MAX_NAME_LEN  = 200
export const MAX_EMAIL_LEN  = 320
export const MAX_PHONE_LEN  = 20
export const MIN_PHONE_LEN  = 7

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Digits with optional leading + and common separators (spaces, hyphens, parens).
const PHONE_RE = /^\+?[\d\s\-()]+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email)
  return e.length > 0 && e.length <= MAX_EMAIL_LEN && EMAIL_RE.test(e)
}

/** Phone is stored trimmed (matches submission); separators are allowed. */
export function normalizePhone(phone: string): string {
  return phone.trim()
}

export function isValidPhone(phone: string): boolean {
  const p = normalizePhone(phone)
  if (p.length < MIN_PHONE_LEN || p.length > MAX_PHONE_LEN) return false
  if (!PHONE_RE.test(p)) return false
  // Require at least 7 actual digits (country code + number) regardless of separators.
  const digits = p.replace(/\D/g, '')
  return digits.length >= MIN_PHONE_LEN && digits.length <= 15
}

export function normalizeName(name: string): string {
  return name.trim()
}

export function isValidName(name: string): boolean {
  const n = normalizeName(name)
  return n.length > 0 && n.length <= MAX_NAME_LEN
}
