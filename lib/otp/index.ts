// Server-only OTP utilities — never import from client components or pages.
//
// RD-CONF-11: OTP POLICY (length / TTL / attempts / resend / hourly cap) now lives
// in the Business Configuration `security` section, resolved via getSecurityConfig.
// This module holds only the crypto primitives; callers pass the resolved digit
// count. No policy constants live here anymore (single source of truth).

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'

// ─── Generation ───────────────────────────────────────────────────────────────

/** Cryptographically random N-digit code, zero-padded. `digits` comes from the
 *  resolved security policy (security.otpDigits, validated to 4..10). */
export function generateCode(digits: number): string {
  return randomInt(0, 10 ** digits).toString().padStart(digits, '0')
}

/** Random 32-byte hex salt — unique per OTP request. */
export function generateSalt(): string {
  return randomBytes(32).toString('hex')
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** SHA-256(code + salt) — stored in Firestore instead of the plain code. */
export function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(code + salt).digest('hex')
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Timing-safe comparison of a candidate code against a stored hash.
 * Returns true only when code + salt produces an identical hash.
 */
export function verifyCode(
  candidate: string,
  salt:      string,
  stored:    string,
): boolean {
  const a = Buffer.from(hashCode(candidate, salt), 'hex')
  const b = Buffer.from(stored, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
