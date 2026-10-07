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

import type {
  IdentifierCaseMode, IdentifierFormat, IdentifierPool, IdentifierType,
} from './types'

const DEFAULT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32 (no I,L,O,U)

/**
 * RD-EVENT-19A · the shared ceiling for a manual identifier value.
 *
 * The platform had no limit at all, so a value was bounded only by Firestore's
 * 1,500-byte document-id cap (locks are keyed `{slug}__{value}`) — i.e. a bad
 * request could mint a lock id nobody can read back or print. 64 characters is
 * comfortably above every real identifier ("EXHIBITOR-HALL-B-0042" is 21) and far
 * below anything that endangers the key. Declared ONCE; routes must not
 * re-declare their own.
 */
export const MAX_VALUE_LENGTH = 64

// ─── Effective format (pool overrides config) ───────────────────────────────

export interface EffectiveFormat {
  prefix:       string
  suffix:       string
  padding:      number
  pattern:      string | null
  alphabet:     string
  randomLength: number
  caseMode:     IdentifierCaseMode
}

export function effectiveFormat(fmt: IdentifierFormat, pool: IdentifierPool): EffectiveFormat {
  return {
    prefix:       pool.prefix  ?? fmt.prefix  ?? '',
    suffix:       pool.suffix  ?? fmt.suffix  ?? '',
    padding:      pool.padding ?? fmt.padding ?? 0,
    pattern:      fmt.pattern ?? null,
    alphabet:     fmt.alphabet && fmt.alphabet.length >= 2 ? fmt.alphabet : DEFAULT_ALPHABET,
    randomLength: fmt.randomLength && fmt.randomLength > 0 ? fmt.randomLength : 6,
    // Absent ⇒ 'preserve': every event that predates 19A keeps its exact values.
    caseMode:     fmt.caseMode ?? 'preserve',
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

// ─── Normalization (RD-EVENT-19A) ───────────────────────────────────────────
//
// The lock document id is `{eventSlug}__{value}`, so the value IS the identity.
// " 5001" and "5001" were therefore two different identifiers, and reserve /
// block / retire did not even trim, while allocate did. One function now decides
// what a value means, and every entry point calls it.
//
// What normalization deliberately does NOT do:
//   • it does not touch internal spacing — "SEAT A 12" is a legitimate Seat
//     Number and "A  12" is not the same identifier as "A 12";
//   • it does not remove hyphens — "DEL-0001" is the value, not "DEL0001";
//   • it does not turn anything into a number.
// It also never rewrites a stored value: normalization applies to INPUT.

/** Trims and applies the configured case policy. Pure. */
export function normalizeIdentifierValue(
  raw:      unknown,
  caseMode: IdentifierCaseMode = 'preserve',
): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (caseMode === 'upper') return trimmed.toUpperCase()
  if (caseMode === 'lower') return trimmed.toLowerCase()
  return trimmed
}

export type ValueRejection = 'EMPTY' | 'TOO_LONG'

export type ValueCheck =
  | { ok: true;  value: string }
  | { ok: false; reason: ValueRejection; value: string }

/**
 * Normalizes AND bounds a manual value. Callers must run this before a lock is
 * created, so an unusable identifier is refused rather than persisted.
 */
export function validateIdentifierValue(
  raw:      unknown,
  caseMode: IdentifierCaseMode = 'preserve',
): ValueCheck {
  const value = normalizeIdentifierValue(raw, caseMode)
  if (value.length === 0) return { ok: false, reason: 'EMPTY', value }
  // Counted in code points, not UTF-16 units, so an emoji or a Devanagari
  // identifier is measured the way a person would count it.
  if ([...value].length > MAX_VALUE_LENGTH) return { ok: false, reason: 'TOO_LONG', value }
  return { ok: true, value }
}

// ─── Numeric extraction ─────────────────────────────────────────────────────

/** The affix pair a value was built from. Both default to empty. */
export interface NumericAffixes {
  prefix?: string
  suffix?: string
}

/**
 * Extracts the numeric component of a value.
 *
 *   numericOf('5001')                              → 5001
 *   numericOf('B5001',  { prefix: 'B'   })         → 5001
 *   numericOf('DEL-0001', { prefix: 'DEL-' })      → 1
 *   numericOf('A-001',  { prefix: 'A-'  })         → 1
 *   numericOf('RUN-2026-001')                      → null   ← ambiguous
 *   numericOf('B5001')                             → null   ← no format supplied
 *
 * RULE: the affixes are stripped, and what remains must be ENTIRELY digits.
 * Nothing is scavenged out of the middle of a value, so a pattern identifier
 * like `RUN-2026-001` can never be mistaken for the number 2026001 — the format
 * does not say which component bears the range, so there is no answer to give.
 *
 * Called with one argument it behaves exactly as it did before RD-EVENT-19A,
 * which is what keeps every existing caller unchanged.
 */
export function numericOf(value: string, affixes?: NumericAffixes): number | null {
  if (typeof value !== 'string' || value.length === 0) return null

  const prefix = affixes?.prefix ?? ''
  const suffix = affixes?.suffix ?? ''

  let body = value
  if (prefix) {
    if (!body.startsWith(prefix)) return pureNumeric(value)
    body = body.slice(prefix.length)
  }
  if (suffix) {
    if (!body.endsWith(suffix)) return pureNumeric(value)
    body = body.slice(0, body.length - suffix.length)
  }
  return pureNumeric(body)
}

function pureNumeric(s: string): number | null {
  if (!/^\d+$/.test(s)) return null
  const n = parseInt(s, 10)
  return Number.isSafeInteger(n) ? n : null
}
