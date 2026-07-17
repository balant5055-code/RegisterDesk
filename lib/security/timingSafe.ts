// Constant-time string comparison for secrets / capability tokens. Server-only.
//
// A plain `===` / `!==` on secret strings short-circuits at the first differing
// byte, so response timing leaks how much of a guess was correct — over many
// requests an attacker can recover a token byte-by-byte. Compare through
// crypto.timingSafeEqual instead. Length is checked first (it is not secret for
// the fixed-length tokens this guards) because timingSafeEqual throws on a
// length mismatch.

import { timingSafeEqual } from 'crypto'

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
