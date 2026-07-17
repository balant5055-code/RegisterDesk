// Phase H.1.5B — Participant Identity Platform: format engine.
//
// Pure, deterministic value formatting. Given a pool + a sequence number (or a
// random seed), produce the rendered identifier string. No I/O, no SDK.
//
// Supported types:
//   numeric       → 1, 2, 0042
//   alphanumeric  → A001, VIP001, RUN2042, CONF0008   (prefix + zero-padded body)
//   random        → 8DK92A                            (token from an alphabet)
//   pattern       → RUN-{YEAR}-{0001}, VIP-{CITY}-{001} (token substitution)
//
// Pattern context tokens (CITY / TRACK / STATE / YEAR …) are resolved from the
// supplied context map; a `{0000}` digit-run is replaced by the zero-padded
// sequence number. Patterns are fully designed here for future expansion.

import type { IdentifierFormat, IdentifierPool, IdentifierType } from './types'

const DEFAULT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32 (no I,L,O,U)

// ─── Effective format (pool overrides config) ───────────────────────────────

export interface EffectiveFormat {
  prefix:       string
  suffix:       string
  padding:      number
  pattern:      string | null
  alphabet:     string
  randomLength: number
}

export function effectiveFormat(fmt: IdentifierFormat, pool: IdentifierPool): EffectiveFormat {
  return {
    prefix:       pool.prefix  ?? fmt.prefix  ?? '',
    suffix:       pool.suffix  ?? fmt.suffix  ?? '',
    padding:      pool.padding ?? fmt.padding ?? 0,
    pattern:      fmt.pattern ?? null,
    alphabet:     fmt.alphabet && fmt.alphabet.length >= 2 ? fmt.alphabet : DEFAULT_ALPHABET,
    randomLength: fmt.randomLength && fmt.randomLength > 0 ? fmt.randomLength : 6,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
  const s = String(n)
  return width > 0 ? s.padStart(width, '0') : s
}

/**
 * Deterministic pseudo-random token derived from a numeric seed. Determinism
 * keeps allocation reproducible and avoids Math.random; collisions are still
 * caught by the lock layer, which advances the seed on conflict.
 */
function randomToken(seed: number, alphabet: string, length: number): string {
  // xorshift32 — small, fast, deterministic.
  let x = (seed ^ 0x9e3779b9) >>> 0
  let out = ''
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x >>>= 0
    x ^= x >> 17
    x ^= x << 5;  x >>>= 0
    out += alphabet[x % alphabet.length]
  }
  return out
}

/**
 * Substitutes pattern tokens. `{0000}` (a run of digits) → zero-padded number.
 * Named tokens (`{YEAR}`, `{CITY}`, …) come from `context`; unknown tokens are
 * left intact so nothing is silently dropped.
 */
function applyPattern(pattern: string, n: number, context: Record<string, string>): string {
  return pattern.replace(/\{([^}]+)\}/g, (match, token: string) => {
    if (/^0+$/.test(token)) return pad(n, token.length)
    const key = token.toUpperCase()
    if (key in context) return context[key]
    return match
  })
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface FormatArgs {
  type:    IdentifierType
  format:  EffectiveFormat
  /** Sequence number for numeric / alphanumeric / pattern; seed for random. */
  n:       number
  /** Optional named tokens for pattern type (e.g. { YEAR: '2026', CITY: 'MAA' }). */
  context?: Record<string, string>
}

/** Renders the final identifier string for a given sequence number. */
export function formatIdentifier(args: FormatArgs): string {
  const { type, format, n } = args
  const ctx = args.context ?? {}

  switch (type) {
    case 'numeric':
      return `${format.prefix}${pad(n, format.padding)}${format.suffix}`
    case 'alphanumeric':
      return `${format.prefix}${pad(n, format.padding)}${format.suffix}`
    case 'random':
      return `${format.prefix}${randomToken(n, format.alphabet, format.randomLength)}${format.suffix}`
    case 'pattern':
      return format.pattern
        ? applyPattern(format.pattern, n, ctx)
        : `${format.prefix}${pad(n, format.padding)}${format.suffix}`
    default:
      return `${format.prefix}${pad(n, format.padding)}${format.suffix}`
  }
}

/** Extracts the numeric component of a value when it is purely numeric. */
export function numericOf(value: string): number | null {
  return /^\d+$/.test(value) ? parseInt(value, 10) : null
}
