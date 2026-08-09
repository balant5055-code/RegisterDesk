// RD-FINANCE-TAX-CLEANUP-01 — the ONE GSTIN validator.
//
// The pattern moved out of the dormant `lib/platform/pricing/taxProfile.ts` so the LIVE
// payout profile could reuse it instead of a second copy. These tests pin the shared
// module; tests/unit/tax.test.ts independently pins that the dormant engine's behaviour is
// unchanged by the move.

import { describe, it, expect } from 'vitest'
import { GSTIN_RE, isValidGstin } from '@/lib/validators/gstin'

// 2-digit state + 5 alpha + 4 digit + 1 alpha + 1 alnum + 'Z' + 1 alnum
const VALID = ['29ABCDE1234F1Z5', '27AADCB2230M1ZT', '07AAACH7409R1ZZ', '19AAACI1195H1Z9']

describe('isValidGstin — accepts well-formed GSTINs', () => {
  it.each(VALID)('accepts %s', g => {
    expect(isValidGstin(g)).toBe(true)
  })
})

describe('isValidGstin — rejects malformed input', () => {
  it.each([
    ['too short',              '29ABCDE1234F1Z'],
    ['too long',               '29ABCDE1234F1Z55'],
    ['non-numeric state code', 'XXABCDE1234F1Z5'],
    ['digits in the PAN block','29ABC1E1234F1Z5'],
    ['letters in the number',  '29ABCDEA234F1Z5'],
    ['missing the literal Z',  '29ABCDE1234F1A5'],
    ['entity code 0',          '29ABCDE1234F0Z5'],
    ['lower case',             '29abcde1234f1z5'],
    ['padded with spaces',     ' 29ABCDE1234F1Z5 '],
    ['a PAN, not a GSTIN',     'ABCDE1234F'],
    ['empty',                  ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidGstin(value)).toBe(false)
  })

  it('rejects null and undefined without throwing', () => {
    expect(isValidGstin(null)).toBe(false)
    expect(isValidGstin(undefined)).toBe(false)
  })
})

describe('single source of truth', () => {
  it('exposes the regex and the predicate from ONE module', () => {
    // If a second GSTIN pattern is ever added elsewhere, this is the module it must import.
    expect(GSTIN_RE.test('29ABCDE1234F1Z5')).toBe(true)
    expect(isValidGstin('29ABCDE1234F1Z5')).toBe(GSTIN_RE.test('29ABCDE1234F1Z5'))
  })

  it('is a FORMAT check only — it makes no checksum or real-state claim', () => {
    // 99 is not a real GST state code; the validator deliberately does not know that.
    // Documented behaviour, asserted so a future "improvement" is a conscious decision.
    expect(isValidGstin('99ABCDE1234F1Z5')).toBe(true)
  })
})
