// Server-only OTP utilities — never import from client components or pages.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'

// ─── Constants ────────────────────────────────────────────────────────────────

export const OTP_DIGITS        = 6
export const OTP_TTL_MS        = 10 * 60 * 1_000    // 10 minutes
export const OTP_MAX_ATTEMPTS  = 5
export const OTP_RESEND_WAIT   = 60 * 1_000          // 60-second cooldown

// ─── Generation ───────────────────────────────────────────────────────────────

/** Cryptographically random 6-digit code, zero-padded. */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(OTP_DIGITS, '0')
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
